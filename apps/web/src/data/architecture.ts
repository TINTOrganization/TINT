// Modelo de la ruta oculta /arquitectura: componentes y conectores de TINT, transcritos de
// docs/arquitectura.md §4 (vista C&C). Las rutas de `sources` son relativas a la raíz del
// monorepo; el test comprueba que existen.

export type ArchNodeId =
  | 'web'
  | 'firebase'
  | 'identity'
  | 'sync'
  | 'social'
  | 'analytics'
  | 'media'
  | 'postgres'
  | 'redis'
  | 'minio';

export type ArchNodeKind = 'cliente' | 'servicio' | 'almacen' | 'externo';

export interface ArchNode {
  id: ArchNodeId;
  label: string;
  kind: ArchNodeKind;
  /** Stack o imagen, en una línea. */
  stack: string;
  /** Puerto local, o null si no expone ninguno. */
  port: string | null;
  role: string;
  /** Datos de los que es dueño (o que guarda). */
  owns: string[];
  /** ADRs que explican por qué existe o cómo se comporta. */
  adrs: string[];
  sources: string[];
  /** Centro del nodo en el viewBox del diagrama. */
  x: number;
  y: number;
}

/** `sync`: petición/respuesta · `ws`: WebSocket persistente · `async`: por Redis (Pub/Sub, Streams, claves). */
export type ArchConnectorMode = 'sync' | 'ws' | 'async';

export interface ArchConnector {
  id: string;
  label: string;
  protocol: string;
  mode: ArchConnectorMode;
  /** Pares de componentes que une; un mismo conector puede tener varios extremos (p. ej. SQL). */
  links: [ArchNodeId, ArchNodeId][];
  sources: string[];
}

export const ARCH_VIEWBOX = { width: 1000, height: 640 };
export const ARCH_NODE_SIZE = { width: 150, height: 56 };

export const ARCH_KIND_LABELS: Record<ArchNodeKind, string> = {
  cliente: 'Cliente',
  servicio: 'Servicio',
  almacen: 'Almacén de datos',
  externo: 'Servicio externo',
};

export const ARCH_MODE_LABELS: Record<ArchConnectorMode, string> = {
  sync: 'Síncrono: petición y respuesta (HTTP, SQL, S3)',
  ws: 'WebSocket persistente y bidireccional',
  async: 'Asíncrono por Redis (Pub/Sub, Streams, claves)',
};

const ARQ = 'docs/arquitectura.md';

