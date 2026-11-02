package store

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/master"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

const (
	room = "room-1"
	t0   = int64(1_791_655_200_000)
	ttl  = 12 * time.Hour
)

func setup(t *testing.T) (*Store, *miniredis.Miniredis, *redis.Client) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	return New(rdb, ttl), mr, rdb
}

func encodeVersion(st master.State) ([]byte, error) {
	return []byte(string(st.Status)), nil
}

func TestInitCreatesPausedRoomWithTTL(t *testing.T) {
	s, mr, _ := setup(t)
	ctx := context.Background()

	st, err := s.Init(ctx, room, "host-1", t0)
	if err != nil {
		t.Fatal(err)
	}
	want := master.Initial("host-1", t0)
	if st != want {
		t.Errorf("Init = %+v, want %+v", st, want)
	}
	if got := mr.TTL(syncevent.StateKey(room)); got != ttl {
		t.Errorf("TTL = %v, want %v", got, ttl)
	}
}

func TestInitIsIdempotentAndKeepsState(t *testing.T) {
	s, _, _ := setup(t)
	ctx := context.Background()
	if _, err := s.Init(ctx, room, "", t0); err != nil { // participante llega primero
		t.Fatal(err)
	}
	if _, _, err := s.Apply(ctx, room, "e1", master.Command{Type: syncevent.Seek, PositionMs: 9000}, t0+10, 0, encodeVersion); err != nil {
		t.Fatal(err)
	}
	st, err := s.Init(ctx, room, "host-1", t0+5000) // luego llega el host
	if err != nil {
		t.Fatal(err)
	}
	if st.PositionMs != 9000 || st.Version != 1 || st.UpdatedAtMs != t0+10 {
		t.Errorf("Init no debe pisar el estado existente: %+v", st)
	}
	if st.HostID != "host-1" {
		t.Errorf("HostID = %q, el host debe registrarse", st.HostID)
	}
}

