#!/usr/bin/env python3
"""Smoke test de observabilidad (OPS-04 #89, ADR 0021).

Verifica los tres criterios de aceptación de OPS-04:
- AC1: dado un contenedor en ejecución, al llamar a su endpoint de salud, reporta estado.
- AC2: dado un contenedor no saludable, Compose lo muestra como unhealthy.
- AC3: al ejecutar `docker compose logs`, aparecen los logs de cada servicio con esquema uniforme.

Uso:
    python scripts/observability_smoke.py
    python scripts/observability_smoke.py --services "web,sync-core,analytics"
    python scripts/observability_smoke.py --skip-up --skip-ac2 --keep
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parents[1]

# Mapeo de servicio -> nombre de contenedor, comando de sonda y servicio esperado en el body.
HEALTHZ_PROBES: dict[str, dict[str, str | list[str]]] = {
    "gateway": {
        "container": "tint-gateway",
        "cmd": ["wget", "-qO-", "--no-check-certificate", "https://localhost/healthz"],
        "service": "gateway",
    },
    "web": {
        "container": "tint-web",
        "cmd": ["wget", "-qO-", "http://127.0.0.1:5173/healthz"],
        "service": "web",
    },
    "identity-api": {
        "container": "tint-identity-api",
        "cmd": [
            "node",
            "-e",
            "fetch('http://localhost:8081/healthz').then(r=>r.text()).then(t=>process.stdout.write(t))",
        ],
        "service": "identity-api",
    },
    "sync-core": {
        "container": "tint-sync-core",
        "cmd": ["wget", "-qO-", "http://localhost:8080/healthz"],
        "service": "sync-core",
    },
    "social-core": {
        "container": "tint-social-core",
        "cmd": ["wget", "-qO-", "http://localhost:8082/healthz"],
        "service": "social-core",
    },
    "analytics": {
        "container": "tint-analytics",
        "cmd": [
            "python",
            "-c",
            "import os, urllib.request; print(urllib.request.urlopen(f'http://localhost:{os.environ.get(\"ANALYTICS_PORT\",\"8084\")}/healthz').read().decode())",
        ],
        "service": "analytics",
    },
    "media-worker": {
        "container": "tint-media-worker",
        "cmd": [
            "python",
            "-c",
            "import os, urllib.request; print(urllib.request.urlopen(f'http://localhost:{os.environ.get(\"MEDIA_WORKER_PORT\",\"8088\")}/healthz').read().decode())",
        ],
        "service": "media-worker",
    },
    "voice-core": {
        "container": "tint-voice-core",
        "cmd": ["curl", "-fs", "http://localhost:8085/healthz"],
        "service": "voice-core",
    },
    "stream-core": {
        "container": "tint-stream-core",
        "cmd": ["curl", "-fs", "http://localhost:8086/healthz"],
        "service": "stream-core",
    },
}

DATASTORES = {
    "postgres": "tint-postgres",
    "redis": "tint-redis",
    "minio": "tint-minio",
    "mongodb": "tint-mongodb",
}

APP_SERVICES = {
    "identity-api",
    "sync-core",
    "social-core",
    "analytics",
    "media-worker",
    "voice-core",
    "stream-core",
}

REQUIRED_LOG_FIELDS = {"timestamp", "level", "service", "message"}


def run_cmd(
    cmd: list[str],
    *,
    cwd: Path = ROOT,
    check: bool = True,
    capture: bool = True,
    timeout: float | None = None,
) -> subprocess.CompletedProcess[str]:
    print(f"==> {' '.join(cmd)}")
    return subprocess.run(
        cmd,
        cwd=cwd,
        check=check,
        capture_output=capture,
        text=True,
        timeout=timeout,
    )


def docker_inspect_health(container: str) -> str:
    res = run_cmd(
        ["docker", "inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", container],
        check=False,
    )
    if res.returncode != 0:
        return "missing"
    return res.stdout.strip()


def wait_for_health(container: str, expected: str = "healthy", timeout_s: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        status = docker_inspect_health(container)
        if status == expected:
            return True
        time.sleep(1.0)
    return False


def ensure_env_file() -> None:
    env_file = ROOT / ".env"
    if not env_file.exists():
        example = ROOT / ".env.example"
        if example.exists():
            print("==> Copiando .env.example a .env para el smoke test")
            shutil.copyfile(example, env_file)


def verify_ac1_healthz(target_services: set[str]) -> list[str]:
    """AC1: verifica que cada servicio reporte status: ok y su nombre de servicio."""
    errors: list[str] = []
    print("\n--- Verificando AC1: Sondas de salud (/healthz) ---")

    for svc in sorted(target_services):
        if svc in DATASTORES:
            container = DATASTORES[svc]
            status = docker_inspect_health(container)
            if status != "healthy":
                errors.append(f"Datastore {svc} ({container}) no está healthy (estado: {status})")
            else:
                print(f"  [OK] {svc}: healthy según docker inspect")
            continue

        if svc == "coturn":
            if platform.system() != "Linux":
                print("  [SKIP] coturn: probe omitido en entornos no-Linux (network_mode: host)")
                continue
            container = "tint-coturn"
            status = docker_inspect_health(container)
            if status != "healthy":
                errors.append(f"coturn ({container}) no está healthy (estado: {status})")
            else:
                print("  [OK] coturn: healthy")
            continue

        probe_info = HEALTHZ_PROBES.get(svc)
        if not probe_info:
            continue

        container = str(probe_info["container"])
        status = docker_inspect_health(container)
        if status != "healthy":
            errors.append(f"{svc} ({container}) no está healthy según docker inspect (estado: {status})")

        cmd = ["docker", "exec", container] + list(probe_info["cmd"])
        res = run_cmd(cmd, check=False)
        if res.returncode != 0:
            errors.append(f"{svc}: llamada a /healthz falló con código {res.returncode}: {res.stderr.strip()}")
            continue

        raw = res.stdout.strip()
        try:
            body = json.loads(raw)
        except json.JSONDecodeError as exc:
            errors.append(f"{svc}: /healthz no devolvió JSON válido: {raw!r} ({exc})")
            continue

        expected_service = probe_info["service"]
        if body.get("status") != "ok":
            errors.append(f"{svc}: status esperado 'ok', recibido: {body.get('status')!r}")
        if body.get("service") != expected_service:
            errors.append(
                f"{svc}: servicio esperado '{expected_service}', recibido: {body.get('service')!r}"
            )

        print(f"  [OK] {svc}: {body}")

    return errors


def verify_ac2_unhealthy() -> list[str]:
    """AC2: contenedor no saludable aparece como unhealthy en Compose."""
    errors: list[str] = []
    print("\n--- Verificando AC2: Contenedor no saludable detectado por Compose ---")

    override_content = """services:
  web:
    healthcheck:
      test: ["CMD", "false"]
      interval: 1s
      timeout: 1s
      retries: 1
