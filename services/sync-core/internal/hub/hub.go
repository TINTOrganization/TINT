// Package hub orquesta las salas del Canal Sync: registro de clientes,
// despacho de comandos, heartbeat/drift y presencia del host.
//
// Es independiente del transporte: la capa ws lee del socket y llama a
// Handle/Tick, y escribe lo que el cliente expone en Send().
//
// Flujo de un comando (HU-SYNC-02):
//
//	Handle → store.Apply (WATCH/MULTI + PUBLISH) → Redis Pub/Sub
//	       → bus de cada réplica → Deliver → canal Send() de cada cliente
//
// La réplica emisora no difunde localmente: todo pasa por Pub/Sub, así hay
// un único camino y un orden consistente en todas las réplicas.
//
// Run mantiene dos bucles por réplica (no por conexión): el de HEARTBEAT,
// que también cierra a los clientes que dejaron de responder, y el barrido
// de presencia, que publica HOST_STATUS aunque la réplica del host muera y
// delega el control si el host no vuelve (ver sweep).
package hub

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/codec"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/drift"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/master"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/metrics"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/store"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/telemetry"
)

const (
	// SendBuffer es la cola de salida por cliente; si se llena, el cliente
	// es demasiado lento y se desconecta para no frenar a los demás.
	SendBuffer = 64
	// HeartbeatInterval es la frecuencia por defecto de HEARTBEAT (y de SYNC_CHECK).
	HeartbeatInterval = time.Second
	// MaxMissedChecks: latidos sin SYNC_CHECK antes de cerrar la conexión.
	MaxMissedChecks = 3
	// MaxMsgsPerSecond limita los mensajes entrantes por conexión.
	MaxMsgsPerSecond = 20
	// MaxSyncChecksPerSecond es el límite propio de SYNC_CHECK, que no
	// cuenta en MaxMsgsPerSecond; el exceso se descarta en silencio.
	MaxSyncChecksPerSecond = 5
	// CacheTTL: cada cuánto se relee el estado de Redis aunque la caché
	// local (alimentada por el bus) esté al día. Red de seguridad por si se
	// perdiera un mensaje Pub/Sub durante una reconexión.
	CacheTTL = 5 * time.Second
	// SweepInterval: cada cuánto se renueva la presencia y se evalúa el
	// estado del host y la delegación de control.
	SweepInterval = time.Second
	// HandoffAfter: tiempo sin host/cohost tras el cual un participante
	// recibe el control (CONTROL_HANDOFF_AFTER).
	HandoffAfter = 5 * time.Minute
	// BufferingInterval: mínimo entre dos BUFFERING aceptados de una misma
	// conexión; los que llegan antes se descartan en silencio.
	BufferingInterval = time.Second

	ioTimeout = 2 * time.Second
)

// StateStore persiste el Reloj Maestro y la presencia (ver package store).
type StateStore interface {
	Init(ctx context.Context, roomID, hostID string, nowMs int64) (master.State, error)
	Load(ctx context.Context, roomID string) (master.State, error)
	Apply(ctx context.Context, roomID, eventID string, cmd master.Command, receivedAtMs, rttMs int64, encode store.Encoder) (master.State, bool, error)
	Touch(ctx context.Context, roomID string) error
	HostGone(ctx context.Context, roomID, connID string, nowMs int64) (int64, error)
	MemberGone(ctx context.Context, roomID, sub string) error
	BeatPresence(ctx context.Context, roomID string, hostConns, memberSubs []string, nowMs int64) (store.Presence, error)
	Sweep(ctx context.Context, roomID string, hostConns, memberSubs []string, nowMs int64) (store.Presence, bool, error)
	LiveMembers(ctx context.Context, roomID string, nowMs int64) ([]string, error)
	SwapDelegate(ctx context.Context, roomID, sub string) (string, error)
}

// Bus distribuye mensajes de sala entre réplicas (ver package bus).
type Bus interface {
	Subscribe(ctx context.Context, roomID string) error
	Unsubscribe(ctx context.Context, roomID string) error
	Publish(ctx context.Context, roomID string, payload []byte) error
}

// Telemetry recibe los eventos de analítica (ver package telemetry). Cada
// método solo encola: nunca bloquea ni hace I/O en el camino del mensaje.
type Telemetry interface {
	EmitDrift(telemetry.DriftSample) bool
	EmitPlayback(telemetry.PlaybackSample) bool
	EmitBuffering(telemetry.BufferingSample) bool
}

