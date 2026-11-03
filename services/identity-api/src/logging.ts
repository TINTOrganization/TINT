/**
 * Logs estructurados de identity-api (ADR 0021).
 *
 * Una línea JSON por evento en stdout, con `timestamp`, `level`, `service` y `message`.
 * El nivel se configura con `LOG_LEVEL` y un valor inválido falla al arrancar.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface LogSink {
  write(chunk: string): boolean;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  service: string;
  level: LogLevel;
  stream?: LogSink;
  now?: () => Date;
}

export function parseLogLevel(raw: string | undefined): LogLevel {
  if (!raw) return 'info';
  const level = raw.toLowerCase();
  if (!(LOG_LEVELS as readonly string[]).includes(level)) {
    throw new Error(`LOG_LEVEL inválido: "${raw}" (usa ${LOG_LEVELS.join('|')})`);
  }
  return level as LogLevel;
}

export function createLogger(options: LoggerOptions): Logger {
  const { service, level, stream = process.stdout, now = () => new Date() } = options;
  const minimum = RANK[level];

  const emit = (entryLevel: LogLevel, message: string, fields?: LogFields) => {
    if (RANK[entryLevel] < minimum) return;
    const entry: Record<string, unknown> = {
      timestamp: now().toISOString(),
      level: entryLevel,
      service,
      message,
    };
    for (const [key, value] of Object.entries(fields ?? {})) {
      // Los campos del contrato no se pueden pisar desde el contexto.
      if (!(key in entry) && value !== undefined) entry[key] = value;
    }
    stream.write(`${JSON.stringify(entry)}\n`);
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

export const logger = createLogger({
  service: 'identity-api',
  level: parseLogLevel(process.env.LOG_LEVEL),
});
