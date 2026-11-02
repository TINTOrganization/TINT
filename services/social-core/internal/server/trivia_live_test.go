package server

import (
	"net/http/httptest"
	"runtime"
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

// liveRoom arranca una réplica con la sala live, el host conectado y una
// trivia programada en at_ms; devuelve el reloj, los timers y el colector
// del invitado.
func liveRoom(t *testing.T, mr *miniredis.Miniredis, atMS int64) (*testClock, *fakeTimers, *collector) {
	t.Helper()
	const secret = "s3cr3t"
	clock, timers := newTestClock(), &fakeTimers{}
	url, _ := redisReplica(t, mr, secret, clock, timers)
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	t.Cleanup(func() { h.CloseNow() })
	nextOfType(t, colH, "trivia_schedule_state")
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	t.Cleanup(func() { g.CloseNow() })
	schedule(t, h, atMS, 15)
	nextOfType(t, colH, "trivia_schedule_state")
	return clock, timers, colG
}

func pendingTimers(ft *fakeTimers) int {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	n := 0
	for _, tm := range ft.pending {
		if !tm.stopped.Load() {
			n++
		}
	}
	return n
}

func waitStopped(t *testing.T, tm *fakeTimer) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !tm.stopped.Load() {
		if time.Now().After(deadline) {
			t.Fatal("el timer no se canceló")
		}
		runtime.Gosched()
	}
}

// Sin STREAM_STARTED la trivia de una sala live queda pendiente (no hay
// reloj del vídeo); un STREAM_STARTED repetido con el mismo started_at_ms
// no reprograma, y uno con otro valor sí.
func TestTriviaLivePendingAndIdempotentStart(t *testing.T) {
	mr := miniredis.RunT(t)
	markLive(t, mr, "r1")
	clock, timers, _ := liveRoom(t, mr, 45_000)
	if n := pendingTimers(timers); n != 0 {
		t.Fatalf("timers antes de STREAM_STARTED = %d, want 0", n)
	}
	started := clock.UnixMilli() - 10_000
	publishStream(t, mr, "r1", streamStarted("r1", started))
	first := timers.take(t, 35*time.Second)
	publishStream(t, mr, "r1", streamStarted("r1", started))       // repetido: nada
	publishStream(t, mr, "r1", streamStarted("r1", started-5_000)) // otro inicio: rearma
	timers.take(t, 30*time.Second)
	if n := timers.live(35 * time.Second); n != 0 {
		t.Fatalf("el STREAM_STARTED repetido reprogramó (%d timers de 35 s)", n)
	}
	waitStopped(t, first[0])
}

// STREAM_ENDED cancela lo pendiente.
func TestTriviaLiveStreamEndedCancels(t *testing.T) {
	mr := miniredis.RunT(t)
	markLive(t, mr, "r1")
	clock, timers, _ := liveRoom(t, mr, 45_000)
	publishStream(t, mr, "r1", streamStarted("r1", clock.UnixMilli()))
	launch := timers.take(t, 45*time.Second)
	publishStream(t, mr, "r1", `{"type":"STREAM_ENDED","event_id":"9b2f0d1e-3c4a-4b5d-8e6f-7a8b9c0d1e2f","room_id":"r1","reason":"grace_expired","occurred_at":"2026-11-01T18:00:00.000Z"}`)
	waitStopped(t, launch[0])
	if n := pendingTimers(timers); n != 0 {
		t.Fatalf("timers tras STREAM_ENDED = %d, want 0", n)
	}
}

// Tras un reinicio (sin STREAM_STARTED en memoria) se reconstruye con
// room:{id}:stream:started_at, que escribe stream-core.
func TestTriviaLiveRebuildsFromStartedKey(t *testing.T) {
	mr := miniredis.RunT(t)
	markLive(t, mr, "r1")
	clock := newTestClock()
	if err := mr.Set("room:r1:stream:started_at", itoa(clock.UnixMilli()-20_000)); err != nil {
		t.Fatal(err)
	}
	// liveRoom crea su propio reloj con la misma hora inicial.
	_, timers, _ := liveRoom(t, mr, 45_000)
	launch := timers.take(t, 25*time.Second)
	launch[0].f() // el reloj no avanzó: 5 s antes, fuera de la tolerancia
	if n := timers.live(25 * time.Second); n != 1 {
		t.Fatalf("no se rearmó tras un disparo temprano (%d)", n)
	}
}

// En una sala watch STREAM_STARTED no cambia nada: sigue el reloj del vídeo.
func TestTriviaWatchIgnoresStream(t *testing.T) {
	mr := miniredis.RunT(t)
	clock, timers, _ := liveRoom(t, mr, 45_000)
	publishStream(t, mr, "r1", streamStarted("r1", clock.UnixMilli()-10_000))
	publishSync(t, mr, 1, "PLAY", 0, "playing")
	timers.take(t, 45*time.Second)
	if n := timers.live(35 * time.Second); n != 0 {
		t.Fatalf("la sala watch usó el reloj del stream (%d)", n)
	}
}
