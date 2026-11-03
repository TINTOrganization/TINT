package chat

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

// ADR 0019 / dominio-transmision §6.1: ROOM_CLOSED llega por room:{id}:sync
// y STREAM_STARTED/STREAM_ENDED por room:{id}:stream. Los mensajes mal
// formados (o de otra sala) se descartan; los válidos se entregan como
// RoomClosed / Stream, nunca como payload para los clientes.
func TestRedisSubscribeDeliversRoomClosedAndStream(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()
	s := NewRedisStoreWithClient(client, 3, time.Hour)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sub, stop := s.Subscribe(ctx, "r1")
	defer stop()
	waitSubscribers(t, mr, StreamChannelKey("r1"))

	publish := func(channel, raw string) {
		t.Helper()
		if err := client.Publish(ctx, channel, raw).Err(); err != nil {
			t.Fatal(err)
		}
	}
	next := func() Inbound {
		t.Helper()
		select {
		case got := <-sub:
			return got
		case <-ctx.Done():
			t.Fatal("timeout esperando el evento")
		}
		return Inbound{}
	}

	// Mal formados: se descartan.
	for _, raw := range []string{
		`{"type":"ROOM_CLOSED","room_id":"r1","reason":"host_ended"}`,                 // sin event_id
		`{"type":"ROOM_CLOSED","event_id":"c0","room_id":"r2","reason":"host_ended"}`, // otra sala
		`{"type":"ROOM_CLOSED","event_id":"c0","reason":"host_ended"}`,                // sin room_id
		`{"type":"ROOM_CLOSED","event_id":"c0","room_id":"r1","reason":"x"}`,          // reason fuera del contrato
	} {
		publish(SyncChannelKey("r1"), raw)
	}
	publish(SyncChannelKey("r1"), `{"type":"ROOM_CLOSED","event_id":"c1","room_id":"r1","reason":"host_ended","occurred_at":"2026-11-01T18:00:00.000Z"}`)
	if got := next(); !got.RoomClosed || got.Payload != nil || got.Sync != nil {
		t.Fatalf("sub = %+v, want RoomClosed", got)
	}

	for _, raw := range []string{
		`no-json`,
		`{"type":"STREAM_STARTED","event_id":"s0","room_id":"r1"}`,                        // sin started_at_ms
		`{"type":"STREAM_STARTED","event_id":"s0","room_id":"r1","started_at_ms":-5}`,     // negativo
		`{"type":"STREAM_STARTED","room_id":"r1","started_at_ms":1000}`,                   // sin event_id
		`{"type":"STREAM_STARTED","event_id":"s0","room_id":"r2","started_at_ms":1000}`,   // otra sala
		`{"type":"STREAM_STARTED","event_id":"s0","room_id":"r1","started_at_ms":"1000"}`, // texto
		`{"type":"STREAM_PAUSED","event_id":"s0","room_id":"r1"}`,                         // tipo desconocido
		`{"type":"STREAM_ENDED","event_id":"e0","room_id":"r1","reason":"otra"}`,          // reason fuera del contrato
	} {
		publish(StreamChannelKey("r1"), raw)
	}
	publish(StreamChannelKey("r1"), `{"type":"STREAM_STARTED","event_id":"s1","room_id":"r1","started_at":"2026-11-01T17:00:00.000Z","started_at_ms":1793552400000,"occurred_at":"2026-11-01T17:00:00.000Z"}`)
	got := next()
	want := socialevent.StreamEvent{Type: socialevent.StreamStarted, EventID: "s1", RoomID: "r1", StartedAtMS: 1793552400000}
	if got.Stream == nil || *got.Stream != want || got.Payload != nil {
		t.Fatalf("sub = %+v, want Stream %+v", got, want)
	}
	publish(StreamChannelKey("r1"), `{"type":"STREAM_ENDED","event_id":"e1","room_id":"r1","reason":"grace_expired","occurred_at":"2026-11-01T18:00:00.000Z"}`)
	got = next()
	want = socialevent.StreamEvent{Type: socialevent.StreamEnded, EventID: "e1", RoomID: "r1", Reason: "grace_expired"}
	if got.Stream == nil || *got.Stream != want {
		t.Fatalf("sub = %+v, want Stream %+v", got, want)
	}
}

func TestRedisRoomStateKeys(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer client.Close()
	s := NewRedisStoreWithClient(client, 3, time.Hour)
	ctx := context.Background()

	if closed, err := s.IsRoomClosed(ctx, "r1"); err != nil || closed {
		t.Fatalf("IsRoomClosed sin clave = %v, %v", closed, err)
	}
	_ = mr.Set(ClosedKey("r1"), "1")
	if closed, err := s.IsRoomClosed(ctx, "r1"); err != nil || !closed {
		t.Fatalf("IsRoomClosed con clave = %v, %v", closed, err)
	}

	if live, err := s.IsLive(ctx, "r1"); err != nil || live {
		t.Fatalf("IsLive sin clave = %v, %v", live, err)
	}
	_ = mr.Set(KindKey("r1"), "watch")
	if live, _ := s.IsLive(ctx, "r1"); live {
		t.Fatal("watch no es live")
	}
	_ = mr.Set(KindKey("r1"), "live")
	if live, err := s.IsLive(ctx, "r1"); err != nil || !live {
		t.Fatalf("IsLive live = %v, %v", live, err)
	}

	if ms, ok, err := s.StreamStartedAt(ctx, "r1"); err != nil || ok || ms != 0 {
		t.Fatalf("StreamStartedAt sin clave = %d, %v, %v", ms, ok, err)
	}
	_ = mr.Set(StreamStartedKey("r1"), "basura")
	if _, ok, err := s.StreamStartedAt(ctx, "r1"); err != nil || ok {
		t.Fatalf("StreamStartedAt basura = %v, %v (se ignora)", ok, err)
	}
	_ = mr.Set(StreamStartedKey("r1"), "1793552400000")
	if ms, ok, err := s.StreamStartedAt(ctx, "r1"); err != nil || !ok || ms != 1793552400000 {
		t.Fatalf("StreamStartedAt = %d, %v, %v", ms, ok, err)
	}

	mr.Close() // Redis caído: los errores llegan al llamador (falla cerrado).
	if _, err := s.IsRoomClosed(ctx, "r1"); err == nil {
		t.Fatal("IsRoomClosed con Redis caído debe fallar")
	}
	if _, err := s.IsLive(ctx, "r1"); err == nil {
		t.Fatal("IsLive con Redis caído debe fallar")
	}
	if _, _, err := s.StreamStartedAt(ctx, "r1"); err == nil || errors.Is(err, redis.Nil) {
		t.Fatalf("StreamStartedAt con Redis caído = %v", err)
	}
}
