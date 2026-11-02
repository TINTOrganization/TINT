package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

func errorCode(t *testing.T, body []byte) string {
	t.Helper()
	var e struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(body, &e); err != nil {
		t.Fatalf("JSON %s: %v", body, err)
	}
	return e.Error
}

// §6.1: los errores de las rutas nuevas son {error:"UPPER_SNAKE"}.
func TestChatRESTErrorBodies(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	base, _ := closedReplica(t, mr, secret)
	if status, body := getChat(t, base, "r1", ""); status != http.StatusUnauthorized || errorCode(t, body) != "UNAUTHORIZED" {
		t.Fatalf("sin token = %d %s", status, body)
	}
	if status, body := getChat(t, base, "r1", guestToken(t, secret, "guest:a", "r1", exp0())); status != http.StatusForbidden || errorCode(t, body) != "FORBIDDEN" {
		t.Fatalf("participante = %d %s", status, body)
	}
	// Un sync-ticket revocado no lee el historial.
	if err := mr.Set(chat.RevokedKey("jti-host-1"), "1"); err != nil {
		t.Fatal(err)
	}
	if status, body := getChat(t, base, "r1", roleTicket(t, secret, "host-1", "Ana", "host", "r1")); status != http.StatusUnauthorized || errorCode(t, body) != "UNAUTHORIZED" {
		t.Fatalf("revocado = %d %s", status, body)
	}
}

// El cohost también lee; el historial es el de la sala, del más antiguo al
// más nuevo y como máximo 100, aunque el WebSocket solo entregue 50.
func TestChatRESTCohostAndLimit(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	base, deps := closedReplica(t, mr, secret)
	ctx := context.Background()
	at := time.Date(2026, 11, 1, 18, 0, 0, 0, time.UTC)
	for i := 0; i < ChatRESTLimit+20; i++ {
		msg := socialevent.ChatMessage{
			EventID: "m" + itoa(int64(i)), Type: socialevent.TypeChatMessage, RoomID: "r1",
			UserID: "guest:a", Nick: "Ana", Text: "t" + itoa(int64(i)), OccurredAt: at, ReceivedAt: at,
		}
		if err := deps.History.Push(ctx, "r1", msg); err != nil {
			t.Fatal(err)
		}
	}
	status, body := getChat(t, base, "r1", roleTicket(t, secret, "co-1", "Caro", "cohost", "r1"))
	if status != http.StatusOK {
		t.Fatalf("status = %d %s", status, body)
	}
	var got struct {
		Messages []map[string]any `json:"messages"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Messages) != ChatRESTLimit || got.Messages[0]["text"] != "t20" || got.Messages[ChatRESTLimit-1]["text"] != "t119" {
		t.Fatalf("messages = %d (%v … %v), want 100 de t20 a t119", len(got.Messages), got.Messages[0]["text"], got.Messages[len(got.Messages)-1]["text"])
	}
	// Mismos campos que el chat_message del WebSocket.
	for _, k := range []string{"event_id", "type", "room_id", "user_id", "nick", "text", "occurred_at", "received_at"} {
		if _, ok := got.Messages[0][k]; !ok {
			t.Fatalf("falta %s en %v", k, got.Messages[0])
		}
	}
	// El WebSocket sigue entregando los 50 más recientes.
	if recent, err := deps.History.Recent(ctx, "r1", socialevent.HistoryLimit); err != nil || len(recent) != socialevent.HistoryLimit || recent[0].Text != "t70" {
		t.Fatalf("history WS = %d, %v", len(recent), err)
	}
}

// Sin Redis no hay historial compartido ni revocación: 503 UNAVAILABLE.
func TestChatRESTUnavailable(t *testing.T) {
	const secret = "s3cr3t"
	t.Run("sin redis", func(t *testing.T) {
		deps := DefaultDeps(func(k string) string { return map[string]string{"JWT_SECRET": secret}[k] })
		srv := httptest.NewServer(NewRouterWithDeps(deps))
		t.Cleanup(srv.Close)
		if status, body := getChat(t, srv.URL, "r1", roleTicket(t, secret, "host-1", "Ana", "host", "r1")); status != http.StatusServiceUnavailable || errorCode(t, body) != "UNAVAILABLE" {
			t.Fatalf("status = %d %s", status, body)
		}
	})
	t.Run("revocación caída", func(t *testing.T) {
		mr := miniredis.RunT(t)
		env := map[string]string{"REDIS_URL": "redis://" + mr.Addr(), "JWT_SECRET": secret}
		deps := DefaultDeps(func(k string) string { return env[k] })
		deps.IsRevoked = func(context.Context, string) (bool, error) { return false, errors.New("caído") }
		srv := httptest.NewServer(NewRouterWithDeps(deps))
		t.Cleanup(srv.Close)
		if status, _ := getChat(t, srv.URL, "r1", roleTicket(t, secret, "host-1", "Ana", "host", "r1")); status != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503", status)
		}
	})
	t.Run("historial caído", func(t *testing.T) {
		mr := miniredis.RunT(t)
		base, deps := closedReplica(t, mr, secret)
		deps.History = failingStore{}
		if status, _ := getChat(t, base, "r1", roleTicket(t, secret, "host-1", "Ana", "host", "r1")); status != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503", status)
		}
	})
}

type failingStore struct{}

func (failingStore) Push(context.Context, string, socialevent.ChatMessage) error {
	return errors.New("caído")
}

func (failingStore) Recent(context.Context, string, int) ([]socialevent.ChatMessage, error) {
	return nil, errors.New("caído")
}
