# ADR 0023 — Instrucciones de Ejecución del Prototipo y Guía de Revisión (OPS-06)

| Campo | Valor |
| :--- | :--- |
| **Estado** | Aceptada |
| **Fecha** | 2026-11-02 |
| **Dominios afectados** | Infraestructura / CI (`README.md`, `docs/`, `gateway/tests`, `Makefile`) |

## Contexto
El requerimiento funcional y de entrega R11 ("Delivery artifact: documentation, four views and prototype instructions") y el requerimiento técnico R10 ("The deployment of the software system must be container-oriented"), junto con el issue OPS-06 (#91), exigen que cualquier evaluador o revisor externo pueda descargar, configurar, ejecutar y verificar el prototipo completo de TINT siguiendo una secuencia breve de comandos sin requerir instalación de herramientas o lenguajes específicos en su sistema anfitrión (salvo Docker y Git).

Las restricciones no funcionales establecidas son:
1. **Usabilidad**: Las instrucciones deben ser concisas y caber idealmente en una sola página impresa o en pantalla estándar (~100–140 líneas).
2. **Reproducibilidad**: El tiempo total para descargar, construir, levantar y verificar el prototipo en una máquina limpia debe ser inferior a 15 minutos.
3. **Criterios de Aceptación**:
   - **AC1**: Dado el apartado del prototipo, al seguir los comandos, el sistema arranca y es verificable.
   - **AC2**: Los pasos son reproducibles en sistemas operativos distintos (Linux, macOS, Windows).
   - **AC3**: Ante un error común de configuración, recursos o puertos, el apartado lista la solución específica y accionable.

*Nota sobre R11*: Las cuatro vistas de arquitectura (C&C, Deployment Structure, Layered y Decomposition) se desarrollan en paralelo en issues independientes y quedan desacopladas de esta decisión sobre las instrucciones de ejecución.

## Decisión
1. **Ubicación centralizada y concisa en el README raíz**:
   Se consolida la sección `## 🚀 Instrucciones de Ejecución del Prototipo (OPS-06)` en `README.md`, estructurada en un flujo lineal de 5 pasos:
   - **Prerrequisitos mínimos y recursos**: Git, Docker Engine ≥ 24.0 y Docker Compose v2; recomendados 4 GB de RAM y 2 vCPUs; puertos 80/443.
   - **Paso 1: Clonar y navegar**: `git clone https://github.com/TINTOrganization/TINT.git && cd TINT`.
   - **Paso 2: Configuración del entorno**: `cp .env.example .env` (con valores por defecto listos para desarrollo local que pasan la validación fail-closed de `env-check`).
   - **Paso 3: Construcción y despliegue (R10)**: `docker compose up -d --build`.
   - **Paso 4: Verificación inmediata y exploración**:
     - Diagnóstico de contenedores: `docker compose ps` (todos en estado `healthy` o `running`).
     - Sonda HTTP de gateway: `curl -k https://localhost/healthz`.
     - Acceso visual: Gateway HTTPS en `https://localhost` o Web en `http://localhost:5173`.
     - Rutas de evaluación independientes de Firebase: `/test-me` (cuestionario técnico interactivo), `/arquitectura` (mapa navegable del sistema) y `/analitica` (dashboard de KPIs).
   - **Paso 5: Apagado y reinicio limpio**: `docker compose down` y `docker compose down -v`.

2. **Matriz de solución de problemas (AC3)**:
   Se incorpora una tabla compacta de resolución rápida con 5 fallos comunes:
   - *Falta de `.env`*: Error de validación `Missing required variables` -> `cp .env.example .env`.
   - *Conflicto de puertos*: Mensaje `bind: address already in use` (80, 443, 5432, 6379, 27017) -> Liberar el puerto local o modificar los puertos en `.env`.
   - *Certificado SSL autofirmado*: Advertencia de seguridad en `https://localhost` -> Comportamiento normal del certificado local de Caddy en desarrollo; omitir advertencia o acceder a `http://localhost:5173`.
   - *Docker inactivo o RAM insuficiente*: Fallo al compilar o arrancar contenedores -> Iniciar Docker Desktop y verificar asignación de memoria (≥ 4 GB).
   - *Diferencias de plataforma para coturn*: En Linux utiliza `network_mode: host`; en Windows/macOS mapea puertos a través de la máquina virtual de Docker Desktop sobre `localhost:3478`.

3. **Multiplataforma (AC2)**:
   Se documenta explícitamente la compatibilidad para Linux (bash), macOS (zsh) y Windows (PowerShell), señalando el comando alternativo para copiar archivos si no se dispone de bash (`copy .env.example .env`).

4. **Blindaje mediante pruebas automatizadas (TDD)**:
   Se crea `gateway/tests/test_run_instructions.py` en el dominio de Infra / CI, asegurando que cualquier cambio futuro en `README.md` o en la configuración de Compose preserve los comandos esenciales, el límite de una página y la matriz de solución de problemas.

## Consecuencias
**Positivas**:
- La evaluación del sistema es predecible, autónoma y no requiere conocimientos previos del monorepo.
- Se cumple R10 al delegar el 100 % de los servicios y dependencias a contenedores gestionados por Compose.
- Se garantiza una usabilidad de una página y un tiempo de ejecución estimado de 3 a 5 minutos (bien por debajo del umbral de 15 minutos).
- Se facilita la verificación visual mediante rutas que no dependen de cuentas de Google / Firebase externas.

**Negativas / Limitaciones**:
- La primera ejecución requiere ancho de banda suficiente para descargar imágenes base (~1-2 GB) si no están en caché local.
- En máquinas con menos de 4 GB de memoria libre, Docker Compose puede experimentar lentitud durante la compilación multi-etapa de `services/voice-core` o `apps/web`.

## Referencias
- Issue: [#91 (OPS-06)](https://github.com/TINTOrganization/TINT/issues/91).
- Requerimientos: R10, R11.
- ADRs relacionados: [ADR 0017 (Contenedores)](0017-despliegue-orientado-a-contenedores.md), [ADR 0020 (Entrada única HTTPS)](0020-entrada-unica-https-y-topologia-produccion.md), [ADR 0021 (Observabilidad y salud)](0021-observabilidad-salud-y-logs.md), [ADR 0022 (Secretos por entorno)](0022-secretos-por-variables-de-entorno.md).
