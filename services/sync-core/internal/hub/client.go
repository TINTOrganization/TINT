package hub

import (
	"context"
	"errors"
	"sync/atomic"

	"github.com/google/uuid"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/codec"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/drift"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

var (
	ErrSlowConsumer = errors.New("cliente demasiado lento: cola de salida llena")
	ErrStale        = errors.New("cliente sin responder SYNC_CHECK")
	ErrClosed       = errors.New("conexión cerrada")
	ErrRevoked      = errors.New("token revocado")
)

// Client es una conexión al Canal Sync. Solo la goroutine escritora lee de
// Send(); el resto del sistema encola sin bloquear.
type Client struct {
	id     string
	claims auth.Claims
	codec  codec.Codec
	send   chan []byte
	ctx    context.Context
	cancel context.CancelCauseFunc

	rttMs       atomic.Int64 // RTT suavizado (EWMA), medido con el reloj del servidor
	lastCheckMs atomic.Int64 // último SYNC_CHECK recibido
	lastDriftMs atomic.Int64 // último drift medido (se informa en HEARTBEAT)
	lastSeekMs  atomic.Int64 // último SYNC_CORRECTION por seek enviado (0 = nunca)

	// Rate limits por ventana fija; solo los toca la goroutine lectora.
	// SYNC_CHECK tiene el suyo para que un host que agota el general con
	// comandos no deje de responder latidos (y acabe cerrado como stale).
	msgs   fixedWindow
	checks fixedWindow
	// Último BUFFERING aceptado (unix ms); solo lo toca la goroutine lectora.
	lastBufferingMs int64

	// Hasta encolar el STATE inicial, lo que llega por la sala se retiene
	// (HU-SYNC-01: el STATE va primero). Protegidos por Hub.mu.
	ready bool
	held  [][]byte
}

func newClient(parent context.Context, claims auth.Claims, nowMs int64) *Client {
	ctx, cancel := context.WithCancelCause(parent)
	c := &Client{id: uuid.NewString(), claims: claims, codec: codec.JSON, send: make(chan []byte, SendBuffer), ctx: ctx, cancel: cancel}
	c.lastCheckMs.Store(nowMs)
	return c
}

// ConnOption configura una conexión al registrarla.
type ConnOption func(*Client)

// WithCodec fija el formato negociado por el cliente (JSON por defecto).
func WithCodec(c codec.Codec) ConnOption {
	return func(cl *Client) { cl.codec = c }
}

// Codec devuelve el formato de la conexión.
func (c *Client) Codec() codec.Codec { return c.codec }

// enqueueEvent codifica ev en el formato del cliente y lo encola.
func (c *Client) enqueueEvent(ev syncevent.Event) {
	raw, err := c.codec.Encode(ev)
	if err != nil {
		c.close(err) // Event siempre es serializable: sería un bug
		return
	}
	c.enqueue(raw)
}

// Send es la cola de mensajes salientes del cliente.
func (c *Client) Send() <-chan []byte { return c.send }

// Context se cancela cuando el cliente debe desconectarse.
func (c *Client) Context() context.Context { return c.ctx }

// Done se cierra cuando el cliente debe desconectarse.
func (c *Client) Done() <-chan struct{} { return c.ctx.Done() }

// Err devuelve la causa de la desconexión.
func (c *Client) Err() error { return context.Cause(c.ctx) }

// Claims devuelve la identidad verificada del cliente.
func (c *Client) Claims() auth.Claims { return c.claims }

// RTT devuelve el RTT suavizado en milisegundos.
func (c *Client) RTT() int64 { return c.rttMs.Load() }

// enqueue nunca bloquea: un cliente lento no puede frenar a los demás.
// deliver encola un mensaje de la sala o lo retiene si el cliente aún no
// recibió su STATE. Requiere Hub.mu.
func (c *Client) deliver(msg []byte) {
	if !c.ready {
		if len(c.held) >= SendBuffer {
			c.close(ErrSlowConsumer)
			return
		}
		c.held = append(c.held, msg)
		return
	}
	c.enqueue(msg)
}

func (c *Client) enqueue(msg []byte) {
	if c.ctx.Err() != nil {
		return
	}
	select {
	case c.send <- msg:
	default:
		c.close(ErrSlowConsumer)
	}
}

func (c *Client) close(cause error) { c.cancel(cause) }

// fixedWindow es un rate limit por ventana fija de 1 s.
type fixedWindow struct {
	startMs int64
	count   int
}

func (w *fixedWindow) allow(nowMs int64, limit int) bool {
	if nowMs-w.startMs >= 1000 {
		w.startMs, w.count = nowMs, 0
	}
	w.count++
	return w.count <= limit
}

// allow aplica el límite general de mensajes entrantes (todo salvo SYNC_CHECK).
func (c *Client) allow(nowMs int64) bool { return c.msgs.allow(nowMs, MaxMsgsPerSecond) }

// allowSyncCheck aplica el límite propio de SYNC_CHECK.
func (c *Client) allowSyncCheck(nowMs int64) bool {
	return c.checks.allow(nowMs, MaxSyncChecksPerSecond)
}

// allowSeek indica si se le puede enviar un seek al cliente: no más de uno
// cada drift.SeekCooldownMs. Si lo permite, registra nowMs como el último.
func (c *Client) allowSeek(nowMs int64) bool {
	last := c.lastSeekMs.Load()
	if last != 0 && nowMs-last < drift.SeekCooldownMs {
		return false
	}
	c.lastSeekMs.Store(nowMs)
	return true
}

// allowBuffering acepta como máximo un BUFFERING por BufferingInterval.
func (c *Client) allowBuffering(nowMs int64) bool {
	if c.lastBufferingMs != 0 && nowMs-c.lastBufferingMs < BufferingInterval.Milliseconds() {
		return false
	}
	c.lastBufferingMs = nowMs
	return true
}