// Hub gestiona las salas con clientes conectados a esta réplica.
type Hub struct {
	store StateStore
	bus   Bus
	tel   Telemetry
	now   func() time.Time

	heartbeat  time.Duration
	sweepEvery time.Duration
	handoff    time.Duration

	reg *metrics.Registry
	m   hubMetrics

	// mu protege rooms. Nunca se mantiene durante I/O de red: Deliver,
	// latidos y barridos de todas las salas lo necesitan.
	mu    sync.Mutex
	rooms map[string]*roomEntry
	// subMu serializa Subscribe/Unsubscribe del bus (orden: subMu → mu)
	// para que un join y un leave concurrentes de la misma sala no se
	// desordenen. El cliente Pub/Sub de go-redis ya serializa esas
	// operaciones sobre su única conexión, así que no se pierde paralelismo.
	subMu sync.Mutex
}

// roomEntry son los clientes locales de una sala y la caché de su estado.
// Con la caché, los SYNC_CHECK (1/s por cliente) no consultan Redis: con
// 500 clientes serían 500 HGETALL/s compitiendo con los comandos del host.
type roomEntry struct {
	clients    map[*Client]struct{}
	state      master.State
	hasState   bool
	loadedAtMs int64
	delegate   string // sub del participante con control delegado
}

// New crea un Hub.
func New(s StateStore, b Bus, t Telemetry) *Hub {
	h := &Hub{
		store: s, bus: b, tel: t, now: time.Now,
		heartbeat: HeartbeatInterval, sweepEvery: SweepInterval, handoff: HandoffAfter,
		rooms: make(map[string]*roomEntry), reg: metrics.NewRegistry(),
	}
	h.m = newHubMetrics(h.reg, h.roomCount)
	return h
}

// latencyBuckets (segundos) centrados en el objetivo de 100 ms.
var latencyBuckets = []float64{0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1}

// hubMetrics son las métricas operativas del hub (GET /metrics).
type hubMetrics struct {
	connections *metrics.Gauge
	commands    *metrics.CounterVec
	invalid     *metrics.Counter
	rateLimited *metrics.Counter
	disconnects *metrics.CounterVec
	corrections *metrics.CounterVec
	apply       *metrics.Histogram
	delivery    *metrics.Histogram
}

func newHubMetrics(r *metrics.Registry, rooms func() float64) hubMetrics {
	m := hubMetrics{
		connections: r.Gauge("sync_connections", "Conexiones WebSocket activas en esta réplica."),
		commands:    r.CounterVec("sync_commands_total", "Comandos de reproducción por resultado.", "result"),
		invalid:     r.Counter("sync_messages_invalid_total", "Mensajes entrantes inválidos."),
		rateLimited: r.Counter("sync_messages_rate_limited_total", "Mensajes rechazados por rate limit."),
		disconnects: r.CounterVec("sync_disconnects_total", "Desconexiones por motivo.", "reason"),
		corrections: r.CounterVec("sync_corrections_total", "Correcciones de drift por estrategia.", "strategy"),
		apply:       r.Histogram("sync_command_apply_seconds", "Duración de la escritura atómica de un comando en Redis.", latencyBuckets),
		delivery:    r.Histogram("sync_broadcast_delivery_seconds", "Recepción del comando → entrega del broadcast en esta réplica (Pub/Sub).", latencyBuckets),
	}
	r.GaugeFunc("sync_rooms", "Salas con clientes en esta réplica.", rooms)
	return m
}

// Registry devuelve el registro de métricas del hub, para exponerlo y
// añadirle las de otros componentes.
func (h *Hub) Registry() *metrics.Registry { return h.reg }

func (h *Hub) roomCount() float64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return float64(len(h.rooms))
}

func disconnectReason(cause error) string {
	switch {
	case errors.Is(cause, ErrStale):
		return "stale"
	case errors.Is(cause, ErrSlowConsumer):
		return "slow"
	case errors.Is(cause, ErrRevoked):
		return "revoked"
	}
	return "normal"
}

// WithHeartbeat cambia el intervalo de HEARTBEAT (por defecto 1 s).
func (h *Hub) WithHeartbeat(d time.Duration) *Hub {
	h.heartbeat = d
	return h
}

// WithSweep cambia el intervalo del barrido de presencia (por defecto 1 s).
func (h *Hub) WithSweep(d time.Duration) *Hub {
	h.sweepEvery = d
	return h
}

// WithHandoff cambia el tiempo sin host tras el cual se delega el control.
func (h *Hub) WithHandoff(d time.Duration) *Hub {
	h.handoff = d
	return h
}

