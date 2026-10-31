# 🤖 AGENT Guidelines — Domain: Frontend Experience (`apps/web`)

## Contexto & Responsabilidad
Eres el agente especializado en la capa de presentación de **TINT**. Tu foco es desarrollar la UI web responsiva, accesible e inmersiva (estética Dark/Luxury) usando React, TypeScript y Tailwind CSS.

Cómo funciona la SPA por dentro (arquitectura, flujos con diagramas, estado y pruebas): [`README.md`](README.md).

## Stack Técnico
- React 18 + TypeScript (modo `strict`) + Vite 5
- Tailwind CSS 3 (paleta `tint.*` en `tailwind.config.js`)
- Vitest + Testing Library (`jsdom`) + cobertura `v8`
- ESLint 9 (`typescript-eslint`, `react-hooks`)
- `@msgpack/msgpack` — codificación MessagePack opcional del Canal Sync (implementación oficial, sin dependencias, mismo modelo de datos que el JSON del protocolo).
- `framer-motion` 11.11.17 — animaciones declarativas en toda la app. `MotionProvider` (en `App`) carga `LazyMotion` con `domAnimation` en un chunk diferido (`motion/features.ts`; el bundle principal crece ≈ 12 KB gz; no uses `animate()` de framer en código del bundle principal: arrastra el motor completo, ~18 KB gz; sin `layout`/`layoutId`, que exigirían `domMax`) y `MotionConfig reducedMotion="user"`. Los componentes usan `m.*`; el cuestionario `/test-me` (lazy) sigue con `motion.*`. En pruebas `setupTests.ts` activa `MotionGlobalConfig.skipAnimations` y mapea `m` → `motion`; los stubs de `matchMedia` deben incluir `addListener`/`removeListener`.
- Outfit (Google Fonts, `index.html`) — tipografía de la marca.

## Responsabilidades
- Reproductor, sala, chat, reacciones, trivias y visualización Ambilight/Heatmap.
- Cliente de los dos canales WebSocket: `/ws/sync` (sync-core) y canal social (social-core).
- Detección y corrección de desfase de reproducción del lado del cliente.

## Límites de Dominio
- ❌ No implementes lógica de negocio autoritativa (puntajes, rate limiting real, estado maestro): eso vive en `services/*`. La UI solo refleja y pre-valida.
- ❌ No modifiques archivos fuera de `apps/web/` sin coordinación con el dominio dueño.
- ❌ Nunca envíes texto de chat a telemetría (ver `services/analytics/AGENTS.md`).

## Modelo de Datos Involucrado
| Entidad | Origen | Campos clave |
| :--- | :--- | :--- |
| `SyncEvent` | sync-core (`/ws/sync`) | `event_id`, `type` (`PLAY`/`PAUSE`/`SEEK`/`RATE`/`LOAD`/`VOLUME`/`QUALITY`/`STATE`/`HEARTBEAT`/`SYNC_CHECK`/`SYNC_CORRECTION`/`HOST_STATUS`/`CONTROL`/`ACK`/`ERROR`), `room_id`, `position_ms`, `version`, `occurred_at`, `received_at` + ancla (`status`, `rate`, `updated_at_ms`, `server_time_ms`) + v2: `media_id`, `can_control`, `rtt_ms`/`drift_ms` (HEARTBEAT), `volume` (0..1, ausente → 1) y `quality` (`auto`/`source`/`720p`/`360p`, ausente → `auto`) en cada snapshot. Contrato completo en [`services/sync-core/AGENTS.md`](../../services/sync-core/AGENTS.md) |
| `SyncTicket` | identity-api (`POST /rooms/:id/sync-ticket`) | `token` (HS256, `role: host`), `expiresAt` |
| `RoomPlayback` | identity-api (`GET /rooms/:id/playback`, host o guest token) | `mediaId`, `url` (GET prefirmado de MinIO), `expiresAt`, `status` (`pending`/`processing`/`ready`/`failed`/null), `ambilightUrl` (solo `ready`), `qualities` (`[{id: source\|720p\|360p, label, url}]`; ausente → solo el original) |
| `UploadTicket` | identity-api (`POST /rooms/:id/media/uploads`, host) | `videoId`, `uploadUrl` (PUT prefirmado), `storageKey`, `expiresAt`, `headers`; se confirma con `POST …/uploads/:videoId/complete` → `mediaId` |
| `RoomGuest` | identity-api (`GET /rooms/:id/guests`, `POST /rooms/:id/guests/:jti/revoke`) | `jti`, `nick`, `joinedAt`, `expiresAt`, `revoked` |
| `AnalyticsTicket` | identity-api (`POST /rooms/:id/analytics-ticket`, host dueño, también con la sala cerrada) | `token` (HS256, `role: host`, `room_id`), `expiresAt` |
| `RoomKpis` / `ReactionHeatmap` / `RoomTimeline` | analytics (`GET /rooms/:id/kpis`, `/reactions/heatmap`, `/timeline`, puerto 8084) | KPIs (`live`, `closed_at`, pico/promedio de espectadores, drift, conteos, buffering, % trivia); `buckets {bucket_start_ms, emoji, count}` + `by_emoji`; `points {t, connected_users, messages, reactions}` |
| `Reaction` | social-core | `user_id`, `emoji`, `position_ms` (bucket de 5 s) |
| `AmbilightFrame` | media-worker (`ambilight.json`) | `t_ms`, `top`, `bottom`, `left`, `right` (hex) |
| `TriviaQuestion` / `TriviaResult` | social-core | `trivia_question{trivia_id, question, options, opens_at_ms, closes_at_ms}`, `trivia_ack{trivia_id, option, score}`, `trivia_result{trivia_id, correct, top[≤10]{user_id, nick, score}, leaderboard[≤10] (acumulado de la sala), my_score, my_total}`; agenda del host `trivia_schedule_state{questions[{trivia_id, at_ms, question, options, correct, answer_window_s, status: pending/open/closed}]}`. Al entrar llegan, en orden: `history`, `chat_settings`, `poll_state`, `trivia_schedule_state` (solo host) y la `trivia_question` abierta |
| `ChatSettings` | social-core | `chat_settings{slow_mode_s, muted_user_ids[]}` (al unirse y en cada cambio) |
| `RoomBan` | identity-api (`GET/POST /rooms/:id/bans`, `DELETE /rooms/:id/bans/:banId`, host dueño) | `id`, `nick`, `createdAt`; `POST` recibe `{jti}` o `{sub}` (404 sin sesiones de invitado, 503 sin servicio) |
| `LibraryVideo` | identity-api (`GET /videos`, host) | `id`, `title` (puede ser null → "Vídeo sin nombre"), `durationMs`, `status` (`processing`/`ready`), `createdAt`, `previewUrl`; se pone en la sala con `PUT /rooms/:id/media {videoId}` → `{mediaId, mediaKey}` (404 si no está disponible) |

