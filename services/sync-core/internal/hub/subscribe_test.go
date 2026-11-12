package hub

import (
	"context"
	"fmt"
	"math/rand"
	"sync"
	"testing"
	"time"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/auth"
)

// blockingBus bloquea Subscribe de la sala `slow` hasta que se cierre release.
type blockingBus struct {
	nopBus
	slow    string
	entered chan struct{}
	release chan struct{}
}

func (b *blockingBus) Subscribe(ctx context.Context, roomID string) error {
	if roomID == b.slow {
		close(b.entered)
		<-b.release
	}
	return nil
}

// Un Subscribe lento (Redis Pub/Sub saturado) no puede frenar la entrega
// de broadcasts ni los latidos de las demás salas: antes se hacía con h.mu
// tomado y congelaba a toda la réplica.
func TestSlowSubscribeDoesNotBlockOtherRooms(t *testing.T) {
	b := &blockingBus{slow: "sala-lenta", entered: make(chan struct{}), release: make(chan struct{})}
	h, clients := benchHub(t, nil, 2, 0)
	h.bus = b
	c := clients[1]

	joined := make(chan error, 1)
	slowClient := newClient(context.Background(), auth.Claims{Sub: "guest:x", RoomID: b.slow, Role: auth.RoleParticipant}, t0.UnixMilli())
	go func() { joined <- h.join(context.Background(), slowClient) }()
	<-b.entered // join está dentro de Subscribe

	done := make(chan struct{})
	go func() {
		h.Deliver(room, benchBroadcast())
		h.beatAll()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		close(b.release)
		t.Fatal("Deliver/beatAll de otra sala quedó bloqueado por un Subscribe lento")
	}
	if len(c.send) != 2 {
		t.Errorf("el cliente de la otra sala debe recibir broadcast y latido: %d", len(c.send))
	}

	close(b.release)
	if err := <-joined; err != nil {
		t.Fatal(err)
	}
	h.mu.Lock()
	_, ok := h.rooms[b.slow].clients[slowClient]
	h.mu.Unlock()
	if !ok {
		t.Error("tras el Subscribe el cliente debe quedar en su sala")
	}
}

// trackingBus registra qué salas están suscritas, con latencia aleatoria
// para provocar entrelazados entre join y leave de la misma sala.
type trackingBus struct {
	nopBus
	mu   sync.Mutex
	subs map[string]bool
	errs []string
}

func (b *trackingBus) jitter() { time.Sleep(time.Duration(rand.Intn(200)) * time.Microsecond) }

func (b *trackingBus) Subscribe(_ context.Context, roomID string) error {
	b.jitter()
	b.mu.Lock()
	b.subs[roomID] = true
	b.mu.Unlock()
	return nil
}

func (b *trackingBus) Unsubscribe(_ context.Context, roomID string) error {
	b.jitter()
	b.mu.Lock()
	b.subs[roomID] = false
	b.mu.Unlock()
	return nil
}

func (b *trackingBus) subscribed(roomID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.subs[roomID]
}

// Altas y bajas concurrentes de la misma sala: mientras un cliente está
// registrado la sala debe seguir suscrita (un Unsubscribe rezagado no puede
// anular la suscripción de un join posterior), y al vaciarse se desuscribe.
func TestConcurrentJoinLeaveKeepsSubscriptionConsistent(t *testing.T) {
	b := &trackingBus{subs: map[string]bool{}}
	h := New(nil, b, &fakeTelemetry{})
	const workers, rounds = 8, 50
	var wg sync.WaitGroup
	errs := make(chan string, workers*rounds)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < rounds; i++ {
				c := newClient(context.Background(), auth.Claims{Sub: fmt.Sprintf("guest:%d", w), RoomID: room, Role: auth.RoleParticipant}, 0)
				if err := h.join(context.Background(), c); err != nil {
					errs <- err.Error()
					return
				}
				if !b.subscribed(room) {
					errs <- "cliente registrado en una sala sin suscripción"
				}
				h.leave(c)
			}
		}(w)
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		t.Fatal(e)
	}
	if b.subscribed(room) {
		t.Error("la sala vacía debe quedar desuscrita")
	}
	if h.roomCount() != 0 {
		t.Errorf("salas = %v, want 0", h.roomCount())
	}
}

// Si Subscribe falla, el cliente no queda registrado y la sala no existe.
func TestJoinSubscribeError(t *testing.T) {
	h := New(nil, failingBus{}, &fakeTelemetry{})
	c := newClient(context.Background(), guest, 0)
	if err := h.join(context.Background(), c); err == nil {
		t.Fatal("esperaba el error de Subscribe")
	}
	if h.roomCount() != 0 {
		t.Error("no debe crearse la sala si Subscribe falla")
	}
	if _, ok := h.leave(c); ok {
		t.Error("el cliente no debe quedar registrado")
	}
}

type failingBus struct{ nopBus }

func (failingBus) Subscribe(context.Context, string) error {
	return fmt.Errorf("pubsub caído")
}