// HeartbeatInterval devuelve el intervalo de HEARTBEAT configurado.
func (h *Hub) HeartbeatInterval() time.Duration { return h.heartbeat }

// Run ejecuta los bucles de HEARTBEAT y de barrido hasta que ctx termine.
func (h *Hub) Run(ctx context.Context) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); every(ctx, h.heartbeat, h.beatAll) }()
	go func() { defer wg.Done(); every(ctx, h.sweepEvery, func() { h.sweepAll(ctx) }) }()
	wg.Wait()
}

func every(ctx context.Context, d time.Duration, fn func()) {
	t := time.NewTicker(d)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			fn()
		}
	}
}

// beatAll envía el HEARTBEAT a cada cliente local y cierra a los que
// dejaron de responder. Un único temporizador por réplica en lugar de uno
// por conexión.
func (h *Hub) beatAll() {
	now := h.now()
	tmpls := map[string]heartbeatTmpl{} // una plantilla JSON por sala y tick
	for _, c := range h.snapshotClients() {
		raw, err := h.tick(c, now, tmpls)
		if err != nil {
			c.close(err)
			continue
		}
		c.enqueue(raw)
	}
}

func (h *Hub) snapshotClients() []*Client {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []*Client
	for _, r := range h.rooms {
		for c := range r.clients {
			if c.ready { // los que aún esperan su STATE los atiende Connect
				out = append(out, c)
			}
		}
	}
	return out
}

// sweepAll renueva la presencia de los clientes locales y reevalúa cada sala.
func (h *Hub) sweepAll(ctx context.Context) {
	type roomBeat struct{ hosts, members []string }
	h.mu.Lock()
	beats := make(map[string]roomBeat, len(h.rooms))
	for id, r := range h.rooms {
		var b roomBeat
		seen := map[string]bool{}
		for c := range r.clients {
			switch {
			case c.ctx.Err() != nil:
			case c.claims.CanControl():
				b.hosts = append(b.hosts, c.id)
			case !seen[c.claims.Sub]:
				seen[c.claims.Sub] = true
				b.members = append(b.members, c.claims.Sub)
			}
		}
		beats[id] = b
	}
	h.mu.Unlock()

	for room, b := range beats {
		rctx, cancel := context.WithTimeout(ctx, ioTimeout)
		if _, err := h.sweep(rctx, room, h.now().UnixMilli(), b.hosts, b.members); err != nil {
			log.Printf("hub: barrido sala %s: %v", room, err)
		}
		cancel()
	}
}

// presence es el resultado de evaluar una sala.
type presence struct {
	online   bool
	delegate string
}

// sweep reconcilia el estado del host y la delegación de una sala. Varias
// réplicas pueden ejecutarlo a la vez: el store solo informa transiciones
// y el delegado elegido es determinista, así que no hay avisos duplicados.
// hosts y members son los latidos locales a registrar en la misma ida y
// vuelta (nil fuera del barrido periódico).
func (h *Hub) sweep(ctx context.Context, room string, nowMs int64, hosts, members []string) (presence, error) {
	p, changed, err := h.store.Sweep(ctx, room, hosts, members, nowMs)
	if err != nil {
		return presence{}, err
	}
	online := p.Online > 0
	if changed {
		h.publishHostStatus(ctx, room, online)
	}
	delegate := p.Delegate
	switch {
	case online && delegate != "":
		if err := h.swapDelegate(ctx, room, ""); err != nil {
			return presence{}, err
		}
		delegate = ""
	case !online && p.HostlessSinceMs > 0 && nowMs-p.HostlessSinceMs >= h.handoff.Milliseconds():
		members, err := h.store.LiveMembers(ctx, room, nowMs)
		if err != nil {
			return presence{}, err
		}
		candidate := ""
		if len(members) > 0 {
			candidate = members[0]
		}
		if candidate != delegate {
			if err := h.swapDelegate(ctx, room, candidate); err != nil {
				return presence{}, err
			}
			delegate = candidate
		}
	}
	h.applyDelegate(room, delegate)
	return presence{online: online, delegate: delegate}, nil
}

// swapDelegate fija el delegado y publica CONTROL si cambió.
func (h *Hub) swapDelegate(ctx context.Context, room, sub string) error {
	prev, err := h.store.SwapDelegate(ctx, room, sub)
	if err != nil || prev == sub {
		return err
	}
	ev := baseEvent(syncevent.Control, room, h.now())
	ev.Holder = sub
	if err := h.bus.Publish(ctx, room, mustJSON(ev)); err != nil {
		log.Printf("hub: CONTROL sala %s: %v", room, err)
	}
	return nil
}

