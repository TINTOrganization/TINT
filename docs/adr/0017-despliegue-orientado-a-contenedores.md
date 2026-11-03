# ADR 0017 — Despliegue orientado a contenedores y aprovisionamiento de MongoDB (OPS-02)

| Campo | Valor |
| :--- | :--- |
| **Estado** | Aceptada |
| **Fecha** | 2026-11-01 |
| **Dominios afectados** | Infraestructura / CI (`docker-compose.yml`, `.github/workflows/ci-pipeline.yml`, `gateway/tests`, `.env.example`), `services/identity-api` |

## Contexto
El requerimiento no funcional R10 y la HU OPS-02 ("Every component in a container", #87) exigen que el despliegue del sistema completo sea reproducible y orientado a contenedores, sin componentes ejecutados directamente sobre el host, con un Dockerfile por servicio y con versiones base fijadas.

Al auditar el estado del monorepo se identificaron las siguientes brechas:
1. Las imágenes de `minio` y `minio-init` utilizaban el tag flotante `pgsty/minio:latest` y `pgsty/mc:latest`.
2. El servicio `identity-api` utilizaba un Dockerfile single-stage que conservaba en la imagen final dependencias de desarrollo y test (`vitest`, `@testcontainers/postgresql`, etc.).
3. No existía validación automatizada en el pipeline de CI para verificar la sintaxis de Docker Compose y la ausencia de tags `:latest`.
4. El issue OPS-02 (#87), junto con SOC-02 (#32), SOC-07 (#37) y DAT-02 (#80), requieren que MongoDB forme parte del stack como base de datos documental para el almacenamiento durable del historial de chat, el cual hasta ahora dependía exclusivamente de estructuras volátiles en Redis y memoria.

## Decisión
1. **Aprovisionamiento de MongoDB en Compose:** Se añade el servicio `mongodb` con imagen fija `mongo:8.0` (LTS de Community Edition), volumen nombrado persistente `mongo-data`, variables `MONGO_INITDB_*` y comprobación de salud mediante `mongosh ping`. Se añade `MONGO_URI` a `.env.example` y a la validación de inicio en `env-check`.
2. **Inmutabilidad y fijación de versiones:** Se fijan las imágenes `pgsty/minio` y `pgsty/mc` mediante sus digests criptográficos SHA-256 (`@sha256:...`), garantizando compilaciones y arranques deterministas.
3. **Multi-stage build en identity-api:** Se refactoriza `services/identity-api/Dockerfile` en tres etapas: compilación TypeScript (`build`), instalación de dependencias de producción con `npm ci --omit=dev` (`deps-prod`), y ensamblado de la imagen final (`dist`, migraciones, `drizzle.config.ts`, y binario autónomo `drizzle-kit` para ejecutar `npm run migrate` sin acceso a red).
4. **Validación en CI y pruebas estáticas:** Se añade el job `compose-lint` en `.github/workflows/ci-pipeline.yml` (ejecutando `docker compose config --quiet` y `gateway/tests`), integrado al `ci-gate`. Se amplía `gateway/tests/test_gateway_config.py` con `ComposeStructureTests` y `DockerfileTests` para validar que todos los servicios y bases de datos están declarados, sin tags `:latest`, con volúmenes persistentes y etapas multi-stage.
5. **Separación de dominios:** Este cambio implementa estrictamente la infraestructura y contratos base (OPS-02). La lógica interna de interacción con MongoDB en Go (`MongoStore`, creación de colecciones e índices) pertenece al dominio de social-core y se aborda en los PRs correspondientes a SOC-07, SOC-02 y DAT-02.
6. **Limitación conocida de coturn:** Se documenta formalmente que `coturn` opera con `network_mode: host` para que el relay TURN pueda anunciar direcciones IP públicas alcanzables en entornos Linux de producción. En entornos de desarrollo como Docker Desktop (Windows/macOS) opera localmente sobre `localhost`.

## Alternativas consideradas
| Alternativa | Por qué no |
| :--- | :--- |
| MongoDB gestionado externo (Atlas) | R10 y OPS-02 exigen que todos los componentes puedan ejecutarse en contenedores en el entorno local. |
| Mantener historial de chat únicamente en Redis | Incumple SOC-02 AC3 (persistencia tras reinicio de servicios) y SOC-07 (evitar sobrecargar almacén relacional). |
| `coturn` en red bridge con mapeo de puertos | El protocolo STUN/TURN requiere conocer y anunciar la IP externa del host; una red bridge oculta dicha IP salvo que se configure dinámicamente `external-ip`. |
| Single-stage con desinstalación manual de dependencias | Deja capas intermedias y artefactos residuales en la imagen Docker; multi-stage garantiza aislamiento estricto. |

## Consecuencias
**Positivas**
- Despliegue 100 % contenerizado, reproducible y validado en CI.
- Infraestructura preparada para los requerimientos de persistencia NoSQL de chat (SOC-02/07, DAT-02).
- Reducción de la superficie de ataque y tamaño de imagen en `identity-api`.

**Negativas / Limitaciones**
- `coturn` con `network_mode: host` no aísla namespace de red en Linux.
- MongoDB añade ~500 MB al consumo de memoria del entorno local completo.

## Referencias
- Issues: [#87 (OPS-02)](https://github.com/TINTOrganization/TINT/issues/87), [#32 (SOC-02)](https://github.com/TINTOrganization/TINT/issues/32), [#37 (SOC-07)](https://github.com/TINTOrganization/TINT/issues/37), [#80 (DAT-02)](https://github.com/TINTOrganization/TINT/issues/80).
- Archivos: `docker-compose.yml`, `gateway/tests/test_gateway_config.py`, `services/identity-api/Dockerfile`, `.github/workflows/ci-pipeline.yml`, `docs/arquitectura.md`.
