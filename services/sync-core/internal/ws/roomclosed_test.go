package ws

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/store"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

// statusRoomDisabled es el cierre terminal 4010 ROOM_DISABLED del ADR 0019:
// la sala fue deshabilitada y el cliente no debe reconectar.
const statusRoomDisabled websocket.StatusCode = 4010

func closedKey(roomID string) string { return "room:" + roomID + ":closed" }

// readUntilClose lee hasta que el socket se cierra y devuelve el código.
func readUntilClose(t *testing.T, c *websocket.Conn) websocket.StatusCode {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for {
		if _, _, err := c.Read(ctx); err != nil {
			return websocket.CloseStatus(err)
		}
	}
}

// ADR 0019 + ADR 0014: con room:{id}:closed presente el handshake hace
// upgrade y cierra con 4010 sin enviar STATE (quien llega tarde o reconecta
// ve "el evento terminó", HU-LIVE-08 AC3).
func TestClosedRoomHandshakeClosesWith4010(t *testing.T) {
	s := newServer(t, time.Second)
	_ = s.mr.Set(closedKey(room), "1")
	for _, role := range []string{"participant", "host"} {
		t.Run(role, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			c, _, err := websocket.Dial(ctx, s.wsURL(room, token(t, role, room)), nil)
			if err != nil {
				t.Fatalf("sala cerrada debe hacer upgrade: %v", err)
			}
			defer c.CloseNow()
			if _, data, err := c.Read(ctx); websocket.CloseStatus(err) != statusRoomDisabled {
				t.Errorf("lectura = %q %v, want cierre %d sin STATE", data, err, statusRoomDisabled)
			}
		})
	}
}

// La clave de otra sala no afecta a esta.
func TestClosedKeyOfOtherRoomDoesNotClose(t *testing.T) {
	s := newServer(t, time.Second)
	_ = s.mr.Set(closedKey("otra"), "1")
	c := dial(t, s, "participant")
	if ev := read(t, c); ev.Type != syncevent.State {
		t.Errorf("primer mensaje = %s, want STATE", ev.Type)
	}
}

// ADR 0019 / HU-LIVE-09 AC1: ROOM_CLOSED en room:{id}:sync cierra todas las
// conexiones vivas de la sala (host incluido) con 4010.
func TestRoomClosedOnBusClosesWith4010(t *testing.T) {
	s := newServer(t, time.Second)
	h := dial(t, s, "host")
	readType(t, h, syncevent.State)
	g := dial(t, s, "participant")
	readType(t, g, syncevent.State)

	_ = s.mr.Set(closedKey(room), "1")
	s.mr.Publish(syncevent.ChannelKey(room), `{"type":"ROOM_CLOSED","room_id":"room-1","reason":"host_ended",`+
		`"event_id":"7d0c8f3e-2b1a-4c5d-9e8f-0a1b2c3d4e5f","occurred_at":"2026-11-01T18:00:00.000Z"}`)

	for name, c := range map[string]*websocket.Conn{"host": h, "participante": g} {
		if code := readUntilClose(t, c); code != statusRoomDisabled {
			t.Errorf("%s: cierre = %d, want %d", name, code, statusRoomDisabled)
		}
	}
}

// Falla cerrado: si Redis no permite comprobar room:{id}:closed, el
// handshake responde 503 antes del upgrade (como la revocación). El token
// sin jti hace que hoy no se consulte la revocación, así que solo la
// comprobación de sala cerrada puede producir el 503.
func TestClosedRoomCheckFailsClosed(t *testing.T) {
	s := newServer(t, time.Second)
	s.mr.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	c, resp, err := websocket.Dial(ctx, s.wsURL(room, token(t, "participant", room)), nil)
	if c != nil {
		c.CloseNow()
	}
	if err == nil || resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("sin Redis no se puede verificar room:{id}:closed: err=%v resp=%v, want 503", err, resp)
	}
}

// staleGate simula la carrera: la comprobación del handshake aún no veía
// room:{id}:closed, pero cuando el hub se registra la sala ya está cerrada.
type staleGate struct{ *store.Store }

func (staleGate) IsRoomClosed(context.Context, string) (bool, error) { return false, nil }

// Si Connect descubre que la sala está cerrada, el socket (ya aceptado) se
// cierra con 4010, no con 1011.
func TestConnectToClosedRoomClosesWith4010(t *testing.T) {
	s := newServerWithGate(t, time.Second, func(st *store.Store) Gate { return staleGate{st} })
	_ = s.mr.Set(closedKey(room), "1")

	c := dial(t, s, "participant")
	if code := readUntilClose(t, c); code != statusRoomDisabled {
		t.Errorf("cierre = %d, want %d", code, statusRoomDisabled)
	}
}
