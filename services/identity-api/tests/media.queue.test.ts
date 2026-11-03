import { describe, it, expect, vi, afterEach } from 'vitest';
import { setRedisClient } from '../src/modules/tokens/revocation.js';
import { MEDIA_UPLOADS_MAXLEN, MEDIA_UPLOADS_STREAM, enqueueMediaUpload } from '../src/modules/media/media.queue.js';

afterEach(() => setRedisClient(null));

describe('media.queue', () => {
  it('publica XADD media:uploads * video_id <id> (contrato del media-worker)', async () => {
    const xadd = vi.fn().mockResolvedValue('1-0');
    setRedisClient({ xadd } as any);
    await expect(enqueueMediaUpload('v-1')).resolves.toBe('1-0');
    expect(MEDIA_UPLOADS_STREAM).toBe('media:uploads');
    expect(xadd).toHaveBeenCalledWith('media:uploads', 'MAXLEN', '~', MEDIA_UPLOADS_MAXLEN, '*', 'video_id', 'v-1');
  });

  it('acota el stream: sin tope los eventos ya confirmados se acumularían para siempre (DAT-03)', () => {
    expect(MEDIA_UPLOADS_MAXLEN).toBe(10_000);
  });
});
