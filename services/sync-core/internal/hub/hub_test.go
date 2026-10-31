package hub

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/bus"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/master"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/store"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/telemetry"
)

const room = "room-1"

var (
	t0         = time.Date(2026, 10, 10, 18, 0, 0, 0, time.UTC)
	host       = auth.Claims{Sub: "user-1", RoomID: room, Role: auth.RoleHost, Nick: "Ana"}
	cohost     = auth.Claims{Sub: "user-2", RoomID: room, Role: auth.RoleCohost}
	guest      = auth.Claims{Sub: "guest:1", RoomID: room, Role: auth.RoleParticipant, Nick: "Luis"}
	guestTwo   = auth.Claims{Sub: "guest:2", RoomID: room, Role: auth.RoleParticipant}
	guestThree = auth.Claims{Sub: "guest:3", RoomID: room, Role: auth.RoleParticipant}
	recvLimit  = 2 * time.Second
)

type fakeClock struct{ ms atomic.Int64 }

func (f *fakeClock) now() time.Time          { return time.UnixMilli(f.ms.Load()).UTC() }
func (f *fakeClock) advance(d time.Duration) { f.ms.Add(d.Milliseconds()) }

type fakeTelemetry struct {
	mu         sync.Mutex
	samples    []telemetry.DriftSample
	playbacks  []telemetry.PlaybackSample
	bufferings []telemetry.BufferingSample
}

func (f *fakeTelemetry) EmitPlayback(s telemetry.PlaybackSample) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.playbacks = append(f.playbacks, s)
	return true
}

func (f *fakeTelemetry) EmitBuffering(s telemetry.BufferingSample) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bufferings = append(f.bufferings, s)
	return true
}

func (f *fakeTelemetry) playbackList() []telemetry.PlaybackSample {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]telemetry.PlaybackSample(nil), f.playbacks...)
}

func (f *fakeTelemetry) bufferingList() []telemetry.BufferingSample {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]telemetry.BufferingSample(nil), f.bufferings...)
}

func (f *fakeTelemetry) EmitDrift(s telemetry.DriftSample) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.samples = append(f.samples, s)
	return true
}

func (f *fakeTelemetry) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.samples)
}

type env struct {
	mr    *miniredis.Miniredis
	clock *fakeClock
	tel   *fakeTelemetry
}

func newEnv(t *testing.T) *env {
	e := &env{mr: miniredis.RunT(t), clock: &fakeClock{}, tel: &fakeTelemetry{}}
	e.clock.ms.Store(t0.UnixMilli())
	return e
}

// newHub crea una "réplica" conectada al Redis compartido del entorno.
func (e *env) newHub(t *testing.T) *Hub {
	t.Helper()
	rdb := redis.NewClient(&redis.Options{Addr: e.mr.Addr(), MaxRetries: -1})
	t.Cleanup(func() { _ = rdb.Close() })
	b := bus.New(rdb)
	h := New(store.New(rdb, 12*time.Hour), b, e.tel)
	h.now = e.clock.now
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	b.Start(ctx, h.Deliver)
	t.Cleanup(func() { _ = b.Close() })
	return h
}

