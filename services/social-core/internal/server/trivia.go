// Package server — trivias programadas en posiciones del vídeo.
//
// El estado vive en Redis (internal/trivia). Cada réplica con clientes en
// la sala mantiene un timer de disparo hacia la próxima pregunta pendiente
// con at_ms ≥ posición (proyectada desde el ancla del recap) y lo rearma en
// cada evento de sync del relay, al programar o borrar y al entrar alguien;
// solo hay timer si el vídeo se reproduce. Al vencer, Launch (HSETNX) deja
// que una sola réplica emita trivia_question. Un SEEK que salta la marca no
// la dispara: queda pendiente por si se vuelve atrás.
//
// Cada réplica agenda además el cierre a closes_at_ms (al lanzarla o al ver
// el trivia_question de otra); Close (HSETNX) deja que una sola emita el
// trivia_result, y cada réplica lo personaliza (my_score, my_total) para
// sus conexiones locales.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/analytics"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/reactions"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/trivia"
)

// triviaOpTimeout acota cada operación Redis lanzada desde un timer o el relay.
const triviaOpTimeout = 2 * time.Second

// TriviaEarlyToleranceMS: un timer que vence con la posición proyectada
// más de esto por debajo de la marca (p. ej. se perdió un evento de sync)
// no lanza la pregunta: se rearma con la posición real.
const TriviaEarlyToleranceMS = 1000

// triviaArm es el timer de disparo de una sala; gen invalida cálculos y
// timers viejos cuando se rearma.
type triviaArm struct {
	gen  uint64
	stop func() bool
}

func triviaErrorCode(err error) string {
	switch {
	case errors.Is(err, trivia.ErrNotFound):
		return "TRIVIA_NOT_FOUND"
	case errors.Is(err, trivia.ErrClosed):
		return "TRIVIA_CLOSED"
	case errors.Is(err, trivia.ErrAlreadyAnswered):
		return "ALREADY_ANSWERED"
	case errors.Is(err, trivia.ErrOption), errors.Is(err, trivia.ErrLimit):
		return "INVALID_PAYLOAD"
	}
	return "UNAVAILABLE"
}

func (d *Deps) handleTriviaSchedule(ctx context.Context, c *websocket.Conn, roomID string, claims auth.Claims, raw []byte) {
	var in socialevent.TriviaSchedule
	if err := json.Unmarshal(raw, &in); err != nil {
		writeError(ctx, c, "INVALID_PAYLOAD", "")
		return
	}
	if !isModerator(claims, roomID) {
		writeError(ctx, c, "FORBIDDEN", in.EventID)
		return
	}
	if d.Trivia == nil {
		writeError(ctx, c, "UNAVAILABLE", in.EventID)
		return
	}
	if err := in.Validate(); err != nil || (in.RoomID != "" && in.RoomID != roomID) {
		writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
		return
	}
	question, options, window := in.Normalized()
	q := trivia.Question{
		ID: d.newID(), AtMS: *in.AtMS, Question: question, Options: options,
		Correct: *in.Correct, AnswerWindowS: window,
	}
	if err := d.Trivia.Schedule(ctx, roomID, q); err != nil {
		writeError(ctx, c, triviaErrorCode(err), in.EventID)
		return
	}
	d.sendScheduleState(ctx, c, roomID, in.EventID)
	d.armTrivia(roomID)
}

func (d *Deps) handleTriviaUpdate(ctx context.Context, c *websocket.Conn, roomID string, claims auth.Claims, raw []byte) {
	var in socialevent.TriviaUpdate
	if err := json.Unmarshal(raw, &in); err != nil {
		writeError(ctx, c, "INVALID_PAYLOAD", "")
		return
	}
	if !isModerator(claims, roomID) {
		writeError(ctx, c, "FORBIDDEN", in.EventID)
		return
	}
	if d.Trivia == nil {
		writeError(ctx, c, "UNAVAILABLE", in.EventID)
		return
	}
	if err := in.Validate(); err != nil || (in.RoomID != "" && in.RoomID != roomID) {
		writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
		return
	}
	question, options, window := in.Normalized()
	q := trivia.Question{
		ID: in.TriviaID, AtMS: *in.AtMS, Question: question, Options: options,
		Correct: *in.Correct, AnswerWindowS: window,
	}
	if err := d.Trivia.Update(ctx, roomID, q); err != nil {
		writeError(ctx, c, triviaErrorCode(err), in.EventID)
		return
	}
	d.sendScheduleState(ctx, c, roomID, in.EventID)
	d.armTrivia(roomID)
}

