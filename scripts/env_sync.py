#!/usr/bin/env python3
"""Sincroniza .env con .env.example: crea .env si no existe y añade las variables que falten.

Nunca modifica ni borra las variables que ya están en .env (aunque estén vacías: de eso avisa
env-check). Los valores añadidos son los de desarrollo de la plantilla. Lo usa `make up` antes de
arrancar; sin make: `python scripts/env_sync.py`. No lo uses en producción: allí los secretos se
definen a mano (ADR 0022).

Uso: python scripts/env_sync.py [ruta/.env] [ruta/.env.example]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
KEY = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=")
SECRET_HINTS = ("PASSWORD", "SECRET", "PEPPER", "TOKEN", "URI")


def keys_and_lines(text: str) -> list[tuple[str, str]]:
    """Pares (variable, línea) de un archivo .env, sin comentarios ni líneas vacías."""
    pairs = []
    for line in text.splitlines():
        match = KEY.match(line)
        if match and not line.lstrip().startswith("#"):
            pairs.append((match.group(1), line))
    return pairs


def is_secret(key: str) -> bool:
    return any(hint in key for hint in SECRET_HINTS)


def sync(env_path: Path, example_path: Path) -> list[str]:
    """Crea o completa env_path con las variables de example_path; devuelve las añadidas."""
    template = example_path.read_text(encoding="utf-8")
    if not env_path.exists():
        env_path.write_text(template, encoding="utf-8")
        return [key for key, _ in keys_and_lines(template)]
    current = env_path.read_text(encoding="utf-8")
    present = {key for key, _ in keys_and_lines(current)}
    missing = [(key, line) for key, line in keys_and_lines(template) if key not in present]
    if not missing:
        return []
    prefix = "" if current.endswith("\n") or not current else "\n"
    block = "\n# Añadidas por scripts/env_sync.py desde .env.example (valores de desarrollo)\n"
    block += "".join(line + "\n" for _, line in missing)
    with env_path.open("a", encoding="utf-8") as handle:
        handle.write(prefix + block)
    return [key for key, _ in missing]


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    env_path = Path(args[0]) if len(args) > 0 else ROOT / ".env"
    example_path = Path(args[1]) if len(args) > 1 else ROOT / ".env.example"
    if not example_path.exists():
        print(f"env-sync: no existe {example_path}")
        return 1
    created = not env_path.exists()
    added = sync(env_path, example_path)
    if not added:
        print(f"env-sync: {env_path.name} está al día con {example_path.name}")
        return 0
    action = "creado" if created else "actualizado"
    print(f"env-sync: {env_path.name} {action}; {len(added)} variable(s) añadida(s): {', '.join(added)}")
    secrets = [key for key in added if is_secret(key)]
    if secrets:
        print("env-sync: estos secretos tienen valores de desarrollo; cámbialos fuera de tu máquina: " + ", ".join(secrets))
    return 0


if __name__ == "__main__":
    sys.exit(main())
