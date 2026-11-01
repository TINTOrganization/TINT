// Variable del Canal de Voz (aparte de vite-env.d.ts para no tocar el resto del dominio web).
interface ImportMetaEnv {
  /** WebSocket del Canal de Voz de voice-core (por defecto ws://localhost:8085/ws/voice). */
  readonly VITE_VOICE_WS_URL?: string;
}
