"""KPIs por sala y agregaciones para la API de lectura (funciones puras).

Los eventos llegan desde Redis como texto (`"3"`, `"true"`): todo valor numérico o booleano se
interpreta con tolerancia y un valor ilegible se ignora en la medida, sin descartar el evento.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any

from analytics.sanitize import parse_timestamp

Event = dict[str, Any]
TRUE_VALUES = frozenset({"true", "1", "yes"})
# Tipos que alimentan cada consulta (para no traer de la BD eventos que no aportan).
KPI_TYPES = (
    "presence",
    "drift_correction",
    "trivia_answer",
    "chat_message",
    "reaction",
    "playback_command",
    "buffering",
)
HEATMAP_TYPES = ("reaction",)
TIMELINE_TYPES = ("presence", "chat_message", "reaction")


@dataclass(frozen=True)
class RoomKpis:
    room_id: str
    peak_users: int
    avg_users: float
    avg_drift_ms: float
    trivia_accuracy_pct: float
    messages: int
    reactions: int
    playback_commands: int
    buffering_events: int
    avg_buffering_ms: float
    # QoS (red y sincronización) y QoE (tiempo total que la audiencia pasó recargando).
    avg_rtt_ms: float = 0.0
    p95_drift_ms: float = 0.0
    total_buffering_ms: int = 0

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def to_float(value: Any) -> float | None:
    """Número finito a partir de int/float/str; None si no se puede interpretar."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def to_int(value: Any) -> int | None:
    number = to_float(value)
    return None if number is None else int(number)