func (d *Deps) handleTriviaDelete(ctx context.Context, c *websocket.Conn, roomID string, claims auth.Claims, raw []byte) {
	var in socialevent.TriviaDelete
	if err := json.Unmarshal(raw, &in); err != nil {
		writeError(ctx, c, "INVALID_PAYLOAD", "")
		return
	}
	if !isModerator(claims, roomID) {
		writeError(ctx, c, "FORBIDDEN", in.EventID)
		return
	}
	if d.Trivia == nil {
		writeError(ctx, c, "UNAVAILABLE", in.EventID)
		return
	}
	if err := in.Validate(); err != nil || (in.RoomID != "" && in.RoomID != roomID) {
		writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
		return
	}
	if err := d.Trivia.Delete(ctx, roomID, in.TriviaID); err != nil {
		writeError(ctx, c, triviaErrorCode(err), in.EventID)
		return
	}
	d.sendScheduleState(ctx, c, roomID, in.EventID)
	d.armTrivia(roomID)
}

func (d *Deps) handleTriviaList(ctx context.Context, c *websocket.Conn, roomID string, claims auth.Claims, raw []byte) {
	var in socialevent.TriviaList
	if err := json.Unmarshal(raw, &in); err != nil {
		writeError(ctx, c, "INVALID_PAYLOAD", "")
		return
	}
	if !isModerator(claims, roomID) {
		writeError(ctx, c, "FORBIDDEN", in.EventID)
		return
	}
	if d.Trivia == nil {
		writeError(ctx, c, "UNAVAILABLE", in.EventID)
		return
	}
	if err := in.Validate(); err != nil || (in.RoomID != "" && in.RoomID != roomID) {
		writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
		return
	}
	d.sendScheduleState(ctx, c, roomID, in.EventID)
}

func (d *Deps) handleTriviaAnswer(ctx context.Context, c *websocket.Conn, roomID string, claims auth.Claims, raw []byte, limiter *reactions.Limiter) {
	var in socialevent.TriviaAnswer
	if err := json.Unmarshal(raw, &in); err != nil {
		writeError(ctx, c, "INVALID_PAYLOAD", "")
		return
	}
	if d.Trivia == nil {
		writeError(ctx, c, "UNAVAILABLE", in.EventID)
		return
	}
	if err := in.Validate(); err != nil || (in.RoomID != "" && in.RoomID != roomID) {
		writeError(ctx, c, "INVALID_PAYLOAD", in.EventID)
		return
	}
	if !limiter.Allow(claims.Subject, d.now()) {
		writeError(ctx, c, "RATE_LIMITED", in.EventID)
		return
	}
	now := d.now()
	res, err := d.Trivia.Answer(ctx, roomID, in.TriviaID, claims.Subject, claims.Nick, *in.Option, now.UnixMilli())
	if err != nil {
		writeError(ctx, c, triviaErrorCode(err), in.EventID)
		return
	}
	if d.TrackTrivia != nil {
		d.TrackTrivia(analytics.TriviaAnswer{
			EventID: d.newID(), RoomID: roomID, UserID: claims.Subject, QuestionID: in.TriviaID,
			Correct: res.Correct, ResponseMS: res.ResponseMS, OccurredAt: now, ReceivedAt: now,
		})
	}
	ack := socialevent.TriviaAck{
		Type: socialevent.TypeTriviaAck, RoomID: roomID, EventIDRef: in.EventID,
		TriviaID: in.TriviaID, Option: *in.Option, Score: res.Score,
	}
	if msg, err := json.Marshal(ack); err == nil {
		_ = writeMsg(ctx, c, msg, d.writeTimeout())
	}
}

func triviaStatus(st trivia.State, nowMS int64) string {
	switch {
	case !st.Launched:
		return socialevent.TriviaPending
	case st.Closed || nowMS >= st.ClosesAtMS:
		return socialevent.TriviaClosed
	}
	return socialevent.TriviaOpen
}