func (e *env) waitSubscribers(t *testing.T, n int) {
	t.Helper()
	ch := syncevent.ChannelKey(room)
	deadline := time.Now().Add(recvLimit)
	for time.Now().Before(deadline) {
		if e.mr.PubSubNumSub(ch)[ch] == n {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("esperaba %d suscriptores, hay %d", n, e.mr.PubSubNumSub(ch)[ch])
}

func connect(t *testing.T, h *Hub, c auth.Claims) *Client {
	t.Helper()
	cl, err := h.Connect(context.Background(), c)
	if err != nil {
		t.Fatalf("Connect(%s): %v", c.Role, err)
	}
	t.Cleanup(func() { h.Disconnect(cl) })
	return cl
}

func next(t *testing.T, c *Client) syncevent.Event {
	t.Helper()
	select {
	case raw := <-c.Send():
		var ev syncevent.Event
		if err := json.Unmarshal(raw, &ev); err != nil {
			t.Fatalf("JSON inválido %s: %v", raw, err)
		}
		return ev
	case <-time.After(recvLimit):
		t.Fatal("no llegó ningún mensaje")
		return syncevent.Event{}
	}
}

func nextOf(t *testing.T, c *Client, typ syncevent.Type) syncevent.Event {
	t.Helper()
	for {
		if ev := next(t, c); ev.Type == typ {
			return ev
		}
	}
}

// expectSilence verifica que no lleguen mensajes. Ignora HOST_STATUS, que
// viaja por el bus de forma asíncrona tras la conexión de un host.
// collect lee mensajes hasta ver todos los tipos pedidos, sin importar el
// orden: el broadcast llega por el bus y puede adelantarse al ACK.
func collect(t *testing.T, c *Client, types ...syncevent.Type) map[syncevent.Type]syncevent.Event {
	t.Helper()
	want := map[syncevent.Type]bool{}
	for _, typ := range types {
		want[typ] = true
	}
	got := map[syncevent.Type]syncevent.Event{}
	for len(got) < len(want) {
		if ev := next(t, c); want[ev.Type] {
			got[ev.Type] = ev
		}
	}
	return got
}

func expectSilence(t *testing.T, c *Client) {
	t.Helper()
	timeout := time.After(50 * time.Millisecond)
	for {
		select {
		case raw := <-c.Send():
			var ev syncevent.Event
			_ = json.Unmarshal(raw, &ev)
			if ev.Type != syncevent.HostStatus {
				t.Fatalf("no esperaba mensajes, llegó %s", raw)
			}
		case <-timeout:
			return
		}
	}
}

func send(t *testing.T, h *Hub, c *Client, ev map[string]any) {
	t.Helper()
	raw, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	h.Handle(context.Background(), c, raw)
}

func cmd(id string, typ syncevent.Type, pos int64) map[string]any {
	return map[string]any{
		"event_id": id, "type": typ, "room_id": room, "position_ms": pos,
		"occurred_at": t0.Add(-time.Hour).Format(time.RFC3339Nano), // reloj de cliente atrasado: válido
	}
}

func TestConnectSendsInitialState(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)

	g := connect(t, h, guest)
	st := next(t, g)
	if st.Type != syncevent.State || st.Status != "paused" || st.PositionMs != 0 || st.Version != 0 ||
		st.ServerTimeMs != t0.UnixMilli() || st.Online == nil || *st.Online || st.RoomID != room || st.EventID == "" {
		t.Errorf("STATE inicial = %+v", st)
	}
	if err := st.Validate(); err != nil {
		t.Errorf("STATE debe cumplir el contrato: %v", err)
	}
}

func TestHostPresenceAndCommandsBroadcast(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)

	hc := connect(t, h, host)
	if st := next(t, hc); st.Online == nil || !*st.Online {
		t.Errorf("el host conectado debe verse online: %+v", st)
	}
	g := connect(t, h, guest)
	if st := next(t, g); st.Online == nil || !*st.Online {
		t.Errorf("el participante debe ver al host online: %+v", st)
	}
	e.waitSubscribers(t, 1) // una réplica, una suscripción para toda la sala

	e.clock.advance(time.Second)
	send(t, h, hc, cmd("e-play", syncevent.Play, 1500))

	got := collect(t, hc, syncevent.Ack, syncevent.Play)
	if ack := got[syncevent.Ack]; ack.RefEventID != "e-play" || ack.Version != 1 || ack.Duplicate {
		t.Errorf("ACK = %+v", ack)
	}
	for _, ev := range []syncevent.Event{got[syncevent.Play], nextOf(t, g, syncevent.Play)} {
		if ev.EventID != "e-play" || ev.Status != "playing" || ev.PositionMs != 1500 || ev.Version != 1 ||
			ev.UpdatedAtMs != t0.Add(time.Second).UnixMilli() || ev.Rate != 1 || ev.ReceivedAt.IsZero() {
			t.Errorf("broadcast PLAY = %+v", ev)
		}
	}
}

func TestCohostCanControl(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	c := connect(t, h, cohost)
	next(t, c)
	send(t, h, c, cmd("e1", syncevent.Seek, 9000))
	if ack := collect(t, c, syncevent.Ack)[syncevent.Ack]; ack.Version != 1 {
		t.Errorf("cohost ACK = %+v", ack)
	}
}

func TestParticipantCommandIsForbidden(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc := connect(t, h, host)
	next(t, hc)
	g := connect(t, h, guest)
	next(t, g)

	send(t, h, g, cmd("e-evil", syncevent.Pause, 0))
	errEv := nextOf(t, g, syncevent.Error)
	if errEv.Code != syncevent.CodeForbidden || errEv.RefEventID != "e-evil" {
		t.Errorf("ERROR = %+v", errEv)
	}
	expectSilence(t, hc)
	if st, _ := h.store.Load(context.Background(), room); st.Version != 0 {
		t.Errorf("el estado maestro debe quedar intacto: %+v", st)
	}
}

