import { pgTable, text, timestamp, boolean, uuid, varchar, bigint, integer, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider', { enum: ['firebase'] }).notNull().default('firebase'),
  providerSub: text('provider_sub').notNull(),
  email: text('email'),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // Un usuario por cuenta del proveedor: es el target del upsert atómico (migración 0005).
  uniqueIndex('users_provider_sub_unique').on(t.provider, t.providerSub),
]);

export const rooms = pgTable('rooms', {
  id: uuid('id').primaryKey().defaultRandom(),
  hostId: uuid('host_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 150 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  // Vídeo asignado (F3): id estable que viaja en LOAD/STATE y key del objeto en MINIO_BUCKET.
  mediaId: uuid('media_id'),
  mediaKey: text('media_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Sesiones de invitado (F5): una fila por guest token emitido, para listarlos y revocarlos.
export const guestSessions = pgTable('guest_sessions', {
  jti: uuid('jti').primaryKey(),
  roomId: uuid('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  sub: text('sub').notNull(),
  nick: varchar('nick', { length: 64 }).notNull(),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revoked: boolean('revoked').default(false).notNull(),
  // Identificador anónimo del navegador (UUID en localStorage) que envía la web al
  // reclamar la invitación. Nullable: los clientes viejos no lo mandan (migración 0007).
  deviceId: uuid('device_id'),
});

// Bloqueos de invitados por dispositivo (migración 0007). Un invitado bloqueado no
// puede volver a reclamar una invitación de la sala desde el mismo navegador.
// device_id es null si la sesión venía de un cliente sin deviceId: ese bloqueo
// solo queda registrado por `sub` y no impide volver a entrar (ver usuarios-e-identidad §6.6).
export const roomBans = pgTable('room_bans', {
  id: uuid('id').primaryKey().defaultRandom(),
  roomId: uuid('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id'),
  sub: text('sub').notNull(),
  nick: varchar('nick', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
}, (t) => [
  // Varios null no chocan (NULLS DISTINCT): los bloqueos sin dispositivo se deduplican por sub.
  uniqueIndex('room_bans_room_device_unique').on(t.roomId, t.deviceId),
]);

export const invitations = pgTable('invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 12 }).unique().notNull(),
  roomId: uuid('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by').references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revoked: boolean('revoked').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Vídeos subidos al Blob Storage (MinIO). identity-api crea la fila y publica
// `media:uploads`; media-worker solo la actualiza (processing → ready | failed,
// duration_ms, renditions). Las columnas id, storage_key, duration_ms, status y
// renditions son su contrato.
export const videos = pgTable('videos', {
  id: uuid('id').primaryKey(),
  roomId: uuid('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  uploadedBy: uuid('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  storageKey: text('storage_key').notNull(),
  contentType: varchar('content_type', { length: 100 }).notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  durationMs: integer('duration_ms'),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  // Por qué quedó en `failed` (código de FAILURE_REASONS que escribe media-worker); NULL en el resto de
  // estados y en fallos anteriores a esta columna. Migración 0008.
  failureReason: varchar('failure_reason', { length: 40 }),
  // Nombre visible en la biblioteca: el filename sin extensión al reservar (migración 0007).
  title: varchar('title', { length: 255 }),
  // Alturas de las calidades publicadas por media-worker (`{id}/{h}p.mp4`), p. ej. [720, 360].
  renditions: jsonb('renditions').$type<number[]>().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