// sendScheduleState responde la lista de preguntas (con correct) solo a c.
func (d *Deps) sendScheduleState(ctx context.Context, c *websocket.Conn, roomID, ref string) {
	list, err := d.Trivia.List(ctx, roomID)
	if err != nil {
		writeError(ctx, c, "UNAVAILABLE", ref)
		return
	}
	d.writeScheduleState(ctx, c, roomID, ref, list)
}

func (d *Deps) writeScheduleState(ctx context.Context, c *websocket.Conn, roomID, ref string, list []trivia.Scheduled) {
	now := d.now().UnixMilli()
	out := socialevent.TriviaScheduleState{
		Type: socialevent.TypeTriviaScheduleState, RoomID: roomID, EventIDRef: ref,
		Questions: make([]socialevent.TriviaScheduled, 0, len(list)),
	}
	for _, q := range list {
		out.Questions = append(out.Questions, socialevent.TriviaScheduled{
			TriviaID: q.ID, AtMS: q.AtMS, Question: q.Question.Question, Options: q.Options,
			Correct: q.Correct, AnswerWindowS: q.AnswerWindowS, Status: triviaStatus(q.State, now),
		})
	}
	if msg, err := json.Marshal(out); err == nil {
		_ = writeMsg(ctx, c, msg, d.writeTimeout())
	}
}

// sendTriviaOnJoin envía al que entra la lista (si modera) y la pregunta
// abierta; cierra las vencidas que nadie cerró y rearma el disparo.
func (d *Deps) sendTriviaOnJoin(ctx context.Context, c *websocket.Conn, roomID string, claims auth.Claims) {
	if d.Trivia == nil {
		return
	}
	d.sendLeaderboardOnJoin(ctx, c, roomID, claims)
	list, err := d.Trivia.List(ctx, roomID)
	if err != nil {
		return
	}
	if isModerator(claims, roomID) {
		d.writeScheduleState(ctx, c, roomID, "", list)
	}
	now := d.now().UnixMilli()
	for _, q := range list {
		if !q.State.Launched || q.State.Closed {
			continue
		}
		if now >= q.State.ClosesAtMS {
			go d.closeTrivia(roomID, q.ID)
			continue
		}
		if msg, err := json.Marshal(d.triviaQuestion(roomID, q.Question, q.State)); err == nil {
			_ = writeMsg(ctx, c, msg, d.writeTimeout())
		}
		d.observeTriviaClose(roomID, q.ID, q.State.ClosesAtMS)
	}
	d.armTrivia(roomID)
}

// sendLeaderboardOnJoin entrega el ranking acumulado persistido (con el
// puesto y los puntos de quien entra). Sin puntos en la sala no se envía.
func (d *Deps) sendLeaderboardOnJoin(ctx context.Context, c *websocket.Conn, roomID string, claims auth.Claims) {
	board, err := d.Trivia.TotalTop(ctx, roomID, socialevent.TriviaTopN)
	if err != nil || len(board) == 0 {
		return
	}
	out := socialevent.TriviaLeaderboard{
		EventID: d.newID(), Type: socialevent.TypeTriviaLeaderboard, RoomID: roomID, Leaderboard: toScores(board),
	}
	if ranks, err := d.Trivia.Ranks(ctx, roomID, []string{claims.Subject}); err == nil {
		if r, ok := ranks[claims.Subject]; ok {
			out.MyRank = &r
		}
	}
	if _, totals, err := d.Trivia.Scores(ctx, roomID, "", []string{claims.Subject}); err == nil {
		t := totals[claims.Subject]
		out.MyTotal = &t
	}
	if msg, err := json.Marshal(out); err == nil {
		_ = writeMsg(ctx, c, msg, d.writeTimeout())
	}
}

func (d *Deps) triviaQuestion(roomID string, q trivia.Question, st trivia.State) socialevent.TriviaQuestion {
	return socialevent.TriviaQuestion{
		EventID: d.newID(), Type: socialevent.TypeTriviaQuestion, RoomID: roomID,
		TriviaID: q.ID, Question: q.Question, Options: q.Options,
		OpensAtMS: st.OpensAtMS, ClosesAtMS: st.ClosesAtMS,
	}
}

