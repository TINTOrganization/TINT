// Package analytics publica eventos del canal social en el stream
// analytics:events (contrato: docs/contrato-eventos-analitica.md) sin
// bloquear nunca el chat ni las reacciones.
//
// Los Emit* solo encolan en un canal con buffer; una goroutine aparte (Run)
// hace XADD. Si el buffer está lleno (Redis lento o caído) el evento se
// descarta y se cuenta: perder una métrica es preferible a frenar al usuario.
// Nunca viajan el texto del chat ni el nick (Ley 1581).
package analytics

import (
	"context"
	"log/slog"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	// StreamKey es el stream consumido por services/analytics (XREADGROUP).
	StreamKey = "analytics:events"
	// Source identifica a este servicio en el campo source.
	Source = "social-core"
	maxLen = 100_000
	// timeLayout: RFC 3339 con milisegundos; sobre UTC termina en "Z".
	timeLayout = "2006-01-02T15:04:05.000Z07:00"
)

// PresenceKind es el tipo de cambio de presencia.
type PresenceKind string

const (
	PresenceJoined PresenceKind = "joined"
	PresenceLeft   PresenceKind = "left"
)

// ChatMessage son los metadatos de un mensaje aceptado (sin texto).
type ChatMessage struct {
	EventID       string
	RoomID        string
	UserID        string
	MessageLength int
	OccurredAt    time.Time
	ReceivedAt    time.Time
}

// Presence es una entrada o salida avisada en la sala.
type Presence struct {
	EventID        string
	RoomID         string
	UserID         string
	Kind           PresenceKind
	ConnectedUsers int
	OccurredAt     time.Time
	ReceivedAt     time.Time
}

// Reaction es una reacción aceptada (después del límite de 5/s).
type Reaction struct {
	EventID    string
	RoomID     string
	UserID     string
	Emoji      string
	PositionMS int64
	OccurredAt time.Time
	ReceivedAt time.Time
}

// TriviaAnswer es una respuesta de trivia evaluada por el servidor.
// question_id es el trivia_id; response_ms se mide con el reloj del
// servidor (respuesta − apertura).
type TriviaAnswer struct {
	EventID    string
	RoomID     string
	UserID     string
	QuestionID string
	Correct    bool
	ResponseMS int64
	OccurredAt time.Time
	ReceivedAt time.Time
}

// FormatTime da el formato del contrato: RFC 3339, UTC, con milisegundos.
func FormatTime(t time.Time) string {
	return t.UTC().Format(timeLayout)
}

// Emitter encola y escribe eventos de analítica.
type Emitter struct {
	rdb     redis.Cmdable
	ch      chan map[string]any
	dropped atomic.Int64
	failed  atomic.Int64
}

// New crea un Emitter con un buffer de tamaño buffer.
func New(rdb redis.Cmdable, buffer int) *Emitter {
	return &Emitter{rdb: rdb, ch: make(chan map[string]any, buffer)}
}

func base(eventType, eventID, roomID, userID string, occurred, received time.Time) map[string]any {
	return map[string]any{
		"event_id":    eventID,
		"type":        eventType,
		"source":      Source,
		"room_id":     roomID,
		"user_id":     userID,
		"occurred_at": FormatTime(occurred),
		"received_at": FormatTime(received),
	}
}

// EmitChat encola un chat_message. Devuelve false si se descartó.
func (e *Emitter) EmitChat(m ChatMessage) bool {
	ev := base("chat_message", m.EventID, m.RoomID, m.UserID, m.OccurredAt, m.ReceivedAt)
	ev["message_length"] = strconv.Itoa(m.MessageLength)
	return e.enqueue(ev)
}

// EmitPresence encola un presence. Devuelve false si se descartó.
func (e *Emitter) EmitPresence(p Presence) bool {
	ev := base("presence", p.EventID, p.RoomID, p.UserID, p.OccurredAt, p.ReceivedAt)
	ev["kind"] = string(p.Kind)
	ev["connected_users"] = strconv.Itoa(p.ConnectedUsers)
	return e.enqueue(ev)
}

// EmitReaction encola un reaction. Devuelve false si se descartó.
func (e *Emitter) EmitReaction(r Reaction) bool {
	ev := base("reaction", r.EventID, r.RoomID, r.UserID, r.OccurredAt, r.ReceivedAt)
	ev["emoji"] = r.Emoji
	ev["position_ms"] = strconv.FormatInt(r.PositionMS, 10)
	return e.enqueue(ev)
}

// EmitTrivia encola un trivia_answer. Devuelve false si se descartó.
func (e *Emitter) EmitTrivia(a TriviaAnswer) bool {
	ev := base("trivia_answer", a.EventID, a.RoomID, a.UserID, a.OccurredAt, a.ReceivedAt)
	ev["question_id"] = a.QuestionID
	ev["correct"] = strconv.FormatBool(a.Correct)
	ev["response_ms"] = strconv.FormatInt(a.ResponseMS, 10)
	return e.enqueue(ev)
}

func (e *Emitter) enqueue(ev map[string]any) bool {
	select {
	case e.ch <- ev:
		return true
	default:
		e.dropped.Add(1)
		return false
	}
}

// Run escribe los eventos encolados hasta que ctx se cancele.
func (e *Emitter) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-e.ch:
			e.write(ctx, ev)
		}
	}
}

// drain escribe lo que haya en el buffer sin esperar más (pruebas).
func (e *Emitter) drain(ctx context.Context) {
	for {
		select {
		case ev := <-e.ch:
			e.write(ctx, ev)
		default:
			return
		}
	}
}

func (e *Emitter) write(ctx context.Context, ev map[string]any) {
	err := e.rdb.XAdd(ctx, &redis.XAddArgs{Stream: StreamKey, MaxLen: maxLen, Approx: true, Values: ev}).Err()
	if err != nil {
		e.failed.Add(1)
		slog.Error("analytics: XADD falló", "error", err)
	}
}

// Dropped devuelve cuántos eventos se descartaron por buffer lleno.
func (e *Emitter) Dropped() int64 { return e.dropped.Load() }

// Failed devuelve cuántos XADD fallaron.
func (e *Emitter) Failed() int64 { return e.failed.Load() }