## Sistema visual (quiet luxury)
Discord-dark + naranja, con vidrio **solo** en botones, inputs, chips y paneles flotantes: `Card` sigue sólida (decisión de producto).

| Pieza | Rol |
| :--- | :--- |
| `tailwind.config.js` · `src/index.css` | Tokens `shadow-glow`/`shadow-lift`, `bg-accent-sheen` (gradiente cálido del primario), `bg-noise`; utilidades `.tint-glass` (vidrio ligero), `.tint-glass-panel` (diálogos, popovers, toasts; ≥ 80 % opaco para AA), `.tint-eyebrow`, `.tint-shimmer`. |
| `src/lib/motion.ts` | Una curva (`ease`), un `spring` y variantes compartidas `fadeUp`, `fadeBlur`, `pop`, `scaleIn`, `stagger()` (etiquetas `hidden` → `show` → `exit`). No declares duraciones sueltas. `fadeBlur` termina en `filter: none` para no volver al wrapper bloque contenedor de los `fixed`. |
| `src/components/motion/*` | `MotionProvider`, `PageTransition` (cada ruta, `AnimatePresence mode="wait"` en `App`), `StaggerList`/`StaggerItem`, `CountUp`. |
| `src/components/ui/*` | `Button` (`primary`/`ghost`/`quiet`/`danger`, `md`/`sm`, press con spring), `ButtonLink`, `Input`, `useConfirm` (`ConfirmDialog`: `alertdialog` que reemplaza a `window.confirm`). |
| `src/components/layout/AmbientBackground.tsx` | Orbes difusos y grano, decorativos; la raíz de la página necesita `relative isolate`. Estáticos con `prefers-reduced-motion`. |
| `src/components/InvitePopover.tsx` · `WatchRoom` | Bajo `sm` la cabecera de la sala va en dos filas (marca/título/"Invitar" y estado de sincronía/chat); identidad y link de invitación pasan a un popover de vidrio (`aria-expanded`, Escape y clic fuera cierran, el foco vuelve al botón). El halo cálido del reproductor (`data-playing`) respira mientras el `<video>` reproduce y se atenúa en pausa; es el respaldo de `AmbilightGlow`: solo aparece si el vídeo no tiene paleta (`ambilightUrl` null), para no apilar brillos. |
| Confirmaciones | Eliminar sala (Dashboard, CreateRoom) y revocar el link usan `useConfirm`; no uses `window.confirm`. Las pruebas pulsan los botones del `alertdialog`. |

