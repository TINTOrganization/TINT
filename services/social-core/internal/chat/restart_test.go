package chat

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// DAT-03: tras reiniciar Redis el historial del chat sigue ahí y se puede seguir escribiendo.
func TestHistoryRecoversAfterRedisRestart(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	s := NewRedisStoreWithClient(client, 10, time.Hour)
	ctx := context.Background()
	if err := s.Push(ctx, "r1", msg("1", "antes")); err != nil {
		t.Fatal(err)
	}

	mr.Close()
	if err := s.Push(ctx, "r1", msg("x", "perdido")); err == nil {
		t.Fatal("con Redis caído Push debería fallar (el usuario ve un error de entrega)")
	}
	if err := mr.Restart(); err != nil {
		t.Fatal(err)
	}

	if err := s.Push(ctx, "r1", msg("2", "despues")); err != nil {
		t.Fatalf("Push tras el reinicio: %v", err)
	}
	got, err := s.Recent(ctx, "r1", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].EventID != "1" || got[1].EventID != "2" {
		t.Errorf("historial tras el reinicio = %+v", got)
	}
}

// DAT-03: la suscripción de la sala (REVOKED de identity-api) se restablece sola tras el corte.
func TestSubscriptionResumesAfterRedisRestart(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	s := NewRedisStoreWithClient(client, 10, time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	in, stop := s.Subscribe(ctx, "r1")
	defer stop()
	waitSubs(t, mr, "room:r1:sync", 1)

	mr.Close()
	if err := mr.Restart(); err != nil {
		t.Fatal(err)
	}
	waitSubs(t, mr, "room:r1:sync", 1)

	if err := s.PublishRaw(ctx, "r1", []byte(`{"type":"x"}`)); err != nil {
		t.Fatalf("publicar tras el reinicio: %v", err)
	}
	revoked := []byte(`{"type":"REVOKED","jti":"j-1"}`)
	if n, err := client.Publish(ctx, "room:r1:sync", revoked).Result(); err != nil || n != 1 {
		t.Fatalf("publish = %d, %v", n, err)
	}
	select {
	case got := <-in:
		if got.RevokedJTI != "j-1" {
			t.Errorf("recibido %+v", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("la revocación publicada tras el reinicio no llegó")
	}
}

func waitSubs(t *testing.T, mr *miniredis.Miniredis, channel string, n int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if mr.PubSubNumSub(channel)[channel] == n {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("esperaba %d suscriptores en %s", n, channel)
}
