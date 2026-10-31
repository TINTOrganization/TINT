package server

import (
	"context"
	"fmt"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/analytics"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/recap"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/trivia"
)

// triviaReplica arranca una réplica con Redis, reloj y timers inyectados;
// processed cuenta los eventos de sync ya procesados (recap + rearme de
// trivias) y track recibe los trivia_answer de analítica. Los hooks se
// fijan antes de arrancar el servidor.
func triviaReplica(t *testing.T, mr *miniredis.Miniredis, secret string, clock *testClock, timers *fakeTimers, processed *atomic.Int64, track chan analytics.TriviaAnswer) string {
	t.Helper()
	env := map[string]string{"REDIS_URL": "redis://" + mr.Addr(), "JWT_SECRET": secret}
	deps := DefaultDeps(func(k string) string { return env[k] })
	deps.Now = clock.Now
	deps.AfterFunc = timers.AfterFunc
	deps.syncHook = func(recap.Kind) { processed.Add(1) }
	if track != nil {
		deps.TrackTrivia = func(a analytics.TriviaAnswer) { track <- a }
	}
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	t.Cleanup(srv.Close)
	return "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
}

// publishSync publica un comando de reproducción como sync-core.
func publishSync(t *testing.T, mr *miniredis.Miniredis, version int64, typ string, pos int64, status string) {
	t.Helper()
	pub := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer pub.Close()
	ev := fmt.Sprintf(`{"event_id":"s%d","type":%q,"room_id":"r1","position_ms":%d,"status":%q,"rate":1,"updated_at_ms":%d,"version":%d}`,
		version, typ, pos, status, 1_000_000+version, version)
	if err := pub.Publish(context.Background(), chat.SyncChannelKey("r1"), ev).Err(); err != nil {
		t.Fatal(err)
	}
}

func waitProcessed(t *testing.T, processed *atomic.Int64, n int64) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for processed.Load() < n {
		if time.Now().After(deadline) {
			t.Fatalf("eventos de sync procesados = %d, want %d", processed.Load(), n)
		}
		runtime.Gosched()
	}
}

func schedule(t *testing.T, c *websocket.Conn, at int64, window int) {
	t.Helper()
	sendRaw(t, c, map[string]any{
		"event_id": "ts", "type": "trivia_schedule", "at_ms": at,
		"question": " ¿Quién llegó primero? ", "options": []string{"Ana", "Beto", "Caro"},
		"correct": 1, "answer_window_s": window,
	})
}

