// Package server — endpoint WebSocket del Canal Social (/ws/social, solo chat).
package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"sync"
	"time"
	"unicode/utf8"

	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/analytics"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/moderation"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/polls"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/reactions"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/recap"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/trivia"
)

// Deps son las dependencias del endpoint social (inyectables en tests).
type Deps struct {
	Hub     *chat.Hub
	History chat.Store
	Publish func(ctx context.Context, roomID string, msg socialevent.ChatMessage) error
	// PublishReaction reenvía la reacción a las demás réplicas (nil = una réplica).
	PublishReaction func(ctx context.Context, roomID string, r socialevent.Reaction) error
	// TrackChat, TrackPresence y TrackReaction publican en analytics:events
	// (sin texto ni nick). Nil = sin Redis: no se registra nada. Deben ser
	// no bloqueantes (el emisor de internal/analytics solo encola).
	TrackChat     func(analytics.ChatMessage)
	TrackPresence func(analytics.Presence)
	TrackReaction func(analytics.Reaction)
	// analytics es el emisor cableado por DefaultDeps (Run lo arranca).
	analytics *analytics.Emitter
	// Subscribe abre la suscripción Pub/Sub de la sala (eventos de otras
	// réplicas y REVOKED de identity-api); una sola por sala y réplica.
	Subscribe func(ctx context.Context, roomID string) (<-chan chat.Inbound, func())
	// IsRevoked consulta token:revoked:{jti}. Nil = sin Redis (modo memoria).
	// Un error rechaza el handshake (falla cerrado).
	IsRevoked func(ctx context.Context, jti string) (bool, error)
	// Auth
	JWTSecret         string
	JWTIssuer         string // vacío = auth.DefaultIssuer
	JWTAudience       string // vacío = auth.DefaultAudience
	FirebaseProjectID string
	// HostKeys resuelve las claves públicas de Firebase por kid. Nil o sin
	// FirebaseProjectID = los host tokens se rechazan (falla cerrado).
	HostKeys auth.KeySource
	// AllowedOrigins son los patrones de host aceptados en el handshake
	// (ALLOWED_ORIGINS). Vacío = solo mismo origen.
	AllowedOrigins []string
	// Utilidades
	Now       func() time.Time
	NewID     func() string
	ChatLimit *reactions.Limiter
	// ReactionLimit frena el spam de reacciones (5/s por conexión, en memoria).
	// Nil = limitador propio por conexión (igual que el chat).
	ReactionLimit *reactions.Limiter
	// ReactionIPLimit frena el spam de reacciones por IP de origen.
	// Nil = sin límite adicional por IP.
	ReactionIPLimit *reactions.Limiter
	// ReactionBuckets acumula conteos por sala y ventana de 5s (base del
	// heatmap). Nil = no se agregan (solo broadcast en vivo).
	ReactionBuckets *reactions.Buckets
	// PublishRaw reenvía a las demás réplicas un evento ya serializado
	// (laser, poll_state) por room:{id}:social. Nil = una réplica.
	PublishRaw func(ctx context.Context, roomID string, payload []byte) error
	// LaserLimit frena el puntero láser (30/s por usuario). Nil = limitador
	// propio por conexión.
	LaserLimit *reactions.Limiter
	// Polls guarda las encuestas en Redis. Nil (modo memoria) = las
	// operaciones de encuesta responden UNAVAILABLE.
	Polls *polls.Store
	// OnPollCreated se llama tras crear una encuesta (contador del recap).
	OnPollCreated func(ctx context.Context, roomID string)
	// AfterFunc agenda timers (cierre de encuestas, flush de votos).
	// Nil = time.AfterFunc; los tests inyectan uno manual.
	AfterFunc func(d time.Duration, f func()) (stop func() bool)
	// Recap acumula las métricas de la sala en Redis. Nil (modo memoria) =
	// no se cuentan y recap_request responde UNAVAILABLE.
	Recap *recap.Store
	// Moderation guarda modo lento y silenciados en Redis. Nil (modo
	// memoria) = chat sin moderación y chat_slow_mode/chat_mute responden
	// UNAVAILABLE.
	Moderation *moderation.Store
	// Trivia guarda las trivias programadas en Redis. Nil (modo memoria) =
	// los mensajes de trivia responden UNAVAILABLE.
	Trivia *trivia.Store
	// TrackTrivia publica trivia_answer en analytics:events (nil = no).
	TrackTrivia func(analytics.TriviaAnswer)
	// triviaArms es el timer de disparo por sala; triviaClosers, el de
	// cierre por pregunta (ver trivia.go).
	triviaArms    map[string]*triviaArm
	triviaClosers map[string]func() bool
	// syncHook observa cada evento de sync procesado (solo tests).
	syncHook func(recap.Kind)
	// pollTimers es el timer de cierre de la encuesta vigente por sala.
	pollTimers map[string]*pollTimer
	// Estado interno del relay compartido y dedup (ver relay.go).
	mu     sync.Mutex
	relays map[string]*roomRelay
	seen   *seenIDs
	// conns son las conexiones locales por sala (para revocarlas por jti).
	conns map[string]map[string]liveConn
	// LeaveGrace retrasa el aviso de salida: si el usuario vuelve dentro de
	// la ventana se considera el mismo de antes (cero = DefaultLeaveGrace).
	LeaveGrace time.Duration
	// PingInterval/PingTimeout detectan conexiones muertas (cero = defaults).
	PingInterval time.Duration
	PingTimeout  time.Duration
	// WriteTimeout acota cada escritura al cliente (cero = DefaultWriteTimeout).
	WriteTimeout time.Duration
	// presence cuenta conexiones por sala y usuario para no spamear avisos
	// con multipestaña, StrictMode (doble montaje) o flaps de red.
	presence map[string]map[string]*presenceEntry
}

