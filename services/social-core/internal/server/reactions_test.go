package server

import (
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/reactions"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

func TestSocialReactionBroadcast(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	deps.LeaveGrace = 300 * time.Millisecond
	deps.ReactionBuckets = reactions.NewBuckets()
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	exp := time.Now().Add(time.Hour)

	a := dial(t, wsBase, guestTokenAs(t, secret, "guest:ana", "Ana", "r1", exp))
	defer a.Close(websocket.StatusNormalClosure, "")
	colA := collectConn(a)
	if m, ok := colA.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje A = %v, want history", m)
	}
	expectNoticeCol(t, colA, "joined", "Ana")

	b := dial(t, wsBase, guestTokenAs(t, secret, "guest:pedro", "Pedro", "r1", exp))
	defer b.Close(websocket.StatusNormalClosure, "")
	colB := collectConn(b)
	if m, ok := colB.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje B = %v, want history", m)
	}
	expectNoticeCol(t, colB, "joined", "Pedro")
	expectNoticeCol(t, colA, "joined", "Pedro")

	sendRaw(t, a, socialevent.ReactionSend{
		EventID: "e1", Type: socialevent.TypeReactionSend, RoomID: "r1",
		Emoji: "👏", PositionMS: 12000, OccurredAt: time.Now().UTC(),
	})
	for name, col := range map[string]*collector{"A": colA, "B": colB} {
		m, ok := col.next(5 * time.Second)
		if !ok {
			t.Fatalf("%s no recibió la reacción", name)
		}
		if m["type"] != "reaction" || m["emoji"] != "👏" || m["nick"] != "Ana" {
			t.Fatalf("%s = %v, want reaction 👏 de Ana", name, m)
		}
		if m["position_ms"] != float64(12000) {
			t.Fatalf("%s = %v, want position_ms 12000", name, m)
		}
		if m["user_id"] != "guest:ana" || m["room_id"] != "r1" {
			t.Fatalf("%s = %v, want user/room", name, m)
		}
	}

	// La reacción cae al bucket de 5s (12000ms -> bucket 2), sin historial.
	if got := deps.ReactionBuckets.Count("r1", 2, "👏"); got != 1 {
		t.Fatalf("bucket(2,👏) = %d, want 1", got)
	}
}

func TestSocialReactionRateLimited(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	deps.LeaveGrace = 300 * time.Millisecond
	deps.ReactionLimit = reactions.NewLimiter()
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	c := dial(t, wsBase, guestTokenAs(t, secret, "guest:ana", "Ana", "r1", exp0()))
	defer c.Close(websocket.StatusNormalClosure, "")
	col := collectConn(c)
	if m, ok := col.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje = %v, want history", m)
	}
	expectNoticeCol(t, col, "joined", "Ana")

	for i := 0; i < 5; i++ {
		sendRaw(t, c, socialevent.ReactionSend{
			EventID: "e", Type: socialevent.TypeReactionSend, RoomID: "r1",
			Emoji: "❤️", PositionMS: 0, OccurredAt: time.Now().UTC(),
		})
		m, ok := col.next(5 * time.Second)
		if !ok || m["type"] != "reaction" {
			t.Fatalf("reacción %d = %v, want reaction", i+1, m)
		}
	}
	sendRaw(t, c, socialevent.ReactionSend{
		EventID: "spam", Type: socialevent.TypeReactionSend, RoomID: "r1",
		Emoji: "❤️", PositionMS: 0, OccurredAt: time.Now().UTC(),
	})
	m, ok := col.next(5 * time.Second)
	if !ok || m["type"] != "error" || m["code"] != "RATE_LIMITED" || m["retry_after_ms"].(float64) <= 0 {
		t.Fatalf("sexta reacción = %v, want RATE_LIMITED", m)
	}
}

func TestSocialReactionRateLimitedPerIP(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	deps.LeaveGrace = 300 * time.Millisecond
	deps.ReactionLimit = reactions.NewLimiter()
	deps.ReactionIPLimit = reactions.NewLimiter()
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	exp := exp0()

	a := dial(t, wsBase, guestTokenAs(t, secret, "guest:ana", "Ana", "r1", exp))
	defer a.Close(websocket.StatusNormalClosure, "")
	colA := collectConn(a)
	colA.next(5 * time.Second)
	expectNoticeCol(t, colA, "joined", "Ana")

	for i := 0; i < reactions.MaxPerSecond; i++ {
		sendRaw(t, a, socialevent.ReactionSend{
			EventID: "a-" + itoa(int64(i)), Type: socialevent.TypeReactionSend, RoomID: "r1",
			Emoji: "👏", PositionMS: 0, OccurredAt: time.Now().UTC(),
		})
		if m, ok := colA.next(5 * time.Second); !ok || m["type"] != "reaction" {
			t.Fatalf("reacción de Ana %d = %v, want reaction", i+1, m)
		}
	}

	b := dial(t, wsBase, guestTokenAs(t, secret, "guest:pedro", "Pedro", "r1", exp))
	defer b.Close(websocket.StatusNormalClosure, "")
	colB := collectConn(b)
	colB.next(5 * time.Second)
	expectNoticeCol(t, colB, "joined", "Pedro")
	expectNoticeCol(t, colA, "joined", "Pedro")

	sendRaw(t, b, socialevent.ReactionSend{
		EventID: "ip-spam", Type: socialevent.TypeReactionSend, RoomID: "r1",
		Emoji: "👏", PositionMS: 0, OccurredAt: time.Now().UTC(),
	})
	m, ok := colB.next(5 * time.Second)
	if !ok || m["type"] != "error" || m["code"] != "RATE_LIMITED" || m["retry_after_ms"].(float64) <= 0 {
		t.Fatalf("reacción de Pedro = %v, want per-IP RATE_LIMITED con retry", m)
	}
}