## Canal Sync (implementado, contrato v2)
| Pieza | Rol |
| :--- | :--- |
| `src/lib/syncProtocol.ts` | Tipos del protocolo v2, `toServerMessage`/`parseServerMessage` defensivos, `buildCommand` (con `rate`/`media_id`/`volume`/`quality`), `normalizeVolume`/`normalizeQuality`, `buildSyncCheck`, `expectedPosition`, `estimateServerNow`, `backoffDelay` (500 ms → 10 s), `CLOSE_REVOKED` (4001), `CLOSE_EXPIRED` (4003), `RATE_OPTIONS`/`stepRate`. |
| `src/lib/syncCodec.ts` | Codificación JSON (default) o MessagePack (`tint.sync.msgpack`, `@msgpack/msgpack`); los frames se decodifican según su tipo real. |
| `src/lib/drift.ts` | `computeDrift`, `correctionAction`/`applyCorrection` (seek o `playbackRate` relativo a la velocidad de la sala: `rate × 1.05` atrasado, `rate × 0.95` adelantado), `shouldRestoreRate` (< 100 ms o 5 s; se vuelve a la velocidad de la sala) y `shouldSkipSeekCorrection` (omite el seek en buffering —reproduciendo con `readyState` < 3—, con autoplay bloqueado, con el vídeo terminado y el objetivo en o tras el final, o a < 250 ms del objetivo). |
| `src/lib/syncQuality.ts` | Semáforo: verde RTT < 150 y \|drift\| < 200; amarillo RTT < 400 y \|drift\| ≤ 500; rojo el resto. |
| `src/hooks/useSyncSocket.ts` | Conexión y reconexión (`reconnect: { attempt, nextRetryAt }`); el host pide un sync-ticket en cada intento y el invitado usa `tint_guest_token`. Responde `HEARTBEAT` con `SYNC_CHECK` (lleva la `version` del estado aplicado; sync-core no corrige a un cliente con versión vieja), descarta broadcasts con `version` vieja y, en la misma conexión, `STATE` con `version` menor (el primero de cada conexión siempre aplica: la sala pudo reiniciarse tras el TTL), reconcilia el estado con una `SYNC_CORRECTION` que trae `status`/`rate` (y `media_id`) distintos —broadcast perdido—, devuelve un objeto memoizado (props estables para `SyncedPlayer`), expone `canControl` (`STATE.can_control`/`CONTROL`; host → true antes del 1.er STATE), `rttMs`/`driftMs`, `lastBroadcast` (con `own` por `event_id`) y `revoked` (cierre 4001: no reconecta y borra `tint_guest_token`) y `expired` (cierre 4003, token caducado: el invitado no reconecta y borra `tint_guest_token`; el host pide un sync-ticket nuevo una vez —se rearma al recibir `STATE`— y si se repite se rinde). Si el sync-ticket del host responde 403/404/410 deja de reintentar y expone `fatalError` (`NOT_HOST`/`ROOM_GONE`). `sendCommand` admite PLAY/PAUSE/SEEK/RATE/LOAD/VOLUME/QUALITY (pre-valida `volume` ∈ [0, 1] y `quality`). Expone `volume`/`quality` maestros (STATE, broadcasts —filtrados por `version` como RATE— y `SYNC_CORRECTION`, que solo los pisa si los trae). |
| `src/hooks/useRoomPlayback.ts` | `GET /rooms/:id/playback` al montar, cuando cambia el `media_id` del estado sync y ~1 min antes de `expiresAt` de la URL más nueva. Ese refresco **no** cambia el `src` si es el mismo vídeo: guarda las URLs aparte y las adopta `recover()` (el `<video>` falló: `SyncedPlayer.onMediaError`; sin URLs guardadas pide unas nuevas, como mucho cada 30 s) o `adoptFresh()` (`WatchRoom` al cambiar la calidad maestra). Expone `status`/`ambilightUrl` y, mientras el vídeo está `pending`/`processing`, re-consulta cada 5 s (máx. 120) sin cambiar el `src` (suma las `qualities` nuevas conservando las URLs aplicadas; las publicadas al quedar `ready` también quedan para `recover()`). Expone `qualities`. Si el invitado recibe 401/403 borra `tint_guest_token` y expone `revoked` (pantalla "Tu invitación ya no es válida"). |
| `src/lib/quality.ts` | `normalizeQualities` (servidor sin `qualities` → original), `resolveQuality` (`auto` → 360p con `effectiveType` 2g/3g o `saveData`, 720p con ancho < 640 px; si no, 720p salvo `navigator.connection.downlink` ≥ 10 Mbps → original; sin Network Information API → 720p; la pedida que no exista cae al original) y `QUALITY_LABELS`. |
| `src/lib/upload.ts` | Subida directa al Blob Storage: `requestUpload` → `uploadToBlob` (XHR `PUT` con progreso, cabeceras exactas, sin `Authorization`, `AbortSignal`) → `completeUpload`; `uploadErrorMessage` (413/409/403/404/410) con mensajes simples, sin jerga técnica (nada de HTTP, MinIO ni bucket). |
| `src/lib/videos.ts` | Biblioteca: `listVideos` (`GET /videos`), `assignVideo` (`PUT /rooms/:id/media {videoId}`), `assignVideoErrorMessage`, `formatDuration` ("45 s", "1 min 05 s", "1 h 30 min"), `videoStatusLabel` ("Listo"/"Preparando…") y `videoTitle`. |
| `src/lib/bans.ts` | `banGuest` (`{jti}` o `{sub}`), `listBans`, `unbanGuest` y `banErrorMessage` (404/503/403 en palabras simples). |
| `src/hooks/useSyncToasts.ts` · `src/components/sync/*` | Avisos de comandos ajenos (3 s, máx. 3, `aria-live`), semáforo de sincronía y "Reconectando… intento N · S s". |
| `src/hooks/usePlayerShortcuts.ts` | Atajos para quien controla: Espacio/K, ←/→ y J/L (±10 s), `[`/`]` (velocidad), `?` (ayuda); ignorados en campos de texto y si otro control ya atendió la tecla (`defaultPrevented`). Con puntero láser disponible, `L` lo alterna (ver `HostControlBar`) y la ayuda lo muestra en lugar de "avanzar". |
| `src/components/player/SeekBar.tsx` | Barra de cine `role="slider"` (teclado y puntero), búfer, tiempo bajo el cursor y marcadores de saltos del host. |
| `src/components/SyncedPlayer.tsx` | `React.memo`. `<video>` gobernado por el estado maestro: cada estado aplica velocidad y play/pausa, pero solo hace seek si la deriva supera 250 ms reproduciendo (50 ms en pausa), así `VOLUME`/`QUALITY`/`RATE` no hacen saltar a nadie; los seeks de corrección siguen `shouldSkipSeekCorrection`. Controles habilitados por `canControl`; barra del host (`HostControlBar`); aviso "Host desconectado" y de control temporal delegado; botón de autoplay (solo con `NotAllowedError`; un `AbortError` se ignora); fundido al corregir con seek y en saltos > 2 s (sin él con `prefers-reduced-motion`); re-aplica el estado al cambiar el `src`; `onMediaError` ante `MEDIA_ERR_NETWORK`/`SRC_NOT_SUPPORTED` (URL caducada); el progreso solo re-renderiza si avanzó ≥ 250 ms (o tras un seek), la duración y el búfer solo si cambian. `WatchRoom` le pasa props estables (`useCallback`, `useMemo` de la capa láser); el láser a 30 Hz sí la cambia y re-renderiza el reproductor, es lo esperado; tras un `LOAD`, hasta que llega la URL nueva, el heartbeat informa la posición esperada en vez de la del vídeo anterior; aplica el `volume` maestro a todos (el participante tiene un silencio local, `aria-pressed`) y cambia el `src` a la calidad maestra resuelta. |
| `src/components/host/*` | Paneles del host: "Cambiar vídeo", con pestañas (`role="tablist"`, flechas) "Mis vídeos" (cuadrícula con miniatura `<video preload="metadata" muted>` de `previewUrl`, título, duración, estado, búsqueda por nombre, estado vacío y "Ver en la sala" → `PUT media {videoId}` → `LOAD{media_id}`; se recarga tras subir; `openRequest` lo abre desde el recap) y "Subir nuevo" (subida desde el navegador con progreso y cancelar → `LOAD{media_id}`), y "Participantes" (listar —se refresca cada 10 s y con "Actualizar"—, retirar o bloquear invitados con confirmación y sección "Bloqueados" con "Desbloquear"). `HostControlBar` (solo con `canControl`, dentro de `SyncedPlayer`): volumen + silencio de la sala (`VOLUME`, deslizador con debounce de 150 ms), calidad (`Auto` + `playback.qualities` → `QUALITY`), velocidad (`RATE`, atajos `[`/`]`), puntero láser (atajo `L`: escucha en captura sobre `window` y hace `preventDefault`, así `usePlayerShortcuts` no avanza 10 s; ignorado en campos de texto) y "Crear encuesta". |