// DefaultLeaveGrace es la ventana de gracia de presencia en producción.
const DefaultLeaveGrace = 5 * time.Second

// presenceEntry lleva las conexiones activas, la última salida y una
// generación para invalidar timers viejos cuando el usuario reingresa.
type presenceEntry struct {
	conns     int
	lastLeave time.Time
	gen       uint64
}

func (d *Deps) leaveGrace() time.Duration {
	if d.LeaveGrace > 0 {
		return d.LeaveGrace
	}
	return DefaultLeaveGrace
}

func (d *Deps) presenceUsers(roomID string) map[string]*presenceEntry {
	if d.presence == nil {
		d.presence = make(map[string]map[string]*presenceEntry)
	}
	users := d.presence[roomID]
	if users == nil {
		users = make(map[string]*presenceEntry)
		d.presence[roomID] = users
	}
	return users
}

// presenceJoin suma una conexión; true si hay que avisar la entrada.
// No se avisa si ya hay otra conexión activa (multipestaña) ni si el
// usuario salió dentro de la ventana de gracia (reingreso/flap).
// connected son las entradas de presencia de la sala tras el cambio
// (leídas bajo el mismo lock, para analítica).
func (d *Deps) presenceJoin(roomID, userID string, now time.Time) (notify bool, connected int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	users := d.presenceUsers(roomID)
	e := users[userID]
	if e == nil {
		e = &presenceEntry{}
		users[userID] = e
	}
	e.conns++
	e.gen++
	connected = len(users)
	if e.conns > 1 {
		return false, connected
	}
	if !e.lastLeave.IsZero() && now.Sub(e.lastLeave) < d.leaveGrace() {
		return false, connected
	}
	return true, connected
}