// armTrivia (re)agenda el timer de disparo de la sala hacia la próxima
// pregunta pendiente con at_ms ≥ posición, solo si se está reproduciendo.
func (d *Deps) armTrivia(roomID string) {
	if d.Trivia == nil || d.Recap == nil {
		return
	}
	d.mu.Lock()
	if d.triviaArms == nil {
		d.triviaArms = make(map[string]*triviaArm)
	}
	arm := d.triviaArms[roomID]
	if arm == nil {
		arm = &triviaArm{}
		d.triviaArms[roomID] = arm
	}
	arm.gen++
	gen := arm.gen
	if arm.stop != nil {
		arm.stop()
		arm.stop = nil
	}
	d.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), triviaOpTimeout)
	defer cancel()
	pb, ok, err := d.Recap.Position(ctx, roomID, d.now())
	if err != nil || !ok || !pb.Playing {
		return
	}
	list, err := d.Trivia.List(ctx, roomID)
	if err != nil {
		return
	}
	var next *trivia.Scheduled
	for i := range list { // ordenada por at_ms
		if !list[i].State.Launched && list[i].AtMS >= pb.PositionMS {
			next = &list[i]
			break
		}
	}
	if next == nil {
		return
	}
	delay := time.Duration(float64(next.AtMS-pb.PositionMS) / pb.Rate * float64(time.Millisecond))
	tid, at := next.ID, next.AtMS
	d.mu.Lock()
	defer d.mu.Unlock()
	if cur := d.triviaArms[roomID]; cur == arm && arm.gen == gen {
		arm.stop = d.afterFunc(delay, func() { d.fireTrivia(roomID, tid, at, gen) })
	}
}

// fireTrivia lanza la pregunta si el timer sigue vigente y el vídeo llegó
// a la marca; luego rearma hacia la siguiente.
func (d *Deps) fireTrivia(roomID, triviaID string, atMS int64, gen uint64) {
	d.mu.Lock()
	arm := d.triviaArms[roomID]
	if arm == nil || arm.gen != gen {
		d.mu.Unlock()
		return
	}
	arm.stop = nil
	d.mu.Unlock()
	defer d.armTrivia(roomID)

	ctx, cancel := context.WithTimeout(context.Background(), triviaOpTimeout)
	defer cancel()
	pb, ok, err := d.Recap.Position(ctx, roomID, d.now())
	if err != nil || !ok || !pb.Playing || pb.PositionMS < atMS-TriviaEarlyToleranceMS {
		return
	}
	st, won, err := d.Trivia.Launch(ctx, roomID, triviaID, d.now().UnixMilli())
	if err != nil {
		return
	}
	if won {
		if q, _, ok, err := d.Trivia.Get(ctx, roomID, triviaID); err == nil && ok {
			out := d.triviaQuestion(roomID, q, st)
			d.emitRoom(ctx, roomID, out.EventID, out)
		}
	}
	if !st.Closed {
		d.observeTriviaClose(roomID, triviaID, st.ClosesAtMS)
	}
}

// stopTriviaArm cancela el disparo de una sala sin clientes locales (sin
// relay no se ven los eventos de sync y el timer quedaría desfasado).
// Llamar con d.mu tomado.
func (d *Deps) stopTriviaArmLocked(roomID string) {
	if arm := d.triviaArms[roomID]; arm != nil {
		if arm.stop != nil {
			arm.stop()
		}
		delete(d.triviaArms, roomID)
	}
}

func closerKey(roomID, triviaID string) string { return roomID + "\x00" + triviaID }

// observeTriviaClose agenda (una vez por réplica) el cierre a closes_at_ms.
func (d *Deps) observeTriviaClose(roomID, triviaID string, closesAtMS int64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.triviaClosers == nil {
		d.triviaClosers = make(map[string]func() bool)
	}
	key := closerKey(roomID, triviaID)
	if _, ok := d.triviaClosers[key]; ok {
		return
	}
	delay := time.Duration(closesAtMS-d.now().UnixMilli()) * time.Millisecond
	if delay < 0 {
		delay = 0
	}
	d.triviaClosers[key] = d.afterFunc(delay, func() { d.closeTrivia(roomID, triviaID) })
}

