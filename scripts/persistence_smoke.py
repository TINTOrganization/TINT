#!/usr/bin/env python3
"""Smoke de volúmenes persistentes, respaldo y restauración (DAT-06).

Corre en un proyecto de Compose aislado (sin puertos publicados ni container_name fijos), así que
no toca el stack ni los datos de quien lo ejecuta. Solo levanta los almacenes:

- AC1: escribe una marca en PostgreSQL, MongoDB, Redis y MinIO, recrea los contenedores
  (--force-recreate) y comprueba que las marcas siguen.
- AC3: respalda con scripts/data_backup.py, borra las marcas, restaura y comprueba que vuelven.
- AC2: borra los volúmenes (down -v), vuelve a arrancar y comprueba que no queda ninguna marca.

Uso:
    python scripts/persistence_smoke.py           # se limpia al terminar
    python scripts/persistence_smoke.py --keep    # deja el proyecto para inspeccionarlo
"""

from __future__ import annotations

import argparse
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STORES = ("postgres", "redis", "mongodb", "minio")
ISOLATED = ("env-check", "minio-init", "mongo-init") + STORES
MARK = "dat06"

PG = 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc'
MONGO = 'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval'
MC = 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null &&'


def override() -> str:
    lines = ["services:"]
    for service in ISOLATED:
        lines += [f"  {service}:", "    container_name: !reset null"]
        if service in STORES:
            lines.append("    ports: !reset []")
    return "\n".join(lines) + "\n"


def run(cmd: list[str], env: dict[str, str], check: bool = True) -> str:
    result = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:4])}… falló:\n{result.stderr.strip()}")
    return result.stdout.strip()


class Stores:
    """Escribe, borra y lee una marca en cada almacén del proyecto aislado."""

    def __init__(self, env: dict[str, str]):
        self.env = env

    def sh(self, service: str, script: str) -> str:
        return run(["docker", "compose", "exec", "-T", service, "sh", "-c", script], self.env)

    def mc(self, script: str) -> str:
        return run(["docker", "compose", "run", "--rm", "--no-deps", "-e", "MC_CONFIG_DIR=/tmp/.mc",
                    "--entrypoint", "sh", "minio-init", "-ec", f"{MC} {script}"], self.env)

    def write(self) -> None:
        self.sh("postgres", f"{PG} \"CREATE TABLE IF NOT EXISTS {MARK}_probe (v text); INSERT INTO {MARK}_probe VALUES ('{MARK}')\"")
        self.sh("mongodb", f"{MONGO} 'db.getSiblingDB(\"{MARK}\").probe.insertOne({{v: \"{MARK}\"}})'")
        self.sh("redis", f"redis-cli SET {MARK}:probe {MARK}")
        self.mc(f'echo {MARK} | mc pipe "local/$MINIO_BUCKET/{MARK}/probe.txt"')

    def delete(self) -> None:
        self.sh("postgres", f"{PG} 'DROP TABLE IF EXISTS {MARK}_probe'")
        self.sh("mongodb", f"{MONGO} 'db.getSiblingDB(\"{MARK}\").dropDatabase()'")
        self.sh("redis", f"redis-cli DEL {MARK}:probe")
        self.mc(f'mc rm --force "local/$MINIO_BUCKET/{MARK}/probe.txt"')

    def read(self) -> dict[str, bool]:
        return {
            "postgres": self.sh("postgres", f"{PG} \"SELECT count(*) FROM pg_tables WHERE tablename = '{MARK}_probe'\"") == "1"
            and self.sh("postgres", f"{PG} 'SELECT v FROM {MARK}_probe'") == MARK,
            "mongodb": self.sh("mongodb", f"{MONGO} 'db.getSiblingDB(\"{MARK}\").probe.countDocuments({{v: \"{MARK}\"}})'") == "1",
            "redis": self.sh("redis", f"redis-cli GET {MARK}:probe") == MARK,
            "minio": self.mc(f'mc cat "local/$MINIO_BUCKET/{MARK}/probe.txt" 2>/dev/null || true') == MARK,
        }


def expect(label: str, got: dict[str, bool], present: bool) -> bool:
    ok = all(v == present for v in got.values())
    state = "presentes" if present else "ausentes"
    detail = ", ".join(f"{k}={'sí' if v else 'no'}" for k, v in got.items())
    print(f"  {'✓' if ok else '✗'} {label}: marcas {state} ({detail})")
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--keep", action="store_true", help="no borrar el proyecto aislado al terminar")
    args = parser.parse_args()

    project = f"tint-dat06-{secrets.token_hex(3)}"
    workdir = Path(tempfile.mkdtemp(prefix="tint-dat06-"))
    (workdir / "isolated.yml").write_text(override(), encoding="utf-8")
    env = dict(os.environ, COMPOSE_PROJECT_NAME=project,
               COMPOSE_FILE=os.pathsep.join([str(ROOT / "docker-compose.yml"), str(workdir / "isolated.yml")]))
    up = ["docker", "compose", "up", "-d", "--wait", *STORES]
    stores = Stores(env)
    results = []
    print(f"Proyecto aislado: {project}")
    try:
        run(up, env)
        run(["docker", "compose", "run", "--rm", "minio-init"], env)  # crea el bucket
        stores.write()
        results.append(expect("escritas", stores.read(), True))

        run([*up, "--force-recreate"], env)
        results.append(expect("AC1 tras recrear los contenedores", stores.read(), True))

        backup_dir = workdir / "backup"
        run([sys.executable, str(ROOT / "scripts" / "data_backup.py"), "backup", str(backup_dir)], env)
        stores.delete()
        results.append(expect("borradas tras el respaldo", stores.read(), False))
        run([sys.executable, str(ROOT / "scripts" / "data_backup.py"), "restore", str(backup_dir)], env)
        results.append(expect("AC3 tras restaurar el respaldo", stores.read(), True))

        run(["docker", "compose", "down", "-v"], env)
        run(up, env)
        run(["docker", "compose", "run", "--rm", "minio-init"], env)
        results.append(expect("AC2 tras borrar los volúmenes", stores.read(), False))
    except RuntimeError as exc:
        print(f"  ✗ {exc}")
        results.append(False)
    finally:
        if args.keep:
            print(f"Proyecto conservado: COMPOSE_PROJECT_NAME={project} COMPOSE_FILE={env['COMPOSE_FILE']}")
        else:
            run(["docker", "compose", "down", "-v", "--remove-orphans"], env, check=False)
            shutil.rmtree(workdir, ignore_errors=True)
    ok = all(results)
    print("DAT-06 OK" if ok else "DAT-06 FALLÓ")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