// presenceLeave resta una conexión y, si fue la última, programa el aviso
// de salida tras la gracia: solo se emite si el usuario sigue ausente
// (misma generación). Así un reingreso rápido cancela el aviso.
func (d *Deps) presenceLeave(roomID string, claims auth.Claims) {
	d.mu.Lock()
	users := d.presence[roomID]
	e := users[claims.Subject]
	if e == nil || e.conns <= 0 {
		d.mu.Unlock()
		return
	}
	e.conns--
	if e.conns > 0 {
		d.mu.Unlock()
		return
	}
	e.lastLeave = d.now()
	e.gen++
	gen := e.gen
	grace := d.leaveGrace()
	d.mu.Unlock()
	time.AfterFunc(grace, func() {
		d.mu.Lock()
		cur := d.presence[roomID][claims.Subject]
		fire := cur != nil && cur.conns == 0 && cur.gen == gen
		connected := 0
		if fire {
			// Pasada la gracia la entrada ya no aporta nada: se borra (y la
			// sala si quedó vacía) para no acumular memoria sin cota.
			delete(d.presence[roomID], claims.Subject)
			connected = len(d.presence[roomID])
			if connected == 0 {
				delete(d.presence, roomID)
			}
		}
		d.mu.Unlock()
		if fire {
			d.announcePresence(roomID, claims, socialevent.NoticeLeft, connected)
		}
	})
}

// presenceCount devuelve las entradas de presencia de una sala (pruebas/métricas).
func (d *Deps) presenceCount(roomID string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.presence[roomID])
}

// presenceRooms devuelve cuántas salas tienen presencia (pruebas/métricas).
func (d *Deps) presenceRooms() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.presence)
}

func noticeText(nick string, kind socialevent.NoticeKind) string {
	if kind == socialevent.NoticeLeft {
		return nick + " salió del chat"
	}
	return nick + " entró al chat"
}

// announcePresence emite el aviso en vivo y, si se emitió, el evento presence
// de analítica con el mismo event_id. connected es el conteo de esta
// réplica (la presencia no se comparte entre réplicas).
func (d *Deps) announcePresence(roomID string, claims auth.Claims, kind socialevent.NoticeKind, connected int) {
	eventID, at, ok := d.emitNotice(roomID, claims, kind)
	if !ok || d.TrackPresence == nil {
		return
	}
	pk := analytics.PresenceJoined
	if kind == socialevent.NoticeLeft {
		pk = analytics.PresenceLeft
	}
	d.TrackPresence(analytics.Presence{
		EventID: eventID, RoomID: roomID, UserID: claims.Subject, Kind: pk,
		ConnectedUsers: connected, OccurredAt: at, ReceivedAt: at,
	})
}

// emitNotice envía un aviso de presencia solo en vivo: no se guarda en el
// historial ni se publica a otras réplicas. Devuelve el event_id y la hora
// del aviso; ok = false si no se emitió.
func (d *Deps) emitNotice(roomID string, claims auth.Claims, kind socialevent.NoticeKind) (eventID string, at time.Time, ok bool) {
	now := d.now()
	n := socialevent.Notice{
		EventID: d.newID(), Type: socialevent.TypeNotice, RoomID: roomID,
		UserID: claims.Subject, Nick: claims.Nick, Kind: kind,
		Text: noticeText(claims.Nick, kind), OccurredAt: now,
	}
	if err := n.Validate(); err != nil {
		return "", time.Time{}, false
	}
	raw, err := json.Marshal(n)
	if err != nil {
		return "", time.Time{}, false
	}
	if d.markSeen(n.EventID) {
		return "", time.Time{}, false
	}
	d.Hub.Broadcast(roomID, raw)
	return n.EventID, now, true
}

func (d *Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now().UTC()
}

func (d *Deps) newID() string {
	if d.NewID != nil {
		return d.NewID()
	}
	return newUUID()
}

// MountSocial registra GET /ws/social sobre mux.
func MountSocial(mux *http.ServeMux, d *Deps) {
	mux.HandleFunc("GET /ws/social", func(w http.ResponseWriter, r *http.Request) {
		handleSocial(w, r, d)
	})
}

