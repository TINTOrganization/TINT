"""Dobles de prueba compartidos: nunca se usan PostgreSQL ni Redis reales."""

from __future__ import annotations

from contextlib import contextmanager

from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import ResponseError


class FakeCursor:
    def __init__(self, rows=(), rowcount=0):
        self.rows = list(rows)
        self.rowcount = rowcount

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return list(self.rows)


class FakeConn:
    """Conexión psycopg mínima: registra cada `execute` y responde con `responder(sql, params)`.

    `responder` devuelve una lista de filas o un `FakeCursor`; si lanza, la excepción sale del
    `execute` (para simular una caída de PostgreSQL).
    """

    def __init__(self, responder=None):
        self.responder = responder or (lambda sql, params: [])
        self.executed = []
        self.transactions = 0
        self.committed = 0
        self.closed = False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        result = self.responder(sql, params)
        return result if isinstance(result, FakeCursor) else FakeCursor(result)

    @contextmanager
    def transaction(self):
        self.transactions += 1
        yield
        self.committed += 1

    def close(self):
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def statements(self, prefix):
        return [(sql, params) for sql, params in self.executed if sql.lstrip().startswith(prefix)]


class FakeRedis:
    """Subconjunto de Redis: un stream con grupo de consumidores y claves de revocación."""

    def __init__(self):
        self.groups = set()
        self.entries = []
        self.delivered = 0
        self.pending = {}
        self.acks = []
        self.keys = set()
        self.down = False

    def xgroup_create(self, name, groupname, id="$", mkstream=False):
        if (name, groupname) in self.groups:
            raise ResponseError("BUSYGROUP Consumer Group name already exists")
        self.groups.add((name, groupname))

    def xadd(self, name, fields):
        message_id = f"{len(self.entries) + 1}-0"
        self.entries.append((message_id, fields))
        return message_id

    def xreadgroup(self, groupname, consumername, streams, count=None, block=None):
        ((stream, last_id),) = streams.items()
        if last_id == "0":
            batch = [(mid, fields) for mid, (_c, fields) in self.pending.items()][:count]
        else:
            batch = self.entries[self.delivered : self.delivered + count]
            self.delivered += len(batch)
            for mid, fields in batch:
                self.pending[mid] = (consumername, fields)
        return [[stream, batch]] if batch else []

    def xack(self, name, groupname, *ids):
        for mid in ids:
            self.pending.pop(mid, None)
            self.acks.append(mid)
        return len(ids)

    def exists(self, *names):
        if self.down:
            raise RedisConnectionError("redis caído")
        return sum(name in self.keys for name in names)


class FakeEventStore:
    """Almacén de eventos en memoria con la misma interfaz que `db.EventStore`."""

    def __init__(self, fail_times=0, invalid_ids=()):
        self.events = {}
        self.fail_times = fail_times
        self.invalid_ids = set(invalid_ids)
        self.saves = 0
        self.batches = []
        self.purges = 0
        self.grace_closes = []
        self.dau_refreshes = []

    def save(self, event):
        return self.save_many([event]) == 1

    def save_many(self, events):
        """Todo o nada, como la transacción real: si un evento falla no se guarda ninguno."""
        from analytics.sanitize import InvalidEvent

        events = list(events)
        self.saves += 1
        self.batches.append([event["event_id"] for event in events])
        if self.fail_times:
            self.fail_times -= 1
            raise RuntimeError("postgres caído")
        if any(event["event_id"] in self.invalid_ids for event in events):
            raise InvalidEvent("dato inválido para la BD")
        return sum(self.stored(event) for event in events)

    def stored(self, event):
        if event["event_id"] in self.events:
            return False
        self.events[event["event_id"]] = event
        return True

    def purge_expired(self):
        self.purges += 1
        return 0

    def close_idle_rooms(self, grace):
        self.grace_closes.append(grace)
        return 0

    def refresh_daily_active_users(self, timezone, days):
        self.dau_refreshes.append((timezone, days))
        return days


class FakeReadRepository:
    def __init__(self, kpis=None, events=None, fail=False, overview=None):
        self.overview = overview
        self.kpis = dict(kpis or {})
        self.events = dict(events or {})
        self.fail = fail
        self.calls = []

    def room_kpis(self, room_id):
        self.calls.append(("room_kpis", room_id))
        if self.fail:
            raise RuntimeError("postgres caído")
        return self.kpis.get(room_id)

    def business_overview(self, days, rooms):
        self.calls.append(("business_overview", days, rooms))
        if self.fail:
            raise RuntimeError("postgres caído")
        return self.overview

    def room_events(self, room_id, types):
        self.calls.append(("room_events", room_id, tuple(types)))
        if self.fail:
            raise RuntimeError("postgres caído")
        return [e for e in self.events.get(room_id, []) if e.get("type") in types]