func TestDuplicateCommandIsAckedOnce(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc := connect(t, h, host)
	next(t, hc)

	send(t, h, hc, cmd("e1", syncevent.Seek, 5000))
	collect(t, hc, syncevent.Ack, syncevent.Seek)

	send(t, h, hc, cmd("e1", syncevent.Seek, 5000))
	ack := nextOf(t, hc, syncevent.Ack)
	if !ack.Duplicate || ack.Version != 1 {
		t.Errorf("ACK duplicado = %+v", ack)
	}
	expectSilence(t, hc)
}

func TestInvalidMessages(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc := connect(t, h, host)
	next(t, hc)

	bad := cmd("e1", syncevent.Seek, -10)
	other := cmd("e2", syncevent.Play, 0)
	other["room_id"] = "otra-sala"
	chat := cmd("e3", "CHAT", 0)
	noID := cmd("", syncevent.Play, 0)

	for name, raw := range map[string][]byte{
		"json roto":         []byte("{nope"),
		"posición negativa": toJSON(t, bad),
		"otra sala":         toJSON(t, other),
		"chat":              toJSON(t, chat),
		"sin event_id":      toJSON(t, noID),
	} {
		h.Handle(context.Background(), hc, raw)
		if ev := nextOf(t, hc, syncevent.Error); ev.Code != syncevent.CodeInvalid {
			t.Errorf("%s: respuesta = %+v", name, ev)
		}
	}
}

func toJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestSyncCheckCorrectsDriftAndEmitsTelemetry(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc := connect(t, h, host)
	next(t, hc)
	g := connect(t, h, guest)
	next(t, g)

	load := cmd("e-load", syncevent.Load, 0)
	load["media_id"] = "vid-1"
	send(t, h, hc, load)
	nextOf(t, g, syncevent.Load)
	send(t, h, hc, cmd("e-play", syncevent.Play, 0))
	nextOf(t, g, syncevent.Play)

	// A t0+10s el cliente sigue vivo (SYNC_CHECK alineado, sin echo).
	e.clock.advance(10 * time.Second)
	send(t, h, g, cmd("c0", syncevent.SyncCheck, 10_000))
	expectSilence(t, g)

	// El servidor late; el cliente responde 100 ms después (RTT=100).
	hb, err := h.Tick(g)
	if err != nil {
		t.Fatal(err)
	}
	var beat syncevent.Event
	if err := json.Unmarshal(hb, &beat); err != nil || beat.Type != syncevent.Heartbeat || beat.ServerTimeMs != t0.Add(10*time.Second).UnixMilli() {
		t.Fatalf("HEARTBEAT = %s (%v)", hb, err)
	}
	e.clock.advance(100 * time.Millisecond)

	check := cmd("c1", syncevent.SyncCheck, 9_000) // el maestro va en ~10050: drift ≈ -1050
	check["echo_server_ts"] = beat.ServerTimeMs
	send(t, h, g, check)

	corr := nextOf(t, g, syncevent.SyncCorrection)
	if corr.Strategy != "rate" || corr.DriftMs != -1050 || corr.TargetMs == nil || *corr.TargetMs != 10_150 || corr.Version != 2 {
		t.Errorf("SYNC_CORRECTION = %+v (target %v)", corr, corr.TargetMs)
	}
	// Lleva status, rate y media_id: un cliente que perdió un broadcast
	// puede reconciliarse sin esperar al siguiente comando.
	if corr.Status != "playing" || corr.Rate != 1 || corr.MediaID != "vid-1" {
		t.Errorf("SYNC_CORRECTION sin estado para reconciliar: status=%q rate=%v media_id=%q", corr.Status, corr.Rate, corr.MediaID)
	}
	if g.RTT() != 100 {
		t.Errorf("RTT = %d, want 100", g.RTT())
	}
	if e.tel.count() != 1 {
		t.Fatalf("telemetría emitida = %d, want 1", e.tel.count())
	}
	s := e.tel.samples[0]
	if s.RoomID != room || s.DriftMs != -1050 || s.RTTMs != 100 || s.Role != "participant" || s.Strategy != "rate" || s.PositionMs != 10_150 {
		t.Errorf("muestra = %+v", s)
	}

	// Alineado: ni corrección ni telemetría.
	aligned := cmd("c2", syncevent.SyncCheck, 10_050)
	send(t, h, g, aligned)
	expectSilence(t, g)
	if e.tel.count() != 1 {
		t.Error("un cliente alineado no genera telemetría")
	}
}

