/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IDENTITY_API_URL?: string;
  /** WebSocket del Canal Sync de sync-core (p. ej. ws://localhost:8083/ws/sync). */
  readonly VITE_SYNC_WS_URL?: string;
  /** WebSocket del canal social de social-core (p. ej. ws://localhost:8082/ws/social). */
  readonly VITE_SOCIAL_WS_URL?: string;
  /** Codificación del Canal Sync: `json` (default) o `msgpack` (subprotocolo tint.sync.msgpack). */
  readonly VITE_SYNC_ENCODING?: string;
  /** Vídeo de respaldo si la sala no tiene vídeo asignado en identity-api. */
  readonly VITE_DEMO_VIDEO_URL?: string;
  /** API de lectura de analytics (p. ej. http://localhost:8084/api/v1). */
  readonly VITE_ANALYTICS_API_URL?: string;
  /** Origen de stream-core o del gateway (WHIP/WHEP en /api/v1/stream; p. ej. http://localhost:8086). */
  readonly VITE_STREAM_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
