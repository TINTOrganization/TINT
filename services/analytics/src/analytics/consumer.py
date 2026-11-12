"""Ingesta: consume `analytics:events` (`XREADGROUP` + `XACK`) y lo persiste en PostgreSQL.

Adaptado del consumidor de `services/media-worker` (mismo manejo de pendientes). Por lote leído:
`sanitize_event` de cada mensaje → `EventStore.save_many` (INSERT idempotente en una sola
transacción; `room_closed` consolida KPIs) → `XACK` de todo el lote. Un evento inválido se
registra y se confirma para no envenenar el stream; un fallo de infraestructura deja el lote
pendiente y se reintenta.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from datetime import timedelta

from redis.exceptions import ResponseError

from analytics.sanitize import CONSUMER_GROUP, STREAM_KEY, InvalidEvent, sanitize_event

logger = logging.getLogger(__name__)

DEFAULT_BLOCK_MS = 5000
# Eventos por lote y, por tanto, por transacción: con 50 el commit se llevaba casi todo el tiempo.
DEFAULT_COUNT = 500
# Espera tras un fallo de infraestructura antes de reintentar los pendientes.
RETRY_DELAY_S = 5.0
# Cada cuánto corre el mantenimiento: cierre por gracia, purga de 90 días y DAU/MAU.
MAINTENANCE_INTERVAL_S = 3600.0
# Periodo de gracia de la sala (REQ-07): el mismo TTL que usan sync-core y social-core.
DEFAULT_ROOM_GRACE = timedelta(hours=12)
DEFAULT_TIMEZONE = "America/Bogota"
# El primer ciclo rellena todo lo que aún hay en la telemetría cruda; después, hoy y ayer.
DAU_BACKFILL_DAYS = 90
DAU_REFRESH_DAYS = 2


class StreamConsumer:
    """Lee `analytics:events` con el grupo `analytics-workers` y confirma tras persistir.

    Si el almacén lanza (p. ej. PostgreSQL caído) el lote no se confirma: queda pendiente,
    `run` espera `RETRY_DELAY_S` y lo reintenta (`recover_pending`) sin tumbar el servicio. Al
    reiniciar también se reprocesan los pendientes; la inserción idempotente evita duplicados.
    """

    def __init__(
        self,
        redis,
        store,
        consumer: str,
        stream: str = STREAM_KEY,
        group: str = CONSUMER_GROUP,
        block_ms: int = DEFAULT_BLOCK_MS,
        count: int = DEFAULT_COUNT,
        sleep: Callable[[float], object] = time.sleep,
    ) -> None:
        self.redis = redis
        self.store = store
        self.consumer = consumer
        self.stream = stream
        self.group = group
        self.block_ms = block_ms
        self.count = count
        self.sleep = sleep

    def ensure_group(self) -> None:
        """Crea el grupo (y el stream) desde el inicio; ignora `BUSYGROUP` si ya existe."""
        try:
            self.redis.xgroup_create(self.stream, self.group, id="0", mkstream=True)
        except ResponseError as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    def poll(self, last_id: str = ">") -> int:
        """Lee un lote (`>` = nuevos, `0` = pendientes propios) y devuelve cuántos procesó."""
        block = None if last_id == "0" else self.block_ms
        response = self.redis.xreadgroup(
            self.group, self.consumer, {self.stream: last_id}, count=self.count, block=block
        )
        messages = [message for _stream, batch in response or [] for message in batch]
        if messages:
            self._handle(messages)
        return len(messages)

    def recover_pending(self) -> int:
        """Reprocesa los eventos entregados a este consumidor que nunca se confirmaron."""
        total = 0
        while handled := self.poll("0"):
            total += handled
        return total

    def run(self, stop: threading.Event) -> None:
        self.ensure_group()
        if stop.is_set():
            return
        recovered = self.recover_pending()
        if recovered:
            logger.info("reprocesados %d eventos pendientes", recovered)
        retry = False
        while not stop.is_set():
            try:
                if retry:
                    # Hasta que los pendientes salgan bien no se avanza a eventos nuevos.
                    self.sleep(RETRY_DELAY_S)
                    self.recover_pending()
                    retry = False
                else:
                    self.poll()
            except Exception:
                logger.exception(
                    "fallo procesando un evento; se reintenta en %.0f s", RETRY_DELAY_S
                )
                retry = True

    def _handle(self, messages: list[tuple[str, dict | None]]) -> None:
        """Persiste el lote en una transacción y lo confirma entero (inválidos incluidos)."""
        valid = []
        for message_id, fields in messages:
            try:
                valid.append((message_id, sanitize_event(dict(fields or {}))))
            except InvalidEvent as exc:
                logger.warning("evento %s inválido, se descarta: %s", message_id, exc)
        if valid:
            try:
                self.store.save_many([event for _id, event in valid])
            except InvalidEvent:
                # PostgreSQL rechazó algún dato y deshizo el lote: uno por uno, para descartar
                # solo el evento malo.
                for message_id, event in valid:
                    try:
                        self.store.save(event)
                    except InvalidEvent as exc:
                        logger.warning("evento %s inválido, se descarta: %s", message_id, exc)
        self.redis.xack(self.stream, self.group, *(message_id for message_id, _ in messages))


def _maintain(task: str, done: str, call: Callable[[], int]) -> bool:
    """Ejecuta una tarea de mantenimiento; un fallo se registra y no detiene las demás."""
    try:
        logger.info(done, call())
    except Exception:
        logger.exception("fallo %s", task)
        return False
    return True


def run_maintenance_loop(
    store,
    stop: threading.Event,
    interval_s: float = MAINTENANCE_INTERVAL_S,
    room_grace: timedelta = DEFAULT_ROOM_GRACE,
    timezone: str = DEFAULT_TIMEZONE,
) -> None:
    """Mantenimiento al arrancar y luego cada `interval_s` hasta `stop`.

    Primero consolida las salas que agotaron el periodo de gracia (antes de que la purga se
    lleve sus eventos), luego purga la telemetría vencida y por último recalcula DAU/MAU.
    """
    dau_days = DAU_BACKFILL_DAYS
    while True:
        _maintain(
            "consolidando las salas inactivas",
            "consolidadas %d salas por periodo de gracia",
            lambda: store.close_idle_rooms(room_grace),
        )
        _maintain(
            "purgando la telemetría vencida",
            "purgados %d eventos con más de 90 días",
            store.purge_expired,
        )
        if _maintain(
            "calculando los usuarios activos",
            "usuarios activos (DAU/MAU) recalculados para %d días",
            lambda days=dau_days: store.refresh_daily_active_users(timezone, days),
        ):
            dau_days = DAU_REFRESH_DAYS
        if stop.wait(interval_s):
            return