export const ARCH_NODES: ArchNode[] = [
  {
    id: 'web',
    label: 'web (SPA)',
    kind: 'cliente',
    stack: 'React 18 + TypeScript + Vite',
    port: '5173',
    role: 'La interfaz en el navegador del host y de los invitados. No decide nada autoritativo: refleja el estado que le llega y pre-valida.',
    owns: ['localStorage: tint_token (host), tint_guest_token (invitado), tint_device_id'],
    adrs: ['0005 · Canales WebSocket separados para sync y social'],
    sources: [ARQ, 'apps/web/AGENTS.md'],
    x: 120,
    y: 300,
  },
  {
    id: 'firebase',
    label: 'Firebase Auth',
    kind: 'externo',
    stack: 'Google (externo)',
    port: null,
    role: 'Inicia la sesión del host con Google y emite su ID token RS256. TINT solo verifica ese token con las claves públicas de Google.',
    owns: ['Cuentas de Google de los hosts', 'Claves públicas (JWKS y certificados x509)'],
    adrs: ['0006 · Tickets JWT HS256 emitidos por identity-api'],
    sources: [ARQ, 'docs/usuarios-e-identidad.md'],
    x: 500,
    y: 50,
  },
  {
    id: 'identity',
    label: 'identity-api',
    kind: 'servicio',
    stack: 'Node 22 + Express 5 + Drizzle',
    port: '8081',
    role: 'Usuarios, salas, invitaciones y vídeos. Es el único emisor de tokens propios (guest token, sync-ticket, analytics-ticket) y quien firma las URLs de MinIO.',
    owns: ['PostgreSQL: users, rooms, invitations, guest_sessions, room_bans, videos', 'Redis: token:revoked:{jti}'],
    adrs: [
      '0006 · Tickets JWT HS256 emitidos por identity-api',
      '0007 · Revocación por clave Redis y cierre 4001',
      '0008 · Subida directa a MinIO con URL firmada',
    ],
    sources: [ARQ, 'services/identity-api/AGENTS.md'],
    x: 500,
    y: 160,
  },
  {
    id: 'sync',
    label: 'sync-core',
    kind: 'servicio',
    stack: 'Go 1.22 + WebSockets · N réplicas',
    port: '8083 → 8080',
    role: 'Dueño del Reloj Maestro: aplica los comandos de reproducción, los reparte a toda la sala y mide y corrige el desfase de cada cliente.',
    owns: ['Redis: room:{id}:sync_state, presencia y Pub/Sub room:{id}:sync'],
    adrs: [
      '0002 · Reloj Maestro autoritativo en sync-core',
      '0003 · Redis Pub/Sub para el fan-out entre réplicas',
      '0004 · Scripts Lua en lugar de WATCH/MULTI',
      '0014 · Upgrade y cierre 4xxx para estados terminales',
    ],
    sources: [ARQ, 'services/sync-core/AGENTS.md', 'docs/dominio-reproduccion.md'],
    x: 500,
    y: 270,
  },
  {
    id: 'social',
    label: 'social-core',
    kind: 'servicio',
    stack: 'Go + WebSockets · N réplicas',
    port: '8082',
    role: 'Chat con moderación, reacciones, puntero láser, encuestas, trivias y recap. No emite comandos de reproducción: solo los lee.',
    owns: ['Redis: room:{id}:chat:*, poll*, recap:*, trivia:* y Pub/Sub room:{id}:social'],
    adrs: [
      '0005 · Canales WebSocket separados para sync y social',
      '0012 · Trivia con el reloj del servidor y el ancla del recap',
    ],
    sources: [ARQ, 'services/social-core/AGENTS.md'],
    x: 500,
    y: 380,
  },
  {
    id: 'analytics',
    label: 'analytics',
    kind: 'servicio',
    stack: 'Python 3.11',
    port: '8084',
    role: 'Consume los eventos de analítica (sin datos personales), calcula los KPIs de cada sala y los expone al host en una API de solo lectura.',
    owns: ['PostgreSQL: telemetry_events (90 días), room_kpis'],
    adrs: ['0009 · Procesamiento asíncrono con Redis Streams', '0010 · Eventos de analítica sin PII'],
    sources: [ARQ, 'services/analytics/AGENTS.md', 'docs/contrato-eventos-analitica.md'],
    x: 500,
    y: 490,
  },
  {
    id: 'media',
    label: 'media-worker',
    kind: 'servicio',
    stack: 'Python 3.11 + FFmpeg',
    port: null,
    role: 'Worker sin HTTP: toma cada vídeo subido, lo valida y normaliza, genera las calidades 720p y 360p y extrae la paleta del Ambilight.',
    owns: ['MinIO: {videoId}/source.mp4, 720p.mp4, 360p.mp4 y ambilight.json', 'PostgreSQL: estado de videos (no crea filas)'],
    adrs: ['0009 · Procesamiento asíncrono con Redis Streams', '0011 · Ambilight precalculado por media-worker'],
    sources: [ARQ, 'services/media-worker/AGENTS.md'],
    x: 840,
    y: 520,
  },
  {
    id: 'postgres',
    label: 'PostgreSQL',
    kind: 'almacen',
    stack: 'postgres:16-alpine',
    port: '5432',
    role: 'Lo que debe durar: cuentas, salas, invitaciones, sesiones de invitado, vídeos y la telemetría agregada.',
    owns: ['Tablas de identity-api', 'Tablas de analytics'],
    adrs: [],
    sources: [ARQ, 'docs/usuarios-e-identidad.md'],
    x: 840,
    y: 130,
  },
  {
    id: 'redis',
    label: 'Redis',
    kind: 'almacen',
    stack: 'redis:7-alpine (AOF)',
    port: '6379',
    role: 'El estado en vivo de cada sala y el pegamento asíncrono entre servicios: Pub/Sub entre réplicas, Streams como colas y la marca de tokens revocados.',
    owns: ['Estado de sala de sync-core y social-core', 'Streams media:uploads y analytics:events', 'token:revoked:{jti}'],
    adrs: [
      '0003 · Redis Pub/Sub para el fan-out entre réplicas',
      '0004 · Scripts Lua en lugar de WATCH/MULTI',
      '0009 · Procesamiento asíncrono con Redis Streams',
    ],
    sources: [ARQ, 'docs/dominio-reproduccion.md'],
    x: 840,
    y: 325,
  },
  {
    id: 'minio',
    label: 'MinIO',
    kind: 'almacen',
    stack: 'pgsty/minio · bucket tint-media',
    port: '9000',
    role: 'Almacén de objetos compatible con S3. Guarda los vídeos y la paleta del Ambilight; el navegador sube y descarga directo con URLs firmadas.',
    owns: ['incoming/{videoId}/original.* (staging, caduca a los 2 días)', '{videoId}/source.mp4, 720p.mp4, 360p.mp4, ambilight.json'],
    adrs: ['0008 · Subida directa a MinIO con URL firmada'],
    sources: [ARQ, 'docker-compose.yml'],
    x: 300,
    y: 580,
  },
];