func exp0() time.Time { return time.Now().Add(time.Hour) }

func TestSocialReactionInvalidEmoji(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	deps.LeaveGrace = 300 * time.Millisecond
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	c := dial(t, wsBase, guestTokenAs(t, secret, "guest:ana", "Ana", "r1", exp0()))
	defer c.Close(websocket.StatusNormalClosure, "")
	col := collectConn(c)
	if m, ok := col.next(5 * time.Second); !ok || m["type"] != "history" {
		t.Fatalf("primer mensaje = %v, want history", m)
	}
	expectNoticeCol(t, col, "joined", "Ana")

	sendRaw(t, c, socialevent.ReactionSend{
		EventID: "bad", Type: socialevent.TypeReactionSend, RoomID: "r1",
		Emoji: "💩", PositionMS: 0, OccurredAt: time.Now().UTC(),
	})
	m, ok := col.next(5 * time.Second)
	if !ok || m["type"] != "error" || m["code"] != "INVALID_EMOJI" {
		t.Fatalf("emoji inválido = %v, want INVALID_EMOJI", m)
	}
}

func TestSocialConcurrentReactionsNoOverwrite(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	deps.LeaveGrace = 300 * time.Millisecond
	deps.ReactionBuckets = reactions.NewBuckets()
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	wsBase := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	exp := time.Now().Add(time.Hour)

	// Observador conectado a la sala
	obs := dial(t, wsBase, guestTokenAs(t, secret, "guest:obs", "Observador", "r1", exp))
	defer obs.Close(websocket.StatusNormalClosure, "")
	colObs := collectConn(obs)
	colObs.next(5 * time.Second) // history
	expectNoticeCol(t, colObs, "joined", "Observador")

	// Dos clientes distintos que mandarán reacciones diferentes al mismo tiempo
	c1 := dial(t, wsBase, guestTokenAs(t, secret, "guest:user1", "User1", "r1", exp))
	defer c1.Close(websocket.StatusNormalClosure, "")
	collectConn(c1).next(5 * time.Second)
	expectNoticeCol(t, colObs, "joined", "User1")

	c2 := dial(t, wsBase, guestTokenAs(t, secret, "guest:user2", "User2", "r1", exp))
	defer c2.Close(websocket.StatusNormalClosure, "")
	collectConn(c2).next(5 * time.Second)
	expectNoticeCol(t, colObs, "joined", "User2")

	// Disparamos dos reacciones diferentes concurrentemente en el mismo timeframe
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		sendRaw(t, c1, socialevent.ReactionSend{
			EventID: "e-user1", Type: socialevent.TypeReactionSend, RoomID: "r1",
			Emoji: "👏", PositionMS: 1000, OccurredAt: time.Now().UTC(),
		})
	}()
	go func() {
		defer wg.Done()
		sendRaw(t, c2, socialevent.ReactionSend{
			EventID: "e-user2", Type: socialevent.TypeReactionSend, RoomID: "r1",
			Emoji: "❤️", PositionMS: 1000, OccurredAt: time.Now().UTC(),
		})
	}()
	wg.Wait()

	// El observador debe recibir AMBAS reacciones (sin sobreescritura de estado ni pérdida)
	received := make(map[string]string)
	for i := 0; i < 2; i++ {
		m, ok := colObs.next(5 * time.Second)
		if !ok {
			t.Fatalf("no se recibió la reacción concurrente %d/2", i+1)
		}
		if m["type"] != "reaction" {
			t.Fatalf("esperaba tipo reaction, got %v", m)
		}
		received[m["user_id"].(string)] = m["emoji"].(string)
	}

	if received["guest:user1"] != "👏" {
		t.Fatalf("reacción de user1 = %q, want 👏", received["guest:user1"])
	}
	if received["guest:user2"] != "❤️" {
		t.Fatalf("reacción de user2 = %q, want ❤️", received["guest:user2"])
	}

	// Ambos emojis deben estar contabilizados concurrentemente en el bucket de la sala
	if got := deps.ReactionBuckets.Count("r1", 0, "👏"); got != 1 {
		t.Fatalf("bucket(0, 👏) = %d, want 1", got)
	}
	if got := deps.ReactionBuckets.Count("r1", 0, "❤️"); got != 1 {
		t.Fatalf("bucket(0, ❤️) = %d, want 1", got)
	}
}