func TestTickDetectsStaleClient(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	g := connect(t, h, guest)
	next(t, g)

	e.clock.advance(HeartbeatInterval * MaxMissedChecks)
	if _, err := h.Tick(g); err != nil {
		t.Fatalf("aún dentro del margen: %v", err)
	}
	e.clock.advance(time.Millisecond)
	if _, err := h.Tick(g); !errors.Is(err, ErrStale) {
		t.Errorf("err = %v, want ErrStale", err)
	}
}

func TestWithHeartbeat(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t).WithHeartbeat(100 * time.Millisecond)
	if h.HeartbeatInterval() != 100*time.Millisecond {
		t.Fatalf("HeartbeatInterval = %v", h.HeartbeatInterval())
	}
	g := connect(t, h, guest)
	if g.Context().Err() != nil || g.Claims() != guest {
		t.Fatal("cliente recién conectado debe estar activo")
	}
	e.clock.advance(301 * time.Millisecond)
	if _, err := h.Tick(g); !errors.Is(err, ErrStale) {
		t.Errorf("con latido de 100 ms, 301 ms sin respuesta es stale: %v", err)
	}
}

func TestSlowConsumerIsKicked(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	g := connect(t, h, guest) // nunca lee su canal
	for i := 0; i <= SendBuffer; i++ {
		h.Deliver(room, []byte(`{}`))
	}
	select {
	case <-g.Done():
		if !errors.Is(g.Err(), ErrSlowConsumer) {
			t.Errorf("causa = %v", g.Err())
		}
	case <-time.After(recvLimit):
		t.Fatal("el cliente lento debe ser desconectado")
	}
}

func TestRateLimit(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	g := connect(t, h, guest)
	next(t, g)
	// BUFFERING cuenta en el límite general (aunque solo 1/s se publique).
	for i := 0; i < MaxMsgsPerSecond; i++ {
		send(t, h, g, buffering("b", 100, 0))
	}
	send(t, h, g, buffering("b", 100, 0))
	if ev := nextOf(t, g, syncevent.Error); ev.Code != syncevent.CodeRateLimited {
		t.Errorf("ERROR = %+v", ev)
	}
	// Nueva ventana de un segundo: vuelve a aceptar.
	e.clock.advance(time.Second)
	send(t, h, g, buffering("b", 100, 0))
	expectSilence(t, g)
}

// REQ-07: la caída del host no destruye la sala; los demás se enteran.
func TestHostDisconnectKeepsRoomAlive(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc, err := h.Connect(context.Background(), host)
	if err != nil {
		t.Fatal(err)
	}
	next(t, hc)
	g := connect(t, h, guest)
	next(t, g)
	send(t, h, hc, cmd("e-play", syncevent.Play, 0))
	nextOf(t, g, syncevent.Play)

	h.Disconnect(hc)
	status := nextOf(t, g, syncevent.HostStatus)
	if status.Online == nil || *status.Online {
		t.Errorf("HOST_STATUS = %+v", status)
	}
	st, err := h.store.Load(context.Background(), room)
	if err != nil || st.Status != "playing" {
		t.Errorf("la sala debe seguir reproduciendo: %+v (%v)", st, err)
	}
	if ttl := e.mr.TTL(syncevent.StateKey(room)); ttl != 12*time.Hour {
		t.Errorf("TTL = %v", ttl)
	}

	// El host vuelve y recupera el control.
	back := connect(t, h, host)
	if st := next(t, back); st.Type != syncevent.State || st.Status != "playing" || !*st.Online {
		t.Errorf("STATE al reconectar = %+v", st)
	}
	if ev := nextOf(t, g, syncevent.HostStatus); !*ev.Online {
		t.Errorf("HOST_STATUS al volver = %+v", ev)
	}
}

func TestLastClientUnsubscribes(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	a, _ := h.Connect(context.Background(), guest)
	b, _ := h.Connect(context.Background(), guestTwo)
	e.waitSubscribers(t, 1)
	h.Disconnect(a)
	e.waitSubscribers(t, 1)
	h.Disconnect(b)
	e.waitSubscribers(t, 0)
	h.Disconnect(b) // idempotente
}

// SYNC-BE-05: host en la réplica A, participante en la réplica B.
func TestCrossReplicaBroadcast(t *testing.T) {
	e := newEnv(t)
	a := e.newHub(t)
	b := e.newHub(t)
	hc := connect(t, a, host)
	next(t, hc)
	g := connect(t, b, guest)
	next(t, g)
	e.waitSubscribers(t, 2)

	send(t, a, hc, cmd("e-seek", syncevent.Seek, 42_000))
	if ev := nextOf(t, g, syncevent.Seek); ev.PositionMs != 42_000 || ev.Version != 1 {
		t.Errorf("SEEK en réplica B = %+v", ev)
	}
}