// closeTrivia cierra por tiempo; solo quien gana el HSETNX emite el resultado.
func (d *Deps) closeTrivia(roomID, triviaID string) {
	d.mu.Lock()
	delete(d.triviaClosers, closerKey(roomID, triviaID))
	d.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), triviaOpTimeout)
	defer cancel()
	if won, err := d.Trivia.Close(ctx, roomID, triviaID); err != nil || !won {
		return
	}
	res, err := d.triviaResult(ctx, roomID, triviaID)
	if err != nil {
		return
	}
	if d.PublishRaw != nil {
		if raw, err := json.Marshal(res); err == nil {
			_ = d.PublishRaw(ctx, roomID, raw)
		}
	}
	if d.markSeen(res.EventID) {
		return
	}
	d.deliverTriviaResult(ctx, roomID, res)
}

func toScores(entries []trivia.Entry) []socialevent.TriviaScore {
	out := make([]socialevent.TriviaScore, 0, len(entries))
	for _, e := range entries {
		out = append(out, socialevent.TriviaScore{UserID: e.UserID, Nick: e.Nick, Score: e.Score})
	}
	return out
}

// triviaResult arma el resultado común (sin my_score).
func (d *Deps) triviaResult(ctx context.Context, roomID, triviaID string) (socialevent.TriviaResult, error) {
	q, _, ok, err := d.Trivia.Get(ctx, roomID, triviaID)
	if err != nil {
		return socialevent.TriviaResult{}, err
	}
	if !ok {
		return socialevent.TriviaResult{}, trivia.ErrNotFound
	}
	top, err := d.Trivia.Top(ctx, roomID, triviaID, socialevent.TriviaTopN)
	if err != nil {
		return socialevent.TriviaResult{}, err
	}
	board, err := d.Trivia.TotalTop(ctx, roomID, socialevent.TriviaTopN)
	if err != nil {
		return socialevent.TriviaResult{}, err
	}
	return socialevent.TriviaResult{
		EventID: d.newID(), Type: socialevent.TypeTriviaResult, RoomID: roomID,
		TriviaID: triviaID, Correct: q.Correct, Top: toScores(top), Leaderboard: toScores(board),
	}, nil
}

// deliverTriviaResult envía a cada conexión local de la sala el resultado
// con su my_score y my_total. Si no se pueden leer los puntajes se envía
// sin ellos (nunca un 0 inventado).
func (d *Deps) deliverTriviaResult(ctx context.Context, roomID string, res socialevent.TriviaResult) {
	type target struct {
		sub  string
		send chan<- []byte
	}
	d.mu.Lock()
	targets := make([]target, 0, len(d.conns[roomID]))
	seen := make(map[string]struct{})
	var users []string
	for _, c := range d.conns[roomID] {
		if c.send == nil {
			continue
		}
		targets = append(targets, target{sub: c.sub, send: c.send})
		if _, ok := seen[c.sub]; !ok {
			seen[c.sub] = struct{}{}
			users = append(users, c.sub)
		}
	}
	d.mu.Unlock()
	if len(targets) == 0 {
		return
	}
	scores, totals, err := d.Trivia.Scores(ctx, roomID, res.TriviaID, users)
	ranks, rankErr := d.Trivia.Ranks(ctx, roomID, users)
	for _, t := range targets {
		out := res
		if err == nil {
			s, tot := scores[t.sub], totals[t.sub]
			out.MyScore, out.MyTotal = &s, &tot
		}
		if rankErr == nil {
			if r, ok := ranks[t.sub]; ok {
				out.MyRank = &r
			}
		}
		msg, mErr := json.Marshal(out)
		if mErr != nil {
			continue
		}
		select {
		case t.send <- msg:
		default:
		}
	}
}

// observeRemoteTrivia agenda el cierre al ver un trivia_question de otra réplica.
func (d *Deps) observeRemoteTrivia(roomID string, payload []byte) {
	var q socialevent.TriviaQuestion
	if d.Trivia == nil || json.Unmarshal(payload, &q) != nil || q.TriviaID == "" {
		return
	}
	d.observeTriviaClose(roomID, q.TriviaID, q.ClosesAtMS)
}

// deliverRemoteResult personaliza un trivia_result de otra réplica.
func (d *Deps) deliverRemoteResult(roomID string, payload []byte) {
	var res socialevent.TriviaResult
	if d.Trivia == nil || json.Unmarshal(payload, &res) != nil || res.TriviaID == "" {
		return
	}
	res.MyScore, res.MyTotal, res.MyRank = nil, nil, nil
	ctx, cancel := context.WithTimeout(context.Background(), triviaOpTimeout)
	defer cancel()
	d.deliverTriviaResult(ctx, roomID, res)
}
