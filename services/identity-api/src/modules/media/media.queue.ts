import { getRedisClient } from '../tokens/revocation.js';

/**
 * Stream que consume media-worker (grupo `media-workers`): cada evento lleva solo
 * `video_id`; el worker lee `videos.storage_key`, inspecciona con ffprobe, publica
 * `{video_id}/ambilight.json` y deja el vídeo en `ready` o `failed`.
 */
export const MEDIA_UPLOADS_STREAM = 'media:uploads';

/**
 * Tope aproximado (`MAXLEN ~`) del stream. Los eventos confirmados con `XACK` siguen en el stream,
 * así que sin tope crecería sin límite. Diez mil eventos superan con holgura cualquier cola
 * pendiente real y Redis solo recorta los más antiguos.
 */
export const MEDIA_UPLOADS_MAXLEN = 10_000;

export async function enqueueMediaUpload(videoId: string) {
  return getRedisClient().xadd(MEDIA_UPLOADS_STREAM, 'MAXLEN', '~', MEDIA_UPLOADS_MAXLEN, '*', 'video_id', videoId);
}