## Canal Social: interacción del host
JSON sobre `useSocialSocket` (`src/lib/socialSocket.ts`); social-core es autoritativo (permisos, conteos, cierres).

- **Credencial:** social-core solo acepta láser y crear/cerrar encuestas con tokens HS256 de identity-api con `role` host/cohost de la sala (el ID token de Firebase recibe `FORBIDDEN`). Por eso `WatchRoom` abre el canal con `role: 'host'` → `useSocialSocket` pide un sync-ticket (`POST /rooms/:id/sync-ticket`) en cada (re)conexión (403/404/410 → deja de reintentar, `status: 'closed'`); con `role: 'guest'` usa `tint_guest_token`.
- **Límites de social-core:** láser 30/s (incluido `end: true`); votos + `recap_request` comparten 10/s.

| Pieza | Rol |
| :--- | :--- |
| Puntero láser | Envía `laser_point{type, event_id, room_id, x, y, end?}` (x, y normalizados 0..1, 4 decimales) y recibe `laser{event_id, user_id, nick, x, y, end}`. `useSocialSocket` expone `laser` (últimos 64 puntos) y `sendLaser(x, y, end?)`, que pinta el punto propio al instante y descarta su eco por `event_id`. |
| `src/components/LaserOverlay.tsx` | Lienzo sobre el área del vídeo (`SyncedPlayer.overlay`); el host con el modo láser dibuja con eventos de puntero (ventana deslizante de 30 puntos/s contando el final: los movimientos usan como máximo 29 y dejan el hueco del `end`) y todos ven el trazo suavizado (curvas cuadráticas, núcleo blanco y halo en el acento) que se desvanece en 2,5 s (`LASER_FADE_MS`; `requestAnimationFrame`, con guardas para jsdom). Al soltar (`end`) queda un marcador con anillo pulsante y el `nick` del host durante 3 s (`LASER_MARKER_MS`, `drawMarker`). El primer punto se envía al confirmar el arrastre (> 4 px): un clic sin arrastre llega como un único punto con `end`, que el receptor (sin trazo abierto de ese usuario) pinta como un "ping" de ondas (`LASER_PING_MS`, `drawPing`). Cursor SVG propio y ayuda breve la primera vez ("Arrastra para dibujar · haz clic para señalar", `localStorage.tint_laser_hint_seen`). La edad de cada punto usa el reloj local de llegada, nunca el del emisor. |
| Encuestas | Envía `poll_create{question, options[2–4], duration_s}` (30/60/120/300 s), `poll_vote{poll_id, option}` (índice) y `poll_close{poll_id}`; recibe `poll_state{poll_id, question, options, counts, closes_at_ms, closed, my_vote?}`. `my_vote` solo llega en el `poll_state` dirigido a este cliente (al entrar o al votar): `useSocialSocket` recuerda el último visto por `poll_id` (y el propio, optimista). Expone `poll`, `lastError` (`error{code, event_id_ref}`: FORBIDDEN, POLL_ACTIVE, POLL_CLOSED, POLL_NOT_FOUND, UNAVAILABLE, RATE_LIMITED; se limpia al enviar), `createPoll` (pre-valida con `validatePollDraft`), `votePoll` y `closePoll`. |
| `src/components/PollPanel.tsx` | Creador del host (pregunta, 2–4 opciones, duración; el botón "Crear encuesta" de la barra lo abre con el foco en la pregunta), tarjeta con botones de voto (`aria-pressed`), barras con porcentaje, cuenta atrás (solo informativa: el cierre lo decide `closed`, no el reloj local), "Cerrar encuesta" para el host y resultados finales. |
| Moderación del chat | Envía `chat_slow_mode{seconds ∈ 0/5/10/30/60}` y `chat_mute{user_id, muted}` (host/cohost) y `chat_send{…, spoiler?}`; recibe `chat_settings` y `chat_message{…, spoiler?}`. `useSocialSocket` expone `chatSettings`, `setSlowMode`, `muteUser`, `send(text, {spoiler})` y `chatCooldownUntil` (reloj local: `retry_after_ms` del `error{code:"SLOW_MODE"}` o, para el invitado, `slow_mode_s` tras enviar). Errores nuevos (`socialErrorMessage`): SLOW_MODE (único con `retry_after_ms`), MUTED, UNAVAILABLE (chat sin servicio), TRIVIA_NOT_FOUND, TRIVIA_CLOSED (también al borrar una pregunta ya lanzada), ALREADY_ANSWERED. Host y cohost están exentos del modo lento y del silencio. |
| `src/components/chat/ChatPanel.tsx` | Chat extraído de `WatchRoom` (alto `60dvh`, pie de vidrio `tint-glass` con `Input`/`Button`; solo entran animados con `fadeUp` los mensajes que no estaban en el primer render, `data-enter`; menús y confirmaciones en `tint-glass-panel`, confirmar con `danger`): selector "Modo lento" del host; aviso y cuenta regresiva en "Enviar" para el invitado; silenciado → campo deshabilitado "El host te silenció; puedes leer el chat"; menú del host (`aria-haspopup="menu"`, Escape) en mensajes ajenos con "Silenciar / Quitar silencio" y "Bloquear de la sala" (confirmación → `POST /rooms/:id/bans {sub}`); botón "Spoiler" (`aria-pressed`) y texto difuminado hasta hover, revelado con foco de teclado (`aria-label` "Spoiler oculto, enfoca para leer") y alternado con el toque. |
| Trivia | Envía `trivia_schedule{at_ms, question, options[2–4], correct, answer_window_s(10–60, 20)}`, `trivia_delete{trivia_id}`, `trivia_list` (tras programar/borrar; al conectar la agenda llega sola en la instantánea) y `trivia_answer{trivia_id, option}`. `useSocialSocket` expone `trivia` (`question`, `receivedAt`, `ack`, `result`, `myOption`), `triviaSchedule` (ordenada por `at_ms`), `scheduleTrivia` (pre-valida con `validateTriviaDraft`), `deleteTrivia`, `listTrivia`, `answerTrivia` y `dismissTrivia`. El puntaje y el disparo exacto son de social-core. |
| `src/components/quiz/TriviaPanel.tsx` | `TriviaPanel`: el host pulsa "Agregar pregunta en este momento" (toma el `currentTime`, campo mm:ss editable con `parseMmSs`), escribe la pregunta, 2–4 respuestas con la correcta marcada y el tiempo para responder; lista por tiempo con estado ("Pendiente"/"En curso"/"Terminada") y "Eliminar"; `at_ms` de 0 a 24 h. `TriviaPopup`: tarjeta emergente sobre el reproductor con cuenta regresiva (anclada al reloj local de llegada + `closes_at_ms − opens_at_ms`, sin comparar relojes), opciones y "¡Responde rápido: más puntos!"; el `trivia_ack` solo muestra "Respuesta enviada" (no revela si acertó); al `trivia_result`, respuesta correcta, puntos propios, total en la sala, top 10 de la pregunta y ranking acumulado de la sala. |
| Recap | Envía `recap_request{event_id, room_id}` y recibe `recap{room_id, event_id_ref?, top_emoji_user, most_paused, peak_reactions, totals}` (los tres primeros pueden ser null). `useSocialSocket` expone `recap` y `requestRecap`. |
| `src/components/RecapScreen.tsx` | Diálogo modal "Watch Party Recap" (`aria-modal`, foco en "Cerrar", Escape): 🏆 quien mandó más emojis, ⏸️ escena con más pausas/retrocesos y 😂 momento con más reacciones/risas (`mm:ss` con `formatMmSs`), más totales; mensajes amables para los nulos. `src/hooks/useRecapGate.ts` decide cuándo se ve: **una sola vez por `media_id`** (al `ended`, pidiendo el recap con estado de carga, o al llegar uno sin pedirlo); ignora los `ended` repetidos (el drift re-posiciona el vídeo cerca del final) y los recaps nuevos del mismo vídeo tras cerrarlo; otro vídeo o "Volver a verla" lo rearman. Al terminar, el host envía `PAUSE` en la posición final. El host elige qué sigue: "Elegir otra película" (abre "Mis vídeos"), "Volver a verla" (`SEEK 0` + `PLAY`) o "Terminar la sala" (confirmación → `DELETE /rooms/:id` → `/dashboard`). El invitado ve "Esperando a que el host decida qué sigue…" y, si lo expulsan (4001) después del final, "El host terminó la sala". |

