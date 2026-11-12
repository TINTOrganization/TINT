package hub

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/codec"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/master"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/store"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

// Los benchmarks del hub miden CPU y memoria de los caminos calientes
// (fan-out, latido, SYNC_CHECK, barrido) sin WebSocket: los clientes se
// registran directamente en la sala y sus colas se vacían en cada iteración.

// nopBus descarta suscripciones y publicaciones.
type nopBus struct{}

func (nopBus) Subscribe(context.Context, string) error       { return nil }
func (nopBus) Unsubscribe(context.Context, string) error     { return nil }
func (nopBus) Publish(context.Context, string, []byte) error { return nil }

var benchState = master.State{Status: master.Playing, PositionMs: 120_000, UpdatedAtMs: t0.UnixMilli(), Rate: 1, Version: 42, MediaID: "video-123"}

// benchHub crea un hub con n clientes listos en la sala (cada msgpackEvery-
// ésimo usa MessagePack; 0 = todos JSON, 1 = todos MessagePack).
func benchHub(b testing.TB, s StateStore, n, msgpackEvery int) (*Hub, []*Client) {
	b.Helper()
	clock := &fakeClock{}
	clock.ms.Store(t0.UnixMilli())
	h := New(s, nopBus{}, &fakeTelemetry{})
	h.now = clock.now
	r := &roomEntry{clients: make(map[*Client]struct{}, n), state: benchState, hasState: true, loadedAtMs: t0.UnixMilli()}
	h.rooms[room] = r
	clients := make([]*Client, n)
	for i := range clients {
		claims := auth.Claims{Sub: fmt.Sprintf("guest:%d", i), RoomID: room, Role: auth.RoleParticipant}
		if i == 0 {
			claims.Role = auth.RoleHost
		}
		c := newClient(context.Background(), claims, t0.UnixMilli())
		if msgpackEvery > 0 && i%msgpackEvery == 0 {
			c.codec = codec.MsgPack
		}
		c.ready = true
		c.rttMs.Store(40)
		r.clients[c] = struct{}{}
		clients[i] = c
	}
	return h, clients
}

func drain(clients []*Client) {
	for _, c := range clients {
		for len(c.send) > 0 {
			<-c.send
		}
	}
}

func benchBroadcast() []byte {
	ev := stateEvent(syncevent.Play, room, benchState, t0)
	ev.OccurredAt = t0.Add(-30 * time.Millisecond)
	return mustJSON(ev)
}

// BenchmarkDeliver: un broadcast del bus repartido a todos los clientes locales.
func BenchmarkDeliver(b *testing.B) {
	payload := benchBroadcast()
	for _, n := range []int{50, 500} {
		for _, mode := range []struct {
			name  string
			every int
		}{{"json", 0}, {"msgpack", 1}, {"mixed", 2}} {
			b.Run(fmt.Sprintf("%s-%d", mode.name, n), func(b *testing.B) {
				h, clients := benchHub(b, nil, n, mode.every)
				b.ReportAllocs()
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					h.Deliver(room, payload)
					drain(clients)
				}
			})
		}
	}
}

// BenchmarkBeatAll: un tick del temporizador de HEARTBEAT de la réplica.
func BenchmarkBeatAll(b *testing.B) {
	for _, mode := range []struct {
		name  string
		every int
	}{{"json", 0}, {"msgpack", 1}} {
		b.Run(fmt.Sprintf("%s-500", mode.name), func(b *testing.B) {
			h, clients := benchHub(b, nil, 500, mode.every)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				h.beatAll()
				drain(clients)
			}
		})
	}
}