def to_bool(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in TRUE_VALUES
    return bool(value)


def _mean(values: list[float]) -> float:
    return round(sum(values) / len(values), 2) if values else 0.0


def _percentile(values: list[float], pct: float) -> float:
    """Percentil por rango más cercano (el menor valor que deja `pct` % de la muestra debajo)."""
    if not values:
        return 0.0
    ordered = sorted(values)
    return round(ordered[max(math.ceil(pct / 100 * len(ordered)) - 1, 0)], 2)


def compute_room_kpis(room_id: str, events: Iterable[Event]) -> RoomKpis:
    """Agrega eventos sanitizados de una sala en sus KPIs.

    `avg_users` es el promedio de las muestras de `connected_users` de los eventos `presence`.
    `avg_rtt_ms` y `p95_drift_ms` salen de `drift_correction` (QoS); el buffering es la QoE.
    """
    users: list[float] = []
    drifts: list[float] = []
    rtts: list[float] = []
    buffering: list[float] = []
    counts: Counter[str] = Counter()
    correct = 0

    for event in events:
        kind = event.get("type")
        counts[kind] += 1
        if kind == "presence":
            if (connected := to_int(event.get("connected_users"))) is not None:
                users.append(connected)
        elif kind == "drift_correction":
            if (drift := to_float(event.get("drift_ms"))) is not None:
                drifts.append(abs(drift))
            if (rtt := to_float(event.get("rtt_ms"))) is not None and rtt >= 0:
                rtts.append(rtt)
        elif kind == "trivia_answer":
            correct += to_bool(event.get("correct"))
        elif kind == "buffering":
            if (duration := to_float(event.get("duration_ms"))) is not None:
                buffering.append(duration)

    answers = counts["trivia_answer"]
    return RoomKpis(
        room_id=room_id,
        peak_users=int(max(users, default=0)),
        avg_users=_mean(users),
        avg_drift_ms=_mean(drifts),
        trivia_accuracy_pct=round(100 * correct / answers, 2) if answers else 0.0,
        messages=counts["chat_message"],
        reactions=counts["reaction"],
        playback_commands=counts["playback_command"],
        buffering_events=counts["buffering"],
        avg_buffering_ms=_mean(buffering),
        avg_rtt_ms=_mean(rtts),
        p95_drift_ms=_percentile(drifts, 95),
        total_buffering_ms=int(sum(buffering)),
    )


def _reaction_positions(events: Iterable[Event]) -> Iterable[tuple[int, str]]:
    """(`position_ms`, `emoji`) de las reacciones con emoji y posición válida."""
    for event in events:
        if event.get("type") != "reaction" or not event.get("emoji"):
            continue
        position = to_int(event.get("position_ms"))
        if position is not None and position >= 0:
            yield position, event["emoji"]


def reaction_heatmap(events: Iterable[Event], bucket_ms: int = 5000) -> list[dict[str, Any]]:
    """Reacciones por tramo de `bucket_ms` de la posición del vídeo y por emoji.

    Ordenado por `bucket_start_ms` y `emoji`. Se omiten reacciones sin emoji o sin posición válida.
    """
    if bucket_ms <= 0:
        raise ValueError("bucket_ms debe ser positivo")
    counts: Counter[tuple[int, str]] = Counter()
    for position, emoji in _reaction_positions(events):
        counts[(position // bucket_ms * bucket_ms, emoji)] += 1
    return [
        {"bucket_start_ms": start, "emoji": emoji, "count": count}
        for (start, emoji), count in sorted(counts.items())
    ]


def heatmap_density(events: Iterable[Event], bucket_ms: int = 5000) -> list[dict[str, Any]]:
    """Reacciones por tramo (todos los emojis) y su densidad normalizada de 0 a 1.

    `density` = reacciones del tramo / reacciones del tramo más activo de la sala. Solo se
    devuelven los tramos con reacciones, ordenados por `bucket_start_ms`.
    """
    if bucket_ms <= 0:
        raise ValueError("bucket_ms debe ser positivo")
    counts: Counter[int] = Counter(
        position // bucket_ms * bucket_ms for position, _emoji in _reaction_positions(events)
    )
    peak = max(counts.values(), default=0)
    return [
        {"bucket_start_ms": start, "count": count, "density": round(count / peak, 4)}
        for start, count in sorted(counts.items())
    ]


def reactions_by_emoji(events: Iterable[Event]) -> list[dict[str, Any]]:
    """Total de reacciones por emoji, de la más usada a la menos (empates por emoji)."""
    counts = Counter(
        event["emoji"] for event in events if event.get("type") == "reaction" and event.get("emoji")
    )
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return [{"emoji": emoji, "count": count} for emoji, count in ranked]


def format_timestamp(moment: datetime) -> str:
    """RFC 3339 en UTC con milisegundos y `Z` (el mismo formato del contrato de eventos)."""
    return moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _occurred_epoch(event: Event) -> float | None:
    try:
        return parse_timestamp(event.get("occurred_at")).timestamp()
    except ValueError:
        return None


def timeline(events: Iterable[Event], step_s: int = 60) -> list[dict[str, Any]]:
    """Serie por intervalos de `step_s` segundos alineados a la época, por `occurred_at`.

    Cada punto trae los mensajes y reacciones del intervalo y `connected_users`: el último valor de
    `presence` conocido al final del intervalo (se arrastra en intervalos sin presencia; 0 antes de
    la primera). Cubre desde el primer hasta el último evento, incluidos los intervalos vacíos.
    """
    if step_s <= 0:
        raise ValueError("step_s debe ser positivo")
    timed = sorted(
        (
            (epoch, event)
            for event in events
            if event.get("type") in TIMELINE_TYPES and (epoch := _occurred_epoch(event)) is not None
        ),
        key=lambda pair: pair[0],
    )
    if not timed:
        return []

    first = int(timed[0][0] // step_s)
    last = int(timed[-1][0] // step_s)
    points = []
    connected = 0
    index = 0
    for bucket in range(first, last + 1):
        messages = reactions = 0
        end = (bucket + 1) * step_s
        while index < len(timed) and timed[index][0] < end:
            event = timed[index][1]
            kind = event["type"]
            if kind == "chat_message":
                messages += 1
            elif kind == "reaction":
                reactions += 1
            elif (value := to_int(event.get("connected_users"))) is not None:
                connected = value
            index += 1
        points.append(
            {
                "t": format_timestamp(datetime.fromtimestamp(bucket * step_s, UTC)),
                "connected_users": connected,
                "messages": messages,
                "reactions": reactions,
            }
        )
    return points