func TestRedisDown(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc := connect(t, h, host)
	next(t, hc)
	e.mr.Close()

	send(t, h, hc, cmd("e1", syncevent.Play, 0))
	if ev := nextOf(t, hc, syncevent.Error); ev.Code != syncevent.CodeInternal {
		t.Errorf("Redis caído: respuesta = %+v", ev)
	}
	send(t, h, hc, cmd("c1", syncevent.SyncCheck, 0))
	expectSilence(t, hc) // sin estado no se puede calcular drift: se ignora
	if _, err := h.Connect(context.Background(), guest); err == nil {
		t.Error("Connect con Redis caído debe fallar")
	}
}

// countingStore cuenta las lecturas del estado para verificar la caché.
type countingStore struct {
	StateStore
	loads atomic.Int64
}

func (c *countingStore) Load(ctx context.Context, roomID string) (master.State, error) {
	c.loads.Add(1)
	return c.StateStore.Load(ctx, roomID)
}

func (e *env) newCountingHub(t *testing.T) (*Hub, *countingStore) {
	t.Helper()
	h := e.newHub(t)
	cs := &countingStore{StateStore: h.store}
	h.store = cs
	return h, cs
}

// Con 500 clientes por sala, cada SYNC_CHECK no puede ir a Redis: el hub
// mantiene el estado en caché, actualizado por los broadcasts del bus.
func TestSyncCheckUsesCachedState(t *testing.T) {
	e := newEnv(t)
	h, cs := e.newCountingHub(t)
	hc := connect(t, h, host)
	next(t, hc)
	g := connect(t, h, guest)
	next(t, g)

	send(t, h, hc, cmd("e-play", syncevent.Play, 0))
	nextOf(t, g, syncevent.Play)

	e.clock.advance(2 * time.Second)
	for i := 0; i < 10; i++ {
		send(t, h, g, cmd("c", syncevent.SyncCheck, 2_000))
	}
	expectSilence(t, g) // alineado con el PLAY recibido por el bus
	if n := cs.loads.Load(); n != 0 {
		t.Errorf("SYNC_CHECK leyó Redis %d veces; debe usar la caché", n)
	}

	// Tras CacheTTL se refresca una vez desde Redis (red de seguridad).
	e.clock.advance(CacheTTL)
	send(t, h, g, cmd("c", syncevent.SyncCheck, 2_000+CacheTTL.Milliseconds()))
	send(t, h, g, cmd("c", syncevent.SyncCheck, 2_000+CacheTTL.Milliseconds()))
	if n := cs.loads.Load(); n != 1 {
		t.Errorf("lecturas tras expirar la caché = %d, want 1", n)
	}
}

func TestCacheIgnoresStaleBroadcast(t *testing.T) {
	e := newEnv(t)
	h, _ := e.newCountingHub(t)
	hc := connect(t, h, host)
	next(t, hc)
	send(t, h, hc, cmd("e1", syncevent.Seek, 5_000))
	send(t, h, hc, cmd("e2", syncevent.Seek, 9_000))
	collect(t, hc, syncevent.Ack, syncevent.Seek)
	nextOf(t, hc, syncevent.Seek)

	// Un broadcast viejo (version 1) llega tarde: no debe pisar la version 2.
	old := stateEvent(syncevent.Seek, room, master.State{Status: master.Paused, PositionMs: 5_000, Rate: 1, Version: 1}, e.clock.now())
	h.Deliver(room, mustJSON(old))
	if st, ok := h.cached(room); !ok || st.Version != 2 || st.PositionMs != 9_000 {
		t.Errorf("caché = %+v (ok=%v)", st, ok)
	}
	h.Deliver(room, []byte("no-json")) // payload corrupto: se ignora
	if st, _ := h.cached(room); st.Version != 2 {
		t.Errorf("payload corrupto alteró la caché: %+v", st)
	}
}

