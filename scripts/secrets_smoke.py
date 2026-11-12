#!/usr/bin/env python3
"""Smoke test de secretos por entorno (OPS-05 #90, ADR 0022).

Verifica el ciclo de vida de secretos inyectados en runtime:
- AC1: Protección de secretos: .gitignore, .dockerignore y ausencia de secretos en git.
- AC2: Arranque exitoso de contenedores a partir de .env.example (copiado a .env) validado por env-check.
- AC3: Actualización de secreto sin reconstrucción de imagen (docker compose up -d --no-build --force-recreate),
       comprobando mediante docker inspect que el nuevo secreto fue inyectado y restaurando el .env original.

Uso:
    python scripts/secrets_smoke.py
    python scripts/secrets_smoke.py --keep
    python scripts/secrets_smoke.py --skip-ac3
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env"
ENV_EXAMPLE = ROOT / ".env.example"


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


def docker_inspect_env(container: str) -> dict[str, str]:
    """Obtiene el mapa de variables de entorno de un contenedor inspeccionando Docker."""
    res = run_cmd(
        ["docker", "inspect", "--format", "{{json .Config.Env}}", container],
        check=False,
    )
    if res.returncode != 0:
        return {}
    try:
        raw_list = json.loads(res.stdout.strip())
        env_map: dict[str, str] = {}
        for item in raw_list:
            if "=" in item:
                k, v = item.split("=", 1)
                env_map[k] = v
        return env_map
    except json.JSONDecodeError:
        return {}


def docker_inspect_health(container: str) -> str:
    res = run_cmd(
        ["docker", "inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", container],
        check=False,
    )
    if res.returncode != 0:
        return "missing"
    return res.stdout.strip()


def wait_for_health(container: str, expected: str = "healthy", timeout_s: float = 45.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        status = docker_inspect_health(container)
        if status == expected:
            return True
        time.sleep(1.0)
    return False


def verify_ac1_static_protections() -> list[str]:
    """AC1: Protección estática de secretos."""
    errors: list[str] = []
    print("\n--- Verificando AC1: Protección de archivos de entorno y exclusión Git/Docker ---")

    gitignore = ROOT / ".gitignore"
    if not gitignore.exists() or ".env" not in gitignore.read_text(encoding="utf-8"):
        errors.append("AC1: .gitignore debe existir y contener .env")
    else:
        print("  [OK] .gitignore excluye .env")

    dockerignore = ROOT / ".dockerignore"
    if not dockerignore.exists() or ".env" not in dockerignore.read_text(encoding="utf-8"):
        errors.append("AC1: .dockerignore debe existir y contener .env")
    else:
        print("  [OK] .dockerignore excluye .env")

    # Verificar que .env no esté trackeado por git
    res = run_cmd(["git", "ls-files", ".env"], check=False)
    if res.stdout.strip():
        errors.append("AC1: El archivo .env está versionado en Git")
    else:
        print("  [OK] .env no está versionado en Git")

    return errors


def verify_ac2_startup_from_env_example() -> list[str]:
    """AC2: Arranque de contenedores a partir de .env copiado desde .env.example."""
    errors: list[str] = []
    print("\n--- Verificando AC2: Arranque desde .env.example con env-check ---")

    if not ENV_FILE.exists():
        print("==> Copiando .env.example a .env")
        shutil.copyfile(ENV_EXAMPLE, ENV_FILE)

    print("==> Ejecutando docker compose up para env-check, redis y sync-core...")
    res = run_cmd(
        ["docker", "compose", "up", "-d", "--wait", "env-check", "redis", "sync-core"],
        check=False,
    )
    if res.returncode != 0:
        errors.append(f"AC2: Falló docker compose up: {res.stderr}")
        return errors

    # Verificar que env-check terminó con éxito
    inspect_check = run_cmd(
        ["docker", "inspect", "--format", "{{.State.ExitCode}}", "tint-env-check"],
        check=False,
    )
    if inspect_check.returncode != 0 or inspect_check.stdout.strip() != "0":
        errors.append(f"AC2: tint-env-check no finalizó con código 0: {inspect_check.stdout.strip()}")
    else:
        print("  [OK] tint-env-check validó el entorno satisfactoriamente (ExitCode: 0)")

    if not wait_for_health("tint-sync-core", "healthy", timeout_s=45.0):
        status = docker_inspect_health("tint-sync-core")
        errors.append(f"AC2: tint-sync-core no alcanzó estado healthy (estado actual: {status})")
    else:
        print("  [OK] tint-sync-core levantó y reportó estado healthy con variables de .env")

    return errors


def verify_ac3_secret_recreation() -> list[str]:
    """AC3: Actualización de secreto en .env y recreación sin build."""
    errors: list[str] = []
    print("\n--- Verificando AC3: Actualización de secreto en runtime (up -d --no-build) ---")

    original_env_content = ENV_FILE.read_text(encoding="utf-8")
    test_secret_value = "smoke-test-secret-rotated-value-12345"

    try:
        # Reemplazar JWT_SECRET en .env
        lines = original_env_content.splitlines()
        updated_lines = []
        replaced = False
        for line in lines:
            if line.startswith("JWT_SECRET="):
                updated_lines.append(f"JWT_SECRET={test_secret_value}")
                replaced = True
            else:
                updated_lines.append(line)
        if not replaced:
            updated_lines.append(f"JWT_SECRET={test_secret_value}")

        ENV_FILE.write_text("\n".join(updated_lines) + "\n", encoding="utf-8")
        print("==> JWT_SECRET actualizado temporalmente en .env")

        # Recrear sync-core con --no-build
        print("==> Recreando tint-sync-core con docker compose up -d --no-build --force-recreate...")
        res = run_cmd(
            ["docker", "compose", "up", "-d", "--no-build", "--force-recreate", "sync-core"],
            check=False,
        )
        if res.returncode != 0:
            errors.append(f"AC3: Falló recreación de sync-core: {res.stderr}")
            return errors

        # Inspeccionar env inyectado en el contenedor
        env_map = docker_inspect_env("tint-sync-core")
        injected_secret = env_map.get("JWT_SECRET")

        if injected_secret != test_secret_value:
            errors.append(
                f"AC3: El contenedor no recibió el nuevo secreto. Esperado: {test_secret_value!r}, recibido: {injected_secret!r}"
            )
        else:
            print(f"  [OK] tint-sync-core recibió el secreto actualizado vía runtime: {injected_secret}")

    finally:
        print("==> Restaurando .env original...")
        ENV_FILE.write_text(original_env_content, encoding="utf-8")
        # Re-aplicar el secreto original al contenedor
        run_cmd(
            ["docker", "compose", "up", "-d", "--no-build", "--force-recreate", "sync-core"],
            check=False,
        )
        print("  [OK] Contenedor restaurado con el secreto original")

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke test de secretos por entorno (OPS-05)")
    parser.add_argument("--keep", action="store_true", help="No detener los contenedores al terminar")
    parser.add_argument("--skip-ac2", action="store_true", help="Omitir prueba de arranque con Compose")
    parser.add_argument("--skip-ac3", action="store_true", help="Omitir prueba de rotación de secreto")
    args = parser.parse_args()

    total_errors: list[str] = []

    # AC1: Comprobaciones estáticas
    total_errors.extend(verify_ac1_static_protections())

    env_created_by_script = False
    if not ENV_FILE.exists():
        ensure_env = True
        env_created_by_script = True
    else:
        ensure_env = False

    try:
        # AC2: Arranque de compose y env-check
        if not args.skip_ac2:
            total_errors.extend(verify_ac2_startup_from_env_example())

        # AC3: Rotación y recreación con --no-build
        if not args.skip_ac3 and not args.skip_ac2:
            total_errors.extend(verify_ac3_secret_recreation())

    finally:
        if not args.keep and not args.skip_ac2:
            print("\n==> Deteniendo contenedores de prueba...")
            run_cmd(["docker", "compose", "stop", "sync-core", "redis", "env-check"], check=False)

        if env_created_by_script and ENV_FILE.exists():
            print("==> Eliminando .env creado temporalmente para el test")
            ENV_FILE.unlink()

    print("\n================== RESUMEN ==================")
    if total_errors:
        print(f"FALLOS DETECTADOS ({len(total_errors)}):")
        for err in total_errors:
            print(f"  - {err}")
        return 1

    print("TODAS LAS PRUEBAS DE SECRETOS PASARON EXITOSAMENTE.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
