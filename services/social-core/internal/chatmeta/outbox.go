package chatmeta

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	// StreamKey es la cola de documentos pendientes de escribir en MongoDB.
	StreamKey = "chat:meta:outbox"
	// Group es el grupo de consumidores de los escritores (uno por réplica).
	Group = "chat-meta-writer"
	// MaxLen acota la cola (~40 MB): con MongoDB caído mucho tiempo se
	// descartan los documentos más antiguos, nunca mensajes.
	MaxLen = 100_000
	// warnBacklog avisa en el log antes de llegar al tope.
	warnBacklog = MaxLen * 9 / 10
)

// Enqueue deja el documento en la cola (XADD MAXLEN ~).
func Enqueue(ctx context.Context, rdb redis.Cmdable, d Doc) error {
	raw, err := json.Marshal(d)
	if err != nil {
		return err
	}
	return rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: StreamKey, MaxLen: MaxLen, Approx: true, Values: map[string]any{"doc": string(raw)},
	}).Err()
}

var errMalformed = errors.New("entrada de la cola mal formada")

func decode(values map[string]any) (Doc, error) {
	raw, ok := values["doc"].(string)
	if !ok {
		return Doc{}, errMalformed
	}
	var d Doc
	if err := json.Unmarshal([]byte(raw), &d); err != nil || d.ID == "" {
		return Doc{}, errMalformed
	}
	return d, nil
}

// Inserter es el almacén de destino (MongoDB en producción).
type Inserter interface {
	EnsureSchema(ctx context.Context) error
	// InsertMany debe tratar un _id repetido como escrito (idempotencia).
	InsertMany(ctx context.Context, docs []Doc) error
}

// Health resume el estado del escritor para /healthz.
type Health struct {
	Degraded bool  // el último intento de escribir en MongoDB falló
	Backlog  int64 // documentos en cola sin escribir
}

// Writer vacía la cola en MongoDB. Confirma (XACK) y borra (XDEL) cada lote
// solo después de escribirlo: si MongoDB falla, el lote queda pendiente y se
// reintenta; los pendientes de una réplica caída los reclama otra.
type Writer struct {
	rdb      redis.Cmdable
	store    Inserter
	consumer string
	// Batch es el tamaño máximo del lote.
	Batch int64
	// Block es la espera de XREADGROUP con la cola vacía.
	Block time.Duration
	// ClaimIdle es cuánto debe llevar un pendiente de otra réplica para
	// reclamarlo (más que lo que tarda un lote en escribirse).
	ClaimIdle time.Duration
	// MinBackoff y MaxBackoff acotan la espera entre reintentos.
	MinBackoff, MaxBackoff time.Duration
	// Sleep espera respetando ctx (inyectable en pruebas).
	Sleep func(ctx context.Context, d time.Duration)

	groupReady  bool
	schemaReady bool
	degraded    atomic.Bool
}

// NewWriter crea el escritor de una réplica (consumer debe ser único).
func NewWriter(rdb redis.Cmdable, store Inserter, consumer string) *Writer {
	return &Writer{
		rdb: rdb, store: store, consumer: consumer,
		Batch: 100, Block: 2 * time.Second, ClaimIdle: time.Minute,
		MinBackoff: time.Second, MaxBackoff: 30 * time.Second,
		Sleep: sleepCtx,
	}
}

