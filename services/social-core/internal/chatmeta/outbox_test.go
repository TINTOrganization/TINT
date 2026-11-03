package chatmeta

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newRedis(t *testing.T) (*redis.Client, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	return rdb, mr
}

// fakeStore registra lo insertado y puede fallar a demanda.
type fakeStore struct {
	mu         sync.Mutex
	docs       []Doc
	failInsert error
	failSchema error
	schemaRuns int
}

func (f *fakeStore) EnsureSchema(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.schemaRuns++
	return f.failSchema
}

func (f *fakeStore) InsertMany(_ context.Context, docs []Doc) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failInsert != nil {
		return f.failInsert
	}
	f.docs = append(f.docs, docs...)
	return nil
}

func (f *fakeStore) ids() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.docs))
	for _, d := range f.docs {
		out = append(out, d.ID)
	}
	return out
}

func doc(id string) Doc {
	return Build(pepper, Input{EventID: id, RoomID: "r1", Subject: "s", Role: "participant", Status: StatusAccepted, Text: "hola", ReceivedAt: t0, SentAt: t0})
}

func TestEnqueueAddsTheDocumentToTheCappedStream(t *testing.T) {
	rdb, _ := newRedis(t)
	ctx := context.Background()
	if err := Enqueue(ctx, rdb, doc("e-1")); err != nil {
		t.Fatal(err)
	}
	entries, err := rdb.XRange(ctx, StreamKey, "-", "+").Result()
	if err != nil || len(entries) != 1 {
		t.Fatalf("entries = %v, %v", entries, err)
	}
	got, err := decode(entries[0].Values)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "e-1" || got.Author != Pseudonym(pepper, "r1", "s") || !got.ReceivedAt.Equal(t0) {
		t.Errorf("decodificado = %+v", got)
	}
	if StreamKey != "chat:meta:outbox" || MaxLen != 100_000 {
		t.Errorf("contrato de la cola: %s %d", StreamKey, MaxLen)
	}
}

func TestDecodeRejectsMalformedEntries(t *testing.T) {
	for _, values := range []map[string]any{{}, {"doc": "{roto"}, {"doc": `{"_id":""}`}, {"doc": 42}} {
		if _, err := decode(values); err == nil {
			t.Errorf("decode(%v) debería fallar", values)
		}
	}
}

func TestWriterInsertsAcksAndRemovesTheBatch(t *testing.T) {
	rdb, _ := newRedis(t)
	ctx := context.Background()
	for _, id := range []string{"e-1", "e-2", "e-3"} {
		if err := Enqueue(ctx, rdb, doc(id)); err != nil {
			t.Fatal(err)
		}
	}
	store := &fakeStore{}
	w := NewWriter(rdb, store, "w1")
	n, err := w.Step(ctx)
	if err != nil || n != 3 {
		t.Fatalf("Step = %d, %v", n, err)
	}
	if got := store.ids(); len(got) != 3 || got[0] != "e-1" || got[2] != "e-3" {
		t.Errorf("insertados = %v", got)
	}
	if l := rdb.XLen(ctx, StreamKey).Val(); l != 0 {
		t.Errorf("la cola debería quedar vacía, XLEN = %d", l)
	}
	st, err := w.Status(ctx)
	if err != nil || st.Degraded || st.Backlog != 0 {
		t.Errorf("Status = %+v, %v", st, err)
	}
}

