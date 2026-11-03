#!/usr/bin/env python3
"""Respaldo y restauración de los almacenes de datos de TINT (DAT-06).

    python scripts/data_backup.py backup [carpeta]     # por defecto backups/<fecha-hora>
    python scripts/data_backup.py restore <carpeta>

Usa `docker compose` (exec y run), así que no depende de los nombres de los volúmenes ni de
tener herramientas instaladas en el equipo. Respeta COMPOSE_PROJECT_NAME y COMPOSE_FILE.

| Almacén    | Respaldo                                         | Restauración                               |
| PostgreSQL | pg_dump -Fc de POSTGRES_DB (identity-api, analytics) | pg_restore --clean --if-exists          |
| MongoDB    | mongodump --archive --gzip                       | mongorestore --drop (sin admin ni config)  |
| Redis      | redis-cli --rdb                                  | carga el RDB con AOF apagado y lo reescribe |
| MinIO      | mc mirror del bucket                             | mc mirror --remove hacia el bucket         |

Restaurar detiene antes los servicios que usan los almacenes y los vuelve a arrancar al final.
Los certificados del gateway no se respaldan: Caddy los regenera.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_SERVICES = ("postgres", "redis", "mongodb", "minio")
# Servicios de una sola ejecución o de infraestructura que no escriben en los almacenes.
NOT_APPS = set(DATA_SERVICES) | {"env-check", "minio-init", "mongo-init", "coturn", "gateway", "web"}
FILES = {"postgres": "postgres.dump", "mongodb": "mongo.archive.gz", "redis": "redis.rdb", "minio": "minio"}

PG_DUMP = 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc'
PG_RESTORE = 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --single-transaction'
MONGO_AUTH = '-u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'
MONGO_DUMP = f'mongodump --quiet --archive --gzip {MONGO_AUTH}'
# admin (usuarios, que recrea mongo-init) y config no se restauran: --drop los pisaría.
MONGO_RESTORE = f'mongorestore --quiet --archive --gzip --drop {MONGO_AUTH} --nsExclude "admin.*" --nsExclude "config.*"'
MC_ALIAS = 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null'
REDIS_RDB_TMP = "/tmp/tint-backup.rdb"
# Con AOF activo y sin archivos AOF, Redis arranca vacío e ignora dump.rdb: se carga el RDB con
# AOF apagado, se activa AOF para que lo reescriba desde memoria y se apaga limpio.
REDIS_LOAD = f"""
rm -rf /data/appendonlydir /data/dump.rdb
cp /restore/{FILES['redis']} /data/dump.rdb
redis-server --appendonly no --dir /data --daemonize yes --save ""
until redis-cli ping >/dev/null 2>&1; do sleep 0.2; done
redis-cli CONFIG SET appendonly yes >/dev/null
while redis-cli INFO persistence | grep -qE "aof_rewrite_in_progress:1|aof_rewrite_scheduled:1|aof_enabled:0"; do sleep 0.2; done
redis-cli SHUTDOWN >/dev/null 2>&1 || true
rm -f /data/dump.rdb
"""


def compose(*args: str, stdin: bytes | None = None, capture: bool = False) -> bytes:
    """Ejecuta docker compose desde la raíz del repo; falla con el error de compose."""
    result = subprocess.run(
        ["docker", "compose", *args], cwd=ROOT, input=stdin,
        stdout=subprocess.PIPE if capture else None, stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        raise RuntimeError(f"docker compose {' '.join(args[:3])}… falló: {result.stderr.decode(errors='replace').strip()}")
    return result.stdout or b""


def user_flags() -> list[str]:
    """En Linux/macOS los archivos de MinIO quedan a nombre de quien respalda, no de root."""
    if hasattr(os, "getuid"):
        return ["--user", f"{os.getuid()}:{os.getgid()}"]
    return []


def mc(mount: Path, script: str) -> None:
    compose("run", "--rm", "--no-deps", *user_flags(), "-e", "MC_CONFIG_DIR=/tmp/.mc",
            "-v", f"{mount.resolve()}:/backup", "--entrypoint", "sh", "minio-init", "-ec", f"{MC_ALIAS} && {script}")


def app_services(running: list[str]) -> list[str]:
    """Servicios en marcha que escriben en los almacenes (se detienen durante la restauración)."""
    return [s for s in running if s not in NOT_APPS]


def default_destination(now: dt.datetime) -> Path:
    return ROOT / "backups" / now.strftime("%Y%m%d-%H%M%S")


def backup(dest: Path) -> Path:
    dest.mkdir(parents=True, exist_ok=False)
    print(f"Respaldando en {dest}")
    (dest / FILES["postgres"]).write_bytes(compose("exec", "-T", "postgres", "sh", "-c", PG_DUMP, capture=True))
    print("  ✓ PostgreSQL")
    (dest / FILES["mongodb"]).write_bytes(compose("exec", "-T", "mongodb", "sh", "-c", MONGO_DUMP, capture=True))
    print("  ✓ MongoDB")
    compose("exec", "-T", "redis", "redis-cli", "--rdb", REDIS_RDB_TMP, capture=True)
    compose("cp", f"redis:{REDIS_RDB_TMP}", str(dest / FILES["redis"]))
    compose("exec", "-T", "redis", "rm", "-f", REDIS_RDB_TMP)
    print("  ✓ Redis")
    (dest / FILES["minio"]).mkdir()
    mc(dest, 'mc mirror --quiet --overwrite "local/$MINIO_BUCKET" /backup/minio')
    print("  ✓ MinIO")
    manifest = {
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "project": os.environ.get("COMPOSE_PROJECT_NAME", ROOT.name.lower()),
        "files": FILES,
    }
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Respaldo listo: {dest}")
    return dest


def restore(src: Path) -> None:
    missing = [name for name in FILES.values() if not (src / name).exists()]
    if missing:
        raise RuntimeError(f"{src} no es un respaldo completo; falta: {', '.join(missing)}")
    running = compose("ps", "--services", "--status", "running", capture=True).decode().split()
    apps = app_services(running)
    if apps:
        print(f"Deteniendo durante la restauración: {', '.join(apps)}")
        compose("stop", *apps)
    try:
        print(f"Restaurando desde {src}")
        compose("exec", "-T", "postgres", "sh", "-c", PG_RESTORE, stdin=(src / FILES["postgres"]).read_bytes())
        print("  ✓ PostgreSQL")
        compose("exec", "-T", "mongodb", "sh", "-c", MONGO_RESTORE, stdin=(src / FILES["mongodb"]).read_bytes())
        print("  ✓ MongoDB")
        compose("stop", "redis")
        compose("run", "--rm", "--no-deps", "-v", f"{src.resolve()}:/restore:ro", "--entrypoint", "sh", "redis", "-ec", REDIS_LOAD)
        compose("up", "-d", "--wait", "redis")
        print("  ✓ Redis")
        mc(src, 'mc mirror --quiet --overwrite --remove /backup/minio "local/$MINIO_BUCKET"')
        print("  ✓ MinIO")
    finally:
        if apps:
            compose("start", *apps)
            print(f"Servicios reanudados: {', '.join(apps)}")
    print("Restauración lista.")


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not args or args[0] not in ("backup", "restore") or (args[0] == "restore" and len(args) < 2):
        print(__doc__.split("\n\n")[1])
        return 2
    try:
        if args[0] == "backup":
            backup(Path(args[1]) if len(args) > 1 else default_destination(dt.datetime.now()))
        else:
            restore(Path(args[1]))
    except (RuntimeError, FileExistsError) as exc:
        print(f"data_backup: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
