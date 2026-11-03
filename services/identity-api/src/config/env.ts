import { z } from 'zod';
import { LOG_LEVELS } from '../logging.js';

const envSchema = z.object({
  IDENTITY_API_PORT: z.string().default('8081'),
  // Nivel de los logs JSON (ADR 0021). Un valor inválido impide el arranque.
  LOG_LEVEL: z.preprocess(
    (v) => (typeof v === 'string' ? v.toLowerCase() : v),
    z.enum(LOG_LEVELS).default('info'),
  ),
  SYNC_CORE_URL: z.string().url().default('http://localhost:8083'),
  SOCIAL_CORE_URL: z.string().url().default('http://localhost:8082'),
  ANALYTICS_URL: z.string().url().default('http://localhost:8084'),
  // stream-core: alta y baja de las salas live en POST /events/start (ADR 0019).
  STREAM_CORE_URL: z.string().url().default('http://localhost:8086'),
  // Secreto de las llamadas internas (X-Internal-Token). Sin él, /internal/rooms/* responde 503.
  INTERNAL_API_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AUTH_PROVIDER: z.enum(['firebase']).default('firebase'),
  JWT_ISSUER: z.string().default('tint-identity'),
  JWT_AUDIENCE: z.string().default('tint:room'),
  JWT_SECRET: z.string().default('dev-secret-change-in-prod'),
  GUEST_TOKEN_TTL_HOURS: z.string().default('4'),
  INVITATION_DEFAULT_TTL_HOURS: z.string().default('24'),
  SYNC_TICKET_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  DATABASE_URL: z.string().default('postgres://tint:tint@localhost:5432/tint'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  // MinIO / S3: firmado de URLs GET para reproducir el vídeo de la sala.
  MINIO_ENDPOINT: z.string().url().default('http://localhost:9000'),
  // Host que ve el navegador (la firma SigV4 incluye el host). Por defecto = MINIO_ENDPOINT.
  MINIO_PUBLIC_ENDPOINT: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  MINIO_ACCESS_KEY: z.string().default('tintadmin'),
  MINIO_SECRET_KEY: z.string().default('tintadmin123'),
  MINIO_BUCKET: z.string().default('tint-media'),
  MINIO_REGION: z.string().default('us-east-1'),
  PLAYBACK_URL_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  // Subida directa navegador → MinIO con URL PUT firmada.
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024 * 1024),
  FIREBASE_PROJECT_ID: z.string().min(1, 'FIREBASE_PROJECT_ID es obligatorio'),
  // Solo desarrollo (ADR 0024): con valor, se aceptan los ID tokens sin firma (`alg: none`)
  // del Firebase Auth Emulator. Vacío = desactivado.
  FIREBASE_AUTH_EMULATOR_HOST: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
});

/** Prefijo de los proyectos de demostración de Firebase: el emulador no llama a Google. */
export const DEMO_PROJECT_PREFIX = 'demo-';

/**
 * Valida el entorno. Falla cerrado: el modo emulador (tokens sin firma) impide el arranque
 * con `NODE_ENV=production` o con un proyecto real (sin el prefijo `demo-`).
 */
export function parseEnv(source: Record<string, string | undefined>) {
  return envSchema
    .superRefine((value, ctx) => {
      if (!value.FIREBASE_AUTH_EMULATOR_HOST) return;
      if (value.NODE_ENV === 'production') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['FIREBASE_AUTH_EMULATOR_HOST'],
          message: 'FIREBASE_AUTH_EMULATOR_HOST no se permite con NODE_ENV=production',
        });
      }
      if (!value.FIREBASE_PROJECT_ID.startsWith(DEMO_PROJECT_PREFIX)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['FIREBASE_PROJECT_ID'],
          message: `Con FIREBASE_AUTH_EMULATOR_HOST, FIREBASE_PROJECT_ID debe empezar por "${DEMO_PROJECT_PREFIX}"`,
        });
      }
    })
    .parse(source);
}

export type Env = ReturnType<typeof parseEnv>;

export const env: Env = parseEnv(process.env);