func TestRateAndLoadBroadcastWithMedia(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc := connect(t, h, host)
	next(t, hc)
	g := connect(t, h, guest)
	next(t, g)

	load := cmd("e-load", syncevent.Load, 0)
	load["media_id"] = "media-42"
	send(t, h, hc, load)
	if ev := nextOf(t, g, syncevent.Load); ev.MediaID != "media-42" || ev.Status != "paused" || ev.Rate != 1 || ev.Version != 1 {
		t.Errorf("broadcast LOAD = %+v", ev)
	}

	rate := cmd("e-rate", syncevent.Rate, 2000)
	rate["rate"] = 1.5
	send(t, h, hc, rate)
	ev := nextOf(t, g, syncevent.Rate)
	if ev.Rate != 1.5 || ev.PositionMs != 2000 || ev.MediaID != "media-42" || ev.Version != 2 {
		t.Errorf("broadcast RATE = %+v", ev)
	}
	if st, ok := h.cached(room); !ok || st.MediaID != "media-42" || st.Rate != 1.5 {
		t.Errorf("la caché debe reflejar media y rate: %+v", st)
	}

	// Un participante nuevo ve el vídeo actual en su STATE.
	g2 := connect(t, h, guestTwo)
	if st := next(t, g2); st.MediaID != "media-42" || st.Rate != 1.5 {
		t.Errorf("STATE = %+v", st)
	}

	bad := cmd("e-bad", syncevent.Rate, 0)
	bad["rate"] = 10.0
	send(t, h, hc, bad)
	if ev := nextOf(t, hc, syncevent.Error); ev.Code != syncevent.CodeInvalid || ev.RefEventID != "e-bad" {
		t.Errorf("RATE fuera de rango = %+v", ev)
	}
}

func TestVolumeBroadcastAndState(t *testing.T) {
	e := newEnv(t)
	a := e.newHub(t)
	b := e.newHub(t)
	hc := connect(t, a, host)
	if st := next(t, hc); st.Volume == nil || *st.Volume != 1 {
		t.Errorf("STATE inicial debe llevar volume=1: %+v", st.Volume)
	}
	g := connect(t, b, guest) // otra réplica
	next(t, g)
	e.waitSubscribers(t, 2)

	send(t, a, hc, cmd("e-play", syncevent.Play, 1000))
	nextOf(t, g, syncevent.Play)

	e.clock.advance(2 * time.Second)
	vol := cmd("e-vol", syncevent.Volume, 50_000) // la posición del Host no mueve el ancla
	vol["volume"] = 0.0
	send(t, a, hc, vol)
	ev := nextOf(t, g, syncevent.Volume)
	if ev.Volume == nil || *ev.Volume != 0 || ev.Status != "playing" || ev.PositionMs != 3000 || ev.Version != 2 {
		t.Errorf("broadcast VOLUME en réplica B = %+v (volume %v)", ev, ev.Volume)
	}
	if st, ok := b.cached(room); !ok || st.Volume != 0 || st.Version != 2 {
		t.Errorf("la caché de B debe reflejar el volumen: %+v", st)
	}
	// Los demás broadcasts siguen llevando el volumen (aunque sea 0).
	send(t, a, hc, cmd("e-seek", syncevent.Seek, 7000))
	if ev := nextOf(t, g, syncevent.Seek); ev.Volume == nil || *ev.Volume != 0 {
		t.Errorf("SEEK debe llevar volume=0: %v", ev.Volume)
	}
	// STATE de un participante nuevo.
	g2 := connect(t, b, guestTwo)
	if st := next(t, g2); st.Volume == nil || *st.Volume != 0 {
		t.Errorf("STATE debe llevar volume=0: %v", st.Volume)
	}
	// SYNC_CORRECTION también lo lleva.
	send(t, b, g2, cmd("c1", syncevent.SyncCheck, 60_000))
	if corr := nextOf(t, g2, syncevent.SyncCorrection); corr.Volume == nil || *corr.Volume != 0 {
		t.Errorf("SYNC_CORRECTION debe llevar volume: %v", corr.Volume)
	}

	for _, v := range []any{nil, 1.5, -0.1} {
		bad := cmd("e-bad", syncevent.Volume, 0)
		if v != nil {
			bad["volume"] = v
		}
		send(t, a, hc, bad)
		if ev := nextOf(t, hc, syncevent.Error); ev.Code != syncevent.CodeInvalid || ev.RefEventID != "e-bad" {
			t.Errorf("VOLUME %v = %+v", v, ev)
		}
	}
}

func TestParticipantVolumeIsForbidden(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc := connect(t, h, host)
	next(t, hc)
	g := connect(t, h, guest)
	next(t, g)

	vol := cmd("e-evil", syncevent.Volume, 0)
	vol["volume"] = 0.1
	send(t, h, g, vol)
	if ev := nextOf(t, g, syncevent.Error); ev.Code != syncevent.CodeForbidden || ev.RefEventID != "e-evil" {
		t.Errorf("ERROR = %+v", ev)
	}
	expectSilence(t, hc)
	if st, _ := h.store.Load(context.Background(), room); st.Version != 0 || st.Volume != 1 {
		t.Errorf("el estado maestro debe quedar intacto: %+v", st)
	}
}