// BenchmarkTick: un HEARTBEAT de un cliente.
func BenchmarkTick(b *testing.B) {
	for _, cd := range []codec.Codec{codec.JSON, codec.MsgPack} {
		b.Run(cd.Name(), func(b *testing.B) {
			h, clients := benchHub(b, nil, 1, 0)
			c := clients[0]
			c.codec = cd
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := h.Tick(c); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkHandleSyncCheck: respuesta a un HEARTBEAT con la caché vigente,
// sin drift (el caso de 1/s por cliente) y con corrección.
func BenchmarkHandleSyncCheck(b *testing.B) {
	for _, tc := range []struct {
		name  string
		pos   int64
		codec codec.Codec
	}{
		{"in-sync-json", benchState.PositionMs, codec.JSON},
		{"in-sync-msgpack", benchState.PositionMs, codec.MsgPack},
		{"correction-json", benchState.PositionMs + 5000, codec.JSON},
	} {
		b.Run(tc.name, func(b *testing.B) {
			h, clients := benchHub(b, nil, 1, 0)
			c := clients[0]
			c.codec = tc.codec
			raw, err := tc.codec.Encode(syncevent.Event{
				EventID: "3f1c7a4e-1b2c-4d5e-8f90-123456789abc", Type: syncevent.SyncCheck, RoomID: room,
				PositionMs: tc.pos, OccurredAt: t0, EchoServerTs: t0.UnixMilli() - 40,
			})
			if err != nil {
				b.Fatal(err)
			}
			ctx := context.Background()
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				c.msgs, c.checks = fixedWindow{}, fixedWindow{}
				c.lastSeekMs.Store(0) // sin enfriamiento: mide siempre el camino de corrección
				h.Handle(ctx, c, raw)
				for len(c.send) > 0 {
					<-c.send
				}
			}
		})
	}
}

func benchRedisStore(b *testing.B) *store.Store {
	s, _ := benchRedis(b)
	return s
}

// benchRedis usa BENCH_REDIS_URL (Redis real) o, si no está, miniredis.
func benchRedis(b *testing.B) (*store.Store, *redis.Client) {
	b.Helper()
	opt := &redis.Options{}
	if url := os.Getenv("BENCH_REDIS_URL"); url != "" {
		var err error
		if opt, err = redis.ParseURL(url); err != nil {
			b.Fatal(err)
		}
	} else {
		opt.Addr = miniredis.RunT(b).Addr()
	}
	rdb := redis.NewClient(opt)
	b.Cleanup(func() { _ = rdb.Close() })
	return store.New(rdb, 12*time.Hour), rdb
}

// rtHook cuenta idas y vueltas a Redis (comando suelto o pipeline = 1).
type rtHook struct{ n atomic.Int64 }

func (h *rtHook) DialHook(next redis.DialHook) redis.DialHook { return next }
func (h *rtHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error { h.n.Add(1); return next(ctx, cmd) }
}
func (h *rtHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []redis.Cmder) error { h.n.Add(1); return next(ctx, cmds) }
}

// BenchmarkConnectDisconnect: alta (STATE incluido) y baja de un
// participante en una sala con host, con su costo en idas y vueltas.
func BenchmarkConnectDisconnect(b *testing.B) {
	s, rdb := benchRedis(b)
	h := New(s, nopBus{}, &fakeTelemetry{})
	roomID := fmt.Sprintf("bench-connect-%d", time.Now().UnixNano())
	hostClaims := auth.Claims{Sub: "host", RoomID: roomID, Role: auth.RoleHost}
	hc, err := h.Connect(context.Background(), hostClaims)
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { h.Disconnect(hc) })
	guestClaims := auth.Claims{Sub: "guest:1", RoomID: roomID, Role: auth.RoleParticipant}
	rt := &rtHook{}
	rdb.AddHook(rt)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		c, err := h.Connect(context.Background(), guestClaims)
		if err != nil {
			b.Fatal(err)
		}
		h.Disconnect(c)
	}
	b.ReportMetric(float64(rt.n.Load())/float64(b.N), "rt/op")
}

// BenchmarkHandleCommand: SEEK del host de punta a punta contra miniredis
// (validación, CAS Lua con PUBLISH y ACK). Los tiempos no son los de Redis
// real, pero las asignaciones del lado Go sí.
func BenchmarkHandleCommand(b *testing.B) {
	s := benchRedisStore(b)
	ctx := context.Background()
	if _, err := s.Init(ctx, room, "guest:0", t0.UnixMilli()); err != nil {
		b.Fatal(err)
	}
	h, clients := benchHub(b, s, 1, 0)
	c := clients[0]
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		raw, _ := json.Marshal(syncevent.Event{
			EventID: fmt.Sprintf("evt-%d", i), Type: syncevent.Seek, RoomID: room, PositionMs: int64(i), OccurredAt: t0,
		})
		c.msgs, c.checks = fixedWindow{}, fixedWindow{}
		h.Handle(ctx, c, raw)
		<-c.send
	}
}

// BenchmarkSweepAll: un barrido de presencia de 10 salas × 50 clientes
// contra miniredis (cuenta idas y vueltas y asignaciones, no latencia).
func BenchmarkSweepAll(b *testing.B) {
	s := benchRedisStore(b)
	h := New(s, nopBus{}, &fakeTelemetry{})
	clock := &fakeClock{}
	clock.ms.Store(t0.UnixMilli())
	h.now = clock.now
	for r := 0; r < 10; r++ {
		id := fmt.Sprintf("room-%d", r)
		entry := &roomEntry{clients: map[*Client]struct{}{}}
		for i := 0; i < 50; i++ {
			claims := auth.Claims{Sub: fmt.Sprintf("guest:%d", i), RoomID: id, Role: auth.RoleParticipant}
			if i == 0 {
				claims.Role = auth.RoleHost
			}
			c := newClient(context.Background(), claims, t0.UnixMilli())
			c.ready = true
			entry.clients[c] = struct{}{}
		}
		h.rooms[id] = entry
	}
	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		h.sweepAll(ctx)
	}
}