// applyDelegate actualiza el delegado local y avisa a los participantes
// locales si cambió (los host/cohost siempre tienen el control).
func (h *Hub) applyDelegate(room, holder string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[room]
	if !ok || r.delegate == holder {
		return
	}
	r.delegate = holder
	now := h.now()
	for c := range r.clients {
		if c.claims.CanControl() {
			continue
		}
		ev := baseEvent(syncevent.Control, room, now)
		ev.CanControl = syncevent.Bool(c.claims.Sub == holder)
		if raw, err := c.codec.Encode(ev); err == nil {
			c.deliver(raw)
		}
	}
}

// revoke cierra las conexiones locales del token revocado.
func (h *Hub) revoke(room, jti string) {
	if jti == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[room]
	if !ok {
		return
	}
	for c := range r.clients {
		if c.claims.JTI == jti {
			c.close(ErrRevoked)
		}
	}
}

// canControl indica si el cliente puede emitir comandos ahora mismo.
func (h *Hub) canControl(c *Client) bool {
	if c.claims.CanControl() {
		return true
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[c.claims.RoomID]
	return ok && r.delegate != "" && r.delegate == c.claims.Sub
}

// Connect registra una conexión autenticada, crea la sala si no existe y le
// encola de inmediato el STATE actual (HU-SYNC-01).
func (h *Hub) Connect(parent context.Context, claims auth.Claims, opts ...ConnOption) (*Client, error) {
	now := h.now()
	c := newClient(parent, claims, now.UnixMilli())
	for _, opt := range opts {
		opt(c)
	}
	room := claims.RoomID
	ctx, cancel := context.WithTimeout(parent, ioTimeout)
	defer cancel()

	// Suscribirse antes de leer el estado: un comando concurrente llegará
	// por el bus con version mayor y el cliente descarta lo obsoleto.
	if err := h.join(ctx, c); err != nil {
		return nil, err
	}
	h.m.connections.Inc()
	hostID := ""
	if claims.Role == auth.RoleHost {
		hostID = claims.Sub
	}
	st, err := h.store.Init(ctx, room, hostID, now.UnixMilli())
	if err != nil {
		h.Disconnect(c)
		return nil, err
	}
	h.cache(room, st, now.UnixMilli())
	nowMs := now.UnixMilli()
	var hosts, members []string
	if claims.CanControl() {
		hosts = []string{c.id}
	} else {
		members = []string{claims.Sub}
	}
	p, err := h.store.BeatPresence(ctx, room, hosts, members, nowMs)
	if err != nil {
		h.Disconnect(c)
		return nil, err
	}

	// El STATE va primero (HU-SYNC-01); el barrido puede publicar
	// HOST_STATUS/CONTROL, que llegan después por el bus. Se sella justo
	// antes de encolarlo: el cliente proyecta la posición desde
	// server_time_ms y `now` es anterior a las idas y vueltas a Redis.
	ev := stateEvent(syncevent.State, room, st, h.now())
	ev.Online = syncevent.Bool(p.Online > 0)
	ev.CanControl = syncevent.Bool(claims.CanControl() || (p.Delegate != "" && p.Delegate == claims.Sub))
	c.enqueueEvent(ev)
	h.release(c)
	if _, err := h.sweep(ctx, room, nowMs, nil, nil); err != nil {
		log.Printf("hub: barrido sala %s: %v", room, err)
	}
	return c, nil
}

// Disconnect da de baja al cliente. Es idempotente. La sala sobrevive con
// su TTL de gracia (REQ-07); si era el último host se avisa a los demás.
func (h *Hub) Disconnect(c *Client) {
	cause := c.Err()
	c.close(ErrClosed)
	left, ok := h.leave(c)
	if !ok {
		return
	}
	h.m.connections.Dec()
	h.m.disconnects.With(disconnectReason(cause)).Inc()
	ctx, cancel := context.WithTimeout(context.Background(), ioTimeout)
	defer cancel()
	room := c.claims.RoomID
	nowMs := h.now().UnixMilli()
	reevaluate := false
	if c.claims.CanControl() {
		if _, err := h.store.HostGone(ctx, room, c.id, nowMs); err == nil {
			reevaluate = true
		}
	} else if !left.sameSub {
		if err := h.store.MemberGone(ctx, room, c.claims.Sub); err == nil {
			reevaluate = left.delegate == c.claims.Sub // se fue el delegado: reasignar
		}
	}
	if reevaluate {
		if _, err := h.sweep(ctx, room, nowMs, nil, nil); err != nil {
			log.Printf("hub: barrido sala %s: %v", room, err)
		}
	}
	if err := h.store.Touch(ctx, room); err != nil {
		log.Printf("hub: touch sala %s: %v", room, err)
	}
}

// Deliver entrega un payload del bus a todos los clientes locales de la
// sala y, si es un comando, actualiza la caché del estado maestro.
func (h *Hub) Deliver(roomID string, payload []byte) {
	var ev syncevent.Event
	parsed := json.Unmarshal(payload, &ev) == nil
	if parsed {
		switch ev.Type {
		case syncevent.Control:
			h.applyDelegate(roomID, ev.Holder) // cada cliente recibe su propio CONTROL
			return
		case syncevent.Revoked:
			h.revoke(roomID, ev.JTI) // solo entre réplicas: nunca llega a los clientes
			return
		}
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[roomID]
	if !ok {
		return
	}
	if ev.IsCommand() {
		if d := h.now().Sub(ev.ReceivedAt); d >= 0 {
			h.m.delivery.Observe(d.Seconds())
		}
		r.update(master.State{
			Status: master.Status(ev.Status), PositionMs: ev.PositionMs, UpdatedAtMs: ev.UpdatedAtMs,
			Rate: ev.Rate, Version: ev.Version, MediaID: ev.MediaID, Volume: volumeOf(ev),
			Quality: qualityOf(ev),
		}, h.now().UnixMilli())
	}
	// El bus siempre viaja en JSON; para los clientes MessagePack se
	// transcodifica una sola vez y los bytes se comparten entre todos.
	var packed []byte
	for c := range r.clients {
		if c.codec == codec.JSON {
			c.deliver(payload)
			continue
		}
		if packed == nil && parsed {
			packed, _ = c.codec.Encode(ev)
		}
		if packed != nil {
			c.deliver(packed)
		}
	}
}

// Handle procesa un mensaje entrante. Solo debe llamarse desde la goroutine
// lectora del cliente (el rate limit no está protegido para concurrencia).
func (h *Hub) Handle(ctx context.Context, c *Client, raw []byte) {
	now := h.now()
	nowMs := now.UnixMilli()
	// Se decodifica antes del rate limit para elegir el límite por tipo: el
	// mensaje ya está acotado a 4 KB, y lo que no se puede decodificar
	// cuenta en el límite general como cualquier otro mensaje.
	var ev syncevent.Event
	decodeErr := c.codec.Decode(raw, &ev)
	if decodeErr == nil && ev.Type == syncevent.SyncCheck {
		if !c.allowSyncCheck(nowMs) {
			return // exceso de SYNC_CHECK: se descarta en silencio
		}
	} else if !c.allow(nowMs) {
		h.m.rateLimited.Inc()
		c.enqueueEvent(errorEvent(c.claims.RoomID, "", syncevent.CodeRateLimited, now))
		return
	}
	if decodeErr != nil {
		h.m.invalid.Inc()
		c.enqueueEvent(errorEvent(c.claims.RoomID, "", syncevent.CodeInvalid, now))
		return
	}
	ev.ReceivedAt = now // el reloj del servidor siempre es el de recepción
	if err := ev.ValidateInbound(); err != nil || ev.RoomID != c.claims.RoomID {
		h.m.invalid.Inc()
		c.enqueueEvent(errorEvent(c.claims.RoomID, ev.EventID, syncevent.CodeInvalid, now))
		return
	}
	if ev.IsCommand() {
		ctx, cancel := context.WithTimeout(ctx, ioTimeout)
		defer cancel()
		h.handleCommand(ctx, c, ev, now)
		return
	}
	if ev.Type == syncevent.Buffering {
		h.handleBuffering(c, ev, now)
		return
	}
	h.handleSyncCheck(ctx, c, ev, now)
}

// handleBuffering publica el stall del reproductor en analytics:events. Lo
// puede enviar cualquier rol; no responde, no difunde y no toca Redis en
// este camino (la telemetría solo encola).
func (h *Hub) handleBuffering(c *Client, ev syncevent.Event, now time.Time) {
	if !c.allowBuffering(now.UnixMilli()) {
		return
	}
	h.tel.EmitBuffering(telemetry.BufferingSample{
		EventID: ev.EventID, RoomID: c.claims.RoomID, DurationMs: ev.DurationMs, PositionMs: ev.PositionMs,
		Role: string(c.claims.Role), OccurredAt: ev.OccurredAt, ReceivedAt: now,
	})
}

func (h *Hub) handleCommand(ctx context.Context, c *Client, ev syncevent.Event, now time.Time) {
	room := c.claims.RoomID
	if !h.canControl(c) {
		h.m.commands.With("forbidden").Inc()
		c.enqueueEvent(errorEvent(room, ev.EventID, syncevent.CodeForbidden, now))
		return
	}
	encode := func(st master.State) ([]byte, error) {
		out := stateEvent(ev.Type, room, st, now)
		out.EventID = ev.EventID // mismo id en todos los clientes: idempotencia
		out.OccurredAt = ev.OccurredAt
		return json.Marshal(out)
	}
	cmd := master.Command{Type: ev.Type, PositionMs: ev.PositionMs, Rate: ev.Rate, MediaID: ev.MediaID, Quality: ev.Quality}
	if ev.Volume != nil {
		cmd.Volume = *ev.Volume
	}
	started := time.Now()
	st, dup, err := h.store.Apply(ctx, room, ev.EventID, cmd, now.UnixMilli(), c.RTT(), encode)
	h.m.apply.Observe(time.Since(started).Seconds())
	if err != nil {
		code, result := syncevent.CodeInternal, "error"
		if errors.Is(err, syncevent.ErrNegativePosition) || errors.Is(err, syncevent.ErrInvalidRate) || errors.Is(err, syncevent.ErrInvalidMedia) ||
			errors.Is(err, syncevent.ErrInvalidVolume) || errors.Is(err, syncevent.ErrInvalidQuality) {
			code, result = syncevent.CodeInvalid, "invalid"
		} else {
			log.Printf("hub: comando %s en sala %s: %v", ev.Type, room, err)
		}
		h.m.commands.With(result).Inc()
		c.enqueueEvent(errorEvent(room, ev.EventID, code, now))
		return
	}
	if dup {
		h.m.commands.With("duplicate").Inc()
	} else {
		h.m.commands.With("ok").Inc()
		h.tel.EmitPlayback(telemetry.PlaybackSample{
			EventID: ev.EventID, RoomID: room, Command: string(ev.Type), PositionMs: st.PositionMs,
			Role: string(c.claims.Role), OccurredAt: ev.OccurredAt, ReceivedAt: now,
		})
	}
	ack := baseEvent(syncevent.Ack, room, now)
	ack.RefEventID = ev.EventID
	ack.Version = st.Version
	ack.Duplicate = dup
	c.enqueueEvent(ack)
}

// handleSyncCheck mide el RTT con el reloj del servidor y corrige el drift
// si supera 500 ms (HU-SYNC-03).
func (h *Hub) handleSyncCheck(ctx context.Context, c *Client, ev syncevent.Event, now time.Time) {
	nowMs := now.UnixMilli()
	c.lastCheckMs.Store(nowMs)
	if ev.EchoServerTs > 0 {
		c.rttMs.Store(drift.UpdateRTT(c.rttMs.Load(), nowMs-ev.EchoServerTs))
	}
	room := c.claims.RoomID
	st, ok := h.fresh(room, nowMs)
	if !ok {
		// Solo un fallo de caché va a Redis: el temporizador del contexto
		// se crea aquí y no en cada SYNC_CHECK (1/s por cliente).
		lctx, cancel := context.WithTimeout(ctx, ioTimeout)
		loaded, err := h.store.Load(lctx, room)
		cancel()
		if err != nil {
			return // sin estado no hay referencia; el siguiente latido reintenta
		}
		st = h.cache(room, loaded, nowMs)
	}
	if ev.Version > 0 && ev.Version < st.Version {
		// El cliente midió su posición antes de aplicar el último broadcast
		// (p. ej. justo tras un SEEK/LOAD del host): corregirlo produciría un
		// seek duplicado. Ni corrección ni drift; el próximo latido lo mide.
		return
	}
	rtt := c.RTT()
	driftMs, corr := drift.Check(st, ev.PositionMs, nowMs, rtt, h.now().UnixMilli())
	c.lastDriftMs.Store(driftMs)
	if corr == nil {
		return
	}
	// Solo la goroutine lectora del cliente llega aquí: leer y escribir
	// lastSeekMs por separado no compite con otro SYNC_CHECK del mismo cliente.
	if corr.Strategy == drift.Seek && !c.allowSeek(nowMs) {
		return // el cliente aún aplica (o se recupera de) el seek anterior
	}
	h.m.corrections.With(string(corr.Strategy)).Inc()
	out := baseEvent(syncevent.SyncCorrection, room, now)
	out.TargetMs = syncevent.Int64(corr.TargetMs)
	out.PositionMs = corr.TargetMs
	out.Strategy = string(corr.Strategy)
	out.DriftMs = corr.DriftMs
	out.Version = corr.Version
	// Estado de la sala en esa versión: un cliente que perdió un broadcast
	// (p. ej. reconexión del Pub/Sub) puede reconciliar status, velocidad y
	// vídeo. Campos opcionales: los clientes que no los conocen los ignoran.
	out.Status = string(st.Status)
	out.Rate = st.Rate
	out.MediaID = st.MediaID
	out.Volume = syncevent.Float64(st.Volume)
	out.Quality = st.Quality
	c.enqueueEvent(out)
	h.tel.EmitDrift(telemetry.DriftSample{
		RoomID: room, DriftMs: corr.DriftMs, RTTMs: rtt, Strategy: string(corr.Strategy),
		Role: string(c.claims.Role), PositionMs: corr.TargetMs, OccurredAt: ev.OccurredAt, ReceivedAt: now,
	})
}

// Tick genera el siguiente HEARTBEAT del cliente o ErrStale si dejó de
// responder SYNC_CHECK durante MaxMissedChecks intervalos.
func (h *Hub) Tick(c *Client) ([]byte, error) {
	return h.tick(c, h.now(), nil)
}

// tick reutiliza la plantilla JSON de la sala en tmpls (si no es nil) para
// no serializar por reflexión lo que comparten todos los clientes.
func (h *Hub) tick(c *Client, now time.Time, tmpls map[string]heartbeatTmpl) ([]byte, error) {
	if now.UnixMilli()-c.lastCheckMs.Load() > (h.heartbeat * MaxMissedChecks).Milliseconds() {
		return nil, ErrStale
	}
	room := c.claims.RoomID
	if c.codec == codec.JSON {
		tmpl, ok := tmpls[room]
		if !ok {
			tmpl = newHeartbeatTmpl(room, now)
			if tmpls != nil {
				tmpls[room] = tmpl
			}
		}
		return tmpl.encode(uuid.New(), c.lastDriftMs.Load(), c.RTT()), nil
	}
	ev := baseEvent(syncevent.Heartbeat, room, now)
	ev.ServerTimeMs = now.UnixMilli()
	ev.RTTMs = c.RTT()
	ev.DriftMs = c.lastDriftMs.Load()
	return c.codec.Encode(ev)
}

// release marca al cliente como listo (ya tiene su STATE) y le entrega, en
// orden, lo que llegó a la sala mientras se conectaba.
func (h *Hub) release(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	c.ready = true
	for _, msg := range c.held {
		c.enqueue(msg)
	}
	c.held = nil
}

// join registra al cliente en su sala y, si es la primera conexión local,
// suscribe la réplica a la sala. Invariante: una sala está en h.rooms solo
// mientras la suscripción del bus está activa (se inserta después de
// Subscribe y se borra antes de Unsubscribe).
func (h *Hub) join(ctx context.Context, c *Client) error {
	if h.addToRoom(c) { // camino rápido: la sala ya está suscrita
		return nil
	}
	h.subMu.Lock()
	defer h.subMu.Unlock()
	// Re-comprobar: otro join pudo crear la sala mientras esperábamos subMu.
	if h.addToRoom(c) {
		return nil
	}
	// Sin h.mu: un Subscribe lento no frena a las demás salas. Un mensaje
	// publicado antes de insertar la sala se pierde, pero Connect lee el
	// estado (Init) después de join y ese estado ya lo incluye.
	room := c.claims.RoomID
	if err := h.bus.Subscribe(ctx, room); err != nil {
		return err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.rooms[room] = &roomEntry{clients: map[*Client]struct{}{c: {}}}
	return nil
}

// addToRoom registra al cliente si su sala ya existe.
func (h *Hub) addToRoom(c *Client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[c.claims.RoomID]
	if ok {
		r.clients[c] = struct{}{}
	}
	return ok
}

// unsubscribeIfEmpty desuscribe la sala si nadie volvió a crearla desde que
// leave la borró. Con subMu tomado ningún join puede suscribirla a la vez.
func (h *Hub) unsubscribeIfEmpty(room string) {
	h.subMu.Lock()
	defer h.subMu.Unlock()
	h.mu.Lock()
	_, recreated := h.rooms[room]
	h.mu.Unlock()
	if recreated {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), ioTimeout)
	defer cancel()
	if err := h.bus.Unsubscribe(ctx, room); err != nil {
		log.Printf("hub: unsubscribe sala %s: %v", room, err)
	}
}

// leftInfo describe la sala que deja un cliente.
type leftInfo struct {
	delegate string // delegado vigente al salir
	sameSub  bool   // queda otra conexión local con el mismo sub
}

// leave quita al cliente; ok es false si ya no estaba registrado.
func (h *Hub) leave(c *Client) (leftInfo, bool) {
	info, ok, empty := h.removeFromRoom(c)
	if empty {
		h.unsubscribeIfEmpty(c.claims.RoomID) // fuera de h.mu: es I/O de red
	}
	return info, ok
}

// removeFromRoom quita al cliente; empty indica que la sala quedó vacía y
// se borró de h.rooms.
func (h *Hub) removeFromRoom(c *Client) (info leftInfo, ok, empty bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := c.claims.RoomID
	r, found := h.rooms[room]
	if !found {
		return leftInfo{}, false, false
	}
	if _, found := r.clients[c]; !found {
		return leftInfo{}, false, false
	}
	delete(r.clients, c)
	info = leftInfo{delegate: r.delegate}
	for other := range r.clients {
		if other.claims.Sub == c.claims.Sub {
			info.sameSub = true
			break
		}
	}
	if len(r.clients) == 0 {
		delete(h.rooms, room)
		empty = true
	}
	return info, true, empty
}

// cache guarda st si es más nuevo que lo cacheado y devuelve el estado
// vigente de la sala (que puede ser uno más nuevo llegado por el bus).
func (h *Hub) cache(room string, st master.State, nowMs int64) master.State {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[room]
	if !ok {
		return st
	}
	r.update(st, nowMs)
	return r.state
}

// fresh devuelve el estado cacheado si existe y no superó CacheTTL.
func (h *Hub) fresh(room string, nowMs int64) (master.State, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[room]
	if !ok || !r.hasState || nowMs-r.loadedAtMs >= CacheTTL.Milliseconds() {
		return master.State{}, false
	}
	return r.state, true
}

// cached expone la caché para pruebas.
func (h *Hub) cached(room string) (master.State, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.rooms[room]
	if !ok {
		return master.State{}, false
	}
	return r.state, r.hasState
}

// update acepta el estado si no es más viejo que el cacheado: los mensajes
// pueden llegar desordenados y version es el orden total de la sala.
func (r *roomEntry) update(st master.State, nowMs int64) {
	if r.hasState && st.Version < r.state.Version {
		return
	}
	r.state, r.hasState, r.loadedAtMs = st, true, nowMs
}

func (h *Hub) publishHostStatus(ctx context.Context, room string, online bool) {
	ev := baseEvent(syncevent.HostStatus, room, h.now())
	ev.Online = syncevent.Bool(online)
	if err := h.bus.Publish(ctx, room, mustJSON(ev)); err != nil {
		log.Printf("hub: HOST_STATUS sala %s: %v", room, err)
	}
}

func baseEvent(typ syncevent.Type, room string, now time.Time) syncevent.Event {
	return syncevent.Event{EventID: uuid.NewString(), Type: typ, RoomID: room, OccurredAt: now, ReceivedAt: now}
}

func stateEvent(typ syncevent.Type, room string, st master.State, now time.Time) syncevent.Event {
	ev := baseEvent(typ, room, now)
	ev.PositionMs = st.PositionMs
	ev.Version = st.Version
	ev.Status = string(st.Status)
	ev.Rate = st.Rate
	ev.UpdatedAtMs = st.UpdatedAtMs
	ev.ServerTimeMs = now.UnixMilli()
	ev.MediaID = st.MediaID
	ev.Volume = syncevent.Float64(st.Volume)
	ev.Quality = st.Quality
	return ev
}

// volumeOf lee el volumen de un broadcast; los de réplicas anteriores a
// VOLUME no lo traen y equivalen al volumen por defecto.
func volumeOf(ev syncevent.Event) float64 {
	if ev.Volume == nil {
		return master.DefaultVolume
	}
	return *ev.Volume
}

// qualityOf lee la calidad de un broadcast (auto si la réplica no la envía).
func qualityOf(ev syncevent.Event) string {
	if ev.Quality == "" {
		return master.DefaultQuality
	}
	return ev.Quality
}

func errorEvent(room, ref, code string, now time.Time) syncevent.Event {
	ev := baseEvent(syncevent.Error, room, now)
	ev.RefEventID = ref
	ev.Code = code
	return ev
}

// mustJSON serializa eventos propios; Event no contiene tipos que puedan
// fallar al serializar, así que un error aquí es un bug de programación.
func mustJSON(ev syncevent.Event) []byte {
	raw, err := json.Marshal(ev)
	if err != nil {
		panic(err)
	}
	return raw
}