func TestLoadMissing(t *testing.T) {
	s, _, _ := setup(t)
	if _, err := s.Load(context.Background(), "nope"); !errors.Is(err, ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestApplyPersistsPublishesAndRefreshesTTL(t *testing.T) {
	s, mr, rdb := setup(t)
	ctx := context.Background()
	if _, err := s.Init(ctx, room, "host-1", t0); err != nil {
		t.Fatal(err)
	}
	sub := rdb.Subscribe(ctx, syncevent.ChannelKey(room))
	defer sub.Close()
	if _, err := sub.Receive(ctx); err != nil { // confirmación de suscripción
		t.Fatal(err)
	}
	mr.FastForward(time.Hour)

	st, dup, err := s.Apply(ctx, room, "e1", master.Command{Type: syncevent.Play, PositionMs: 1000}, t0+500, 100, encodeVersion)
	if err != nil || dup {
		t.Fatalf("Apply: dup=%v err=%v", dup, err)
	}
	if st.Status != master.Playing || st.PositionMs != 1000 || st.UpdatedAtMs != t0+450 || st.Version != 1 {
		t.Errorf("estado = %+v", st)
	}
	loaded, err := s.Load(ctx, room)
	if err != nil || loaded != st {
		t.Errorf("Load = %+v (%v), want %+v", loaded, err, st)
	}
	if got := mr.TTL(syncevent.StateKey(room)); got != ttl {
		t.Errorf("el comando debe refrescar el TTL a 12h, got %v", got)
	}
	msg, err := sub.ReceiveMessage(ctx)
	if err != nil || msg.Payload != "playing" {
		t.Errorf("publish = %v (%v)", msg, err)
	}
}

func TestApplyDuplicateEventIsIgnored(t *testing.T) {
	s, _, _ := setup(t)
	ctx := context.Background()
	if _, err := s.Init(ctx, room, "host-1", t0); err != nil {
		t.Fatal(err)
	}
	cmd := master.Command{Type: syncevent.Seek, PositionMs: 5000}
	if _, _, err := s.Apply(ctx, room, "e1", cmd, t0, 0, encodeVersion); err != nil {
		t.Fatal(err)
	}
	st, dup, err := s.Apply(ctx, room, "e1", master.Command{Type: syncevent.Seek, PositionMs: 7000}, t0+1, 0, encodeVersion)
	if err != nil || !dup {
		t.Fatalf("dup=%v err=%v", dup, err)
	}
	if st.Version != 1 || st.PositionMs != 5000 {
		t.Errorf("un duplicado no debe modificar el estado: %+v", st)
	}
}

func TestApplyErrors(t *testing.T) {
	s, _, _ := setup(t)
	ctx := context.Background()
	if _, _, err := s.Apply(ctx, "missing", "e1", master.Command{Type: syncevent.Play}, t0, 0, encodeVersion); !errors.Is(err, ErrNotFound) {
		t.Errorf("sala inexistente: err = %v", err)
	}
	if _, err := s.Init(ctx, room, "host-1", t0); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Apply(ctx, room, "e2", master.Command{Type: syncevent.Seek, PositionMs: -1}, t0, 0, encodeVersion); !errors.Is(err, syncevent.ErrNegativePosition) {
		t.Errorf("posición negativa: err = %v", err)
	}
	boom := errors.New("boom")
	failing := func(master.State) ([]byte, error) { return nil, boom }
	if _, _, err := s.Apply(ctx, room, "e3", master.Command{Type: syncevent.Play}, t0, 0, failing); !errors.Is(err, boom) {
		t.Errorf("encode fallido: err = %v", err)
	}
	if st, _ := s.Load(ctx, room); st.Version != 0 {
		t.Errorf("errores no deben modificar el estado: %+v", st)
	}
}

// Comandos concurrentes desde varias "réplicas": la transacción optimista
// garantiza que ninguna actualización se pierda (version == N).
func TestApplyConcurrentCommandsAreSerialized(t *testing.T) {
	s, _, _ := setup(t)
	ctx := context.Background()
	if _, err := s.Init(ctx, room, "host-1", t0); err != nil {
		t.Fatal(err)
	}
	const n = 20
	var wg sync.WaitGroup
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, _, err := s.Apply(ctx, room, "evt-"+string(rune('a'+i)), master.Command{Type: syncevent.Seek, PositionMs: int64(i)}, t0, 0, encodeVersion)
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	st, _ := s.Load(ctx, room)
	if st.Version != n {
		t.Errorf("version = %d, want %d (se perdieron actualizaciones)", st.Version, n)
	}
}

func TestHostPresence(t *testing.T) {
	s, _, _ := setup(t)
	ctx := context.Background()

	n, err := s.HostSeen(ctx, room, "c1", t0)
	if err != nil || n != 1 {
		t.Fatalf("HostSeen c1 = %d, %v", n, err)
	}
	if n, _ = s.HostSeen(ctx, room, "c2", t0); n != 2 {
		t.Errorf("dos conexiones de host = %d", n)
	}
	if n, _ = s.HostSeen(ctx, room, "c1", t0+1000); n != 2 {
		t.Errorf("refrescar no duplica = %d", n)
	}
	if n, _ = s.HostGone(ctx, room, "c1", t0+1000); n != 1 {
		t.Errorf("tras salir c1 = %d", n)
	}
	// c2 dejó de latir (réplica caída): pasado el timeout no cuenta.
	if n, _ = s.OnlineHosts(ctx, room, t0+PresenceTimeout.Milliseconds()+1); n != 0 {
		t.Errorf("host sin latidos debe expirar, online = %d", n)
	}
}

func TestTouchRefreshesTTL(t *testing.T) {
	s, mr, _ := setup(t)
	ctx := context.Background()
	if _, err := s.Init(ctx, room, "", t0); err != nil {
		t.Fatal(err)
	}
	mr.FastForward(11 * time.Hour)
	if err := s.Touch(ctx, room); err != nil {
		t.Fatal(err)
	}
	if got := mr.TTL(syncevent.StateKey(room)); got != ttl {
		t.Errorf("TTL tras Touch = %v", got)
	}
	mr.FastForward(ttl + time.Second)
	if _, err := s.Load(ctx, room); !errors.Is(err, ErrNotFound) {
		t.Errorf("tras el periodo de gracia la sala expira: err = %v", err)
	}
}

func TestRedisDown(t *testing.T) {
	s, mr, _ := setup(t)
	mr.Close()
	ctx := context.Background()
	if _, err := s.Init(ctx, room, "h", t0); err == nil {
		t.Error("Init con Redis caído debe fallar")
	}
	if _, err := s.Load(ctx, room); err == nil || errors.Is(err, ErrNotFound) {
		t.Errorf("Load con Redis caído: err = %v", err)
	}
	if _, _, err := s.Apply(ctx, room, "e", master.Command{Type: syncevent.Play}, t0, 0, encodeVersion); err == nil {
		t.Error("Apply con Redis caído debe fallar")
	}
	if _, err := s.HostSeen(ctx, room, "c", t0); err == nil {
		t.Error("HostSeen con Redis caído debe fallar")
	}
	if _, err := s.HostGone(ctx, room, "c", t0); err == nil {
		t.Error("HostGone con Redis caído debe fallar")
	}
}

func TestParseCorruptState(t *testing.T) {
	s, mr, _ := setup(t)
	mr.HSet(syncevent.StateKey(room), "status", "playing", "position_ms", "x")
	if _, err := s.Load(context.Background(), room); err == nil {
		t.Error("estado corrupto debe devolver error")
	}
}

// Dos réplicas (dos Store con su propio cliente) y muchos cohosts a la vez:
// ningún comando debe perderse ni agotar los reintentos.
func TestApplyHeavyContentionAcrossReplicas(t *testing.T) {
	mr := miniredis.RunT(t)
	newReplica := func() *Store {
		rdb := redis.NewClient(&redis.Options{Addr: mr.Addr(), PoolSize: 32})
		t.Cleanup(func() { _ = rdb.Close() })
		return New(rdb, ttl)
	}
	a, b := newReplica(), newReplica()
	ctx := context.Background()
	if _, err := a.Init(ctx, room, "host-1", t0); err != nil {
		t.Fatal(err)
	}
	const perReplica = 60
	var wg sync.WaitGroup
	errs := make(chan error, 2*perReplica)
	for i := 0; i < perReplica; i++ {
		for r, s := range []*Store{a, b} {
			wg.Add(1)
			go func(s *Store, id string, pos int64) {
				defer wg.Done()
				_, _, err := s.Apply(ctx, room, id, master.Command{Type: syncevent.Seek, PositionMs: pos}, t0, 0, encodeVersion)
				errs <- err
			}(s, fmt.Sprintf("r%d-e%d", r, i), int64(i))
		}
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if st, _ := a.Load(ctx, room); st.Version != 2*perReplica {
		t.Errorf("version = %d, want %d", st.Version, 2*perReplica)
	}
}

func TestApplyPersistsMediaAndRate(t *testing.T) {
	s, _, _ := setup(t)
	ctx := context.Background()
	if _, err := s.Init(ctx, room, "host-1", t0); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Apply(ctx, room, "e1", master.Command{Type: syncevent.Load, MediaID: "m-1"}, t0, 0, encodeVersion); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Apply(ctx, room, "e2", master.Command{Type: syncevent.Rate, PositionMs: 10, Rate: 1.5}, t0+1, 0, encodeVersion); err != nil {
		t.Fatal(err)
	}
	st, err := s.Load(ctx, room)
	if err != nil || st.MediaID != "m-1" || st.Rate != 1.5 || st.Version != 2 {
		t.Errorf("estado = %+v (%v)", st, err)
	}
}

// Estados escritos antes de existir media_id siguen siendo legibles.
func TestLoadStateWithoutMediaField(t *testing.T) {
	s, mr, _ := setup(t)
	mr.HSet(syncevent.StateKey(room), "status", "paused", "position_ms", "5", "updated_at_ms", "1", "rate", "1", "version", "2", "host_id", "h")
	st, err := s.Load(context.Background(), room)
	if err != nil || st.MediaID != "" || st.Version != 2 {
		t.Errorf("estado = %+v (%v)", st, err)
	}
}

// Otra réplica escribe entre la lectura y el CAS: se reintenta y se cuenta.
func TestApplyCountsConflicts(t *testing.T) {
	s, mr, _ := setup(t)
	ctx := context.Background()
	if _, err := s.Init(ctx, room, "h", t0); err != nil {
		t.Fatal(err)
	}
	calls := 0
	racy := func(st master.State) ([]byte, error) {
		calls++
		if calls == 1 {
			mr.HSet(syncevent.StateKey(room), "version", "5") // escritura concurrente
		}
		return encodeVersion(st)
	}
	st, _, err := s.Apply(ctx, room, "e1", master.Command{Type: syncevent.Seek, PositionMs: 1}, t0, 0, racy)
	if err != nil || st.Version != 6 {
		t.Fatalf("Apply tras conflicto = %+v (%v)", st, err)
	}
	if s.Conflicts() != 1 {
		t.Errorf("Conflicts = %d, want 1", s.Conflicts())
	}
}

func TestApplyPersistsVolume(t *testing.T) {
	s, _, _ := setup(t)
	ctx := context.Background()
	st, err := s.Init(ctx, room, "host-1", t0)
	if err != nil || st.Volume != 1 {
		t.Fatalf("Init = %+v (%v), volumen inicial 1", st, err)
	}
	if _, _, err := s.Apply(ctx, room, "e1", master.Command{Type: syncevent.Volume, Volume: 0}, t0+1, 0, encodeVersion); err != nil {
		t.Fatal(err)
	}
	st, err = s.Load(ctx, room)
	if err != nil || st.Volume != 0 || st.Version != 1 {
		t.Errorf("estado = %+v (%v)", st, err)
	}
}

// Estados escritos antes de existir volume se leen con volumen 1; un valor
// corrupto es un error.
func TestLoadStateWithoutVolumeField(t *testing.T) {
	s, mr, _ := setup(t)
	mr.HSet(syncevent.StateKey(room), "status", "paused", "position_ms", "5", "updated_at_ms", "1", "rate", "1", "version", "2", "host_id", "h")
	st, err := s.Load(context.Background(), room)
	if err != nil || st.Volume != 1 {
		t.Errorf("estado = %+v (%v)", st, err)
	}
	mr.HSet(syncevent.StateKey(room), "volume", "fuerte")
	if _, err := s.Load(context.Background(), room); err == nil {
		t.Error("volume corrupto debe fallar")
	}
}

func TestApplyPersistsQuality(t *testing.T) {
	s, mr, _ := setup(t)
	ctx := context.Background()
	st, err := s.Init(ctx, room, "host-1", t0)
	if err != nil || st.Quality != "auto" {
		t.Fatalf("Init = %+v (%v), calidad inicial auto", st, err)
	}
	if _, _, err := s.Apply(ctx, room, "e1", master.Command{Type: syncevent.Quality, Quality: "360p"}, t0+1, 0, encodeVersion); err != nil {
		t.Fatal(err)
	}
	st, err = s.Load(ctx, room)
	if err != nil || st.Quality != "360p" || st.Version != 1 {
		t.Errorf("estado = %+v (%v)", st, err)
	}
	if got := mr.HGet(syncevent.StateKey(room), "quality"); got != "360p" {
		t.Errorf("hash quality = %q", got)
	}
}

// Estados escritos antes de existir quality se leen con calidad auto.
func TestLoadStateWithoutQualityField(t *testing.T) {
	s, mr, _ := setup(t)
	mr.HSet(syncevent.StateKey(room), "status", "paused", "position_ms", "5", "updated_at_ms", "1", "rate", "1", "version", "2", "host_id", "h")
	st, err := s.Load(context.Background(), room)
	if err != nil || st.Quality != "auto" {
		t.Errorf("estado = %+v (%v)", st, err)
	}
}

// DAT-03: tras reiniciar Redis el store vuelve a funcionar con el mismo cliente y conserva el
// estado de la sala (Redis persiste con AOF; miniredis conserva los datos al reiniciarse).
func TestStoreRecoversAfterRedisRestart(t *testing.T) {
	s, mr, _ := setup(t)
	ctx := context.Background()
	if _, err := s.Init(ctx, room, "host-1", t0); err != nil {
		t.Fatal(err)
	}

	mr.Close()
	if _, err := s.Load(ctx, room); err == nil {
		t.Fatal("con Redis caído Load debería fallar")
	}
	if err := mr.Restart(); err != nil {
		t.Fatal(err)
	}

	st, err := s.Load(ctx, room)
	if err != nil {
		t.Fatalf("Load tras el reinicio: %v", err)
	}
	if st != master.Initial("host-1", t0) {
		t.Errorf("estado tras el reinicio = %+v", st)
	}
	if _, _, err := s.Apply(ctx, room, "e1", master.Command{Type: syncevent.Seek, PositionMs: 5000}, t0+10, 0, encodeVersion); err != nil {
		t.Fatalf("Apply tras el reinicio: %v", err)
	}
}
