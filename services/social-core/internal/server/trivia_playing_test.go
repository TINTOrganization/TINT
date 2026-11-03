package server

import (
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/analytics"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
)

// El host programa una pregunta con el vídeo ya en marcha (el formulario propone el segundo
// actual): debe dispararse cuando la reproducción llegue a esa marca. E2E del sistema completo
// (2026-11-02): la pregunta quedaba "Pendiente" para siempre.
func TestTriviaScheduledWhilePlayingFires(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock, timers := newTestClock(), &fakeTimers{}
	var processed atomic.Int64
	track := make(chan analytics.TriviaAnswer, 8)
	url := triviaReplica(t, mr, secret, clock, timers, &processed, track)
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	nextOfType(t, colH, "trivia_schedule_state")
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:g", "Gina", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")
	waitSubs(t, mr, chat.SyncChannelKey("r1"), 1)

	publishSync(t, mr, 1, "PLAY", 0, "playing")
	waitProcessed(t, &processed, 1)
	clock.Advance(193 * time.Second)

	schedule(t, h, 203_000, 15)
	nextOfType(t, colH, "trivia_schedule_state")
	launch := timers.take(t, 10*time.Second)
	if len(launch) != 1 {
		t.Fatalf("timers de disparo = %d, want 1 a 10 s", len(launch))
	}
	clock.Advance(10 * time.Second)
	launch[0].f()
	if m := nextOfType(t, colG, "trivia_question"); m["question"] != "¿Quién llegó primero?" {
		t.Fatalf("trivia_question = %v", m)
	}
}

// "Agregar pregunta en este momento" propone el segundo actual; mientras el host escribe la
// pregunta el vídeo sigue y la marca queda atrás. Antes se quedaba "Pendiente" para siempre
// (E2E del sistema completo, 2026-11-02): ahora se lanza en el acto si la marca pasó hace
// TriviaLateLaunchMS o menos.
func TestTriviaScheduledJustBehindPlaybackLaunchesNow(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock, timers := newTestClock(), &fakeTimers{}
	var processed atomic.Int64
	track := make(chan analytics.TriviaAnswer, 8)
	url := triviaReplica(t, mr, secret, clock, timers, &processed, track)
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	nextOfType(t, colH, "trivia_schedule_state")
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:g", "Gina", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")
	waitSubs(t, mr, chat.SyncChannelKey("r1"), 1)

	publishSync(t, mr, 1, "PLAY", 0, "playing")
	waitProcessed(t, &processed, 1)
	clock.Advance(211 * time.Second)

	schedule(t, h, 190_000, 15) // la marca quedó 21 s atrás mientras escribía
	if m := nextOfType(t, colG, "trivia_question"); m["question"] != "¿Quién llegó primero?" {
		t.Fatalf("trivia_question = %v", m)
	}
	if q := questions(nextOfType(t, colH, "trivia_schedule_state"))[0]; q["status"] != "open" {
		t.Fatalf("estado = %v, want open", q)
	}
}

func TestTriviaScheduledFarBehindPlaybackStaysPending(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock, timers := newTestClock(), &fakeTimers{}
	var processed atomic.Int64
	track := make(chan analytics.TriviaAnswer, 8)
	url := triviaReplica(t, mr, secret, clock, timers, &processed, track)
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	nextOfType(t, colH, "trivia_schedule_state")
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:g", "Gina", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")
	waitSubs(t, mr, chat.SyncChannelKey("r1"), 1)

	publishSync(t, mr, 1, "PLAY", 0, "playing")
	waitProcessed(t, &processed, 1)
	clock.Advance(300 * time.Second)

	schedule(t, h, 300_000-TriviaLateLaunchMS-1, 15) // una escena anterior: espera a que vuelvan a verla
	if q := questions(nextOfType(t, colH, "trivia_schedule_state"))[0]; q["status"] != "pending" {
		t.Fatalf("estado = %v, want pending", q)
	}
	noneOfType(t, colG, "trivia_question")
}
