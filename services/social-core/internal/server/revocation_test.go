package server

import (
	"context"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

func waitSubscribed(t *testing.T, mr *miniredis.Miniredis, channel string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for mr.PubSubNumSub(channel)[channel] == 0 {
		if time.Now().After(deadline) {
			t.Fatalf("sin suscriptores en %s", channel)
		}
		runtime.Gosched()
	}
}

// Un invitado revocado seguía chateando y podía reconectarse (confirmado en
// vivo). Ahora: EXISTS token:revoked:{jti} en el handshake (falla cerrado si
// Redis cae) y cierre 4001 de los sockets vivos al llegar REVOKED por
// room:{id}:sync, igual que sync-core.
func TestSocialRevokedGuest(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	env := map[string]string{"REDIS_URL": "redis://" + mr.Addr(), "JWT_SECRET": secret, "FIREBASE_PROJECT_ID": "tint-login"}
	deps := DefaultDeps(func(k string) string { return env[k] })
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	url := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	exp := time.Now().Add(time.Hour)

	// 1. Token ya revocado en el handshake: upgrade + 4001 (ADR 0014/0019),
	// cubierto por TestSocialTerminalTokensUpgradeAndClose.

	// 2. Revocación en vivo: solo se cierra el socket del jti revocado.
	a := dial(t, url, guestToken(t, secret, "guest:a", "r1", exp))
	defer a.CloseNow()
	b := dial(t, url, guestToken(t, secret, "guest:b", "r1", exp))
	defer b.Close(websocket.StatusNormalClosure, "")
	colB := collectConn(b)
	waitSubscribed(t, mr, chat.SyncChannelKey("r1"))

	pub := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer pub.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	revoked := `{"event_id":"e","type":"REVOKED","room_id":"r1","jti":"jti-guest:a","position_ms":0,"version":0}`
	if err := pub.Publish(ctx, chat.SyncChannelKey("r1"), revoked).Err(); err != nil {
		t.Fatal(err)
	}
	var readErr error
	for i := 0; i < 10 && readErr == nil; i++ {
		_, _, readErr = a.Read(ctx)
	}
	if got := websocket.CloseStatus(readErr); got != StatusRevoked {
		t.Fatalf("cierre de A = %v (%v), want 4001", got, readErr)
	}

	sendRaw(t, b, socialevent.ChatSend{
		EventID: "c1", Type: socialevent.TypeChatSend, RoomID: "r1", Text: "sigo aquí", OccurredAt: time.Now().UTC(),
	})
	for {
		m, ok := colB.next(5 * time.Second)
		if !ok {
			t.Fatal("B dejó de recibir mensajes")
		}
		if m["type"] == "chat_message" && m["text"] == "sigo aquí" {
			break
		}
	}

	// 3. Redis caído: no se puede comprobar la revocación → se rechaza.
	mr.Close()
	if got := dialStatus(t, url, guestToken(t, secret, "guest:c", "r1", exp)); got != 503 {
		t.Fatalf("Redis caído: status = %d, want 503", got)
	}
}

func TestRevokeLocalIgnoresUnknown(t *testing.T) {
	d := testDeps("s")
	d.revokeLocal("sin-sala", "jti") // sin conexiones: no hace nada
	d.revokeLocal("r1", "")          // jti vacío: no hace nada
}
