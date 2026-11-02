"""Disparador del pipeline: consume `media:uploads` de Redis Streams (`XREADGROUP` + `XACK`).

identity-api hace `XADD media:uploads * video_id <id>` al confirmar una subida directa del
navegador al bucket. Este adaptador es quien llama a `pipeline.process_video` (ver `jobs.py`);
el núcleo del worker (pipeline, repositorio, almacenamiento y `Settings`) no conoce Redis.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable

from redis.exceptions import ResponseError

from media_worker.pipeline import VIDEO_ID_PATTERN

logger = logging.getLogger(__name__)

STREAM_KEY = "media:uploads"
CONSUMER_GROUP = "media-workers"
DEFAULT_BLOCK_MS = 5000
DEFAULT_COUNT = 10
# Espera tras un fallo antes de seguir, para no martillar una dependencia caída.
RETRY_DELAY_S = 5.0
# Intentos totales por evento (el campo `attempt` empieza en 1) antes de darlo por fallido.
MAX_ATTEMPTS = 3
# Un evento entregado a otro worker que lleva este tiempo sin confirmarse se da por huérfano.
# Debe superar con holgura lo que tarda el vídeo más largo: reclamar uno que sigue en curso
# solo lo reprocesa (es idempotente), pero desperdicia un FFmpeg.
CLAIM_IDLE_MS = 15 * 60 * 1000
# Cada cuánto, con la cola vacía, se buscan eventos huérfanos.
CLAIM_INTERVAL_S = 60.0


def parse_video_id(fields: dict | None) -> str | None:
    """Extrae y valida `video_id` del evento; None si falta o es inválido."""
    value = (fields or {}).get("video_id")
    if isinstance(value, str) and VIDEO_ID_PATTERN.fullmatch(value):
        return value
    return None


def parse_attempt(fields: dict | None) -> int:
    """Número de intento del evento (1 si falta o no es un entero positivo)."""
    try:
        attempt = int((fields or {}).get("attempt", 1))
    except (TypeError, ValueError):
        return 1
    return attempt if attempt >= 1 else 1


class StreamConsumer:
    """Lee `media:uploads` con un grupo de consumidores y confirma cada evento tras procesarlo.

    Si el handler lanza una excepción (p. ej. SQL o S3 caídos) el evento se confirma y se vuelve
    a publicar al final del stream con `attempt + 1`, así un vídeo que siempre falla no bloquea
    a los demás y el contador sobrevive a un reinicio. Al agotar `max_attempts` se llama a
    `on_exhausted` (que lo marca `failed`) y se confirma. Si Redis o `on_exhausted` fallan, el
    evento queda pendiente y `run` lo reintenta (`recover_pending`) sin tumbar el worker.

    Los eventos pendientes de un worker que murió (otro nombre de consumidor) se reclaman con
    `XAUTOCLAIM` pasado `claim_idle_ms` (`claim_stale`), al arrancar y cada `CLAIM_INTERVAL_S`.
    """

    def __init__(
        self,
        redis,
        handler: Callable[[str], object],
        consumer: str,
        stream: str = STREAM_KEY,
        group: str = CONSUMER_GROUP,
        block_ms: int = DEFAULT_BLOCK_MS,
        count: int = DEFAULT_COUNT,
        sleep: Callable[[float], object] = time.sleep,
        on_exhausted: Callable[[str], object] | None = None,
        max_attempts: int = MAX_ATTEMPTS,
        claim_idle_ms: int = CLAIM_IDLE_MS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.redis = redis
        self.handler = handler
        self.consumer = consumer
        self.stream = stream
        self.group = group
        self.block_ms = block_ms
        self.count = count
        self.sleep = sleep
        self.on_exhausted = on_exhausted
        self.max_attempts = max_attempts
        self.claim_idle_ms = claim_idle_ms
        self.clock = clock

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
        handled = 0
        for _stream, messages in response or []:
            for message_id, fields in messages:
                self._handle(message_id, fields)
                handled += 1
        return handled

    def recover_pending(self) -> int:
        """Reprocesa los eventos entregados a este consumidor que nunca se confirmaron."""
        total = 0
        while handled := self.poll("0"):
            total += handled
        return total

    def claim_stale(self) -> int:
        """Reprocesa los eventos que otro worker recibió y dejó sin confirmar `claim_idle_ms`."""
        total = 0
        cursor = "0-0"
        while True:
            # Redis 7 devuelve (siguiente_id, mensajes, borrados); antes solo los dos primeros.
            cursor, messages = self.redis.xautoclaim(
                self.stream,
                self.group,
                self.consumer,
                min_idle_time=self.claim_idle_ms,
                start_id=cursor,
                count=self.count,
            )[:2]
            for message_id, fields in messages:
                self._handle(message_id, fields)
            total += len(messages)
            if cursor in ("0-0", b"0-0"):
                return total

    def run(self, stop: threading.Event) -> None:
        self.ensure_group()
        if stop.is_set():
            return
        recovered = self.recover_pending()
        if recovered:
            logger.info("reprocesados %d eventos pendientes", recovered)
        self._sweep_stale()
        last_sweep = self.clock()
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
                    if self.clock() - last_sweep >= CLAIM_INTERVAL_S:
                        self._sweep_stale()
                        last_sweep = self.clock()
            except Exception:
                logger.exception(
                    "fallo procesando un evento; se reintenta en %.0f s", RETRY_DELAY_S
                )
                retry = True

    def _sweep_stale(self) -> None:
        claimed = self.claim_stale()
        if claimed:
            logger.info("reclamados %d eventos de otros workers", claimed)

    def _handle(self, message_id: str, fields: dict | None) -> None:
        video_id = parse_video_id(fields)
        if video_id is None:
            logger.warning("evento %s inválido, se descarta: %r", message_id, fields)
        else:
            try:
                self.handler(video_id)
            except Exception as exc:
                self._failed(message_id, video_id, parse_attempt(fields), exc)
                return
        self.redis.xack(self.stream, self.group, message_id)

    def _failed(self, message_id: str, video_id: str, attempt: int, exc: Exception) -> None:
        reason = f"{type(exc).__name__}: {exc}"
        if attempt < self.max_attempts:
            logger.warning(
                "vídeo %s: falló el intento %d/%d (%s); se reintenta en %.0f s",
                video_id,
                attempt,
                self.max_attempts,
                reason,
                RETRY_DELAY_S,
                exc_info=exc,
            )
            # Primero se reencola y después se confirma: si Redis cae entre ambos, el evento se
            # duplica (el pipeline es idempotente) en lugar de perderse.
            self.redis.xadd(self.stream, {"video_id": video_id, "attempt": str(attempt + 1)})
            self.redis.xack(self.stream, self.group, message_id)
            self.sleep(RETRY_DELAY_S)
            return
        logger.error(
            "vídeo %s: reintentos agotados tras %d intentos (%s); se marca failed",
            video_id,
            attempt,
            reason,
            exc_info=exc,
        )
        if self.on_exhausted is not None:
            self.on_exhausted(video_id)
        self.redis.xack(self.stream, self.group, message_id)
