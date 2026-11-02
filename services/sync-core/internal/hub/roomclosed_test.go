package hub

import (
	"errors"
	"testing"
	"time"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

// roomClosedPayload es el mensaje que identity-api publica en room:{id}:sync
// al deshabilitar una sala (ADR 0018), después de escribir room:{id}:closed.
const roomClosedPayload = `{"type":"ROOM_CLOSED","room_id":"room-1","reason":"host_ended",` +
	`"event_id":"c1","occurred_at":"2026-11-01T18:00:00Z"}`

// ADR 0018 / HU-LIVE-09 AC1: ROOM_CLOSED cierra todas las conexiones locales
// de la sala (host incluido, cuyo ticket nunca se revoca), en cualquier
// réplica; las otras salas siguen abiertas.
func TestRoomClosedDisconnectsWholeRoom(t *testing.T) {
	e := newEnv(t)
	h1, h2 := e.newHub(t), e.newHub(t)
	hc := connect(t, h1, host)
	next(t, hc)
	g1 := connect(t, h1, guest)
	next(t, g1)
	g2 := connect(t, h2, guestTwo)
	next(t, g2)
	other := connect(t, h1, auth.Claims{Sub: "guest:9", RoomID: "room-2", Role: auth.RoleParticipant})
	next(t, other)
	e.waitSubscribers(t, 2)

	e.mr.Publish(syncevent.ChannelKey(room), roomClosedPayload)

	for name, c := range map[string]*Client{"host": hc, "invitado": g1, "invitado en otra réplica": g2} {
		select {
		case <-c.Done():
			if errors.Is(c.Err(), ErrRevoked) || errors.Is(c.Err(), ErrStale) || errors.Is(c.Err(), ErrSlowConsumer) {
				t.Errorf("%s: causa = %v, want una causa propia de sala cerrada (cierre 4010)", name, c.Err())
			}
		case <-time.After(recvLimit):
			t.Fatalf("%s: ROOM_CLOSED debe cerrar todas las conexiones de la sala", name)
		}
	}
	if other.Context().Err() != nil {
		t.Error("ROOM_CLOSED de room-1 no debe cerrar conexiones de otra sala")
	}
}

// ROOM_CLOSED solo viaja por el bus: el cliente se entera por el código de
// cierre 4010, nunca como mensaje del Canal Sync.
func TestRoomClosedIsNotForwardedToClients(t *testing.T) {
	e := newEnv(t)
	h := e.newHub(t)
	g := connect(t, h, guest)
	next(t, g)

	h.Deliver(room, []byte(roomClosedPayload))

	select {
	case raw := <-g.Send():
		if ev := decodeEvent(t, raw); ev.Type == "ROOM_CLOSED" {
			t.Fatalf("ROOM_CLOSED no debe llegar a los clientes: %s", raw)
		}
	default:
	}
	select {
	case <-g.Done():
	case <-time.After(recvLimit):
		t.Fatal("ROOM_CLOSED debe cerrar la conexión")
	}
}
