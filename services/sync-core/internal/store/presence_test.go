package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

func TestBeatAndPresence(t *testing.T) {
	s, mr, _ := setup(t)
	ctx := context.Background()
	if err := s.Beat(ctx, room, []string{"c1"}, []string{"guest:b", "guest:a"}, t0); err != nil {
		t.Fatal(err)
	}
	p, err := s.Presence(ctx, room, t0)
	if err != nil || p.Online != 1 || p.Delegate != "" || p.HostlessSinceMs != 0 {
		t.Fatalf("Presence = %+v (%v)", p, err)
	}
	members, err := s.LiveMembers(ctx, room, t0+1000)
	if err != nil || len(members) != 2 || members[0] != "guest:a" || members[1] != "guest:b" {
		t.Errorf("LiveMembers = %v (%v), want ordenados", members, err)
	}
	if got := mr.TTL(syncevent.MembersKey(room)); got != ttl {
		t.Errorf("TTL miembros = %v", got)
	}
	// Sin latidos, pasado el timeout ya no cuentan.
	later := t0 + PresenceTimeout.Milliseconds() + 1
	if p, _ := s.Presence(ctx, room, later); p.Online != 0 {
		t.Errorf("host sin latir debe expirar: %+v", p)
	}
	if m, _ := s.LiveMembers(ctx, room, later); len(m) != 0 {
		t.Errorf("miembros sin latir deben expirar: %v", m)
	}
	if err := s.Beat(ctx, room, nil, nil, t0); err != nil {
		t.Errorf("Beat vacío no debe fallar: %v", err)
	}
	if err := s.MemberGone(ctx, room, "guest:a"); err != nil {
		t.Fatal(err)
	}
	if m, _ := s.LiveMembers(ctx, room, t0); len(m) != 1 || m[0] != "guest:b" {
		t.Errorf("tras MemberGone = %v", m)
	}
}

func TestSetHostStatusOnlyReportsTransitions(t *testing.T) {
	s, _, _ := setup(t)
	ctx := context.Background()
	steps := []struct {
		online  bool
		changed bool
		since   int64
	}{
		{false, false, 0},  // sala sin host desde el inicio: no hay transición ni gracia
		{true, true, 0},    // llega el host
		{true, false, 0},   // sigue
		{false, true, t0},  // se va: empieza la cuenta de la delegación
		{false, false, t0}, // otra réplica evalúa lo mismo: sin duplicados
		{true, true, 0},    // vuelve: se borra la cuenta
	}
	for i, st := range steps {
		changed, err := s.SetHostStatus(ctx, room, st.online, t0)
		if err != nil || changed != st.changed {
			t.Fatalf("paso %d: changed=%v err=%v, want %v", i, changed, err, st.changed)
		}
		p, _ := s.Presence(ctx, room, t0)
		if p.HostlessSinceMs != st.since {
			t.Errorf("paso %d: hostless_since = %d, want %d", i, p.HostlessSinceMs, st.since)
		}
	}
}

func TestSwapDelegate(t *testing.T) {
	s, mr, _ := setup(t)
	ctx := context.Background()
	prev, err := s.SwapDelegate(ctx, room, "guest:a")
	if err != nil || prev != "" {
		t.Fatalf("primer delegado: prev=%q err=%v", prev, err)
	}
	if prev, _ = s.SwapDelegate(ctx, room, "guest:a"); prev != "guest:a" {
		t.Errorf("mismo delegado: prev = %q", prev)
	}
	if got := mr.TTL(syncevent.DelegateKey(room)); got != ttl {
		t.Errorf("TTL delegado = %v", got)
	}
	if p, _ := s.Presence(ctx, room, t0); p.Delegate != "guest:a" {
		t.Errorf("Presence.Delegate = %q", p.Delegate)
	}
	if prev, _ = s.SwapDelegate(ctx, room, ""); prev != "guest:a" {
		t.Errorf("anular: prev = %q", prev)
	}
	if prev, _ = s.SwapDelegate(ctx, room, ""); prev != "" {
		t.Errorf("anular dos veces: prev = %q", prev)
	}
}

