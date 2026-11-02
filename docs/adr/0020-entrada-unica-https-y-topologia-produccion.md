# ADR 0020 — Entrada única HTTPS y topología de producción Compose (OPS-03)

| Campo | Valor |
| :--- | :--- |
| **Estado** | Aceptada |
| **Fecha** | 2026-11-02 |
| **Dominios afectados** | Infraestructura / CI (`gateway/`, `docker-compose.yml`, `docker-compose.production.yml`, `.env.example`, `.github/workflows/ci-pipeline.yml`), `apps/web` |

## Contexto
Los requerimientos no funcionales R10 (despliegue orientado a contenedores) y R8 (conjunto de conectores basados en HTTP), junto con la historia de usuario OPS-03 ("HTTPS at one address", #88), exigen que los usuarios alcancen TINT de forma segura a través de una dirección pública única bajo HTTPS.

Al analizar el estado del sistema se identificaron las siguientes necesidades:
1. **Punto de entrada único:** El despliegue de desarrollo exponía puertos independientes para cada servicio (`8080/3000` para web, `8081` para identity-api, `8080/8083` para sync-core, `8082` para social-core, `8084` para analytics y `8085` para voice-core). En un entorno de producción, los servicios internos no deben publicar puertos en el host, sino ser alcanzables únicamente a través del gateway TLS.
2. **Conectores web en el mismo origen (Same-Origin):** La imagen de `apps/web` se construía con valores por defecto que apuntaban a `localhost:808x`. Si un navegador carga la aplicación web bajo `https://<dominio-publico>`, los intentos de conexión a puertos directos fallan por políticas de origen o bloqueos de red (*Mixed Content*). La SPA debe consumir endpoints relativos (`/api/v1`, `/ws/sync`, `/ws/social`, `/ws/voice`) y construir las conexiones WebSocket dinámicamente con `wss:` en páginas HTTPS y `ws:` en entornos locales HTTP.
3. **Gestión y renovación de certificados (AC1, AC2):** Caddy gestiona y renueva automáticamente certificados TLS públicos (ACME / Let's Encrypt / ZeroSSL) cuando los puertos 80 y 443 y el registro DNS están disponibles. Para que la renovación no sufra pérdidas ni reinicios en frío, el almacenamiento de certificados debe residir en un volumen persistente (`gateway-data`), y el contenedor debe reiniciarse automáticamente ante caídas (`restart: unless-stopped`).
4. **Redirección HTTP a HTTPS (AC3):** Las peticiones entrantes en HTTP plano (puerto 80) deben redirigirse a HTTPS (puerto 443) con código de estado HTTP 308 (*Permanent Redirect*), preservando tanto el método HTTP original como la ruta y parámetros de consulta (`{uri}`).
5. **Delimitación de alcance:** Las transferencias de medios de MinIO mediante URLs presignadas S3 SigV4 y el tráfico UDP/TCP de coturn para STUN/TURN quedan expresamente fuera de la mediación del gateway para no interferir con las firmas criptográficas de almacenamiento ni con el rendimiento del relay de medios en tiempo real.

## Decisión
1. **Gateway Caddy como único punto de entrada público:** Caddy actúa como proxy inverso y terminador TLS. Escucha en los puertos 80 y 443 del host. En el bloque HTTP redirige permanentemente a HTTPS mediante `redir https://{host}:{$GATEWAY_HTTPS_PORT:443}{uri} 308`. En el bloque HTTPS (`https://{$GATEWAY_HOST:localhost}`) enruta las rutas de API y WebSockets a los microservicios internos correspondientes, y entrega las peticiones estáticas de la SPA a `web:80`.
2. **Persistencia y disponibilidad del gateway:** Se monta el volumen persistente `gateway-data` en `/data` del contenedor Caddy, preservando certificados emitidos, claves privadas y estado de renovación. La política de reinicio se fija en `restart: unless-stopped`.
3. **Topología de producción mediante Compose override:** Se introduce `docker-compose.production.yml`. Mientras que `docker-compose.yml` conserva mapeos de puertos locales para depuración, la combinación en producción (`docker compose -f docker-compose.yml -f docker-compose.production.yml up -d`) aplica `ports: !reset []` sobre `web`, `identity-api`, `sync-core`, `social-core`, `analytics` y `voice-core`, garantizando que únicamente los puertos 80 y 443 del gateway queden expuestos al host.
4. **Conectores web y resolución dinámica de WebSockets:**
   - Se actualizan las variables por defecto en `apps/web/Dockerfile`, `.env.example`, `apps/web/.env.example` y los argumentos de compilación en `docker-compose.yml` para usar rutas relativas: `VITE_IDENTITY_API_URL=/api/v1`, `VITE_SYNC_WS_URL=/ws/sync`, `VITE_SOCIAL_WS_URL=/ws/social`, `VITE_VOICE_WS_URL=/ws/voice` y `VITE_ANALYTICS_API_URL=/api/v1`.
   - Se implementa `sameOriginWebSocketUrl` en `apps/web/src/lib/publicEntry.ts` para resolver rutas relativas en URLs absolutas en tiempo de ejecución: utiliza `wss://` cuando `window.location.protocol` es `https:`, y `ws://` cuando es `http:`, conservando sin alteración las URLs absolutas explícitas para diagnósticos.
5. **Validación automatizada en CI:** Se incorpora en `.github/workflows/ci-pipeline.yml` la validación sintáctica del archivo `gateway/Caddyfile` mediante `caddy validate` en su contenedor oficial fijado, y la comprobación de la composición de producción con `docker compose ... config --quiet`. Se amplía la suite de pruebas unitarias en `gateway/tests/test_gateway_config.py` para asegurar el cumplimiento continuo de las propiedades arquitectónicas de OPS-03.

## Alternativas consideradas
| Alternativa | Por qué no |
| :--- | :--- |
| Nginx o Traefik como proxy inverso | Caddy provee soporte nativo, sin dependencias auxiliares de certbot ni scripts cron, para la emisión y renovación automática de certificados ACME con cero tiempo de inactividad. |
| Eliminar los puertos directamente de `docker-compose.yml` | Rompería la ergonomía de desarrollo de los colaboradores que depuran o ejecutan pruebas contra un solo servicio sin levantar todo el gateway. El esquema de override en producción separa limpiamente ambos propósitos. |
| Proxy inverso de almacenamiento MinIO en el gateway | Las URLs firmadas S3 SigV4 calculan el hash de autenticación sobre el Host y la ruta exacta. Reescribir o intermediar dichas peticiones en Caddy rompe las firmas o añade sobrecarga innecesaria en la transferencia de artefactos de vídeo. |
| URLs de WebSockets fijadas durante el build con dominio absoluto | Impide la portabilidad de las imágenes Docker entre diferentes entornos (staging, pre-producción, producción) sin recompilar el código frontend. |

## Consecuencias
**Positivas**
- Conexión HTTPS segura bajo un dominio único, eliminando problemas de *Mixed Content*.
- Renovación transparente de certificados TLS en segundo plano con persistencia ante reinicios.
- Redirección automática 308 desde HTTP conservando métodos y parámetros.
- Desacoplamiento de la configuración del frontend respecto al dominio final mediante resolución en tiempo de ejecución.
- Reducción de la superficie de exposición en producción al cerrar los puertos de microservicios internos.

**Negativas / Limitaciones**
- El aprovisionamiento de certificados válidos mediante Let's Encrypt / ZeroSSL requiere que el dominio posea registros A/AAAA accesibles públicamente y los puertos 80/443 abiertos hacia Caddy.
- MinIO y coturn permanecen fuera de la entrada única por sus requerimientos específicos de protocolo (SigV4 y NAT/STUN).

## Referencias
- Issues: [#88 (OPS-03)](https://github.com/TINTOrganization/TINT/issues/88), [#87 (OPS-02)](https://github.com/TINTOrganization/TINT/issues/87).
- Documentación: [Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https), [docs/arquitectura.md](../arquitectura.md).
- Archivos clave: `gateway/Caddyfile`, `docker-compose.production.yml`, `docker-compose.yml`, `apps/web/src/lib/publicEntry.ts`, `gateway/tests/test_gateway_config.py`.
