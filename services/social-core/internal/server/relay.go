// Package server — relay compartido y dedup contra el eco de Pub/Sub.
//
// Sin esto, cada conexión abría su propia suscripción Redis a la sala y cada
// mensaje se entregaba 1 (broadcast directo) + N (una por suscriptor) veces.
package server

import (
	"context"
	"encoding/json"
	"sync"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

// seenCap es la ventana de event_id recientes para tragar ecos y redeliveries.
const seenCap = 512

// seenIDs registra event_id recientes de forma thread-safe.
// seen devuelve true si el id ya se vio (duplicado).
type seenIDs struct {
	mu    sync.Mutex
	set   map[string]struct{}
	order []string
}

func newSeenIDs() *seenIDs {
	return &seenIDs{set: make(map[string]struct{})}
}

func (s *seenIDs) seen(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.set[id]; ok {
		return true
	}
	s.set[id] = struct{}{}
	s.order = append(s.order, id)
	if len(s.order) > seenCap {
		oldest := s.order[0]
		s.order = s.order[1:]
		delete(s.set, oldest)
	}
	return false
}

// roomRelay es la única suscripción Redis por sala y réplica.
type roomRelay struct {
	refs   int
	cancel context.CancelFunc
	stop   func()
}

// acquireRelay devuelve release(); el primer adquiriente crea la suscripción
// compartida y el último la cierra. La suscripción se abre fuera del lock:
// con Redis caído, un Subscribe bloqueante no debe congelar las conexiones.
func (d *Deps) acquireRelay(roomID string) (release func()) {
	d.mu.Lock()
	if d.relays == nil {
		d.relays = make(map[string]*roomRelay)
	}
	if d.seen == nil {
		d.seen = newSeenIDs()
	}
	if r, ok := d.relays[roomID]; ok {
		r.refs++
		d.mu.Unlock()
		return func() { d.releaseRelay(roomID) }
	}
	seen := d.seen
	hub := d.Hub
	subscribe := d.Subscribe
	d.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	ch, stop := subscribe(ctx, roomID)

	d.mu.Lock()
	if r, ok := d.relays[roomID]; ok {
		// Otro handler la creó mientras suscribíamos: usar la suya.
		r.refs++
		d.mu.Unlock()
		stop()
		cancel()
		return func() { d.releaseRelay(roomID) }
	}
	d.relays[roomID] = &roomRelay{refs: 1, cancel: cancel, stop: stop}
	d.mu.Unlock()

	go func() {
		for in := range ch {
			if in.RevokedJTI != "" {
				d.revokeLocal(roomID, in.RevokedJTI) // nunca llega a los clientes
				continue
			}
			if in.RoomClosed {
				d.closeRoomLocal(roomID) // ADR 0019: 4010 a todos
				continue
			}
			if in.Sync != nil {
				// Métricas del recap y rearme del disparo de trivias (la
				// posición proyectada cambió).
				kind, ok := d.recordSync(roomID, *in.Sync)
				d.armTrivia(roomID)
				if ok && d.syncHook != nil {
					d.syncHook(kind)
				}
				continue
			}
			if in.EventID == "" || seen.seen(in.EventID) {
				continue // eco propio o redelivery
			}
			switch in.Type {
			case socialevent.TypePollState:
				d.observeRemotePoll(roomID, in.Payload)
			case socialevent.TypeTriviaQuestion:
				d.observeRemoteTrivia(roomID, in.Payload)
			case socialevent.TypeTriviaResult:
				// Se personaliza por conexión (my_score), no se reenvía tal cual.
				d.deliverRemoteResult(roomID, in.Payload)
				continue
			}
			hub.Broadcast(roomID, in.Payload)
		}
	}()
	return func() { d.releaseRelay(roomID) }
}

func (d *Deps) releaseRelay(roomID string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	r, ok := d.relays[roomID]
	if !ok {
		return
	}
	r.refs--
	if r.refs <= 0 {
		delete(d.relays, roomID)
		d.stopTriviaArmLocked(roomID)
		if r.stop != nil {
			r.stop()
		}
		if r.cancel != nil {
			r.cancel()
		}
	}
}

// markSeen registra un event_id emitido localmente; true = duplicado.
func (d *Deps) markSeen(id string) bool {
	d.mu.Lock()
	if d.seen == nil {
		d.seen = newSeenIDs()
	}
	seen := d.seen
	d.mu.Unlock()
	return seen.seen(id)
}

// relayRefs devuelve las referencias activas (solo tests).
func (d *Deps) relayRefs(roomID string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	if r, ok := d.relays[roomID]; ok {
		return r.refs
	}
	return 0
}

// broadcastOnce emite al hub salvo que el event_id ya se haya visto
// (el relay remoto ganó la carrera con el eco).
func (d *Deps) broadcastOnce(roomID string, msg socialevent.ChatMessage) {
	d.broadcastRawOnce(roomID, msg.EventID, msg)
}

// broadcastRawOnce emite cualquier evento serializable al hub, tragando
// duplicados por event_id igual que broadcastOnce.
func (d *Deps) broadcastRawOnce(roomID, eventID string, v any) {
	if d.markSeen(eventID) {
		return
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return
	}
	d.Hub.Broadcast(roomID, raw)
}
