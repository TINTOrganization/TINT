package server

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"nhooyr.io/websocket"
)

// trivia_launch_now: errores y trivia_schedule_state actualizado al host.
func TestTriviaLaunchNowErrorsAndState(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock, timers := newTestClock(), &fakeTimers{}
	url, _ := redisReplica(t, mr, secret, clock, timers)
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	nextOfType(t, colH, "trivia_schedule_state")

	schedule(t, h, 600_000, 20)
	tid := questions(nextOfType(t, colH, "trivia_schedule_state"))[0]["trivia_id"].(string)

	for name, tc := range map[string]struct {
		msg  map[string]any
		code string
	}{
		"sin trivia_id": {map[string]any{"event_id": "l1", "type": "trivia_launch_now"}, "INVALID_PAYLOAD"},
		"otra sala":     {map[string]any{"event_id": "l1", "type": "trivia_launch_now", "trivia_id": tid, "room_id": "r2"}, "INVALID_PAYLOAD"},
		"no existe":     {map[string]any{"event_id": "l1", "type": "trivia_launch_now", "trivia_id": "nope"}, "TRIVIA_NOT_FOUND"},
	} {
		sendRaw(t, h, tc.msg)
		if m := nextOfType(t, colH, "error"); m["code"] != tc.code || m["event_id_ref"] != "l1" {
			t.Fatalf("%s: %v, want %s", name, m, tc.code)
		}
	}

	sendRaw(t, h, map[string]any{"event_id": "l2", "type": "trivia_launch_now", "trivia_id": tid})
	nextOfType(t, colH, "trivia_question")
	st := nextOfType(t, colH, "trivia_schedule_state")
	if q := questions(st)[0]; st["event_id_ref"] != "l2" || q["status"] != "open" {
		t.Fatalf("trivia_schedule_state = %v, want open con event_id_ref l2", st)
	}
	// Ya salió: no se puede lanzar otra vez.
	sendRaw(t, h, map[string]any{"event_id": "l3", "type": "trivia_launch_now", "trivia_id": tid})
	if m := nextOfType(t, colH, "error"); m["code"] != "TRIVIA_CLOSED" || m["event_id_ref"] != "l3" {
		t.Fatalf("relanzar = %v, want TRIVIA_CLOSED", m)
	}
	// Se agendó el cierre a closes_at_ms.
	timers.take(t, 20*time.Second)
}

// Sin Redis (modo memoria) las trivias responden UNAVAILABLE.
func TestTriviaLaunchNowUnavailable(t *testing.T) {
	const secret = "s3cr3t"
	srv := httptest.NewServer(NewRouterWithDeps(testDeps(secret)))
	defer srv.Close()
	url := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	sendRaw(t, h, map[string]any{"event_id": "l1", "type": "trivia_launch_now", "trivia_id": "t"})
	if m := nextOfType(t, colH, "error"); m["code"] != "UNAVAILABLE" {
		t.Fatalf("%v, want UNAVAILABLE", m)
	}
}
