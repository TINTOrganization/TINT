package hub

import (
	"context"
	"testing"
	"time"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/codec"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/drift"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/master"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/store"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

// syncCheck arma un SYNC_CHECK con la posición local del cliente.
func syncCheck(id string, pos int64) map[string]any {
	return cmd(id, syncevent.SyncCheck, pos)
}

// playingRoom conecta host e invitado y deja la sala reproduciendo desde 0
// en t0 (version 1).
func playingRoom(t *testing.T, e *env, h *Hub) (*Client, *Client) {
	t.Helper()
	hc := connect(t, h, host)
	next(t, hc)
	g := connect(t, h, guest)
	next(t, g)
	send(t, h, hc, cmd("e-play", syncevent.Play, 0))
	nextOf(t, g, syncevent.Play)
	return hc, g
}

// Un cliente en stall reporta la misma posición congelada en cada latido:
// sin enfriamiento, cada SYNC_CHECK producía otro seek (bucle seek→stall→seek).
func TestSeekCorrectionCooldown(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	_, g := playingRoom(t, e, h)

	// t0+10s: el maestro va en 10000 y el cliente sigue congelado en 0.
	e.clock.advance(10 * time.Second)
	send(t, h, g, syncCheck("c1", 0))
	if corr := nextOf(t, g, syncevent.SyncCorrection); corr.Strategy != "seek" {
		t.Fatalf("primera corrección = %+v, want seek", corr)
	}
	if e.tel.count() != 1 {
		t.Fatalf("telemetría = %d, want 1", e.tel.count())
	}

	// Dentro del enfriamiento (3 s) no se repite el seek ni se reporta.
	for i := 0; i < 2; i++ {
		e.clock.advance(time.Second)
		send(t, h, g, syncCheck("c-frozen", 0))
		expectSilence(t, g)
	}
	if e.tel.count() != 1 {
		t.Errorf("un seek suprimido no debe emitir telemetría: %d", e.tel.count())
	}

	// Una corrección por rate sí se permite durante el enfriamiento
	// (t0+12s: el maestro va en 12000; el cliente, 1000 atrasado).
	send(t, h, g, syncCheck("c-rate", 11_000))
	if corr := nextOf(t, g, syncevent.SyncCorrection); corr.Strategy != "rate" {
		t.Errorf("durante el enfriamiento rate sigue permitido: %+v", corr)
	}

	// Cumplidos 3 s desde el último seek, vuelve a corregir con seek.
	e.clock.advance(time.Duration(drift.SeekCooldownMs)*time.Millisecond - 2*time.Second)
	send(t, h, g, syncCheck("c-again", 0))
	if corr := nextOf(t, g, syncevent.SyncCorrection); corr.Strategy != "seek" {
		t.Errorf("tras el enfriamiento = %+v, want seek", corr)
	}
}

// Tras un SEEK del host, el SYNC_CHECK que el cliente envió antes de aplicar
// el broadcast trae su version anterior: corregirlo provocaba un segundo
// seek duplicado. Se ignora (sin corrección ni drift contado).
func TestSyncCheckWithOlderVersionIsSkipped(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc, g := playingRoom(t, e, h) // version 1
	e.clock.advance(time.Second)
	send(t, h, hc, cmd("e-seek", syncevent.Seek, 60_000))
	nextOf(t, g, syncevent.Seek) // version 2 en la caché

	// El cliente aún reproduce en ~1000 (version 1): no se corrige.
	stale := syncCheck("c-old", 1_000)
	stale["version"] = 1
	send(t, h, g, stale)
	expectSilence(t, g)
	if e.tel.count() != 0 {
		t.Errorf("un SYNC_CHECK atrasado no debe emitir telemetría: %d", e.tel.count())
	}
	if d := g.lastDriftMs.Load(); d != 0 {
		t.Errorf("no debe contar drift para un SYNC_CHECK atrasado: %d", d)
	}

	// Con la version vigente (o mayor) sí se corrige.
	current := syncCheck("c-cur", 1_000)
	current["version"] = 2
	send(t, h, g, current)
	if corr := nextOf(t, g, syncevent.SyncCorrection); corr.Strategy != "seek" || corr.Version != 2 {
		t.Errorf("SYNC_CHECK con version vigente = %+v", corr)
	}
}

// Sin version (clientes anteriores) o con 0, el comportamiento no cambia.
func TestSyncCheckWithoutVersionStillCorrects(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	_, g := playingRoom(t, e, h)
	e.clock.advance(10 * time.Second)
	zero := syncCheck("c-zero", 9_000)
	zero["version"] = 0
	send(t, h, g, zero)
	if corr := nextOf(t, g, syncevent.SyncCorrection); corr.Strategy != "rate" {
		t.Errorf("version 0 = %+v, want rate", corr)
	}
}

// Un cliente MessagePack también puede enviar la version en SYNC_CHECK.
func TestMsgPackSyncCheckWithOlderVersionIsSkipped(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	hc, _ := playingRoom(t, e, h)
	send(t, h, hc, cmd("e-seek", syncevent.Seek, 60_000))
	m, err := h.Connect(context.Background(), guestTwo, WithCodec(codec.MsgPack))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.Disconnect(m) })
	<-m.Send() // STATE
	raw, _ := codec.MsgPack.Encode(syncevent.Event{
		EventID: "mp-check", Type: syncevent.SyncCheck, RoomID: room, PositionMs: 0, OccurredAt: t0, Version: 1,
	})
	h.Handle(context.Background(), m, raw)
	timeout := time.After(50 * time.Millisecond)
	for {
		select {
		case raw := <-m.Send():
			var ev syncevent.Event
			_ = codec.MsgPack.Decode(raw, &ev)
			if ev.Type == syncevent.SyncCorrection {
				t.Fatalf("SYNC_CHECK msgpack atrasado no debe corregirse: %+v", ev)
			}
		case <-timeout:
			return
		}
	}
}