func sleepCtx(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// Run escribe hasta que ctx se cancele, con espera creciente mientras falle.
func (w *Writer) Run(ctx context.Context) {
	backoff := w.MinBackoff
	lastWarn := time.Time{}
	for ctx.Err() == nil {
		_, err := w.Step(ctx)
		if ctx.Err() != nil {
			return
		}
		if st, serr := w.Status(ctx); serr == nil && st.Backlog >= warnBacklog && time.Since(lastWarn) > time.Minute {
			slog.Warn("cola de metadatos del chat casi llena; se perderán los más antiguos", "backlog", st.Backlog, "max", MaxLen)
			lastWarn = time.Now()
		}
		if err == nil {
			backoff = w.MinBackoff
			continue
		}
		slog.Warn("no se pudieron escribir los metadatos del chat; se reintenta", "error", err, "wait", backoff)
		w.Sleep(ctx, backoff)
		backoff = min(backoff*2, w.MaxBackoff)
	}
}

// Step procesa un lote: primero los pendientes huérfanos de otras réplicas,
// luego los propios sin confirmar y por último los nuevos. Devuelve cuántas
// entradas confirmó (incluidas las mal formadas, que se descartan).
func (w *Writer) Step(ctx context.Context) (int, error) {
	if err := w.ensureGroup(ctx); err != nil {
		return 0, err
	}
	if !w.schemaReady {
		if err := w.store.EnsureSchema(ctx); err != nil {
			w.degraded.Store(true)
			return 0, err
		}
		w.schemaReady = true
	}
	msgs, err := w.next(ctx)
	if err != nil || len(msgs) == 0 {
		return 0, err
	}
	docs := make([]Doc, 0, len(msgs))
	ids := make([]string, 0, len(msgs))
	for _, m := range msgs {
		ids = append(ids, m.ID)
		d, derr := decode(m.Values)
		if derr != nil {
			slog.Warn("se descarta una entrada de la cola de metadatos", "id", m.ID)
			continue
		}
		docs = append(docs, d)
	}
	if len(docs) > 0 {
		if err := w.store.InsertMany(ctx, docs); err != nil {
			w.degraded.Store(true)
			return 0, err
		}
	}
	w.degraded.Store(false)
	if err := w.rdb.XAck(ctx, StreamKey, Group, ids...).Err(); err != nil {
		return 0, err
	}
	// Borrar lo escrito: así XLEN es exactamente lo que falta por escribir.
	_ = w.rdb.XDel(ctx, StreamKey, ids...).Err()
	return len(ids), nil
}

func (w *Writer) ensureGroup(ctx context.Context) error {
	if w.groupReady {
		return nil
	}
	err := w.rdb.XGroupCreateMkStream(ctx, StreamKey, Group, "0").Err()
	if err != nil && !strings.Contains(err.Error(), "BUSYGROUP") {
		return err
	}
	w.groupReady = true
	return nil
}

func (w *Writer) next(ctx context.Context) ([]redis.XMessage, error) {
	claimed, _, err := w.rdb.XAutoClaim(ctx, &redis.XAutoClaimArgs{
		Stream: StreamKey, Group: Group, Consumer: w.consumer,
		MinIdle: w.ClaimIdle, Start: "0-0", Count: w.Batch,
	}).Result()
	if err != nil {
		return nil, err
	}
	if len(claimed) > 0 {
		return claimed, nil
	}
	for _, id := range []string{"0", ">"} {
		block := time.Duration(-1) // sin BLOCK para los pendientes propios
		if id == ">" {
			block = w.Block
		}
		res, err := w.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group: Group, Consumer: w.consumer, Streams: []string{StreamKey, id}, Count: w.Batch, Block: block,
		}).Result()
		if errors.Is(err, redis.Nil) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if len(res) > 0 && len(res[0].Messages) > 0 {
			return res[0].Messages, nil
		}
	}
	return nil, nil
}

// Status informa si MongoDB está fallando y cuántos documentos esperan.
func (w *Writer) Status(ctx context.Context) (Health, error) {
	n, err := w.rdb.XLen(ctx, StreamKey).Result()
	if err != nil {
		return Health{Degraded: w.degraded.Load()}, err
	}
	return Health{Degraded: w.degraded.Load(), Backlog: n}, nil
}

// EnrichFunc lee el contexto de la sala en el instante del mensaje.
type EnrichFunc func(ctx context.Context, roomID string, at time.Time) Context

// Recorder recibe los intentos de envío sin bloquear el chat: los encola en
// memoria y una goroutine (Run) los enriquece con el contexto de la sala y
// los deja en chat:meta:outbox. Con el buffer lleno se descartan y cuentan.
type Recorder struct {
	ch      chan Input
	rdb     redis.Cmdable
	pepper  []byte
	enrich  EnrichFunc
	dropped atomic.Int64
	failed  atomic.Int64
}

// NewRecorder crea el registrador (enrich puede ser nil).
func NewRecorder(rdb redis.Cmdable, pepper []byte, enrich EnrichFunc, buffer int) *Recorder {
	return &Recorder{ch: make(chan Input, buffer), rdb: rdb, pepper: pepper, enrich: enrich}
}

// Record encola el intento; false si el buffer está lleno.
func (r *Recorder) Record(in Input) bool {
	select {
	case r.ch <- in:
		return true
	default:
		r.dropped.Add(1)
		return false
	}
}

// Run procesa los intentos hasta que ctx se cancele.
func (r *Recorder) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case in := <-r.ch:
			r.handle(ctx, in)
		}
	}
}

func (r *Recorder) handle(ctx context.Context, in Input) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if r.enrich != nil {
		in.Context = r.enrich(ctx, in.RoomID, in.ReceivedAt)
	}
	if err := Enqueue(ctx, r.rdb, Build(r.pepper, in)); err != nil {
		r.failed.Add(1)
		slog.Warn("no se pudo encolar los metadatos del chat", "error", err)
	}
}

// Dropped cuenta los intentos descartados por buffer lleno.
func (r *Recorder) Dropped() int64 { return r.dropped.Load() }

// Failed cuenta los intentos que no se pudieron encolar en Redis.
func (r *Recorder) Failed() int64 { return r.failed.Load() }
