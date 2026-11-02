# ADR 0022 — Secretos exclusivamente por variables de entorno inyectadas en tiempo de ejecución

| Campo | Valor |
| :--- | :--- |
| **Estado** | Aceptada |
| **Fecha** | 2026-11-02 |
| **Dominios afectados** | Infraestructura, CI/CD, todos los servicios |

## Contexto

El requisito R10 exige un despliegue orientado a contenedores y las restricciones de seguridad y mantenibilidad (OPS-05 #90) exigen que ningún secreto se versione en el repositorio Git ni se hornee en las capas de las imágenes Docker.

En el estado previo:
1. `docker-compose.yml` contenía valores por defecto inseguros para secretos usando sintaxis `${VAR:-dev-...}` o `${VAR:-tint}`, lo que permitía que un servicio arrancara con secretos conocidos si la variable no estaba definida en el entorno.
2. `env-check` no validaba la presencia de `INTERNAL_API_SECRET` ni `MONGO_ROOT_PASSWORD`.
3. No existía `.dockerignore` en la raíz del monorepo, lo que permitía que un archivo `.env` local fuese copiado accidentalmente en contextos de construcción de imágenes mediante directivas `COPY .`.
4. No existía un escaneo automatizado de secretos en el pipeline de CI para auditar el historial de Git.

## Decisión

### 1. Inyección de secretos en tiempo de creación de contenedores

Todos los secretos del sistema se definen exclusivamente en el archivo de entorno `.env` (ignorado por Git en `.gitignore` y excluido del contexto de construcción en `.dockerignore`) y son inyectados por Docker Compose en tiempo de creación e inicio de los contenedores:

- `POSTGRES_PASSWORD`: contraseña de PostgreSQL compartida por identity-api, media-worker y analytics.
- `MINIO_ROOT_PASSWORD`: clave secreta de MinIO / S3 usada por identity-api y media-worker.
- `MONGO_ROOT_PASSWORD`: contraseña administrativa de MongoDB (almacén de chat durable en social-core).
- `MONGO_URI`: URI completa de conexión a MongoDB.
- `JWT_SECRET`: clave simétrica HS256 emitida por identity-api y validada por sync-core, social-core, voice-core, stream-core y analytics.
- `TURN_SECRET`: clave compartida para autenticación efímera entre coturn, voice-core y stream-core.
- `INTERNAL_API_SECRET`: token compartido para llamadas internas autenticadas (stream-core e identity-api).

### 2. Eliminación de fallbacks en Compose y validación estricta en `env-check`

En `docker-compose.yml`, todas las interpolaciones de secretos utilizan estrictamente `${SECRETO}` sin valores por defecto (`:-`). Si falta una variable requerida:
- El servicio `tint-env-check` falla inmediatamente con código 1 y enumera las variables faltantes antes de que cualquier servicio dependiente inicie.
- Las variables no secretas (como puertos, orígenes CORS y `JWT_ISSUER`) pueden conservar valores por defecto convenientes para desarrollo local.

### 3. Regla de actualización y recreación de contenedores

Docker no relee el archivo `.env` del host tras una edición cuando se ejecuta `docker restart`. Para aplicar un cambio de secreto sin reconstruir innecesariamente las imágenes de los servicios, el operador debe recrear los contenedores afectados:

```bash
docker compose up -d --no-build
```

o para un servicio específico:

```bash
docker compose up -d --no-build --force-recreate <servicio>
```

### 4. Excepción documentada: variables de cliente Vite

Las variables con prefijo `VITE_` (como `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN` y `VITE_FIREBASE_PROJECT_ID`) no son secretos de servidor: son parámetros de configuración pública del cliente web compilados estáticamente en los artefactos del navegador por Vite durante `apps/web/Dockerfile`. Los secretos reales de Firebase o claves de servicio no residen en el cliente web.

### 5. Auditoría continua con Gitleaks y `.dockerignore`

- Se añade `.dockerignore` en la raíz excluyendo `.env`, `.env.*` (salvo `.env.example`), `.git`, artefactos de compilación y logs.
- Se integra Gitleaks en el pipeline de CI (`.github/workflows/ci-pipeline.yml`) con escaneo de todo el historial (`fetch-depth: 0`).
- Se declara `.gitleaks.toml` en la raíz con una lista de excepciones acotada exclusivamente a los marcadores de posición (*placeholders*) didácticos documentados en `.env.example` y la documentación técnica (por ejemplo, `dev-secret-change-in-prod`).

## Consecuencias

### Positivas
- Se garantiza el principio de fallo cerrado (*fail-closed*): ningún contenedor levanta con secretos por defecto desconocidos por el operador.
- Las imágenes Docker resultan portables y limpias de credenciales.
- Se detectan posibles filtraciones de secretos en el pipeline de CI antes de fusionar código a las ramas principales.

### Negativas / Mitigaciones
- El arranque inicial local requiere crear `.env` copiando `.env.example` (`cp .env.example .env`). Esto ya está documentado y automatizado en la guía del desarrollador y en el Makefile.