// NewRouterWithDeps construye el router completo (healthz + social).
func NewRouterWithDeps(d *Deps) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthz)
	mux.HandleFunc("POST /internal/events/start", startEvent)
	mux.HandleFunc("POST /internal/events/start/{roomID}", startEvent)
	mux.HandleFunc("DELETE /internal/events/start/{roomID}", stopEvent)
	MountSocial(mux, d)
	return withCorrelation(mux)
}

func startEvent(w http.ResponseWriter, r *http.Request) {
	var input struct {
		RoomID string `json:"roomId"`
		HostID string `json:"hostId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		http.Error(w, "roomId y hostId son obligatorios", http.StatusBadRequest)
		return
	}
	if input.RoomID == "" {
		input.RoomID = r.PathValue("roomID")
	}
	if input.RoomID == "" || input.HostID == "" {
		http.Error(w, "roomId y hostId son obligatorios", http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"roomId":    input.RoomID,
		"sessionId": "social-" + input.RoomID,
		"wsUrl":     "/ws/social?room_id=" + input.RoomID,
	})
}

func stopEvent(w http.ResponseWriter, r *http.Request) {
	if r.PathValue("roomID") == "" {
		http.Error(w, "roomId es obligatorio", http.StatusBadRequest)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(ctx context.Context, c *websocket.Conn, code, ref string) {
	raw, _ := json.Marshal(socialevent.ErrorEnvelope{Type: socialevent.TypeError, Code: code, EventIDRef: ref})
	_ = writeMsg(ctx, c, raw, DefaultWriteTimeout)
}

func writeRateLimited(ctx context.Context, c *websocket.Conn, ref string, retry time.Duration) {
	retryMS := retry / time.Millisecond
	if retry%time.Millisecond != 0 {
		retryMS++
	}
	if retryMS < 1 {
		retryMS = 1
	}
	raw, _ := json.Marshal(socialevent.ErrorEnvelope{
		Type: socialevent.TypeError, Code: "RATE_LIMITED", EventIDRef: ref,
		RetryAfterMS: int64(retryMS),
	})
	_ = writeMsg(ctx, c, raw, DefaultWriteTimeout)
}

// authenticate elige el verificador por el alg del header: HS256 = guest
// token de identity-api; RS256 = Firebase ID token del host. Un token HS256
// inválido nunca cae al camino de host, y nada se acepta sin firma válida.
func (d *Deps) authenticate(ctx context.Context, token, roomID string) (auth.Claims, error) {
	now := d.now()
	switch auth.TokenAlg(token) {
	case "HS256":
		cfg := auth.GuestConfig{Secret: d.JWTSecret, Issuer: d.JWTIssuer, Audience: d.JWTAudience}
		return auth.VerifyGuest(token, cfg, roomID, now)
	case "RS256":
		return auth.VerifyHost(ctx, token, d.FirebaseProjectID, d.HostKeys, now)
	default:
		return auth.Claims{}, auth.ErrInvalidToken
	}
}

func handleSocial(w http.ResponseWriter, r *http.Request, d *Deps) {
	ctx := r.Context()
	roomID := r.URL.Query().Get("room_id")
	if roomID == "" {
		correlationError(w, r, "room_id es obligatorio", http.StatusBadRequest)
		return
	}
	token, err := auth.BearerToken(r.Header.Get("Authorization"), r.URL.Query().Get("token"))
	if err != nil {
		correlationError(w, r, "unauthorized", http.StatusUnauthorized)
		return
	}
	claims, err := d.authenticate(ctx, token, roomID)
	if err != nil {
		status := http.StatusUnauthorized
		if errors.Is(err, auth.ErrWrongRoom) {
			status = http.StatusForbidden
		}
		correlationError(w, r, http.StatusText(status), status)
		return
	}
	// Un token revocado no reconecta; si no se puede comprobar, se rechaza.
	revoked, err := d.checkRevoked(ctx, claims.JTI)
	if err != nil {
		correlationError(w, r, "no se pudo validar el token", http.StatusServiceUnavailable)
		return
	}
	if revoked {
		correlationError(w, r, "token revocado", http.StatusUnauthorized)
		return
	}

	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: d.AllowedOrigins})
	if err != nil {
		return
	}
	defer c.Close(websocket.StatusNormalClosure, "")
	c.SetReadLimit(8 * 1024)

	connID := d.newID()
	clientIP := remoteIP(r.RemoteAddr)
	send := make(chan []byte, 64)
	untrack := d.trackConn(roomID, connID, liveConn{jti: claims.JTI, sub: claims.Subject, send: send, close: func() {
		go func() { _ = c.Close(StatusRevoked, "token revocado") }()
	}})
	defer untrack()
	d.Hub.Join(roomID, connID, send)
	defer d.Hub.Leave(roomID, connID)

	// Relay multirréplica compartido: una sola suscripción por sala y réplica.
	// Sin esto cada conexión reemitía el eco de Redis (entrega 1+N veces).
	if d.Subscribe != nil {
		release := d.acquireRelay(roomID)
		defer release()
	}

	// Historial corto como primer mensaje.
	recent, err := d.History.Recent(ctx, roomID, socialevent.HistoryLimit)
	if err != nil {
		recent = nil
	}
	if recent == nil {
		recent = []socialevent.ChatMessage{}
	}
	histRaw, _ := json.Marshal(socialevent.HistoryEnvelope{Type: socialevent.TypeHistory, RoomID: roomID, Messages: recent})
	_ = writeMsg(ctx, c, histRaw, d.writeTimeout())
	// Estado de moderación del chat (modo lento y silenciados).
	d.sendChatSettingsOnJoin(ctx, c, roomID)
	// Encuesta vigente (con el voto de este usuario), si la hay.
	d.sendPollOnJoin(ctx, c, roomID, claims.Subject)
	// Trivias: la lista (solo moderadores) y la pregunta abierta, si la hay.
	d.sendTriviaOnJoin(ctx, c, roomID, claims)

	// Aviso de entrada (solo en vivo, tras el historial). Se perdona el
	// reingreso dentro de la gracia (StrictMode, refresh, flap).
	if notify, connected := d.presenceJoin(roomID, claims.Subject, d.now()); notify {
		d.announcePresence(roomID, claims, socialevent.NoticeJoined, connected)
	}

	// Escritor hacia este cliente; termina cuando el handler retorna. Si una
	// escritura falla o vence, se corta el socket: así el Read de abajo
	// termina y se emite el aviso de salida (antes quedaba colgado).
	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			select {
			case <-done:
				return
			case msg := <-send:
				if err := writeMsg(ctx, c, msg, d.writeTimeout()); err != nil {
					c.CloseNow()
					return
				}
			}
		}
	}()
	go d.keepAlive(c, done)

	limiter := d.ChatLimit
	if limiter == nil {
		limiter = reactions.NewLimiter()
	}
	reactLimiter := d.ReactionLimit
	if reactLimiter == nil {
		reactLimiter = reactions.NewLimiter()
	}
	laserLimiter := d.LaserLimit
	if laserLimiter == nil {
		laserLimiter = reactions.NewLimiterWith(LaserPerSecond, time.Second)
	}
	actionLimiter := reactions.NewLimiterWith(PollActionsPerSecond, time.Second)

	for {
		_, raw, err := c.Read(ctx)
		if err != nil {
			break
		}
		var envelope struct {
			Type socialevent.Type `json:"type"`
		}
		if err := json.Unmarshal(raw, &envelope); err != nil {
			writeError(ctx, c, "INVALID_PAYLOAD", "")
			continue
		}
		switch envelope.Type {
		case socialevent.TypeReactionSend:
			d.handleReaction(ctx, c, roomID, claims, raw, reactLimiter, d.ReactionIPLimit, clientIP)
			continue
		case socialevent.TypeLaserPoint:
			d.handleLaser(ctx, c, roomID, claims, raw, laserLimiter)
			continue
		case socialevent.TypePollCreate:
			d.handlePollCreate(ctx, c, roomID, claims, raw)
			continue
		case socialevent.TypePollVote:
			d.handlePollVote(ctx, c, roomID, claims, raw, actionLimiter)
			continue
		case socialevent.TypePollClose:
			d.handlePollClose(ctx, c, roomID, claims, raw)
			continue
		case socialevent.TypeRecapRequest:
			d.handleRecapRequest(ctx, c, roomID, raw, claims, actionLimiter)
			continue
		case socialevent.TypeChatSlowMode:
			d.handleSlowMode(ctx, c, roomID, claims, raw)
			continue
		case socialevent.TypeChatMute:
			d.handleMute(ctx, c, roomID, claims, raw)
			continue
		case socialevent.TypeTriviaSchedule:
			d.handleTriviaSchedule(ctx, c, roomID, claims, raw)
			continue
		case socialevent.TypeTriviaUpdate:
			d.handleTriviaUpdate(ctx, c, roomID, claims, raw)
			continue
		case socialevent.TypeTriviaDelete:
			d.handleTriviaDelete(ctx, c, roomID, claims, raw)
			continue
		case socialevent.TypeTriviaList:
			d.handleTriviaList(ctx, c, roomID, claims, raw)
			continue
		case socialevent.TypeTriviaAnswer:
			d.handleTriviaAnswer(ctx, c, roomID, claims, raw, actionLimiter)
			continue
		}
		var in socialevent.ChatSend
		if err := json.Unmarshal(raw, &in); err != nil {
			writeError(ctx, c, "INVALID_PAYLOAD", "")
			continue
		}
		if in.RoomID == "" {
			in.RoomID = roomID
		}
		if err := in.Validate(); err != nil {
			code := "INVALID_PAYLOAD"
			if err == socialevent.ErrTextTooLong {
				code = "TEXT_TOO_LONG"
			}
			writeError(ctx, c, code, in.EventID)
			continue
		}
		if in.RoomID != roomID {
			writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
			continue
		}
		if !limiter.Allow(claims.Subject, d.now()) {
			writeError(ctx, c, "RATE_LIMITED", in.EventID)
			continue
		}
		// Silencio y modo lento al final: el freno solo se toma si el
		// mensaje es válido y pasó el límite de tasa.
		if code, retry := d.admitChat(ctx, roomID, claims); code == "SLOW_MODE" {
			writeSlowMode(ctx, c, in.EventID, retry)
			continue
		} else if code != "" {
			writeError(ctx, c, code, in.EventID)
			continue
		}
		text := trimText(in.Text)
		received := d.now()
		out := socialevent.ChatMessage{
			EventID: d.newID(), Type: socialevent.TypeChatMessage, RoomID: roomID,
			UserID: claims.Subject, Nick: claims.Nick, Text: text, Spoiler: in.Spoiler,
			OccurredAt: socialevent.ClampOccurred(in.OccurredAt, received), ReceivedAt: received,
		}
		if err := out.Validate(); err != nil {
			writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
			continue
		}
		length := utf8.RuneCountInString(text)
		_ = d.History.Push(ctx, roomID, out)
		if d.Publish != nil {
			_ = d.Publish(ctx, roomID, out)
		}
		if d.TrackChat != nil {
			d.TrackChat(analytics.ChatMessage{
				EventID: out.EventID, RoomID: roomID, UserID: claims.Subject,
				MessageLength: length, OccurredAt: out.OccurredAt, ReceivedAt: out.ReceivedAt,
			})
		}
		// broadcastOnce traga el eco de Redis si el relay lo vio primero.
		d.broadcastOnce(roomID, out)
	}

	// Salida explícita antes del defer: el que se va no recibe su propio aviso.
	// El aviso de salida es diferido (ventana de gracia): si el usuario
	// vuelve antes, se cancela.
	d.Hub.Leave(roomID, connID)
	d.presenceLeave(roomID, claims)
}

// handleReaction valida, limita (5/s en memoria), agrega al bucket de 5s,
// emite la reacción en vivo y la registra en analítica. Sin historial.
func (d *Deps) handleReaction(ctx context.Context, c *websocket.Conn, roomID string, claims auth.Claims, raw []byte, limiter, ipLimiter *reactions.Limiter, clientIP string) {
	var in socialevent.ReactionSend
	if err := json.Unmarshal(raw, &in); err != nil {
		writeError(ctx, c, "INVALID_PAYLOAD", "")
		return
	}
	if in.RoomID == "" {
		in.RoomID = roomID
	}
	if err := in.Validate(); err != nil {
		code := "INVALID_PAYLOAD"
		if err == socialevent.ErrInvalidEmoji {
			code = "INVALID_EMOJI"
		}
		writeError(ctx, c, code, in.EventID)
		return
	}
	if in.RoomID != roomID {
		writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
		return
	}
	now := d.now()
	if allowed, retry := limiter.AllowWithRetry(claims.Subject, now); !allowed {
		writeRateLimited(ctx, c, in.EventID, retry)
		return
	}
	if ipLimiter != nil {
		if allowed, retry := ipLimiter.AllowWithRetry(clientIP, now); !allowed {
			writeRateLimited(ctx, c, in.EventID, retry)
			return
		}
	}
	received := d.now()
	out := socialevent.Reaction{
		EventID: d.newID(), Type: socialevent.TypeReaction, RoomID: roomID,
		UserID: claims.Subject, Nick: claims.Nick, Emoji: socialevent.TrimmedEmoji(in.Emoji),
		PositionMS: in.PositionMS, OccurredAt: socialevent.ClampOccurred(in.OccurredAt, received), ReceivedAt: received,
	}
	if err := out.Validate(); err != nil {
		writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
		return
	}
	if d.ReactionBuckets != nil {
		d.ReactionBuckets.Add(roomID, reactions.BucketIndex(bucketPosition(out.PositionMS)), out.Emoji)
	}
	d.recordReaction(ctx, out)
	if d.PublishReaction != nil {
		_ = d.PublishReaction(ctx, roomID, out)
	}
	if d.TrackReaction != nil {
		d.TrackReaction(analytics.Reaction{
			EventID: out.EventID, RoomID: roomID, UserID: claims.Subject, Emoji: out.Emoji,
			PositionMS: out.PositionMS, OccurredAt: out.OccurredAt, ReceivedAt: out.ReceivedAt,
		})
	}
	// broadcastRawOnce traga el eco de Redis si el relay lo vio primero.
	d.broadcastRawOnce(roomID, out.EventID, out)
}

func remoteIP(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err == nil && host != "" {
		return host
	}
	if remoteAddr == "" {
		return "unknown"
	}
	return remoteAddr
}

func bucketPosition(ms int64) time.Duration {
	if ms < 0 {
		return 0
	}
	return time.Duration(ms) * time.Millisecond
}

func trimText(s string) string {
	start := 0
	for start < len(s) && (s[start] == ' ' || s[start] == '\n' || s[start] == '\r' || s[start] == '\t') {
		start++
	}
	end := len(s)
	for end > start && (s[end-1] == ' ' || s[end-1] == '\n' || s[end-1] == '\r' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	hexed := hex.EncodeToString(b[:])
	return hexed[0:8] + "-" + hexed[8:12] + "-" + hexed[12:16] + "-" + hexed[16:20] + "-" + hexed[20:]
}