// Un broadcast de una réplica sin volume (versión anterior) se cachea con volumen 1.
func TestDeliverWithoutVolumeDefaultsToOne(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	g := connect(t, h, guest)
	next(t, g)
	ev := stateEvent(syncevent.Seek, room, master.State{Status: master.Paused, PositionMs: 1, Rate: 1, Version: 5}, e.clock.now())
	ev.Volume = nil
	h.Deliver(room, mustJSON(ev))
	if st, ok := h.cached(room); !ok || st.Volume != 1 || st.Version != 5 {
		t.Errorf("caché = %+v", st)
	}
}

func TestQualityBroadcastAndState(t *testing.T) {
	e := newEnv(t)
	a := e.newHub(t)
	b := e.newHub(t)
	hc := connect(t, a, host)
	if st := next(t, hc); st.Quality != "auto" {
		t.Errorf("STATE inicial debe llevar quality=auto: %q", st.Quality)
	}
	g := connect(t, b, guest) // otra réplica
	next(t, g)
	e.waitSubscribers(t, 2)

	q := cmd("e-q", syncevent.Quality, 0)
	q["quality"] = "720p"
	send(t, a, hc, q)
	if ack := collect(t, hc, syncevent.Ack)[syncevent.Ack]; ack.RefEventID != "e-q" || ack.Version != 1 {
		t.Errorf("ACK = %+v", ack)
	}
	ev := nextOf(t, g, syncevent.Quality)
	if ev.Quality != "720p" || ev.Status != "paused" || ev.Version != 1 || ev.Volume == nil || *ev.Volume != 1 {
		t.Errorf("broadcast QUALITY en réplica B = %+v", ev)
	}
	if st, ok := b.cached(room); !ok || st.Quality != "720p" {
		t.Errorf("la caché de B debe reflejar la calidad: %+v", st)
	}
	send(t, a, hc, cmd("e-play", syncevent.Play, 0))
	if ev := nextOf(t, g, syncevent.Play); ev.Quality != "720p" {
		t.Errorf("PLAY debe llevar quality: %q", ev.Quality)
	}
	g2 := connect(t, b, guestTwo)
	if st := next(t, g2); st.Quality != "720p" {
		t.Errorf("STATE debe llevar quality: %q", st.Quality)
	}
	e.clock.advance(time.Second)
	send(t, b, g2, cmd("c1", syncevent.SyncCheck, 60_000))
	if corr := nextOf(t, g2, syncevent.SyncCorrection); corr.Quality != "720p" {
		t.Errorf("SYNC_CORRECTION debe llevar quality: %q", corr.Quality)
	}

	bad := cmd("e-bad", syncevent.Quality, 0)
	bad["quality"] = "1080p"
	send(t, a, hc, bad)
	if ev := nextOf(t, hc, syncevent.Error); ev.Code != syncevent.CodeInvalid || ev.RefEventID != "e-bad" {
		t.Errorf("QUALITY inválida = %+v", ev)
	}
}

func TestParticipantQualityIsForbidden(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc := connect(t, h, host)
	next(t, hc)
	g := connect(t, h, guest)
	next(t, g)

	q := cmd("e-evil", syncevent.Quality, 0)
	q["quality"] = "360p"
	send(t, h, g, q)
	if ev := nextOf(t, g, syncevent.Error); ev.Code != syncevent.CodeForbidden || ev.RefEventID != "e-evil" {
		t.Errorf("ERROR = %+v", ev)
	}
	expectSilence(t, hc)
	if st, _ := h.store.Load(context.Background(), room); st.Version != 0 || st.Quality != "auto" {
		t.Errorf("el estado maestro debe quedar intacto: %+v", st)
	}
}

// Un broadcast de una réplica sin quality (versión anterior) se cachea como auto.
func TestDeliverWithoutQualityDefaultsToAuto(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	g := connect(t, h, guest)
	next(t, g)
	ev := stateEvent(syncevent.Seek, room, master.State{Status: master.Paused, PositionMs: 1, Rate: 1, Version: 5}, e.clock.now())
	ev.Quality = ""
	h.Deliver(room, mustJSON(ev))
	if st, ok := h.cached(room); !ok || st.Quality != "auto" || st.Version != 5 {
		t.Errorf("caché = %+v", st)
	}
}