export const ARCH_CONNECTORS: ArchConnector[] = [
  {
    id: 'C1',
    label: 'Autenticación externa',
    protocol: 'Firebase JS SDK (signInWithPopup), ID token RS256',
    mode: 'sync',
    links: [['web', 'firebase']],
    sources: [ARQ, 'docs/usuarios-e-identidad.md'],
  },
  {
    id: 'C2',
    label: 'REST',
    protocol: 'HTTP/JSON /api/v1 con Authorization: Bearer (ID token de Firebase o guest token)',
    mode: 'sync',
    links: [['web', 'identity']],
    sources: [ARQ, 'services/identity-api/AGENTS.md'],
  },
  {
    id: 'C3',
    label: 'WebSocket Canal Sync v2',
    protocol: 'GET /ws/sync?room_id&token · JSON o MessagePack · cierres terminales 4001 y 4003',
    mode: 'ws',
    links: [['web', 'sync']],
    sources: [ARQ, 'services/sync-core/AGENTS.md'],
  },
  {
    id: 'C4',
    label: 'WebSocket Canal Social',
    protocol: 'GET /ws/social?room_id&token · JSON · ping cada 20 s',
    mode: 'ws',
    links: [['web', 'social']],
    sources: [ARQ, 'services/social-core/AGENTS.md'],
  },
  {
    id: 'C5',
    label: 'REST de solo lectura',
    protocol: 'HTTP/JSON GET de KPIs con Bearer analytics-ticket',
    mode: 'sync',
    links: [['web', 'analytics']],
    sources: [ARQ, 'services/analytics/AGENTS.md'],
  },
  {
    id: 'C6',
    label: 'S3 con URL firmada',
    protocol: 'HTTP PUT (subida) y GET (vídeo, calidades, ambilight.json) con firma SigV4 calculada por identity-api',
    mode: 'sync',
    links: [['web', 'minio']],
    sources: [ARQ, 'docs/adr/0008-subida-directa-a-minio-con-url-firmada.md'],
  },
  {
    id: 'C7',
    label: 'Verificación de token',
    protocol: 'HTTPS JWKS de Google (jwks-rsa, en caché)',
    mode: 'sync',
    links: [['identity', 'firebase']],
    sources: [ARQ, 'docs/usuarios-e-identidad.md'],
  },
  {
    id: 'C8',
    label: 'Verificación de token',
    protocol: 'HTTPS certificados x509 públicos de Google por kid (en caché)',
    mode: 'sync',
    links: [['social', 'firebase']],
    sources: [ARQ, 'services/social-core/AGENTS.md'],
  },
  {
    id: 'C9',
    label: 'SQL',
    protocol: 'Drizzle ORM (identity-api) · psycopg 3 (Python)',
    mode: 'sync',
    links: [
      ['identity', 'postgres'],
      ['media', 'postgres'],
      ['analytics', 'postgres'],
    ],
    sources: [ARQ, 'docs/usuarios-e-identidad.md'],
  },
  {
    id: 'C10',
    label: 'S3 API',
    protocol: '@aws-sdk/client-s3 (HEAD, DELETE) · boto3 (GET, PUT)',
    mode: 'sync',
    links: [
      ['identity', 'minio'],
      ['media', 'minio'],
    ],
    sources: [ARQ, 'services/media-worker/AGENTS.md'],
  },
  {
    id: 'C11',
    label: 'Revocación: clave Redis + Pub/Sub',
    protocol: 'SET token:revoked:{jti} + PUBLISH room:{id}:sync REVOKED · los consumidores hacen EXISTS',
    mode: 'async',
    links: [
      ['identity', 'redis'],
      ['sync', 'redis'],
      ['social', 'redis'],
      ['analytics', 'redis'],
    ],
    sources: [ARQ, 'docs/adr/0007-revocacion-por-clave-redis-y-cierre-4001.md'],
  },
  {
    id: 'C12',
    label: 'Redis Pub/Sub + claves (sync)',
    protocol: 'Pub/Sub room:{id}:sync · CAS Lua sobre room:{id}:sync_state · ZSET de presencia',
    mode: 'async',
    links: [['sync', 'redis']],
    sources: [ARQ, 'docs/adr/0003-redis-pubsub-para-fanout-entre-replicas.md'],
  },
  {
    id: 'C13',
    label: 'Redis Pub/Sub + claves (social)',
    protocol: 'Pub/Sub room:{id}:social · lectura de room:{id}:sync · claves de chat, encuestas, recap y trivias',
    mode: 'async',
    links: [['social', 'redis']],
    sources: [ARQ, 'services/social-core/AGENTS.md'],
  },
  {
    id: 'C14',
    label: 'Redis Stream media:uploads',
    protocol: 'XADD media:uploads → XREADGROUP del grupo media-workers + XACK',
    mode: 'async',
    links: [
      ['identity', 'redis'],
      ['media', 'redis'],
    ],
    sources: [ARQ, 'docs/adr/0009-procesamiento-asincrono-con-redis-streams.md'],
  },
  {
    id: 'C15',
    label: 'Redis Stream analytics:events',
    protocol: 'XADD analytics:events MAXLEN ~ 100000 → XREADGROUP del grupo analytics-workers + XACK',
    mode: 'async',
    links: [
      ['identity', 'redis'],
      ['sync', 'redis'],
      ['social', 'redis'],
      ['media', 'redis'],
      ['analytics', 'redis'],
    ],
    sources: [ARQ, 'docs/contrato-eventos-analitica.md'],
  },
];