## Marca y Ambilight
| Pieza | Rol |
| :--- | :--- |
| `public/logo.svg` · `public/favicon.svg` | Logo vectorizado a mano desde `Logo.png` (anillo abierto, "T" en línea doble y llama; gradiente `#FFC93C` → `#FF8A1A`, fondo transparente) y su variante simplificada de trazo grueso para 16/32 px. `apple-touch-icon.png` (180 px, fondo `tint.bg`), `icon-192.png` e `icon-512.png` se generan con `rsvg-convert`/`magick` desde el SVG; `manifest.webmanifest` y `theme-color` se enlazan en `index.html` (lo verifica `src/indexHtml.test.ts`). |
| `src/components/brand/TintLogo.tsx` | SVG en línea con prop `size`; por debajo de 24 px usa la variante simplificada. `role="img"` + `aria-label` ("TINT" por defecto) o `decorative` (`aria-hidden`) cuando un enlace o texto ya nombra la marca. Gradiente con id único por instancia (`useId`). Lo usan `BrandMark` (AppShell y cabecera de WatchRoom) y Login. |
| `src/lib/ambilight.ts` | `parseAmbilight` (valida `[{t_ms, top, right, bottom, left}]` en hex y ordena), `findFrameIndex` (búsqueda binaria), `mixHex` y `colorsAt` (interpola entre frames vecinos). |
| `src/hooks/useAmbilight.ts` | Descarga la paleta de `useRoomPlayback().ambilightUrl` una vez por vídeo (la clave ignora la firma de la URL, así un refresco no vuelve a descargar) y muestrea a ~4 Hz (`AMBILIGHT_SAMPLE_MS` = 250 ms, `setInterval`; el primer color es inmediato) los colores según `videoRef.current.currentTime`, ya que la transición CSS dura 700 ms; solo actualiza el estado si cambian. Sin URL, desactivado o con error de descarga → `null`. No lee el canvas del vídeo (sin `crossOrigin` ni canvas "tainted"). |
| `src/components/player/AmbilightGlow.tsx` | Envuelve la tarjeta del reproductor: cuatro manchas por lado (máscara radial) detrás, con transición de color de 700 ms (sin transición ni interpolación con `prefers-reduced-motion`). Interruptor `role="switch"` "Ambilight" (solo con paleta), preferencia en `localStorage.tint_ambilight` vía `src/lib/safeStorage.ts` (try/catch). Sin `ambilightUrl` no hay brillo. |

