"""Dobles de prueba compartidos: nunca se ejecutan FFmpeg, S3 ni PostgreSQL reales."""

import io
import json
import threading
from types import SimpleNamespace
from unittest.mock import Mock

from redis.exceptions import ResponseError

from media_worker.repository import VideoRow


def fake_run(returncode=0, stdout="", stderr=""):
    return Mock(return_value=SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr))


def solid_frame(rgb, width=160, height=90):
    return bytes(rgb) * (width * height)


class Pipe(io.BytesIO):
    """Pipe en memoria que recuerda cuántos bytes quedaban sin leer al cerrarse."""

    unread = None

    def close(self):
        if not self.closed:
            self.unread = len(self.getbuffer()) - self.tell()
        super().close()


class FakeProcess:
    def __init__(self, stdout=b"", stderr=b"", returncode=0):
        self.stdout = stdout if hasattr(stdout, "read") else Pipe(stdout)
        self.stderr = Pipe(stderr)
        self.returncode = returncode
        self.killed = threading.Event()

    def wait(self):
        return self.returncode

    def kill(self):
        self.killed.set()


class FakePopen:
    def __init__(self, **process_kwargs):
        self.process = FakeProcess(**process_kwargs)
        self.calls = []

    def __call__(self, cmd, **kwargs):
        self.calls.append((cmd, kwargs))
        return self.process


class FakeRepository:
    def __init__(self, video_ids, uploaders=None):
        self.video_ids = set(video_ids)
        self.uploaders = dict(uploaders or {})
        self.statuses = {}
        self.durations = {}
        self.storage_keys = {}
        self.renditions = {}
        self.reasons = {}
        self.history = []

    def get_video(self, video_id):
        if video_id not in self.video_ids:
            return None
        return VideoRow(
            self.statuses.get(video_id, "processing"),
            self.storage_keys.get(video_id, f"incoming/{video_id}/original.mp4"),
            self.uploaders.get(video_id),
        )

    def start_processing(self, video_id):
        if video_id not in self.video_ids:
            return False
        self.reasons.pop(video_id, None)
        self._set(video_id, "processing")
        return True

    def mark_ready(self, video_id, duration_ms, storage_key, renditions=()):
        self.durations[video_id] = duration_ms
        self.storage_keys[video_id] = storage_key
        self.renditions[video_id] = list(renditions)
        self.reasons.pop(video_id, None)
        self._set(video_id, "ready")

    def mark_failed(self, video_id, reason):
        self.reasons[video_id] = reason
        self._set(video_id, "failed")

    def _set(self, video_id, status):
        self.statuses[video_id] = status
        self.history.append((video_id, status))


class FakeBlobStore:
    def __init__(self, objects=None):
        self.objects = dict(objects or {})
        self.puts = []

    def upload_file(self, path, key):
        self.objects[key] = path.read_bytes()
        self.puts.append(key)

    def put_json(self, key, data):
        self.objects[key] = json.dumps(data, separators=(",", ":"))
        self.puts.append(key)


class FakeRedis:
    """Subconjunto de Redis Streams: varios streams y un grupo de consumidores por stream."""

    def __init__(self):
        self.groups = set()
        self.streams = {}
        self.delivered = {}
        self.pending = {}
        self.acks = []
        self.xadd_calls = []

    def xgroup_create(self, name, groupname, id="$", mkstream=False):
        if (name, groupname) in self.groups:
            raise ResponseError("BUSYGROUP Consumer Group name already exists")
        self.groups.add((name, groupname))

    def xadd(self, name, fields, maxlen=None, approximate=True):
        entries = self.streams.setdefault(name, [])
        message_id = f"{len(entries) + 1}-0"
        entries.append((message_id, fields))
        self.xadd_calls.append((name, maxlen, approximate))
        return message_id

    def entries(self, name):
        return [fields for _mid, fields in self.streams.get(name, [])]

    def xreadgroup(self, groupname, consumername, streams, count=None, block=None):
        ((stream, last_id),) = streams.items()
        if last_id == "0":
            batch = [
                (mid, fields) for (s, mid), (_c, fields) in self.pending.items() if s == stream
            ]
            batch = batch[:count]
        else:
            start = self.delivered.get(stream, 0)
            batch = self.streams.get(stream, [])[start : start + count]
            self.delivered[stream] = start + len(batch)
            for mid, fields in batch:
                self.pending[(stream, mid)] = (consumername, fields)
        return [[stream, batch]] if batch else []

    def xack(self, name, groupname, *ids):
        for mid in ids:
            self.pending.pop((name, mid), None)
            self.acks.append(mid)
        return len(ids)
