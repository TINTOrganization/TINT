import { describe, expect, it } from 'vitest';
import { FAILURE_REASONS, hostFailureMessage, toFailureReason } from './mediaFailure';

describe('mediaFailure', () => {
  it('conoce los cinco motivos que escribe media-worker (contrato videos.failure_reason)', () => {
    expect([...FAILURE_REASONS]).toEqual([
      'unsupported_format',
      'unreadable',
      'invalid_duration',
      'missing_file',
      'processing_failed',
    ]);
  });

  it.each([...FAILURE_REASONS])('toFailureReason acepta %s', (reason) => {
    expect(toFailureReason(reason)).toBe(reason);
  });

  it.each([[null], [undefined], [''], ['nope'], [3], ['UNREADABLE']])('toFailureReason(%j) → null (se usa el texto genérico)', (value) => {
    expect(toFailureReason(value)).toBeNull();
  });

  it('cada motivo tiene un mensaje específico, accionable y sin jerga técnica', () => {
    const messages = FAILURE_REASONS.map((r) => hostFailureMessage(r));
    expect(new Set(messages).size).toBe(FAILURE_REASONS.length);
    for (const text of messages) {
      expect(text).not.toMatch(/ffprobe|ffmpeg|media-worker|MinIO|bucket|HTTP|SQL/i);
      expect(text.length).toBeGreaterThan(20);
    }
    expect(hostFailureMessage('unsupported_format')).toContain('MP4, MOV, MKV o WebM');
  });
});