## Sesión y credenciales
- **Host:** `tint_token` guarda el ID token de Firebase (caduca a la hora). `src/lib/authSession.ts` (`startHostSession`, llamado en `main.tsx`) lo mantiene fresco con `onIdTokenChanged` y registra en `apiFetch` un proveedor que pide `auth.currentUser.getIdToken()`. Ante un 401 con credencial de host, `apiFetch` fuerza un refresco y reintenta una vez; si sigue en 401 borra `tint_token` y lleva a `/login?next=<ruta actual>`.
- **Invitado:** `tint_guest_token` (+ `tint_room_title`/`tint_invite_link` guardados al canjear) solo da acceso a `/watch/:roomId` si su payload (`guestTokenGrantsRoom`, sin verificar firma) tiene `room_id` igual a la sala y `exp` futuro; si no, se muestra la puerta.
- **Dispositivo:** `src/lib/deviceId.ts` genera `tint_device_id` (`crypto.randomUUID`, guardado con `safeStorage`; respaldo en memoria) y `InviteLanding` lo envía como `deviceId` en `POST /invitations/claim` (se omite si no hay UUID). Un 403 `BANNED` muestra "El host te bloqueó en esta sala". El bloqueo es por dispositivo: borrar los datos del navegador lo evade (limitación documentada en `docs/usuarios-e-identidad.md`).
- **Host en una invitación:** `InviteLanding` no borra `tint_token` en silencio: avisa de la sesión de host, ofrece "Entrar como host" (busca la sala en `GET /rooms` por el código) y solo canjea —y cierra la sesión de host— tras pulsar "Entrar como invitado". Tras crear una sala, `CreateRoom` ofrece "Entrar a la sala" (`/watch/:id`).

