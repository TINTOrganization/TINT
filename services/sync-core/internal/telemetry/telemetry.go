// Package telemetry publica métricas del canal sync en el stream
// analytics:events sin bloquear nunca el tráfico de reproducción (REQ-29).
//
// Cada Emit* solo encola en un canal con buffer; una goroutine aparte hace
// XADD. Si el buffer está lleno (Redis lento o caído) el evento se descarta
// y se cuenta: perder una métrica es preferible a frenar el video.
//
// Contrato: docs/contrato-eventos-analitica.md. Ningún evento lleva
// identidad del usuario (ni sub, ni nick, ni user_id): solo el role.
package telemetry

import (
	"context"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const (
	// StreamKey es el stream consumido por services/analytics (XREADGROUP).
	StreamKey = "analytics:events"
	// Source identifica al productor en cada evento.
	Source = "sync-core"
	maxLen = 100_000

	// timeLayout: RFC 3339 en UTC con milisegundos (contrato de analytics).
	timeLayout = "2006-01-02T15:04:05.000Z07:00"
)

// Tipos de evento publicados por sync-core.
const (
	TypeDriftCorrection = "drift_correction"
	TypePlaybackCommand = "playback_command"
	TypeBuffering       = "buffering"
)

// DriftSample es un desfase > 500 ms corregido en un cliente (REQ-28).
// No contiene identidad del usuario (Privacy by Design, Ley 1581).
type DriftSample struct {
	RoomID     string
	DriftMs    int64
	RTTMs      int64
	Strategy   string
	Role       string
	PositionMs int64     // posición maestra a la que se corrige
	OccurredAt time.Time // reloj del cliente
	ReceivedAt time.Time // reloj del servidor
}

// PlaybackSample es un comando de reproducción aplicado (no duplicado).
type PlaybackSample struct {
	EventID    string // el del comando del cliente
	RoomID     string
	Command    string // PLAY, PAUSE, SEEK, RATE, LOAD
	PositionMs int64  // posición del ancla resultante
	Role       string
	OccurredAt time.Time
	ReceivedAt time.Time
}

// BufferingSample es un stall del reproductor informado por el cliente.
type BufferingSample struct {
	EventID    string // el del mensaje BUFFERING
	RoomID     string
	DurationMs int64
	PositionMs int64
	Role       string
	OccurredAt time.Time
	ReceivedAt time.Time
}

// Emitter encola y escribe eventos de telemetría.
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

// EmitDrift encola la corrección sin bloquear. Devuelve false si se descartó.
func (e *Emitter) EmitDrift(s DriftSample) bool {
	ev := base(uuid.NewString(), TypeDriftCorrection, s.RoomID, s.Role, s.OccurredAt, s.ReceivedAt)
	ev["drift_ms"] = s.DriftMs
	ev["rtt_ms"] = s.RTTMs
	ev["strategy"] = s.Strategy
	ev["position_ms"] = s.PositionMs
	return e.enqueue(ev)
}

// EmitPlayback encola un comando aplicado sin bloquear.
func (e *Emitter) EmitPlayback(s PlaybackSample) bool {
	ev := base(eventID(s.EventID), TypePlaybackCommand, s.RoomID, s.Role, s.OccurredAt, s.ReceivedAt)
	ev["command"] = s.Command
	ev["position_ms"] = s.PositionMs
	return e.enqueue(ev)
}

// EmitBuffering encola un stall del reproductor sin bloquear.
func (e *Emitter) EmitBuffering(s BufferingSample) bool {
	ev := base(eventID(s.EventID), TypeBuffering, s.RoomID, s.Role, s.OccurredAt, s.ReceivedAt)
	ev["duration_ms"] = s.DurationMs
	ev["position_ms"] = s.PositionMs
	return e.enqueue(ev)
}

func base(id, typ, room, role string, occurred, received time.Time) map[string]any {
	return map[string]any{
		"event_id":    id,
		"type":        typ,
		"source":      Source,
		"room_id":     room,
		"role":        role,
		"occurred_at": occurred.UTC().Format(timeLayout),
		"received_at": received.UTC().Format(timeLayout),
	}
}

// eventID reutiliza el event_id del cliente si es un UUID (normalizado) y
// si no genera uno: analytics lo usa como clave primaria UUID.
func eventID(id string) string {
	if u, err := uuid.Parse(id); err == nil {
		return u.String()
	}
	return uuid.NewString()
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
			err := e.rdb.XAdd(ctx, &redis.XAddArgs{Stream: StreamKey, MaxLen: maxLen, Approx: true, Values: ev}).Err()
			if err != nil {
				e.failed.Add(1)
				slog.Error("telemetry: XADD falló", "error", err)
			}
		}
	}
}

// Dropped devuelve cuántos eventos se descartaron por buffer lleno.
func (e *Emitter) Dropped() int64 { return e.dropped.Load() }

// Failed devuelve cuántos XADD fallaron.
func (e *Emitter) Failed() int64 { return e.failed.Load() }
