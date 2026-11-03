/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IDENTITY_API_URL?: string;
  /** WebSocket del Canal Sync, por defecto la ruta pública /ws/sync. */
  readonly VITE_SYNC_WS_URL?: string;
  /** WebSocket del canal social, por defecto la ruta pública /ws/social. */
  readonly VITE_SOCIAL_WS_URL?: string;
  /** Codificación del Canal Sync: `json` (default) o `msgpack` (subprotocolo tint.sync.msgpack). */
  readonly VITE_SYNC_ENCODING?: string;
  /** Vídeo de respaldo si la sala no tiene vídeo asignado en identity-api. */
  readonly VITE_DEMO_VIDEO_URL?: string;
  /** API de lectura de analytics, por defecto la ruta pública /api/v1. */
  readonly VITE_ANALYTICS_API_URL?: string;
  /** Origen de stream-core o del gateway (WHIP/WHEP en /api/v1/stream; p. ej. http://localhost:8086). */
  readonly VITE_STREAM_API_URL?: string;
  /** Solo desarrollo (ADR 0024): origen del Firebase Auth Emulator, p. ej. http://localhost:9099. */
  readonly VITE_FIREBASE_AUTH_EMULATOR_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