func TestIsRevoked(t *testing.T) {
	s, mr, _ := setup(t)
	ctx := context.Background()
	if ok, err := s.IsRevoked(ctx, "j1"); err != nil || ok {
		t.Fatalf("IsRevoked = %v, %v", ok, err)
	}
	_ = mr.Set(syncevent.RevokedKey("j1"), "1")
	if ok, _ := s.IsRevoked(ctx, "j1"); !ok {
		t.Error("jti revocado no detectado")
	}
	if ok, _ := s.IsRevoked(ctx, ""); ok {
		t.Error("jti vacío nunca está revocado")
	}
}

func TestPresenceRedisDown(t *testing.T) {
	s, mr, _ := setup(t)
	mr.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := s.Presence(ctx, room, t0); err == nil {
		t.Error("Presence")
	}
	if _, err := s.SetHostStatus(ctx, room, true, t0); err == nil {
		t.Error("SetHostStatus")
	}
	if _, err := s.SwapDelegate(ctx, room, "x"); err == nil {
		t.Error("SwapDelegate")
	}
	if _, err := s.LiveMembers(ctx, room, t0); err == nil {
		t.Error("LiveMembers")
	}
	if _, err := s.IsRevoked(ctx, "j"); err == nil {
		t.Error("IsRevoked")
	}
	if err := s.Beat(ctx, room, []string{"c"}, nil, t0); err == nil {
		t.Error("Beat")
	}
}

// REQ-07: una sala con clientes conectados que no envían comandos no debe
// perder su sync_state; el latido del barrido renueva su TTL.
func TestBeatRefreshesSyncStateTTL(t *testing.T) {
	s, mr, _ := setup(t)
	ctx := context.Background()
	mr.HSet(syncevent.StateKey(room), "version", "3")
	mr.SetTTL(syncevent.StateKey(room), ttl)
	for range 3 {
		mr.FastForward(ttl - time.Hour)
		if err := s.Beat(ctx, room, nil, []string{"guest:a"}, t0); err != nil {
			t.Fatal(err)
		}
		if got := mr.TTL(syncevent.StateKey(room)); got != ttl {
			t.Fatalf("TTL sync_state tras el latido = %v, want %v", got, ttl)
		}
	}
	if !mr.Exists(syncevent.StateKey(room)) {
		t.Error("sync_state expiró con clientes conectados")
	}
	// Una sala sin estado no lo crea por latir.
	if err := s.Beat(ctx, "vacia", []string{"c1"}, nil, t0); err != nil {
		t.Fatal(err)
	}
	if mr.Exists(syncevent.StateKey("vacia")) {
		t.Error("el latido no debe crear sync_state")
	}
}

// ADR 0019: room:{id}:closed (sin TTL, lo escribe identity-api) marca una
// sala deshabilitada.
func TestIsRoomClosed(t *testing.T) {
	s, mr, _ := setup(t)
	ctx := context.Background()
	if ok, err := s.IsRoomClosed(ctx, room); err != nil || ok {
		t.Fatalf("IsRoomClosed = %v, %v", ok, err)
	}
	_ = mr.Set(syncevent.ClosedKey(room), "1")
	if ok, err := s.IsRoomClosed(ctx, room); err != nil || !ok {
		t.Errorf("sala cerrada no detectada: %v, %v", ok, err)
	}
	if ok, _ := s.IsRoomClosed(ctx, "otra"); ok {
		t.Error("la clave de una sala no cierra otra")
	}
	mr.Close()
	if _, err := s.IsRoomClosed(ctx, room); err == nil {
		t.Error("sin Redis IsRoomClosed debe fallar (el handshake falla cerrado)")
	}
}

// Init comprueba room:{id}:closed en la misma transacción: cubre la carrera
// en la que la sala se cierra entre la comprobación del handshake y la
// suscripción al bus (el ROOM_CLOSED se publicó antes de suscribirse).
func TestInitRejectsClosedRoom(t *testing.T) {
	s, mr, _ := setup(t)
	_ = mr.Set(syncevent.ClosedKey(room), "1")
	if _, err := s.Init(context.Background(), room, "h", t0); !errors.Is(err, ErrRoomClosed) {
		t.Fatalf("Init sala cerrada: err = %v, want ErrRoomClosed", err)
	}
}
