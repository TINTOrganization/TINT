from pathlib import Path
import re
import unittest
import yaml


ROOT = Path(__file__).parents[2]
README = ROOT / "README.md"
ADR_0023 = ROOT / "docs" / "adr" / "0023-instrucciones-de-ejecucion-del-prototipo.md"
ADR_INDEX = ROOT / "docs" / "adr" / "README.md"
DOCS_INDEX = ROOT / "docs" / "README.md"
DOCS_ARQ = ROOT / "docs" / "arquitectura.md"
COMPOSE = ROOT / "docker-compose.yml"


class RunInstructionsContractTests(unittest.TestCase):
    def _extract_prototype_section(self) -> str:
        text = README.read_text(encoding="utf-8")
        match = re.search(
            r"(##\s+🚀\s+Instrucciones de Ejecución del Prototipo.*?)(?=\n##\s+|$)",
            text,
            re.DOTALL,
        )
        self.assertIsNotNone(
            match,
            "README.md debe contener la sección '## 🚀 Instrucciones de Ejecución del Prototipo (OPS-06)'",
        )
        return match.group(1)

    def test_prototype_section_exists_and_fits_on_one_page(self):
        """Usabilidad / OPS-06: Las instrucciones idealmente caben en 1 página (< 160 líneas, < 1200 palabras)."""
        section = self._extract_prototype_section()
        lines = section.strip().splitlines()
        words = section.split()

        self.assertLessEqual(
            len(lines),
            160,
            f"La sección de instrucciones debe caber en 1 página (máx. 160 líneas, tiene {len(lines)})",
        )
        self.assertLessEqual(
            len(words),
            1200,
            f"La sección de instrucciones debe ser concisa (máx. 1200 palabras, tiene {len(words)})",
        )

    def test_prototype_section_declares_r10_and_reproducibility_target(self):
        """R10 y Reproducibilidad: Despliegue 100% orientado a contenedores y objetivo de < 15 minutos."""
        section = self._extract_prototype_section()
        self.assertIn("15", section, "Debe mencionar el objetivo de arranque en menos de 15 minutos")
        self.assertTrue(
            "contenedor" in section.lower() or "docker" in section.lower(),
            "Debe indicar que el despliegue es 100% orientado a contenedores (R10)",
        )

    def test_prototype_section_contains_required_lifecycle_commands(self):
        """OPS-06/AC1: Comandos esenciales para clonar, configurar, arrancar, verificar y apagar."""
        section = self._extract_prototype_section()

        # Clonado
        self.assertIn("git clone https://github.com/TINTOrganization/TINT.git", section)
        # Configuración de variables
        self.assertIn("cp .env.example .env", section)
        # Arranque en contenedores
        self.assertIn("docker compose up -d --build", section)
        # Verificación de salud
        self.assertIn("docker compose ps", section)
        # Apagado
        self.assertIn("docker compose down", section)

    def test_prototype_section_documents_verification_and_demo_routes(self):
        """OPS-06/AC1: Rutas de acceso para verificar funcionamiento con y sin autenticación externa."""
        section = self._extract_prototype_section()

        # Entrada principal HTTPS (gateway) y alternativa web directa
        self.assertIn("https://localhost", section)
        self.assertIn("5173", section)

        # Sonda de liveness del gateway
        self.assertIn("/healthz", section)

        # Vistas clave de revisión sin login de Firebase
        self.assertIn("/test-me", section)
        self.assertIn("/arquitectura", section)

    def test_prototype_section_documents_future_android_build_template(self):
        """DOC-05/AC3: La guía deja una plantilla reproducible para el futuro cliente Android."""
        section = self._extract_prototype_section()
        lower = section.lower()

        self.assertIn("apps/android", lower)
        self.assertIn("gradlew", lower)
        self.assertIn("assembledebug", lower)
        self.assertIn("adb install", lower)
        self.assertIn("todavía no existe", lower)

    def test_prototype_section_troubleshooting_covers_ac3(self):
        """OPS-06/AC3: Solución documentada para errores comunes."""
        section = self._extract_prototype_section()

        # 1. Error de variables requeridas en .env (env-check fail-closed)
        self.assertTrue(
            "Missing required variables" in section or ".env" in section,
            "Debe incluir solución para variables ausentes en .env",
        )

        # 2. Conflicto de puertos en host
        self.assertTrue(
            "already in use" in section or "puerto" in section.lower(),
            "Debe incluir solución para colisión de puertos en el host",
        )

        # 3. Certificado autofirmado de desarrollo
        self.assertTrue(
            "certificado" in section.lower() or "ssl" in section.lower() or "tls" in section.lower(),
            "Debe explicar el certificado local de Caddy en https://localhost",
        )

        # 4. Recursos insuficientes o Docker daemon no iniciado
        self.assertTrue(
            "docker" in section.lower() and ("memoria" in section.lower() or "ram" in section.lower() or "daemon" in section.lower()),
            "Debe indicar requisitos de Docker Desktop / memoria",
        )

        # 5. Comportamiento multiplataforma de coturn (Linux vs Docker Desktop)
        self.assertIn("coturn", section.lower(), "Debe mencionar el comportamiento de coturn")

    def test_cross_platform_support_documented_ac2(self):
        """OPS-06/AC2: Pasos repetibles en diferentes máquinas (Linux, macOS, Windows)."""
        section = self._extract_prototype_section()
        lower = section.lower()
        self.assertTrue(
            "linux" in lower and ("windows" in lower or "powershell" in lower) and "mac" in lower,
            "Debe mencionar explícitamente compatibilidad o comandos equivalentes para Linux, macOS y Windows",
        )

    def test_adr_0023_exists_and_is_indexed(self):
        """R11 / ADR: Registro formal de la decisión de arquitectura sobre instrucciones del prototipo."""
        self.assertTrue(ADR_0023.is_file(), "Debe existir docs/adr/0023-instrucciones-de-ejecucion-del-prototipo.md")
        adr_content = ADR_0023.read_text(encoding="utf-8")
        self.assertIn("ADR 0023", adr_content)
        self.assertIn("OPS-06", adr_content)
        self.assertIn("R10", adr_content)
        self.assertIn("R11", adr_content)

        index_content = ADR_INDEX.read_text(encoding="utf-8")
        self.assertIn("0023-instrucciones-de-ejecucion-del-prototipo.md", index_content)

        docs_content = DOCS_INDEX.read_text(encoding="utf-8")
        self.assertIn("0023", docs_content)