El cálculo del drift es **autoritativo en sync-core**: el cliente solo aplica las `SYNC_CORRECTION` que recibe. Flujos y diagramas en [`docs/dominio-reproduccion.md`](../../docs/dominio-reproduccion.md).

## Analítica
| Pieza | Rol |
| :--- | :--- |
| `src/lib/stallTracker.ts` · `SyncedPlayer` | Mide cada stall del `<video>` (`waiting` → siguiente `playing`). Descarta los < 100 ms, los > 120 s (sync-core los rechazaría) y los causados por un seek (`waiting` entre `seeking` y `seeked`, o `seeking` durante la espera: saltos del usuario, `SEEK` de la sala y correcciones por seek); `emptied` lo reinicia. |
| `useSyncSocket().sendBuffering` · `buildBuffering` | Envía `BUFFERING {event_id, room_id, position_ms, duration_ms, occurred_at}` con la codificación negociada (JSON/msgpack), solo con el socket abierto. Cualquier rol; sin ACK ni broadcast. |
| `src/lib/analytics.ts` | `getAnalyticsTicket` (`POST /rooms/:id/analytics-ticket` en identity-api) y `createAnalyticsClient(roomId)` → `kpis()`, `heatmap(bucketMs = 5000)`, `timeline(stepS = 60)` contra `VITE_ANALYTICS_API_URL` con el ticket como Bearer. Ante un 401 de analytics pide **un** ticket nuevo (compartido entre peticiones paralelas) y reintenta; los errores son `AnalyticsError {status}` (0 = red). |
| `src/pages/RoomAnalytics.tsx` | Ruta `/rooms/:id/analytics` (host, `ProtectedRoute`, `React.lazy`), enlazada desde "Análisis" en cada tarjeta del Dashboard. Insignia "En vivo"/"Sesión cerrada" (`kpis.live`/`closed_at`), 8 KPIs, botón "Actualizar" y estado vacío sin actividad. 401 de identity-api → `/login?next=`; 403 → sin acceso; 401 de analytics tras reintentar → acceso caducado o revocado; 503/red → servicio no disponible. |
| `src/components/analytics/*` · `src/lib/chartScale.ts` | Gráficos SVG propios (sin librería): espectadores en el tiempo (área + línea, crosshair por puntero y teclado como `role="slider"`), reacciones por emoji (barras, > 8 se agrupan en "Otros") y heatmap de reacciones por posición del vídeo (rampa ordinal de 4 pasos; > 60 columnas se agrupan). Cada uno tiene `aria-label` con resumen, tabla alternativa en `<details>` y estado vacío. Colores en `CHART_COLORS` (`ChartCard.tsx`), validados con la skill `dataviz` sobre `tint.card`. |

## Cuestionario oculto `/test-me`
Ruta sin `ProtectedRoute` ni enlaces desde la UI (solo por URL) para aprender cómo funciona el monorepo. Se carga con `React.lazy` para no sumar el banco de preguntas ni las features completas de `motion` al bundle principal.

| Pieza | Rol |
| :--- | :--- |
| `src/data/quizQuestions.ts` | Banco de 60 preguntas en 7 categorías; cada una cita sus archivos fuente. Su prueba verifica que las rutas existan en el repo, el conteo por categoría y que la respuesta correcta no se concentre en una posición. |
| `src/lib/quiz.ts` | Lógica pura: baraja (rng inyectable), 100 pts por acierto con multiplicador de racha (x2 desde 3, x3 desde 5), rangos y reducer. |
| `src/lib/quizSounds.ts` | Efectos sintetizados con Web Audio (sin archivos); silencio persistido en `localStorage.tint_quiz_muted`. |
| `src/hooks/useQuiz.ts` · `src/components/quiz/*` · `src/pages/TestMe.tsx` | Estado + sonidos, tarjeta, panel inferior con respuesta y fuentes, marcador y resumen con confeti. |

Si cambia un dato documentado (puertos, contratos, límites), actualiza la pregunta correspondiente. Al agregar preguntas, ajusta `expected` de la categoría y cita solo datos en los que la documentación no se contradiga.