// Cada comando aplicado (no duplicado) se publica como playback_command con
// el event_id del cliente; los rechazados y los duplicados no.
func TestCommandEmitsPlaybackTelemetry(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc := connect(t, h, host)
	next(t, hc)
	g := connect(t, h, guest)
	next(t, g)

	const id = "6f1c2a8e-8a4e-4d0a-9f5b-1c2d3e4f5a6b"
	e.clock.advance(time.Second)
	send(t, h, hc, cmd(id, syncevent.Seek, 5000))
	collect(t, hc, syncevent.Ack, syncevent.Seek)
	send(t, h, hc, cmd(id, syncevent.Seek, 5000)) // duplicado
	nextOf(t, hc, syncevent.Ack)
	send(t, h, g, cmd("e-evil", syncevent.Pause, 0)) // prohibido
	nextOf(t, g, syncevent.Error)

	got := e.tel.playbackList()
	if len(got) != 1 {
		t.Fatalf("playback_command emitidos = %d, want 1: %+v", len(got), got)
	}
	p := got[0]
	if p.EventID != id || p.RoomID != room || p.Command != "SEEK" || p.PositionMs != 5000 || p.Role != "host" ||
		!p.ReceivedAt.Equal(t0.Add(time.Second)) || !p.OccurredAt.Equal(t0.Add(-time.Hour)) {
		t.Errorf("muestra = %+v", p)
	}
}

func buffering(id string, durationMs, pos int64) map[string]any {
	ev := cmd(id, syncevent.Buffering, pos)
	ev["duration_ms"] = durationMs
	return ev
}

// BUFFERING solo alimenta la telemetría: sin ACK ni broadcast, máximo uno
// por segundo y por conexión (el exceso se descarta en silencio).
func TestBufferingEmitsTelemetryOnly(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc := connect(t, h, host)
	next(t, hc)
	g := connect(t, h, guest)
	next(t, g)
	e.waitSubscribers(t, 1)

	send(t, h, g, buffering("b1", 850, 12_345))
	expectSilence(t, g)
	expectSilence(t, hc)
	got := e.tel.bufferingList()
	if len(got) != 1 {
		t.Fatalf("buffering emitidos = %d, want 1", len(got))
	}
	if b := got[0]; b.EventID != "b1" || b.RoomID != room || b.DurationMs != 850 || b.PositionMs != 12_345 ||
		b.Role != "participant" || !b.ReceivedAt.Equal(t0) || !b.OccurredAt.Equal(t0.Add(-time.Hour)) {
		t.Errorf("muestra = %+v", b)
	}

	// Dentro del mismo segundo: se descarta sin ERROR.
	e.clock.advance(999 * time.Millisecond)
	send(t, h, g, buffering("b2", 300, 13_000))
	expectSilence(t, g)
	// El límite es por conexión: el host no se ve afectado.
	send(t, h, hc, buffering("b3", 200, 13_000))
	expectSilence(t, hc)
	if n := len(e.tel.bufferingList()); n != 2 {
		t.Fatalf("buffering emitidos = %d, want 2", n)
	}

	e.clock.advance(time.Millisecond)
	send(t, h, g, buffering("b4", 300, 14_000))
	if n := len(e.tel.bufferingList()); n != 3 {
		t.Errorf("pasado 1 s debe aceptarse otra vez: %d", n)
	}
	if st, _ := h.store.Load(context.Background(), room); st.Version != 0 {
		t.Errorf("BUFFERING no debe tocar el Reloj Maestro: %+v", st)
	}
}

func TestInvalidBufferingIsRejected(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	g := connect(t, h, guest)
	next(t, g)

	for name, ev := range map[string]map[string]any{
		"duración negativa": buffering("b1", -1, 0),
		"duración excesiva": buffering("b2", syncevent.MaxBufferingMs+1, 0),
		"posición negativa": buffering("b3", 100, -5),
	} {
		send(t, h, g, ev)
		if got := nextOf(t, g, syncevent.Error); got.Code != syncevent.CodeInvalid || got.RefEventID != ev["event_id"] {
			t.Errorf("%s: ERROR = %+v", name, got)
		}
	}
	if n := len(e.tel.bufferingList()); n != 0 {
		t.Errorf("un BUFFERING inválido no se emite: %d", n)
	}
	// Los inválidos no consumen el cupo de 1/s.
	send(t, h, g, buffering("b4", 100, 0))
	if n := len(e.tel.bufferingList()); n != 1 {
		t.Errorf("buffering válido tras inválidos = %d, want 1", n)
	}
}