func questions(m map[string]any) []map[string]any {
	raw, _ := m["questions"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, v := range raw {
		q, _ := v.(map[string]any)
		out = append(out, q)
	}
	return out
}

func answer(t *testing.T, c *websocket.Conn, id, tid string, option int) {
	t.Helper()
	sendRaw(t, c, map[string]any{"event_id": id, "type": "trivia_answer", "trivia_id": tid, "option": option})
}

func TestTriviaScheduleListDelete(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock, timers := newTestClock(), &fakeTimers{}
	url, _ := redisReplica(t, mr, secret, clock, timers)
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	if m := nextOfType(t, colH, "trivia_schedule_state"); len(questions(m)) != 0 || m["questions"] == nil {
		t.Fatalf("estado al entrar (host) = %v, want questions []", m)
	}
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")
	nextOfType(t, colG, "notice")

	schedule(t, g, 30_000, 20)
	if m := nextOfType(t, colG, "error"); m["code"] != "FORBIDDEN" {
		t.Fatalf("invitado programa = %v, want FORBIDDEN", m)
	}
	sendRaw(t, g, map[string]any{"event_id": "tl", "type": "trivia_list"})
	if m := nextOfType(t, colG, "error"); m["code"] != "FORBIDDEN" {
		t.Fatalf("invitado lista = %v, want FORBIDDEN", m)
	}
	sendRaw(t, g, map[string]any{"event_id": "td", "type": "trivia_delete", "trivia_id": "x"})
	if m := nextOfType(t, colG, "error"); m["code"] != "FORBIDDEN" {
		t.Fatalf("invitado borra = %v, want FORBIDDEN", m)
	}

	bad := []map[string]any{
		{"event_id": "b1", "type": "trivia_schedule", "at_ms": 1000, "question": "q", "options": []string{"a"}, "correct": 0},
		{"event_id": "b2", "type": "trivia_schedule", "at_ms": 1000, "question": "q", "options": []string{"a", "b"}, "correct": 2},
		{"event_id": "b3", "type": "trivia_schedule", "at_ms": 1000, "question": "q", "options": []string{"a", "b"}, "correct": 0, "answer_window_s": 5},
		{"event_id": "b4", "type": "trivia_schedule", "question": "q", "options": []string{"a", "b"}, "correct": 0},
		{"event_id": "b5", "type": "trivia_schedule", "at_ms": 1000, "question": "", "options": []string{"a", "b"}, "correct": 0},
	}
	for _, b := range bad {
		sendRaw(t, h, b)
		if m := nextOfType(t, colH, "error"); m["code"] != "INVALID_PAYLOAD" || m["event_id_ref"] != b["event_id"] {
			t.Fatalf("%v = %v, want INVALID_PAYLOAD", b, m)
		}
	}

	// Sin answer_window_s se usan 20 s; solo el host recibe el estado.
	sendRaw(t, h, map[string]any{
		"event_id": "ts", "type": "trivia_schedule", "room_id": "r1", "at_ms": 30_000,
		"question": " ¿Quién? ", "options": []string{" Ana ", "Beto"}, "correct": 1,
	})
	m := nextOfType(t, colH, "trivia_schedule_state")
	qs := questions(m)
	if len(qs) != 1 || m["event_id_ref"] != "ts" || m["room_id"] != "r1" {
		t.Fatalf("trivia_schedule_state = %v", m)
	}
	q := qs[0]
	tid, _ := q["trivia_id"].(string)
	if tid == "" || q["at_ms"] != float64(30_000) || q["question"] != "¿Quién?" || q["correct"] != float64(1) ||
		q["answer_window_s"] != float64(20) || q["status"] != "pending" || q["options"].([]any)[0] != "Ana" {
		t.Fatalf("pregunta = %v", q)
	}
	noneOfType(t, colG, "trivia_schedule_state")

	sendRaw(t, h, map[string]any{"event_id": "tl", "type": "trivia_list"})
	if m := nextOfType(t, colH, "trivia_schedule_state"); len(questions(m)) != 1 || m["event_id_ref"] != "tl" {
		t.Fatalf("trivia_list = %v", m)
	}
	sendRaw(t, h, map[string]any{"event_id": "td0", "type": "trivia_delete", "trivia_id": "nope"})
	if m := nextOfType(t, colH, "error"); m["code"] != "TRIVIA_NOT_FOUND" {
		t.Fatalf("borrar inexistente = %v, want TRIVIA_NOT_FOUND", m)
	}
	sendRaw(t, h, map[string]any{"event_id": "td1", "type": "trivia_delete", "trivia_id": tid})
	if m := nextOfType(t, colH, "trivia_schedule_state"); len(questions(m)) != 0 || m["questions"] == nil {
		t.Fatalf("tras borrar = %v, want questions []", m)
	}
}

func TestTriviaFiresAtPositionScoresAndCloses(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock, timers := newTestClock(), &fakeTimers{}
	var processed atomic.Int64
	track := make(chan analytics.TriviaAnswer, 8)
	url := triviaReplica(t, mr, secret, clock, timers, &processed, track)
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	nextOfType(t, colH, "trivia_schedule_state") // lista al entrar
	a, colA := joinCol(t, url, guestTokenAs(t, secret, "guest:rapido", "Rápido", "r1", exp0()))
	defer a.Close(websocket.StatusNormalClosure, "")
	b, colB := joinCol(t, url, guestTokenAs(t, secret, "guest:mal", "Mal", "r1", exp0()))
	defer b.Close(websocket.StatusNormalClosure, "")
	nextOfType(t, colB, "notice")
	waitSubs(t, mr, chat.SyncChannelKey("r1"), 1)

	// Pregunta a los 30 s (ventana de 15 s). Sin reproducción no se arma.
	schedule(t, h, 30_000, 15)
	tid := questions(nextOfType(t, colH, "trivia_schedule_state"))[0]["trivia_id"].(string)

	// PLAY en 10 s: el timer apunta a 20 s de vídeo (= 20 s a 1x).
	publishSync(t, mr, 1, "PLAY", 10_000, "playing")
	waitProcessed(t, &processed, 1)
	launch := timers.take(t, 20*time.Second)
	if len(launch) != 1 {
		t.Fatalf("timers de disparo = %d, want 1", len(launch))
	}
	noneOfType(t, colA, "trivia_question")
	clock.Advance(20 * time.Second)
	opens := clock.UnixMilli()
	launch[0].f()
	for name, col := range map[string]*collector{"host": colH, "A": colA, "B": colB} {
		m := nextOfType(t, col, "trivia_question")
		if m["trivia_id"] != tid || m["question"] != "¿Quién llegó primero?" || len(m["options"].([]any)) != 3 ||
			m["opens_at_ms"] != float64(opens) || m["closes_at_ms"] != float64(opens+15_000) {
			t.Fatalf("%s trivia_question = %v", name, m)
		}
		if _, leak := m["correct"]; leak {
			t.Fatalf("%s: trivia_question no debe llevar correct: %v", name, m)
		}
	}
	sendRaw(t, h, map[string]any{"event_id": "tl", "type": "trivia_list"})
	if q := questions(nextOfType(t, colH, "trivia_schedule_state"))[0]; q["status"] != "open" {
		t.Fatalf("estado tras disparar = %v, want open", q)
	}
	// Una pregunta ya lanzada no se borra.
	sendRaw(t, h, map[string]any{"event_id": "td", "type": "trivia_delete", "trivia_id": tid})
	if m := nextOfType(t, colH, "error"); m["code"] != "TRIVIA_CLOSED" {
		t.Fatalf("borrar lanzada = %v, want TRIVIA_CLOSED", m)
	}

	// Quien entra con la pregunta abierta la recibe.
	late, colL := joinCol(t, url, guestTokenAs(t, secret, "guest:tarde", "Tarde", "r1", exp0()))
	defer late.Close(websocket.StatusNormalClosure, "")
	if m := nextOfType(t, colL, "trivia_question"); m["trivia_id"] != tid {
		t.Fatalf("trivia_question al entrar = %v", m)
	}

	clock.Advance(2 * time.Second)
	answer(t, a, "a1", tid, 1)
	ack := nextOfType(t, colA, "trivia_ack")
	fast := trivia.Score(true, 2*time.Second)
	if ack["trivia_id"] != tid || ack["option"] != float64(1) || ack["score"] != float64(fast) || ack["event_id_ref"] != "a1" {
		t.Fatalf("trivia_ack = %v, want score %d", ack, fast)
	}
	got := recv(t, track, "trivia_answer")
	if got.QuestionID != tid || !got.Correct || got.ResponseMS != 2000 || got.UserID != "guest:rapido" || got.RoomID != "r1" || got.EventID == "" {
		t.Fatalf("analítica = %+v", got)
	}
	answer(t, b, "b1", tid, 0)
	if m := nextOfType(t, colB, "trivia_ack"); m["score"] != float64(0) {
		t.Fatalf("respuesta incorrecta = %v, want 0", m)
	}
	if got := recv(t, track, "trivia_answer"); got.Correct {
		t.Fatalf("analítica incorrecta = %+v", got)
	}
	answer(t, a, "a2", tid, 0)
	if m := nextOfType(t, colA, "error"); m["code"] != "ALREADY_ANSWERED" {
		t.Fatalf("segunda respuesta = %v, want ALREADY_ANSWERED", m)
	}
	answer(t, a, "a3", "nope", 0)
	if m := nextOfType(t, colA, "error"); m["code"] != "TRIVIA_NOT_FOUND" {
		t.Fatalf("trivia inexistente = %v", m)
	}
	answer(t, late, "l0", tid, 9)
	if m := nextOfType(t, colL, "error"); m["code"] != "INVALID_PAYLOAD" {
		t.Fatalf("opción fuera de rango = %v, want INVALID_PAYLOAD", m)
	}
	sendRaw(t, a, map[string]any{"event_id": "a4", "type": "trivia_answer", "trivia_id": tid})
	if m := nextOfType(t, colA, "error"); m["code"] != "INVALID_PAYLOAD" {
		t.Fatalf("sin option = %v", m)
	}
	expectNone(t, track, "trivia_answer")

	// Cierre a closes_at_ms: resultado con el top y el my_score de cada uno.
	clock.Advance(13 * time.Second)
	timers.fire(t, 15*time.Second)
	for name, c := range map[string]struct {
		col  *collector
		mine float64
		rank any
	}{"host": {colH, 0, nil}, "A": {colA, float64(fast), float64(1)}, "B": {colB, 0, float64(2)}} {
		m := nextOfType(t, c.col, "trivia_result")
		top, _ := m["top"].([]any)
		if m["trivia_id"] != tid || m["correct"] != float64(1) || len(top) != 2 || m["my_score"] != c.mine || m["my_rank"] != c.rank {
			t.Fatalf("%s trivia_result = %v", name, m)
		}
		first, _ := top[0].(map[string]any)
		if first["user_id"] != "guest:rapido" || first["nick"] != "Rápido" || first["score"] != float64(fast) {
			t.Fatalf("%s top[0] = %v", name, first)
		}
		board, _ := m["leaderboard"].([]any)
		if len(board) != 2 {
			t.Fatalf("%s leaderboard = %v", name, m["leaderboard"])
		}
		noneOfType(t, c.col, "trivia_result")
	}
	answer(t, late, "l1", tid, 1)
	if m := nextOfType(t, colL, "error"); m["code"] != "TRIVIA_CLOSED" {
		t.Fatalf("respuesta tras el cierre = %v, want TRIVIA_CLOSED", m)
	}

	// The ranking is persistent: anyone who joins afterwards (even through a
	// replica that never saw the game, i.e. after a restart) gets it at once,
	// personalised with their own place.
	restarted := triviaReplica(t, mr, secret, clock, &fakeTimers{}, &processed, nil)
	for name, c := range map[string]struct {
		token string
		rank  any
		total float64
	}{
		"A":        {guestTokenAs(t, secret, "guest:rapido", "Rápido", "r1", exp0()), float64(1), float64(fast)},
		"newcomer": {guestTokenAs(t, secret, "guest:nuevo", "Nuevo", "r1", exp0()), nil, 0},
	} {
		conn, col := joinCol(t, restarted, c.token)
		m := nextOfType(t, col, "trivia_leaderboard")
		board, _ := m["leaderboard"].([]any)
		first, _ := board[0].(map[string]any)
		if len(board) != 2 || first["user_id"] != "guest:rapido" || m["room_id"] != "r1" || m["my_rank"] != c.rank || m["my_total"] != c.total {
			t.Fatalf("%s trivia_leaderboard = %v", name, m)
		}
		conn.Close(websocket.StatusNormalClosure, "")
	}
	sendRaw(t, h, map[string]any{"event_id": "tl2", "type": "trivia_list"})
	if q := questions(nextOfType(t, colH, "trivia_schedule_state"))[0]; q["status"] != "closed" {
		t.Fatalf("estado tras cerrar = %v, want closed", q)
	}
}

// Un SEEK que salta la marca no la dispara (queda pendiente); volver antes
// de la marca la rearma y una pausa la desarma.
func TestTriviaSeekSkipsAndPauseDisarms(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock, timers := newTestClock(), &fakeTimers{}
	var processed atomic.Int64
	url := triviaReplica(t, mr, secret, clock, timers, &processed, nil)
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	nextOfType(t, colH, "trivia_schedule_state") // lista al entrar
	waitSubs(t, mr, chat.SyncChannelKey("r1"), 1)

	publishSync(t, mr, 1, "PLAY", 10_000, "playing")
	waitProcessed(t, &processed, 1)
	// Programar con el vídeo en marcha arma el timer de inmediato.
	schedule(t, h, 30_000, 15)
	nextOfType(t, colH, "trivia_schedule_state")
	timers.take(t, 20*time.Second)

	publishSync(t, mr, 2, "SEEK", 40_000, "playing")
	waitProcessed(t, &processed, 2)
	if n := timers.live(20 * time.Second); n != 0 {
		t.Fatalf("timers vivos tras saltar la marca = %d, want 0", n)
	}
	publishSync(t, mr, 3, "SEEK", 25_000, "playing")
	waitProcessed(t, &processed, 3)
	if n := timers.live(5 * time.Second); n != 1 {
		t.Fatalf("timers tras volver antes de la marca = %d, want 1", n)
	}
	publishSync(t, mr, 4, "PAUSE", 26_000, "paused")
	waitProcessed(t, &processed, 4)
	if n := timers.live(5 * time.Second); n != 0 {
		t.Fatalf("timers tras pausar = %d, want 0", n)
	}
	publishSync(t, mr, 5, "PLAY", 26_000, "playing")
	waitProcessed(t, &processed, 5)
	stale := timers.take(t, 4*time.Second)
	// Si el timer vence antes de tiempo (p. ej. un evento perdido), no se
	// lanza: se rearma con la posición real.
	stale[0].f()
	if n := timers.live(4 * time.Second); n != 1 {
		t.Fatalf("rearme tras disparo temprano = %d, want 1", n)
	}
	noneOfType(t, colH, "trivia_question")
	clock.Advance(4 * time.Second)
	timers.fire(t, 4*time.Second)
	nextOfType(t, colH, "trivia_question")
}

func TestTriviaAcrossReplicasOnce(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock := newTestClock()
	timersA, timersB := &fakeTimers{}, &fakeTimers{}
	var processed atomic.Int64
	urlA := triviaReplica(t, mr, secret, clock, timersA, &processed, nil)
	urlB := triviaReplica(t, mr, secret, clock, timersB, &processed, nil)
	h, colH := joinCol(t, urlA, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	nextOfType(t, colH, "trivia_schedule_state") // lista al entrar
	g, colG := joinCol(t, urlB, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")
	waitSubs(t, mr, chat.SyncChannelKey("r1"), 2)

	schedule(t, h, 30_000, 15)
	tid := questions(nextOfType(t, colH, "trivia_schedule_state"))[0]["trivia_id"].(string)
	publishSync(t, mr, 1, "PLAY", 10_000, "playing")
	waitProcessed(t, &processed, 2)
	tA, tB := timersA.take(t, 20*time.Second), timersB.take(t, 20*time.Second)
	clock.Advance(20 * time.Second)
	for _, tm := range append(tA, tB...) {
		tm.f()
	}
	for name, col := range map[string]*collector{"A": colH, "B": colG} {
		if m := nextOfType(t, col, "trivia_question"); m["trivia_id"] != tid {
			t.Fatalf("%s trivia_question = %v", name, m)
		}
		noneOfType(t, col, "trivia_question")
	}

	clock.Advance(time.Second)
	answer(t, g, "g1", tid, 1)
	nextOfType(t, colG, "trivia_ack")
	clock.Advance(14 * time.Second)
	cA, cB := timersA.take(t, 15*time.Second), timersB.take(t, 15*time.Second)
	for _, tm := range append(cA, cB...) {
		tm.f()
	}
	want := map[string]float64{"A": 0, "B": float64(trivia.Score(true, time.Second))}
	for name, col := range map[string]*collector{"A": colH, "B": colG} {
		m := nextOfType(t, col, "trivia_result")
		if m["my_score"] != want[name] || len(m["top"].([]any)) != 1 {
			t.Fatalf("%s trivia_result = %v", name, m)
		}
		noneOfType(t, col, "trivia_result")
	}
}

// Si nadie cerró una pregunta vencida (réplicas reiniciadas), se cierra
// cuando alguien entra.
func TestTriviaExpiredClosesOnJoin(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock, timers := newTestClock(), &fakeTimers{}
	url, deps := redisReplica(t, mr, secret, clock, timers)
	ctx := context.Background()
	q := trivia.Question{ID: "t1", AtMS: 1000, Question: "¿?", Options: []string{"a", "b"}, Correct: 0, AnswerWindowS: 10}
	if err := deps.Trivia.Schedule(ctx, "r1", q); err != nil {
		t.Fatal(err)
	}
	if _, _, err := deps.Trivia.Launch(ctx, "r1", "t1", clock.UnixMilli()-20_000); err != nil {
		t.Fatal(err)
	}
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")
	if m := nextOfType(t, colG, "trivia_result"); m["trivia_id"] != "t1" || m["correct"] != float64(0) {
		t.Fatalf("trivia_result al entrar = %v", m)
	}
	noneOfType(t, colG, "trivia_question")
}

func TestTriviaUnavailableWithoutRedis(t *testing.T) {
	const secret = "s3cr3t"
	url := laserURL(t, testDeps(secret))
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	for _, msg := range []map[string]any{
		{"event_id": "1", "type": "trivia_schedule", "at_ms": 1, "question": "q", "options": []string{"a", "b"}, "correct": 0},
		{"event_id": "2", "type": "trivia_list"},
		{"event_id": "3", "type": "trivia_delete", "trivia_id": "t"},
		{"event_id": "4", "type": "trivia_answer", "trivia_id": "t", "option": 0},
	} {
		sendRaw(t, h, msg)
		if m := nextOfType(t, colH, "error"); m["code"] != "UNAVAILABLE" {
			t.Fatalf("%v sin Redis = %v, want UNAVAILABLE", msg["type"], m)
		}
	}
}