// Un host que hace scrubbing agota los 20 msg/s con comandos: si el
// SYNC_CHECK contara en ese límite recibiría RATE_LIMITED, dejaría de
// renovar lastCheckMs y acabaría cerrado como stale (1008).
func TestSyncCheckIsExemptFromMessageLimit(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	_, g := playingRoom(t, e, h)
	e.clock.advance(10 * time.Second)

	for i := 0; i < MaxMsgsPerSecond; i++ {
		send(t, h, g, buffering("b", 100, 0))
	}
	// El límite general está agotado, pero el SYNC_CHECK se procesa.
	send(t, h, g, syncCheck("c", 9_000))
	if corr := nextOf(t, g, syncevent.SyncCorrection); corr.Strategy != "rate" {
		t.Errorf("SYNC_CHECK con el límite general agotado = %+v", corr)
	}
	if got := g.lastCheckMs.Load(); got != e.clock.now().UnixMilli() {
		t.Errorf("lastCheckMs = %d, want %d", got, e.clock.now().UnixMilli())
	}
	// Y no consume cupo del límite general: el siguiente BUFFERING sigue
	// siendo el 21.º de la ventana.
	send(t, h, g, buffering("b", 100, 0))
	if ev := nextOf(t, g, syncevent.Error); ev.Code != syncevent.CodeRateLimited {
		t.Errorf("ERROR = %+v", ev)
	}
}

// SYNC_CHECK tiene su propio límite (5/s); el exceso se descarta en silencio.
func TestSyncCheckOwnLimit(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	_, g := playingRoom(t, e, h)
	e.clock.advance(10 * time.Second)

	for i := 0; i < MaxSyncChecksPerSecond; i++ {
		send(t, h, g, syncCheck("c", 9_000)) // 1000 atrasado: corrección por rate
		nextOf(t, g, syncevent.SyncCorrection)
	}
	send(t, h, g, syncCheck("c-extra", 9_000))
	expectSilence(t, g) // ni corrección ni ERROR
	if n := e.tel.count(); n != MaxSyncChecksPerSecond {
		t.Errorf("correcciones = %d, want %d", n, MaxSyncChecksPerSecond)
	}

	e.clock.advance(time.Second)
	send(t, h, g, syncCheck("c-next", 10_000))
	nextOf(t, g, syncevent.SyncCorrection)
}

// Un mensaje que no se puede decodificar sigue contando en el límite general.
func TestUndecodableMessagesAreRateLimited(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	g := connect(t, h, guest)
	next(t, g)
	for i := 0; i < MaxMsgsPerSecond; i++ {
		h.Handle(context.Background(), g, []byte("{basura"))
		if ev := nextOf(t, g, syncevent.Error); ev.Code != syncevent.CodeInvalid {
			t.Fatalf("ERROR = %+v", ev)
		}
	}
	h.Handle(context.Background(), g, []byte("{basura"))
	if ev := nextOf(t, g, syncevent.Error); ev.Code != syncevent.CodeRateLimited {
		t.Errorf("ERROR = %+v, want RATE_LIMITED", ev)
	}
}

// slowStore simula las idas y vueltas a Redis de Connect avanzando el reloj.
type slowStore struct {
	StateStore
	clock *fakeClock
	d     time.Duration
}

func (s *slowStore) Init(ctx context.Context, roomID, hostID string, nowMs int64) (master.State, error) {
	s.clock.advance(s.d)
	return s.StateStore.Init(ctx, roomID, hostID, nowMs)
}

func (s *slowStore) BeatPresence(ctx context.Context, roomID string, hosts, members []string, nowMs int64) (store.Presence, error) {
	s.clock.advance(s.d)
	return s.StateStore.BeatPresence(ctx, roomID, hosts, members, nowMs)
}

// El cliente proyecta la posición con server_time_ms del STATE: si se
// sellaba al inicio de Connect (antes de Init y BeatPresence), el cliente
// arrancaba atrasado lo que tardaron esas idas y vueltas.
func TestInitialStateIsStampedWhenEnqueued(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	h.store = &slowStore{StateStore: h.store, clock: e.clock, d: 40 * time.Millisecond}

	g := connect(t, h, guest)
	st := next(t, g)
	want := t0.Add(80 * time.Millisecond).UnixMilli()
	if st.Type != syncevent.State || st.ServerTimeMs != want {
		t.Errorf("STATE server_time_ms = %d, want %d (tras las idas y vueltas)", st.ServerTimeMs, want)
	}
	if st.ReceivedAt.UnixMilli() != want {
		t.Errorf("STATE received_at = %v, want %d", st.ReceivedAt, want)
	}
}

// El enfriamiento es por cliente: el seek de uno no silencia al otro.
func TestSeekCooldownIsPerClient(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	_, g := playingRoom(t, e, h)
	g2 := connect(t, h, guestTwo)
	next(t, g2)

	e.clock.advance(10 * time.Second)
	send(t, h, g, syncCheck("a", 0))
	nextOf(t, g, syncevent.SyncCorrection)
	send(t, h, g2, syncCheck("b", 0))
	if corr := nextOf(t, g2, syncevent.SyncCorrection); corr.Strategy != "seek" {
		t.Errorf("el otro cliente debe recibir su seek: %+v", corr)
	}
}