"""
    override_path = ROOT / "docker-compose.unhealthy-test.yml"
    try:
        override_path.write_text(override_content, encoding="utf-8")
        print("==> Aplicando override temporal para inducir fallo de salud en 'web'")
        run_cmd(["docker", "compose", "-f", "docker-compose.yml", "-f", str(override_path), "up", "-d", "web"])

        print("==> Esperando estado 'unhealthy' en tint-web (hasta 30 s)...")
        if not wait_for_health("tint-web", "unhealthy", timeout_s=30.0):
            status = docker_inspect_health("tint-web")
            errors.append(f"AC2: tint-web no alcanzó estado unhealthy (estado actual: {status})")
        else:
            print("  [OK] Compose reportó tint-web como 'unhealthy'")
    finally:
        if override_path.exists():
            override_path.unlink()
        print("==> Restaurando salud normal de 'web'")
        run_cmd(["docker", "compose", "up", "-d", "--force-recreate", "web"])
        if not wait_for_health("tint-web", "healthy", timeout_s=45.0):
            errors.append("AC2: tint-web no se recuperó a estado healthy tras retirar el override")
        else:
            print("  [OK] tint-web restaurado y healthy")

    return errors


def verify_ac3_logs(target_services: set[str]) -> list[str]:
    """AC3: cada servicio de aplicación emite logs JSON con formato uniforme."""
    errors: list[str] = []
    print("\n--- Verificando AC3: Logs JSON uniformes en stdout ---")

    for svc in sorted(target_services):
        if svc not in APP_SERVICES:
            continue

        res = run_cmd(["docker", "compose", "logs", "--no-color", svc], check=False)
        if res.returncode != 0:
            errors.append(f"AC3: no se pudieron obtener logs de {svc}: {res.stderr.strip()}")
            continue

        lines = res.stdout.splitlines() + res.stderr.splitlines()
        found_valid_json = False
        sample_log = None

        for line in lines:
            line = line.strip()
            # docker compose logs puede prefijar con "service_name-1  | "
            if " | " in line:
                line = line.split(" | ", 1)[1].strip()
            if not (line.startswith("{") and line.endswith("}")):
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue

            if isinstance(data, dict) and REQUIRED_LOG_FIELDS.issubset(data.keys()):
                if data.get("service") == svc:
                    found_valid_json = True
                    sample_log = data
                    break

        if not found_valid_json:
            errors.append(
                f"AC3: {svc} no tiene ningún log JSON que contenga los campos "
                f"{REQUIRED_LOG_FIELDS} con service='{svc}'"
            )
        else:
            print(f"  [OK] {svc}: log JSON válido encontrado -> level={sample_log.get('level')} msg={sample_log.get('message')!r}")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test de observabilidad (OPS-04)")
    parser.add_argument(
        "--services",
        help="Lista de servicios separados por coma a verificar (por defecto todos los de larga duración)",
    )
    parser.add_argument(
        "--skip-up",
        action="store_true",
        help="No levantar los contenedores antes de probar (asume que ya están corriendo)",
    )
    parser.add_argument(
        "--skip-ac2",
        action="store_true",
        help="Omitir la prueba de degradación a unhealthy (AC2)",
    )
    parser.add_argument(
        "--keep",
        action="store_true",
        help="No destruir los contenedores (docker compose down) al terminar",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=300,
        help="Tiempo máximo de espera para docker compose up --wait (segundos)",
    )
    args = parser.parse_args()

    ensure_env_file()

    if args.services:
        target_services = {s.strip() for s in args.services.split(",") if s.strip()}
    else:
        target_services = set(HEALTHZ_PROBES.keys()) | set(DATASTORES.keys())
        if platform.system() == "Linux":
            target_services.add("coturn")

    all_errors: list[str] = []
    compose_started = False

    try:
        if not args.skip_up:
            up_cmd = ["docker", "compose", "up", "-d", "--build", "--wait", f"--wait-timeout={args.timeout}"]
            if args.services:
                up_cmd.extend(sorted(target_services))
            print(f"==> Levantando servicios con espera de salud (timeout {args.timeout}s)...")
            res = run_cmd(up_cmd, check=False)
            if res.returncode != 0:
                print(f"ERROR: Falló 'docker compose up':\n{res.stderr}", file=sys.stderr)
                return 1
            compose_started = True

        # AC1: endpoints de salud
        all_errors.extend(verify_ac1_healthz(target_services))

        # AC2: detección de unhealthy
        if not args.skip_ac2 and "web" in target_services:
            all_errors.extend(verify_ac2_unhealthy())

        # AC3: logs JSON uniformes
        all_errors.extend(verify_ac3_logs(target_services))

    finally:
        if compose_started and not args.keep:
            print("\n==> Limpiando stack de prueba (docker compose down -v)...")
            run_cmd(["docker", "compose", "down", "-v"], check=False)

    if all_errors:
        print("\n❌ FALLOS ENCONTRADOS:", file=sys.stderr)
        for err in all_errors:
            print(f"  - {err}", file=sys.stderr)
        return 1

    print("\n✅ Todos los criterios de observabilidad (AC1, AC2, AC3) superados exitosamente.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