func TestWriterKeepsTheBatchWhileMongoIsDownAndWritesItLater(t *testing.T) {
	rdb, _ := newRedis(t)
	ctx := context.Background()
	_ = Enqueue(ctx, rdb, doc("e-1"))
	_ = Enqueue(ctx, rdb, doc("e-2"))
	store := &fakeStore{failInsert: errors.New("mongo caído")}
	w := NewWriter(rdb, store, "w1")

	if _, err := w.Step(ctx); err == nil {
		t.Fatal("con MongoDB caído Step debe fallar")
	}
	st, _ := w.Status(ctx)
	if !st.Degraded || st.Backlog != 2 {
		t.Errorf("Status con MongoDB caído = %+v", st)
	}
	// Llega otro mensaje mientras tanto: el chat no se detiene.
	_ = Enqueue(ctx, rdb, doc("e-3"))

	store.mu.Lock()
	store.failInsert = nil
	store.mu.Unlock()
	for i := 0; i < 3 && rdb.XLen(ctx, StreamKey).Val() > 0; i++ {
		if _, err := w.Step(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if got := store.ids(); len(got) != 3 {
		t.Errorf("tras recuperarse se insertaron %v", got)
	}
	if st, _ := w.Status(ctx); st.Degraded || st.Backlog != 0 {
		t.Errorf("Status tras recuperarse = %+v", st)
	}
}

func TestWriterRetriesTheSchemaUntilMongoAnswers(t *testing.T) {
	rdb, _ := newRedis(t)
	ctx := context.Background()
	_ = Enqueue(ctx, rdb, doc("e-1"))
	store := &fakeStore{failSchema: errors.New("sin conexión")}
	w := NewWriter(rdb, store, "w1")
	if _, err := w.Step(ctx); err == nil {
		t.Fatal("sin esquema no se escribe")
	}
	if len(store.ids()) != 0 {
		t.Error("no debe insertar antes de crear el esquema")
	}
	store.mu.Lock()
	store.failSchema = nil
	store.mu.Unlock()
	if n, err := w.Step(ctx); err != nil || n != 1 {
		t.Fatalf("Step = %d, %v", n, err)
	}
	if _, err := w.Step(ctx); err != nil {
		t.Fatal(err)
	}
	if store.schemaRuns != 2 {
		t.Errorf("el esquema se crea una sola vez tras el éxito; runs = %d", store.schemaRuns)
	}
}

func TestWriterDropsMalformedEntries(t *testing.T) {
	rdb, _ := newRedis(t)
	ctx := context.Background()
	rdb.XAdd(ctx, &redis.XAddArgs{Stream: StreamKey, Values: map[string]any{"doc": "{roto"}})
	_ = Enqueue(ctx, rdb, doc("e-1"))
	store := &fakeStore{}
	if n, err := NewWriter(rdb, store, "w1").Step(ctx); err != nil || n != 2 {
		t.Fatalf("Step = %d, %v", n, err)
	}
	if got := store.ids(); len(got) != 1 || got[0] != "e-1" {
		t.Errorf("insertados = %v", got)
	}
	if l := rdb.XLen(ctx, StreamKey).Val(); l != 0 {
		t.Errorf("XLEN = %d", l)
	}
}

func TestWriterClaimsEntriesLeftByADeadReplica(t *testing.T) {
	rdb, mr := newRedis(t)
	ctx := context.Background()
	mr.SetTime(t0) // reloj de miniredis para la inactividad de los pendientes
	_ = Enqueue(ctx, rdb, doc("e-1"))
	dead := NewWriter(rdb, &fakeStore{failInsert: errors.New("murió")}, "dead")
	if _, err := dead.Step(ctx); err == nil {
		t.Fatal("la réplica caída deja el lote pendiente")
	}
	alive := &fakeStore{}
	w := NewWriter(rdb, alive, "alive")
	w.ClaimIdle = time.Minute
	w.Block = time.Millisecond

	if n, _ := w.Step(ctx); n != 0 || len(alive.ids()) != 0 {
		t.Fatal("un pendiente reciente es de su réplica: no se reclama")
	}
	mr.SetTime(t0.Add(2 * time.Minute))
	if n, err := w.Step(ctx); err != nil || n != 1 {
		t.Fatalf("Step = %d, %v", n, err)
	}
	if got := alive.ids(); len(got) != 1 || got[0] != "e-1" {
		t.Errorf("reclamados = %v", got)
	}
}

func TestRunBacksOffWhileFailingAndResets(t *testing.T) {
	rdb, _ := newRedis(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_ = Enqueue(ctx, rdb, doc("e-1"))
	store := &fakeStore{failInsert: errors.New("mongo caído")}
	w := NewWriter(rdb, store, "w1")
	w.Block = time.Millisecond
	var mu sync.Mutex
	var sleeps []time.Duration
	recovered := make(chan struct{})
	w.Sleep = func(_ context.Context, d time.Duration) {
		mu.Lock()
		defer mu.Unlock()
		sleeps = append(sleeps, d)
		switch len(sleeps) {
		case 7: // MongoDB vuelve
			store.mu.Lock()
			store.failInsert = nil
			store.mu.Unlock()
			close(recovered)
		case 8: // tras un éxito, un fallo nuevo vuelve a esperar 1 s
			cancel()
		}
	}
	go func() {
		<-recovered
		for len(store.ids()) == 0 {
			time.Sleep(time.Millisecond)
		}
		store.mu.Lock()
		store.failInsert = errors.New("mongo caído otra vez")
		store.mu.Unlock()
		_ = Enqueue(context.Background(), rdb, doc("e-2"))
	}()
	w.Run(ctx)
	mu.Lock()
	defer mu.Unlock()
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second, 30 * time.Second, time.Second}
	if len(sleeps) != len(want) {
		t.Fatalf("esperas = %v", sleeps)
	}
	for i, d := range want {
		if sleeps[i] != d {
			t.Fatalf("espera %d = %v, want %v (todas: %v)", i, sleeps[i], d, sleeps)
		}
	}
	if got := store.ids(); len(got) != 1 || got[0] != "e-1" {
		t.Errorf("tras recuperarse se insertaron %v", got)
	}
}

func TestRecorderEnrichesBuildsAndEnqueuesWithoutBlocking(t *testing.T) {
	rdb, _ := newRedis(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var enrichedAt time.Time
	enrich := func(_ context.Context, roomID string, at time.Time) Context {
		enrichedAt = at
		return Context{RoomKind: "live", StreamOffsetMS: ptr(int64(5000))}
	}
	r := NewRecorder(rdb, pepper, enrich, 4)
	in := baseInput()
	in.Context = Context{}
	if !r.Record(in) {
		t.Fatal("Record debe aceptar con buffer libre")
	}
	go r.Run(ctx)
	deadline := time.Now().Add(2 * time.Second)
	for rdb.XLen(ctx, StreamKey).Val() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	entries := rdb.XRange(ctx, StreamKey, "-", "+").Val()
	if len(entries) != 1 {
		t.Fatalf("entries = %v", entries)
	}
	got, _ := decode(entries[0].Values)
	if got.RoomKind != "live" || got.StreamOffsetMS == nil || *got.StreamOffsetMS != 5000 || !enrichedAt.Equal(t0) {
		t.Errorf("enriquecido = %+v (at %v)", got, enrichedAt)
	}
}

func TestRecorderDropsAndCountsWhenTheBufferIsFull(t *testing.T) {
	rdb, _ := newRedis(t)
	r := NewRecorder(rdb, pepper, nil, 1)
	if !r.Record(baseInput()) || r.Record(baseInput()) {
		t.Fatal("el segundo no cabe en un buffer de 1")
	}
	if r.Dropped() != 1 {
		t.Errorf("Dropped = %d", r.Dropped())
	}
}

func TestRecorderCountsEnqueueFailures(t *testing.T) {
	rdb, mr := newRedis(t)
	ctx, cancel := context.WithCancel(context.Background())
	r := NewRecorder(rdb, pepper, nil, 4)
	mr.Close() // Redis caído: se cuenta y se sigue
	r.Record(baseInput())
	done := make(chan struct{})
	go func() { r.Run(ctx); close(done) }()
	deadline := time.Now().Add(3 * time.Second)
	for r.Failed() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if r.Failed() != 1 {
		t.Errorf("Failed = %d", r.Failed())
	}
}

func TestSleepCtxReturnsWhenCancelledOrElapsed(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	sleepCtx(ctx, time.Hour)
	sleepCtx(context.Background(), time.Millisecond)
	if time.Since(start) > time.Second {
		t.Error("sleepCtx no respetó la cancelación")
	}
}
