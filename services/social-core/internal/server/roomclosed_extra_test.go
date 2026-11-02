package server

import (
	"context"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
)

// ADR 0019: si no se puede comprobar room:{id}:closed, el handshake se
// rechaza con 503 (falla cerrado), igual que la revocación.
func TestSocialClosedCheckFailsClosed(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	env := map[string]string{"REDIS_URL": "redis://" + mr.Addr(), "JWT_SECRET": secret}
	deps := DefaultDeps(func(k string) string { return env[k] })
	deps.IsRoomClosed = func(context.Context, string) (bool, error) { return false, errors.New("redis caído") }
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	t.Cleanup(srv.Close)
	url := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	if got := dialStatus(t, url, guestToken(t, secret, "guest:a", "r1", time.Now().Add(time.Hour))); got != 503 {
		t.Fatalf("status = %d, want 503", got)
	}
}

// Un origen no permitido se rechaza antes del cierre terminal (ADR 0014).
func TestSocialTerminalCloseChecksOrigin(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	base, _ := closedReplica(t, mr, secret)
	if err := mr.Set(roomClosedKey("r1"), "1"); err != nil {
		t.Fatal(err)
	}
	if got, _ := dialOrigin(t, wsSocialURL(base, "r1"), guestToken(t, secret, "guest:a", "r1", exp0()), "http://evil.example"); got != 403 {
		t.Fatalf("status = %d, want 403", got)
	}
}
