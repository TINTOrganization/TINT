// Variable del Canal de Voz (aparte de vite-env.d.ts para no tocar el resto del dominio web).
interface ImportMetaEnv {
  /** WebSocket del Canal de Voz, por defecto la ruta pública /ws/voice. */
  readonly VITE_VOICE_WS_URL?: string;
  /** API REST de voice-core (escenario); por defecto el origen de VITE_VOICE_WS_URL en http(s). */
  readonly VITE_VOICE_API_URL?: string;
}
