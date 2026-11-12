import { describe, expect, it } from 'vitest';
import { createLogger, parseLogLevel } from '../src/logging.js';

function capture() {
  const lines: string[] = [];
  const stream = {
    write(chunk: string) {
      lines.push(chunk);
      return true;
    },
  };
  return { lines, stream };
}

describe('parseLogLevel', () => {
  it('defaults to info and accepts case-insensitive values', () => {
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('')).toBe('info');
    expect(parseLogLevel('DEBUG')).toBe('debug');
    expect(parseLogLevel('Warn')).toBe('warn');
    expect(parseLogLevel('error')).toBe('error');
  });

  it('fails fast on an invalid value', () => {
    expect(() => parseLogLevel('verbose')).toThrow(/LOG_LEVEL/);
  });
});

describe('createLogger', () => {
  it('writes one JSON line with the required fields', () => {
    const { lines, stream } = capture();
    const logger = createLogger({
      service: 'identity-api',
      level: 'info',
      stream,
      now: () => new Date('2026-11-02T14:03:11.123Z'),
    });

    logger.info('http_request', { correlation_id: 'trace-1', status: 200 });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({
      timestamp: '2026-11-02T14:03:11.123Z',
      level: 'info',
      service: 'identity-api',
      message: 'http_request',
      correlation_id: 'trace-1',
      status: 200,
    });
  });

  it('filters messages below the configured level', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: 'identity-api', level: 'warn', stream });

    logger.debug('hidden');
    logger.info('hidden');
    logger.warn('shown');
    logger.error('shown');

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).level)).toEqual(['warn', 'error']);
  });

  it('does not let context fields override the contract fields', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ service: 'identity-api', level: 'info', stream });

    logger.info('safe', { service: 'evil', level: 'debug', message: 'evil' });

    const entry = JSON.parse(lines[0]);
    expect(entry.service).toBe('identity-api');
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('safe');
  });
});