## Mapa oculto `/arquitectura`
Ruta hermana de `/test-me` (sin `ProtectedRoute` ni enlaces desde la UI, `React.lazy`): el diagrama de componentes y conectores de [`docs/arquitectura.md` §4](../../docs/arquitectura.md#vista-de-componentes-y-conectores) y cinco historias de usuario que se recorren salto a salto. Dos modos: **Recorrer** (paso a paso, con qué viaja, por qué conector y por qué se decidió así) y **Predecir** (antes de cada salto se hace clic en el componente que recibe el mensaje; al terminar salen las preguntas de `/test-me` de esa historia).

| Pieza | Rol |
| :--- | :--- |
| `src/data/architecture.ts` | Los 10 componentes (con su posición en el `viewBox`) y los conectores C1–C15, con los pares de componentes que une cada uno. |
| `src/data/architectureStories.ts` | Las historias: cada paso tiene `from`, `to`, `connector` (null si es interno), `ask` (pregunta de Predecir, sin nombrar el destino), `message`, `detail`, `why` y `sources`; `quizIds` enlaza preguntas de `quizQuestions.ts`. Su prueba verifica que el conector de cada paso una de verdad a sus dos componentes, que ningún paso salga de un componente que aún no participó y que las fuentes y los `quizIds` existan. |
| `src/lib/archSim.ts` | Lógica pura: aristas (`buildEdges`, una por par de componentes), geometría (`EDGE_BENDS` curva las aristas que pasarían por detrás de otro nodo) y el reducer de los dos modos (puntaje con `multiplierFor` de `quiz.ts`). |
| `src/components/arch/*` · `src/pages/Arquitectura.tsx` | `ArchDiagram` (SVG propio; continuo = síncrono, grueso = WebSocket, punteado = asíncrono por Redis, igual que la leyenda de `docs/`; nodos `role="button"` con teclado; el paquete no se anima con `prefers-reduced-motion`), `StepPanel`, `NodeCard` (ficha del componente) y `RelatedQuiz` (reutiliza `QuizCard`/`AnswerPanel`). Flechas ←/→ para avanzar y retroceder. |

Si cambia un conector o un flujo en `docs/`, actualiza `architecture.ts` y la historia afectada. Una historia nueva se transcribe de un diagrama de secuencia de `docs/` y cita su fuente en cada paso; no inventes saltos.

## Reglas de Dominio
1. **Canales Aislados:** Mantén el uso de dos hooks separados: `useSyncSocket` (vídeo/comandos) y `useSocialSocket` (chat y su moderación, reacciones, láser, encuestas, trivia, recap). Nunca mezcles los sockets. El Ambilight no usa sockets: se descarga por HTTP (`useAmbilight`).
2. **Auto-Alineación:** sync-core detecta el desfase (> 500 ms) y lo reporta a telemetría; el cliente aplica la corrección recibida con `src/lib/drift.ts` y nunca envía telemetría de sync por su cuenta. La única excepción es `BUFFERING` (ver "Analítica"), que viaja por el Canal Sync y lo publica sync-core.
3. **Throttling UI:** Garantiza que los botones de reacción no permitan más de 5 clics/segundo por usuario (`src/hooks/useThrottle.ts`).
4. **Accesibilidad:** Controles con `aria-label`, foco visible y contraste AA sobre fondo oscuro.
5. **TDD & Cobertura:** Todo componente, hook o utilidad debe contar con pruebas unitarias en Vitest escritas **antes** de la implementación (Red → Green → Refactor). Cobertura mínima **85%** (statements, branches, functions, lines) — configurada en `vitest.config.ts`.

## Comandos
```bash
npm ci
npm run dev             # servidor de desarrollo
npm run lint            # ESLint
npm run typecheck       # tsc
npm run test:coverage   # Vitest + umbral 85%
```

## Variables de Entorno
| Variable | Por defecto | Descripción |
| :--- | :--- | :--- |
| `VITE_IDENTITY_API_URL` | `http://localhost:8081/api/v1` | identity-api (salas, invitaciones, sync-tickets). |
| `VITE_SYNC_WS_URL` | `ws://localhost:8083/ws/sync` | Canal Sync de sync-core. |
| `VITE_SOCIAL_WS_URL` | `ws://localhost:8082/ws/social` | Canal social de social-core (chat y su moderación, reacciones, láser, encuestas, trivia y recap). |
| `VITE_SYNC_ENCODING` | `json` | Codificación del Canal Sync: `json` o `msgpack` (pide el subprotocolo `tint.sync.msgpack`; si sync-core no lo acepta, sigue en JSON). |
| `VITE_DEMO_VIDEO_URL` | vacío | Vídeo de respaldo, solo si la sala no tiene vídeo asignado en identity-api (`mediaId: null`). |
| `VITE_ANALYTICS_API_URL` | `http://localhost:8084/api/v1` | API de lectura de analytics (página `/rooms/:id/analytics`). |
