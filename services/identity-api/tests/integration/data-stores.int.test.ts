/**
 * Almacenes de datos contra la infraestructura real (docker compose: PostgreSQL, Redis y MinIO).
 *
 *   DAT-01  sala con dueño, transacción que revierte y migraciones repetibles
 *   DAT-03  Redis: una clave temporal caduca y el cliente se recupera tras un corte
 *   DAT-04  MinIO: el objeto privado no se sirve sin firma
 *
 * Solo corre con INTEGRATION=1 (`npm run test:integration`). Solo se simula la verificación del
 * ID token de Firebase.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import net from 'node:net';
import pg from 'pg';
import { Redis } from 'ioredis';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const state = vi.hoisted(() => ({ userId: '' }));

vi.mock('../../src/middlewares/auth.js', () => ({
  requireAuthHost: (req: any, _res: any, next: any) => {
    req.user = { id: state.userId, providerSub: 'it-data', email: 'data@tint.test', displayName: 'Data IT' };
    next();
  },
}));

const RUN = !!process.env.INTEGRATION;
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tint:tint@localhost:5432/tint';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!RUN)('almacenes de datos con servicios reales', () => {
  let app: any;
  let pool: pg.Pool;
  const titles: string[] = [];

  beforeAll(async () => {
    ({ default: app } = await import('../../src/app.js'));
    const users = await import('../../src/modules/users/users.repo.js');
    const user = await users.upsertByProvider({ providerSub: `it-data-${Date.now()}`, email: 'data@tint.test', displayName: 'Data IT' });
    state.userId = user.id;
    ({ pool } = await import('../../src/db/client.js'));
  });

  afterAll(async () => {
    await pool.query('DELETE FROM rooms WHERE title = ANY($1)', [titles]);
    await pool.end();
  });

  describe('DAT-01 relacional', () => {
    it('AC1: una sala nueva se guarda con su dueño y su invitación', async () => {
      const title = `dat01-ac1-${randomUUID()}`;
      titles.push(title);
      const res = await request(app).post('/api/v1/rooms').send({ title });
      expect(res.status).toBe(200);
      const room = await pool.query('SELECT host_id, status FROM rooms WHERE id = $1', [res.body.room.id]);
      expect(room.rows).toEqual([{ host_id: state.userId, status: 'active' }]);
      const invitation = await pool.query('SELECT created_by, revoked FROM invitations WHERE room_id = $1', [res.body.room.id]);
      expect(invitation.rows).toEqual([{ created_by: state.userId, revoked: false }]);
    });

    it('AC2: si falla la invitación la transacción revierte y no queda la sala', async () => {
      const { createRoomWithInvitation } = await import('../../src/modules/rooms/rooms.create.js');
      const title = `dat01-ac2-${randomUUID()}`;
      titles.push(title);
      await expect(
        createRoomWithInvitation(
          { title, hostId: state.userId },
          // createdBy inexistente: la FK de invitations rechaza la segunda inserción.
          { createdBy: randomUUID(), expiresAt: new Date(Date.now() + 3600_000), revoked: false },
        ),
      ).rejects.toThrow();
      const left = await pool.query('SELECT count(*)::int AS n FROM rooms WHERE title = $1', [title]);
      expect(left.rows[0].n).toBe(0);
    });

    it('AC3: aplicar las migraciones dos veces no da error', async () => {
      const url = new URL(DATABASE_URL);
      const scratch = `tint_it_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const admin = new pg.Pool({ connectionString: DATABASE_URL });
      await admin.query(`CREATE DATABASE ${scratch}`);
      try {
        url.pathname = `/${scratch}`;
        const env = { ...process.env, DATABASE_URL: url.toString() };
        const migrate = () => execFileSync('npm', ['run', 'migrate'], { env, stdio: 'pipe' });
        migrate();
        expect(() => migrate()).not.toThrow();
        const scratchPool = new pg.Pool({ connectionString: url.toString() });
        const tables = await scratchPool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
        const applied = await scratchPool.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
        await scratchPool.end();
        expect(tables.rows.map((r) => r.table_name)).toEqual(expect.arrayContaining(['rooms', 'invitations', 'videos', 'users']));
        // La segunda ejecución no vuelve a registrar ninguna migración.
        const files = execFileSync('sh', ['-c', 'ls migrations/*.sql | wc -l']).toString().trim();
        expect(applied.rows[0].n).toBe(Number(files));
      } finally {
        await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
        await admin.end();
      }
    }, 120_000);
  });

  describe('DAT-03 Redis', () => {
    it('AC2: la marca de revocación caduca con su token y desaparece sola', async () => {
      const { markTokenRevoked, revokedKey } = await import('../../src/modules/tokens/revocation.js');
      const redis = new Redis(REDIS_URL);
      const jti = `it-${randomUUID()}`;
      try {
        await markTokenRevoked(jti, Math.floor(Date.now() / 1000) + 2);
        expect(await redis.exists(revokedKey(jti))).toBe(1);
        expect(await redis.ttl(revokedKey(jti))).toBeGreaterThan(0);
        await sleep(3200);
        expect(await redis.exists(revokedKey(jti))).toBe(0);
      } finally {
        redis.disconnect();
      }
    }, 20_000);

    it('AC3: tras un corte de Redis el cliente se reconecta solo', async () => {
      const target = new URL(REDIS_URL);
      const sockets = new Set<net.Socket>();
      const server = net.createServer((client) => {
        const upstream = net.connect(Number(target.port || 6379), target.hostname);
        sockets.add(client).add(upstream);
        client.pipe(upstream).pipe(client);
        const drop = () => { client.destroy(); upstream.destroy(); };
        client.on('error', drop); upstream.on('error', drop);
      });
      const listen = () => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      await listen();
      const { port } = server.address() as net.AddressInfo;
      const client = new Redis({ host: '127.0.0.1', port, maxRetriesPerRequest: 2, retryStrategy: () => 100 });
      client.on('error', () => {});
      try {
        expect(await client.ping()).toBe('PONG');
        // Corte: se cierran las conexiones y el puerto deja de aceptar.
        server.close();
        sockets.forEach((s) => s.destroy());
        await expect(client.ping()).rejects.toThrow();
        // Redis vuelve en el mismo puerto: el cliente se recupera sin reiniciar el proceso.
        await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
        await sleep(500);
        expect(await client.ping()).toBe('PONG');
      } finally {
        client.disconnect();
        server.close();
        sockets.forEach((s) => s.destroy());
      }
    }, 20_000);
  });

  describe('DAT-04 almacenamiento de objetos', () => {
    it('AC2: sin firma o con la firma alterada el objeto privado se deniega', async () => {
      const title = `dat04-${randomUUID()}`;
      titles.push(title);
      const room = await request(app).post('/api/v1/rooms').send({ title });
      const up = await request(app).post(`/api/v1/rooms/${room.body.room.id}/media/uploads`).send({ filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: 6 });
      expect(up.status).toBe(200);
      const put = await fetch(up.body.uploadUrl, { method: 'PUT', headers: up.body.headers, body: Buffer.from('secret') });
      expect(put.status).toBe(200);

      const signed = new URL(up.body.uploadUrl);
      const bare = `${signed.origin}${signed.pathname}`;
      expect((await fetch(bare)).status).toBe(403);
      expect((await fetch(bare, { method: 'PUT', body: 'x' })).status).toBe(403);
      expect((await fetch(`${signed.origin}${signed.pathname.split('/').slice(0, 2).join('/')}/`)).status).toBe(403);
      const tampered = new URL(up.body.uploadUrl);
      tampered.searchParams.set('X-Amz-Signature', '0'.repeat(64));
      expect((await fetch(tampered, { method: 'PUT', body: 'x' })).status).toBe(403);
    });
  });
});
