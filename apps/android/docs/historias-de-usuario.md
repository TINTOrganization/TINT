# Historias de usuario de la app Android (segunda ronda)

> Derivadas de un recorrido completo de la plataforma web (`apps/web`), de los documentos de `docs/` y de las 98 historias
> que ya existen en GitHub. Continúan la numeración de `AND-01` a `AND-09`, que ya están hechas.
> El texto de cada historia va **en inglés y con el mismo formato que los tickets**, para poder pegarlo tal cual como
> issue. Los mockups que las ilustran están en el artefacto «Mockups TINT Android» (ver [Mockups](#mockups)).

## 1. Lo que ya está hecho

| Ticket | Historia | Estado |
| :--- | :--- | :---: |
| AND-01 | Google sign-in on Android | ✅ |
| AND-02 | Join a room by link or code | ✅ |
| AND-03 | Synchronized playback on mobile | ✅ |
| AND-04 | Chat and reactions on mobile (incluye spoilers, modo lento y silencio) | ✅ |
| AND-05 | Trivia on mobile | ✅ |
| AND-06 | Live stream on mobile | ✅ |
| AND-07 | Voice on mobile | ✅ |
| AND-08 | Shared endpoints with the web | ✅ |
| AND-09 | Installable APK | ✅ |
| — | Ver y votar encuestas, ver el láser del host (sin ticket propio) | ✅ |

La app de hoy es una **app de invitado**: entra con un link, mira, chatea, reacciona, responde la trivia y habla. Las
historias nuevas cierran la distancia con la web en tres frentes: **cómo se ve y se maneja en cada pantalla**
(AND-10 a AND-13), **lo que un invitado hace en la web y la app todavía no** (AND-14 a AND-25) y **ser host desde el
móvil** (AND-26 a AND-36), más calidad (AND-37 y AND-38).

## 2. Quién usa la app

| Rol | Cómo entra | Qué puede hacer | Fuente |
| :--- | :--- | :--- | :--- |
| **Invitado** (`participant`) | Link o código + nick, sin cuenta; token de 4 h | Ver, chatear, reaccionar, responder trivia y encuestas, hablar | [usuarios-e-identidad §2](../../../docs/usuarios-e-identidad.md#2-matriz-de-permisos) |
| **Host** | Cuenta de Google (Firebase) | Todo lo anterior, más crear y gestionar salas, controlar la reproducción, moderar, trivias, encuestas, láser, analítica | ídem |
| **Invitado delegado** | Un invitado elegido por sync-core cuando el host cae 5 min | Controla la reproducción de forma temporal | ídem |

Fuera del alcance de Android, a propósito: la analítica de negocio de TINT (`/analitica`, protegida por contraseña), la
página de arquitectura (`/arquitectura`) y las páginas de pruebas (`/test-me`).

## 3. Tamaños de pantalla

Los mockups usan estos cuatro formatos, más la pantalla completa. Se eligen por el tamaño de ventana (`WindowSizeClass`
de Compose), no por el modelo del aparato.

| Formato | Tamaño de referencia | Clase de ancho | Dispositivo real de prueba |
| :--- | :--- | :--- | :--- |
| Móvil vertical | 390 × 844 dp | Compacto | — |
| Móvil horizontal | 844 × 390 dp | Medio (alto compacto) | — |
| Tableta vertical | 800 × 1280 dp | Medio | Galaxy Tab S6 Lite (1200 × 2000 px a 240 dpi) |
| Tableta horizontal | 1280 × 800 dp | Expandido | ídem |
| Pantalla completa horizontal | cualquiera, sin barras | — | el video solo, con controles superpuestos |

## 4. Mapa de las historias

| ID | Historia | Prioridad | Rol | Referencia en la web | Mockups |
| :--- | :--- | :---: | :--- | :--- | :--- |
| AND-10 | Adaptive room layout | P0 | Invitado | `WatchRoom.tsx` en móvil y escritorio | M05–M08 |
| AND-11 | Fullscreen landscape video | P0 | Invitado | `SyncedPlayer` a pantalla completa | M09, M10 |
| AND-12 | Rotation keeps the session | P1 | Invitado | — | M05–M08 |
| AND-13 | Picture-in-picture | P3 | Invitado | — | — |
| AND-14 | Invitation preview before joining | P2 | Invitado | WEB-02, `InviteLanding.tsx` | M01, M02 |
| AND-15 | Recent rooms shortcut | P3 | Invitado | IDN-06 | M01, M02 |
| AND-16 | Floating reactions over the video | P1 | Invitado | `ReactionOverlay.tsx` | M05–M10 |
| AND-17 | Personal volume and quality | P2 | Invitado | `SyncedPlayer` (volumen, calidad) | M05–M10 |
| AND-18 | Sync and connection status | P1 | Invitado | `SyncStatus.tsx`, `SyncToasts.tsx` | M05–M08 |
| AND-19 | Room leaderboard | P2 | Invitado | `ScoreHud`, `QuizSummary` | M07, M08 |
| AND-20 | Voice participants and speaking indicator | P2 | Invitado | VOI-03, `VoicePanel.tsx` | M05, M07, M08 |
| AND-21 | End-of-event recap | P2 | Invitado | `RecapScreen.tsx` | M18 |
| AND-22 | Invite friends from the room | P2 | Invitado | `InvitePopover.tsx` | M05–M08 |
| AND-23 | Ambilight glow | P3 | Invitado | `AmbilightGlow.tsx`, issue #1 | M07 |
| AND-24 | Live viewer on every screen | P1 | Invitado | `ViewerStage.tsx` | M13, M14 |
| AND-25 | Event chat history | P2 | Host | `EventChatHistory.tsx` | M03, M04 |
| AND-26 | Go live from the phone | P3 | Host | `HostStudio.tsx` (RTC-01) | — |
| AND-27 | Host home: My rooms | P1 | Host | WEB-04, `Dashboard.tsx` | M03, M04 |
| AND-28 | Create a room | P1 | Host | IDN-03, `CreateRoom.tsx` | M15 |
| AND-29 | Manage a room | P1 | Host | IDN-05, `CreateRoom.tsx` en `/rooms/:id` | M16 |
| AND-30 | Host controls playback | P1 | Host | SYN-01, `HostControlBar.tsx` | M11, M12 |
| AND-31 | Choose or upload the video | P2 | Host | MED-01, MED-03, `ChangeVideoPanel.tsx` | M11, M12 |
| AND-32 | Moderate guests and chat | P2 | Host | SOC-03, SOC-04, SOC-05, SOC-09, `ParticipantsPanel.tsx` | M11, M12 |
| AND-33 | Run polls and the laser pointer | P2 | Host | `PollPanel.tsx`, `LaserOverlay.tsx` | M11, M12 |
| AND-34 | Schedule trivia and see the ranking | P2 | Host | GAM-01, GAM-04, `TriviaPanel.tsx` | M11, M12 |
| AND-35 | Host mutes in voice | P2 | Host | VOI-04 | M11, M12 |
| AND-36 | Room analytics | P2 | Host | ANA-02, `RoomAnalytics.tsx` | M17 |
| AND-37 | Accessibility | P1 | Todos | — | todos |
| AND-38 | Verified app links and release build | P2 | Todos | — | — |

Prioridad: **P0** sin esto la app no es usable en tableta ni en horizontal · **P1** paridad básica con la web ·
**P2** paridad completa · **P3** deseable o diferido, con motivo.

---

## 5. Épica A — Pantallas y orientaciones

### AND-10: Adaptive room layout
**User Story:**
As a mobile viewer, I want the room screen to adapt to my device and orientation, so that I use the whole screen well instead of a stretched phone layout.

**Acceptance Criteria:**
- [ ] AC1. Given a phone in portrait, when the room opens, then the video is on top and the chat, voice, trivia, polls and participants are in tabs below it.
- [ ] AC2. Given a phone in landscape, when the room opens, then the video fills the left side and the chat sits in a side panel on the right.
- [ ] AC3. Given a tablet, when the room opens, then portrait shows the video on top with two columns below, and landscape shows the video with controls on the left and a social rail on the right, like the web.

### AND-11: Fullscreen landscape video
**User Story:**
As a mobile viewer, I want to watch the video in fullscreen landscape with controls over it, so that I get a cinema-like view without losing the room.

**Acceptance Criteria:**
- [ ] AC1. Given the user taps the fullscreen button or rotates to landscape, when fullscreen starts, then the system bars hide and the video fills the screen.
- [ ] AC2. Given fullscreen, when a reaction, laser point, poll, trivia question or chat message arrives, then it appears over the video without leaving fullscreen.
- [ ] AC3. Given fullscreen, when the user taps the video, then the controls show or hide, and pressing back exits fullscreen to the room.

### AND-12: Rotation keeps the session
**User Story:**
As a mobile viewer, I want the app to keep my place when I rotate or split the screen, so that I do not rejoin, lose the chat or interrupt my voice.

**Acceptance Criteria:**
- [ ] AC1. Given the user rotates the device, when the layout changes, then playback, chat history, the open trivia question and the voice connection continue without reconnecting.
- [ ] AC2. Given the user puts the app in split-screen or resizes the window, when the width class changes, then the layout switches to the matching format.
- [ ] AC3. Given the user leaves the room screen and comes back, when the room is still active, then they land on the same room with the current playback position.

### AND-13: Picture-in-picture
**User Story:**
As a mobile viewer, I want the video to keep playing in a small window when I switch apps, so that I can reply to a message without leaving the watch party.

**Acceptance Criteria:**
- [ ] AC1. Given the video is playing, when the user presses home, then it continues in a picture-in-picture window.
- [ ] AC2. Given the picture-in-picture window, when the host pauses or seeks, then the window follows within 1 s.
- [ ] AC3. Given the user taps the window, when it expands, then the room screen returns in its previous layout. *(Deferred: voice cannot capture the microphone in the background without a foreground service.)*

## 6. Épica B — Entrada

### AND-14: Invitation preview before joining
**User Story:**
As an invited guest, I want to see the room title and the kind of room before I choose a nick, so that I know I opened the right invitation.

**Acceptance Criteria:**
- [x] AC1. Given a valid invitation link, when the join screen opens, then the room title and whether it is a movie or a live event are shown above the nick field. *(Hecho en parte: `GET /invitations/:code` solo devuelve título y vencimiento, no el tipo de sala; se muestran título y «Vence en …». El tipo exigiría ampliar la respuesta de identity-api, otro dominio.)*
- [x] AC2. Given an invalid, revoked or expired link, when the join screen opens, then a clear message says the invitation is not valid and offers to type another code.
- [x] AC3. Given the room was banned for this device, when the user submits, then the message says the host blocked them in this room.

### AND-15: Recent rooms shortcut
**User Story:**
As a mobile viewer, I want the app to remember the rooms I joined recently, so that I can return to one without the link.

**Acceptance Criteria:**
- [x] AC1. Given the user joined a room in the last 4 hours, when the home opens, then that room is listed with its title and a Rejoin button. *(Hecho en la pantalla de entrada: las 5 últimas salas, sin límite de 4 h; tocar una rellena el código.)*
- [x] AC2. Given the guest token expired or the room was disabled, when the list opens, then the room is marked as ended and cannot be opened. *(Al tocarla, la vista previa dice que no sirve y «Entrar» queda desactivado.)*
- [x] AC3. Given the user taps Forget, when confirmed, then the room disappears from the list. *(P3: guest tokens last 4 h, so the list is short-lived.)*

## 7. Épica C — Experiencia de espectador

### AND-16: Floating reactions over the video
**User Story:**
As a mobile viewer, I want reactions to float up over the video, so that I feel the room's reaction at the right moment, also in fullscreen.

**Acceptance Criteria:**
- [ ] AC1. Given someone reacts, when the reaction arrives, then its emoji floats over the video for about two seconds.
- [ ] AC2. Given many reactions arrive at once, when they are displayed, then the screen shows a bounded number and does not hide the video.
- [ ] AC3. Given an unknown reaction type, when it is received, then it is ignored.

### AND-17: Personal volume and quality
**User Story:**
As a mobile viewer, I want to mute the room only for myself and choose the video quality, so that I can save data or silence the video without affecting others.

**Acceptance Criteria:**
- [x] AC1. Given the user taps the speaker, when it is muted, then only their device is silent and the sync is not affected.
- [x] AC2. Given the quality menu, when the user picks Auto, 720p or 360p, then the player switches without losing the sync position. *(Solo en películas: la transmisión en vivo no ofrece elegir capa. El cambio reanuda en la posición actual y la sincronía la corrige. Pendiente de probar en el aparato.)*
- [x] AC3. Given the connection is on mobile data, when the user opens the menu, then the current quality and an estimate of data per hour are shown. *(La estimación es un tope calculado con el bitrate máximo de media-worker: 360p ≈ 0,5 GB/h, 720p ≈ 1,4 GB/h, original ≈ 3,7 GB/h.)*

### AND-18: Sync and connection status
**User Story:**
As a mobile viewer, I want to see clearly whether I am in sync, waiting or disconnected, so that I know why the video does not move.

**Acceptance Criteria:**
- [ ] AC1. Given the player is in sync, when the status is shown, then a green badge with RTT and drift appears; a yellow badge appears when drift is above 500 ms.
- [ ] AC2. Given the host disconnected, when the room has no active host, then the video shows a "Host disconnected" label and keeps the last position.
- [ ] AC3. Given the room has not started, when the viewer joins, then a waiting screen explains it and starts on its own when the host presses play.

### AND-19: Room leaderboard
**User Story:**
As a mobile viewer, I want to open the room's trivia ranking at any time, so that I can see how I compare with the others.

**Acceptance Criteria:**
- [ ] AC1. Given trivia was played, when the user opens the Ranking tab, then the accumulated ranking is listed with their own row highlighted.
- [ ] AC2. Given two users tie on points, when the ranking is shown, then the one with the lower accumulated time ranks higher.
- [ ] AC3. Given no trivia was played, when the tab opens, then an empty-state message says nobody has scored yet.

### AND-20: Voice participants and speaking indicator
**User Story:**
As a mobile viewer, I want to see who is in the voice channel and who is speaking, so that I know whom I am hearing.

**Acceptance Criteria:**
- [ ] AC1. Given someone speaks, when speech is detected, then their avatar is highlighted; when they stop, the highlight disappears.
- [ ] AC2. Given people are muted by themselves or by the host, when the list is shown, then a muted icon marks them.
- [ ] AC3. Given many participants, when the list is displayed, then it scrolls horizontally and keeps the speaker visible.

### AND-21: End-of-event recap
**User Story:**
As a mobile viewer, I want a short summary when the event ends, so that I remember the highlights of the session.

**Acceptance Criteria:**
- [x] AC1. Given the host ends the session, when the recap arrives, then the screen shows the top reactor, the most paused moment and the reaction peak. *(Verificado en la tablet. Se pide cuando el video llega a ≤ 1,5 s del final y se rearma al alejarse 5 s: con la sala en pausa en el último instante ExoPlayer se quedaba a 1 ms y nunca pasaba a `STATE_ENDED`.)*
- [x] AC2. Given the recap has missing blocks, when it is shown, then the blocks without data are hidden.
- [x] AC3. Given the user taps Close, when the recap is dismissed, then they return to the home screen.

### AND-22: Invite friends from the room
**User Story:**
As a mobile viewer, I want to share the room's invitation from inside the room, so that I can bring friends in.

**Acceptance Criteria:**
- [ ] AC1. Given the user taps Invite, when the share sheet opens, then it offers the invitation link and a Copy action.
- [ ] AC2. Given the link was copied, when the action completes, then a short confirmation is shown.
- [ ] AC3. Given the link expires, when the user taps Invite, then the app says it expired and asks the host for a new one.

### AND-23: Ambilight glow
**User Story:**
As a mobile viewer, I want an optional colored glow around the video, so that the room feels like the web version.

**Acceptance Criteria:**
- [x] AC1. Given the glow is on, when the video plays, then the edges take the palette precomputed by the media worker. *(Halo alrededor del recuadro con `ambilightUrl`; solo se ve donde el video no llega al borde de la pantalla, así que no hay halo en el teléfono horizontal ni en pantalla completa.)*
- [x] AC2. Given battery saver is on, when the room opens, then the glow starts off. *(Cubierto con pruebas unitarias; no se probó en el aparato.)*
- [x] AC3. Given the user toggles it, when the screen is reopened, then the choice is remembered. *(P3: the web has an open bug about Ambilight, issue #1.)*

## 8. Épica D — Transmisión en vivo

### AND-24: Live viewer on every screen
**User Story:**
As a mobile viewer, I want the live stream to use the same adaptive layouts and fullscreen mode as movies, with the host's scene and the viewer count, so that a live event feels like part of the same app.

**Acceptance Criteria:**
- [ ] AC1. Given a live room, when the host switches scene, then the video shows "Starting soon" or "Be right back" over a dimmed picture.
- [ ] AC2. Given a live room in any of the four formats, when it opens, then the layout matches AND-10 and fullscreen works as in AND-11.
- [ ] AC3. Given the stream has viewers, when the status line is shown, then it reads "Live · N viewers".

### AND-25: Event chat history
**User Story:**
As a host, I want to read the chat of a live event after it ended, so that I can review what the audience said.

**Acceptance Criteria:**
- [ ] AC1. Given an ended live event, when the host taps See event chat, then the saved messages are listed in order.
- [ ] AC2. Given the room had no messages, when the screen opens, then an empty-state message is shown.
- [ ] AC3. Given the user is not the host, when they try to open it, then access is denied.

### AND-26: Go live from the phone
**User Story:**
As a host, I want to stream my phone screen or camera to the room, so that I can run an event without a computer.

**Acceptance Criteria:**
- [ ] AC1. Given the host starts a live room, when they accept the screen-capture and microphone permissions, then the stream starts and the badge shows On air.
- [ ] AC2. Given the host denies a permission, when they try to start, then a clear message explains what is missing.
- [ ] AC3. Given the host loses connection, when the grace period of the service has not ended, then the stream resumes when they return. *(P3: deferred; it needs a foreground service for screen capture and a publisher on the same libwebrtc.)*

## 9. Épica E — Host desde el móvil

### AND-27: Host home: My rooms
**User Story:**
As a host, I want to see my rooms on the home screen, so that I can open, manage or review any of them.

**Acceptance Criteria:**
- [ ] AC1. Given a host with rooms, when the home opens, then each room shows its name, kind, invitation link and the actions Open, Manage, Analytics and Delete.
- [ ] AC2. Given a live room that ended, when it is listed, then it is marked "Event ended" and Open is replaced by See event chat.
- [ ] AC3. Given the identity API is slow or down, when the list loads, then an error message with a Retry button appears.

### AND-28: Create a room
**User Story:**
As a host, I want to create a room by choosing a name and a kind, so that I get an invitation to share.

**Acceptance Criteria:**
- [ ] AC1. Given a name and the kind Watch a video together, when the host taps Create, then the room is created and its code and link are shown.
- [ ] AC2. Given the kind Live stream, when the room is created, then the screen warns that the room is disabled when the event ends.
- [ ] AC3. Given an empty name or a failure, when the host taps Create, then the field shows the error and nothing is created.

### AND-29: Manage a room
**User Story:**
As a host, I want to rename a room, create or revoke invitation links and delete it, so that I control who can join.

**Acceptance Criteria:**
- [ ] AC1. Given a new name, when the host saves, then the room title updates for everyone.
- [ ] AC2. Given the host revokes the link, when confirmed, then new entries are refused and people already inside stay.
- [ ] AC3. Given the host deletes the room, when confirmed, then the links stop working and the room disappears from the list.

### AND-30: Host controls playback
**User Story:**
As a host, I want to play, pause, seek and change the speed from my phone, so that everybody follows me.

**Acceptance Criteria:**
- [ ] AC1. Given the host taps play, pause, back 10 s or forward 10 s, when the command is accepted, then all players follow within 1 s.
- [ ] AC2. Given the host drags the seek bar, when released, then everyone lands on that moment.
- [ ] AC3. Given the host token expired, when a control is used, then the app renews the sync ticket without leaving the room.

### AND-31: Choose or upload the video
**User Story:**
As a host, I want to pick a video from my library or upload one from my phone, so that the room has something to watch.

**Acceptance Criteria:**
- [ ] AC1. Given the host picks a file, when the upload runs, then a progress bar and a Cancel button are shown.
- [ ] AC2. Given the video is processing, when the host views it, then the status is pending, processing, ready or failed with the reason.
- [ ] AC3. Given the host picks a ready video, when confirmed, then everyone sees the new video from the start, paused.

### AND-32: Moderate guests and chat
**User Story:**
As a host, I want to remove or block a guest and control the chat, so that I keep the room friendly.

**Acceptance Criteria:**
- [ ] AC1. Given a guest in the list, when the host taps Remove or Block, then the guest is disconnected and Block also denies their device.
- [ ] AC2. Given the chat options, when the host sets Slow Mode or mutes a person, then the rule applies at once and the host is not limited.
- [ ] AC3. Given the Blocked list, when the host unblocks someone, then they can join again with a new link.

### AND-33: Run polls and the laser pointer
**User Story:**
As a host, I want to launch a poll and point at the video with a laser, so that I can involve the audience.

**Acceptance Criteria:**
- [ ] AC1. Given a question with two to four options and a duration, when the host launches it, then every viewer sees it and the live results.
- [ ] AC2. Given a poll is open, when the host closes it, then everyone sees the final result.
- [ ] AC3. Given the laser is on, when the host drags a finger over the video, then viewers see the trail fade after about two seconds.

### AND-34: Schedule trivia and see the ranking
**User Story:**
As a host, I want to schedule trivia questions at moments of the video and see the final ranking, so that I can run a game.

**Acceptance Criteria:**
- [ ] AC1. Given a time, a question and two to four answers with one correct, when the host saves, then the question is listed as pending.
- [ ] AC2. Given a question is pending, when the host edits or deletes it, then the change applies; a question that already ran cannot be edited.
- [ ] AC3. Given the event ends, when the host opens the ranking, then the final results are shown, or a message says no trivia was played.

### AND-35: Host mutes in voice
**User Story:**
As a host, I want to mute a participant in the voice channel, so that I can stop noise.

**Acceptance Criteria:**
- [ ] AC1. Given a participant in voice, when the host taps Mute, then their audio stops for everyone.
- [ ] AC2. Given a participant muted by the host, when they try to unmute, then it is refused until the host lifts it.
- [ ] AC3. Given the host lifts the mute, when applied, then the participant stays muted until they activate their microphone.

### AND-36: Room analytics
**User Story:**
As a host, I want to see how my room performed, so that I can improve the next one.

**Acceptance Criteria:**
- [ ] AC1. Given a room, when the host opens Analytics, then the peak and average viewers, latency, messages, reactions and trivia accuracy are shown.
- [ ] AC2. Given the charts, when the host views them, then viewers over time and reactions along the video are shown and can be refreshed.
- [ ] AC3. Given no data, when the screen opens, then an empty-state message is shown.

## 10. Épica F — Calidad

### AND-37: Accessibility
**User Story:**
As a user with low vision or motor difficulty, I want the app to work with TalkBack and large text, so that I can use it independently.

**Acceptance Criteria:**
- [ ] AC1. Given TalkBack is on, when the user moves through the room, then every control has a spoken name and the focus order follows the screen.
- [ ] AC2. Given the system font is at the largest size, when any screen opens, then no text is cut and no control is hidden.
- [ ] AC3. Given any screen, when it is measured, then touch targets are at least 48 dp and text meets a 4.5:1 contrast ratio.

### AND-38: Verified app links and release build
**User Story:**
As a mobile viewer, I want invitation links to open the app directly and the app to be installable from a store build, so that joining is one tap.

**Acceptance Criteria:**
- [ ] AC1. Given a verified `assetlinks.json` on the TINT domain, when the user taps an invitation, then the app opens without the browser chooser.
- [ ] AC2. Given a release build, when it is installed, then it uses HTTPS and WSS only and has no debug logging.
- [ ] AC3. Given a new version, when released, then the changelog says what changed and the minimum Android version is stated.

---

## Mockups

El artefacto **«Mockups TINT Android»** reúne **18 pantallas** con los colores, la tipografía (Outfit) y el logo reales de
la web. Cada una lleva en su nombre el identificador de esta tabla. Son estáticas: muestran un momento de cada pantalla
(el de mayor contenido), no el flujo entre ellas.

| ID | Mockup | Tamaño (dp) | Historias |
| :--- | :--- | :--- | :--- |
| M01 | Entrada · móvil vertical | 390 × 844 | AND-14, AND-15 |
| M02 | Entrada · tableta horizontal | 1280 × 800 | AND-14, AND-15 |
| M03 | Mis salas · móvil vertical | 390 × 844 | AND-25, AND-27 |
| M04 | Mis salas · tableta horizontal | 1280 × 800 | AND-25, AND-27 |
| M05 | Sala · móvil vertical | 390 × 844 | AND-10, AND-12, AND-16 a AND-18, AND-20, AND-22 |
| M06 | Sala · móvil horizontal | 844 × 390 | AND-10, AND-12, AND-16 a AND-18, AND-22 |
| M07 | Sala · tableta vertical | 800 × 1280 | AND-10, AND-12, AND-16 a AND-20, AND-22, AND-23 |
| M08 | Sala · tableta horizontal | 1280 × 800 | AND-10, AND-12, AND-16 a AND-20, AND-22 |
| M09 | Pantalla completa · móvil horizontal | 844 × 390 | AND-11, AND-16, AND-17, AND-33 |
| M10 | Pantalla completa · tableta horizontal | 1280 × 800 | AND-11, AND-16, AND-17, AND-33 |
| M11 | Host · móvil vertical | 390 × 844 | AND-30, AND-32, AND-33, AND-35 |
| M12 | Host · tableta horizontal | 1280 × 800 | AND-30 a AND-35 |
| M13 | En vivo · móvil vertical | 390 × 844 | AND-24 |
| M14 | En vivo · tableta horizontal | 1280 × 800 | AND-24 |
| M15 | Crear sala · móvil vertical | 390 × 844 | AND-28 |
| M16 | Gestionar sala · móvil vertical | 390 × 844 | AND-29 |
| M17 | Análisis · tableta horizontal | 1280 × 800 | AND-36 |
| M18 | Fin de la función · móvil vertical | 390 × 844 | AND-21 |

Las reglas de adaptación (qué se mueve y por qué) están como notas en el propio lienzo, junto a cada fila.

### Lo que los mockups todavía no cubren
- **AND-13 (picture-in-picture) y AND-26 (transmitir desde el móvil):** son P3 y no tienen pantalla propia.
- **Carga y errores:** cada mockup muestra el estado normal. Falta dibujar el estado de carga, la reconexión y los errores
  de cada pantalla.
- **Móvil horizontal del host** y **tableta vertical del host:** el host solo está en móvil vertical y tableta horizontal;
  los otros dos formatos siguen la misma regla de AND-10.
- **Modo claro:** la web es solo oscura y la app también.
- **Emoji en las reacciones:** se dejaron como en la web (👏 😂 😮 😱 ❤️ 😢) porque son el contenido del producto, no un
  icono de interfaz.
