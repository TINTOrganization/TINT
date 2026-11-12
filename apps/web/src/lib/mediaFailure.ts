/**
 * Motivos por los que un vídeo quedó en `failed` (`videos.failure_reason`, que escribe media-worker
 * y devuelve identity-api en `GET /rooms/:id/playback`). Son códigos estables sin datos personales;
 * cambiar uno exige actualizar los tres lados.
 */
export const FAILURE_REASONS = [
  'unsupported_format',
  'unreadable',
  'invalid_duration',
  'missing_file',
  'processing_failed',
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

/** El código si es uno conocido; cualquier otra cosa (versión anterior, valor raro) → null. */
export function toFailureReason(value: unknown): FailureReason | null {
  return typeof value === 'string' && (FAILURE_REASONS as readonly string[]).includes(value)
    ? (value as FailureReason)
    : null;
}

const HOST_MESSAGES: Record<FailureReason, string> = {
  unsupported_format: 'Formato no soportado. Usa MP4, MOV, MKV o WebM.',
  unreadable: 'No pudimos leer el archivo: parece dañado o no es un vídeo.',
  invalid_duration: 'No pudimos determinar la duración del vídeo.',
  missing_file: 'La subida no llegó completa. Sube el archivo de nuevo.',
  processing_failed: 'No se pudo preparar el vídeo. Prueba con otro archivo.',
};

/** Mensaje específico para el host (los invitados ven siempre el texto genérico). */
export function hostFailureMessage(reason: FailureReason): string {
  return HOST_MESSAGES[reason];
}
