package trivia

import (
	"context"
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func testStore(t *testing.T) (*Store, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return NewStore(client, 0), mr
}

const t0 = int64(1_000_000)

func sample(id string, at int64) Question {
	return Question{ID: id, AtMS: at, Question: "¿Quién fue?", Options: []string{"Ana", "Beto", "Caro"}, Correct: 1, AnswerWindowS: 20}
}

func TestScheduleListDelete(t *testing.T) {
	s, mr := testStore(t)
	ctx := context.Background()
	for _, q := range []Question{sample("b", 60_000), sample("a", 30_000), sample("c", 60_000)} {
		if err := s.Schedule(ctx, "r1", q); err != nil {
			t.Fatal(err)
		}
	}
	list, err := s.List(ctx, "r1")
	if err != nil || len(list) != 3 {
		t.Fatalf("List = %v %v", list, err)
	}
	// Orden por at_ms y luego id.
	if list[0].ID != "a" || list[1].ID != "b" || list[2].ID != "c" || list[0].Correct != 1 || len(list[0].Options) != 3 {
		t.Fatalf("orden = %+v", list)
	}
	if list[0].State.Launched || list[0].State.Closed {
		t.Fatalf("estado inicial = %+v", list[0].State)
	}
	if ttl := mr.TTL(QuestionsKey("r1")); ttl != DefaultTTL {
		t.Fatalf("TTL preguntas = %v", ttl)
	}
	if err := s.Delete(ctx, "r1", "b"); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, "r1", "b"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("borrar dos veces = %v, want ErrNotFound", err)
	}
	// Una pregunta ya lanzada no se borra.
	if _, _, err := s.Launch(ctx, "r1", "a", t0); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, "r1", "a"); !errors.Is(err, ErrClosed) {
		t.Fatalf("borrar lanzada = %v, want ErrClosed", err)
	}
	if list, _ := s.List(ctx, "r1"); len(list) != 2 || !list[0].State.Launched {
		t.Fatalf("List tras borrar = %+v", list)
	}
}

func TestScheduleLimit(t *testing.T) {
	s, _ := testStore(t)
	ctx := context.Background()
	for i := 0; i < MaxQuestions; i++ {
		if err := s.Schedule(ctx, "r1", sample(strconv.Itoa(i), int64(i))); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Schedule(ctx, "r1", sample("extra", 1)); !errors.Is(err, ErrLimit) {
		t.Fatalf("pregunta %d = %v, want ErrLimit", MaxQuestions+1, err)
	}
	// Reemplazar una existente no cuenta como nueva.
	if err := s.Schedule(ctx, "r1", sample("0", 5)); err != nil {
		t.Fatalf("reemplazo = %v", err)
	}
}

func TestLaunchOnce(t *testing.T) {
	s, _ := testStore(t)
	ctx := context.Background()
	if _, _, err := s.Launch(ctx, "r1", "nope", t0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("lanzar inexistente = %v", err)
	}
	_ = s.Schedule(ctx, "r1", sample("q", 30_000))
	st, won, err := s.Launch(ctx, "r1", "q", t0)
	if err != nil || !won || st.OpensAtMS != t0 || st.ClosesAtMS != t0+20_000 || !st.Launched {
		t.Fatalf("Launch = %+v %v %v", st, won, err)
	}
	// Otra réplica pierde y ve el mismo estado.
	st2, won, err := s.Launch(ctx, "r1", "q", t0+50)
	if err != nil || won || st2 != st {
		t.Fatalf("segundo Launch = %+v %v %v, want perdido con %+v", st2, won, err, st)
	}
	q, gotSt, ok, err := s.Get(ctx, "r1", "q")
	if err != nil || !ok || q.Question != "¿Quién fue?" || gotSt != st {
		t.Fatalf("Get = %+v %+v %v %v", q, gotSt, ok, err)
	}
	if _, _, ok, err := s.Get(ctx, "r1", "nope"); err != nil || ok {
		t.Fatalf("Get inexistente = %v %v", ok, err)
	}
}

func TestAnswerScoresAndRanks(t *testing.T) {
	s, mr := testStore(t)
	ctx := context.Background()
	_ = s.Schedule(ctx, "r1", sample("q", 30_000))
	if _, err := s.Answer(ctx, "r1", "q", "u", "U", 1, t0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("responder sin lanzar = %v, want ErrNotFound", err)
	}
	if _, err := s.Answer(ctx, "r1", "nope", "u", "U", 1, t0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("responder inexistente = %v", err)
	}
	_, _, _ = s.Launch(ctx, "r1", "q", t0)

	// Correcta a los 2 s, correcta a los 8 s, incorrecta al instante y dos
	// correctas tras la ventana de bono (empate: gana la más temprana).
	answers := []struct {
		user, nick string
		option     int
		at         int64
		want       int
	}{
		{"guest:lento", "Lento", 1, t0 + 8000, Score(true, 8*time.Second)},
		{"guest:rapido", "Rápido", 1, t0 + 2000, Score(true, 2*time.Second)},
		{"guest:mal", "Mal", 0, t0, 0},
		{"guest:tarde2", "Tarde2", 1, t0 + 15_000, BasePoints},
		{"guest:tarde1", "Tarde1", 1, t0 + 12_000, BasePoints},
	}
	for _, a := range answers {
		got, err := s.Answer(ctx, "r1", "q", a.user, a.nick, a.option, a.at)
		if err != nil || got.Score != a.want || got.Correct != (a.option == 1) {
			t.Fatalf("Answer(%s) = %+v %v, want %d", a.user, got, err, a.want)
		}
	}
	if _, err := s.Answer(ctx, "r1", "q", "guest:mal", "Mal", 1, t0+100); !errors.Is(err, ErrAlreadyAnswered) {
		t.Fatalf("segunda respuesta = %v, want ErrAlreadyAnswered", err)
	}
	if _, err := s.Answer(ctx, "r1", "q", "guest:x", "X", 3, t0+100); !errors.Is(err, ErrOption) {
		t.Fatalf("opción fuera de rango = %v, want ErrOption", err)
	}
	if _, err := s.Answer(ctx, "r1", "q", "guest:x", "X", 1, t0+20_000); !errors.Is(err, ErrClosed) {
		t.Fatalf("respuesta al cierre = %v, want ErrClosed", err)
	}

	top, err := s.Top(ctx, "r1", "q", 10)
	if err != nil || len(top) != 5 {
		t.Fatalf("Top = %+v %v", top, err)
	}
	wantOrder := []string{"guest:rapido", "guest:lento", "guest:tarde1", "guest:tarde2", "guest:mal"}
	for i, u := range wantOrder {
		if top[i].UserID != u {
			t.Fatalf("Top[%d] = %+v, want %s (orden %+v)", i, top[i], u, top)
		}
	}
	if top[0].Nick != "Rápido" || top[0].Score != Score(true, 2*time.Second) || top[4].Score != 0 {
		t.Fatalf("entradas = %+v", top)
	}
	if top2, _ := s.Top(ctx, "r1", "q", 2); len(top2) != 2 {
		t.Fatalf("Top(2) = %+v", top2)
	}

	// Segunda pregunta: el acumulado suma.
	_ = s.Schedule(ctx, "r1", sample("q2", 90_000))
	_, _, _ = s.Launch(ctx, "r1", "q2", t0+100_000)
	_, _ = s.Answer(ctx, "r1", "q2", "guest:lento", "Lento", 1, t0+100_000)
	total, err := s.TotalTop(ctx, "r1", 10)
	if err != nil || total[0].UserID != "guest:lento" || total[0].Score != Score(true, 8*time.Second)+2*BasePoints {
		t.Fatalf("TotalTop = %+v %v", total, err)
	}
	scores, totals, err := s.Scores(ctx, "r1", "q", []string{"guest:rapido", "guest:nadie"})
	if err != nil || scores["guest:rapido"] != Score(true, 2*time.Second) || scores["guest:nadie"] != 0 || totals["guest:rapido"] != Score(true, 2*time.Second) {
		t.Fatalf("Scores = %v %v %v", scores, totals, err)
	}
	if sc, tt, err := s.Scores(ctx, "r1", "q", nil); err != nil || len(sc) != 0 || len(tt) != 0 {
		t.Fatalf("Scores vacío = %v %v %v", sc, tt, err)
	}
	for _, k := range []string{LeaderboardKey("r1", "q"), TotalKey("r1"), NicksKey("r1")} {
		if ttl := mr.TTL(k); ttl != DefaultTTL+LeaderboardTTL {
			t.Fatalf("TTL %s = %v, want %v", k, ttl, DefaultTTL+LeaderboardTTL)
		}
	}
	if ttl := mr.TTL(AnswersKey("r1", "q")); ttl != DefaultTTL {
		t.Fatalf("TTL respuestas = %v", ttl)
	}
}

func TestTotalTieBreakEarlierCorrectAnswerWins(t *testing.T) {
	s, mr := testStore(t)
	ctx := context.Background()
	_ = s.Schedule(ctx, "r1", sample("q", 30_000))
	_, _, _ = s.Launch(ctx, "r1", "q", t0)
	// Same points (both past the bonus window); "zeta" answered first, and
	// Redis alone would sort the tie by member name, putting "alfa" first.
	_, _ = s.Answer(ctx, "r1", "q", "zeta", "Zeta", 1, t0+12_000)
	_, _ = s.Answer(ctx, "r1", "q", "alfa", "Alfa", 1, t0+15_000)
	_, _ = s.Answer(ctx, "r1", "q", "nada", "Nada", 0, t0+11_000)

	total, err := s.TotalTop(ctx, "r1", 10)
	if err != nil || len(total) != 3 || total[0].UserID != "zeta" || total[1].UserID != "alfa" || total[0].Score != total[1].Score || total[2].UserID != "nada" {
		t.Fatalf("TotalTop = %+v %v, want zeta, alfa, nada", total, err)
	}
	ranks, err := s.Ranks(ctx, "r1", []string{"alfa", "zeta", "nada", "nadie"})
	if err != nil || ranks["zeta"] != 1 || ranks["alfa"] != 2 || ranks["nada"] != 3 || ranks["nadie"] != 0 {
		t.Fatalf("Ranks = %v %v", ranks, err)
	}

	// A later question with identical times: the accumulated response time of
	// correct answers (24 s vs 27 s) keeps zeta ahead.
	_ = s.Schedule(ctx, "r1", sample("q2", 90_000))
	_, _, _ = s.Launch(ctx, "r1", "q2", t0+100_000)
	_, _ = s.Answer(ctx, "r1", "q2", "zeta", "Zeta", 1, t0+112_000)
	_, _ = s.Answer(ctx, "r1", "q2", "alfa", "Alfa", 1, t0+112_000)
	total, _ = s.TotalTop(ctx, "r1", 1)
	if len(total) != 1 || total[0].UserID != "zeta" {
		t.Fatalf("TotalTop(1) = %+v, want zeta", total)
	}
	if ttl := mr.TTL(ElapsedKey("r1")); ttl != DefaultTTL+LeaderboardTTL {
		t.Fatalf("TTL elapsed = %v", ttl)
	}
	if r, err := s.Ranks(ctx, "r1", nil); err != nil || len(r) != 0 {
		t.Fatalf("Ranks vacío = %v %v", r, err)
	}
}

func TestCloseOnce(t *testing.T) {
	s, _ := testStore(t)
	ctx := context.Background()
	_ = s.Schedule(ctx, "r1", sample("q", 30_000))
	if _, err := s.Close(ctx, "r1", "q"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cerrar sin lanzar = %v", err)
	}
	_, _, _ = s.Launch(ctx, "r1", "q", t0)
	if won, err := s.Close(ctx, "r1", "q"); err != nil || !won {
		t.Fatalf("Close = %v %v", won, err)
	}
	if won, err := s.Close(ctx, "r1", "q"); err != nil || won {
		t.Fatalf("segundo Close = %v %v, want false", won, err)
	}
	if _, err := s.Answer(ctx, "r1", "q", "u", "U", 1, t0+10); !errors.Is(err, ErrClosed) {
		t.Fatalf("responder cerrada = %v, want ErrClosed", err)
	}
	_, st, _, _ := s.Get(ctx, "r1", "q")
	if !st.Closed {
		t.Fatalf("estado = %+v, want closed", st)
	}
}

func TestStoreRedisDown(t *testing.T) {
	s, mr := testStore(t)
	ctx := context.Background()
	mr.Close()
	if err := s.Schedule(ctx, "r1", sample("q", 1)); err == nil {
		t.Error("Schedule")
	}
	if err := s.Delete(ctx, "r1", "q"); err == nil {
		t.Error("Delete")
	}
	if _, err := s.List(ctx, "r1"); err == nil {
		t.Error("List")
	}
	if _, _, _, err := s.Get(ctx, "r1", "q"); err == nil {
		t.Error("Get")
	}
	if _, _, err := s.Launch(ctx, "r1", "q", t0); err == nil {
		t.Error("Launch")
	}
	if _, err := s.Answer(ctx, "r1", "q", "u", "U", 0, t0); err == nil {
		t.Error("Answer")
	}
	if _, err := s.Close(ctx, "r1", "q"); err == nil {
		t.Error("Close")
	}
	if _, err := s.Top(ctx, "r1", "q", 10); err == nil {
		t.Error("Top")
	}
	if _, err := s.TotalTop(ctx, "r1", 10); err == nil {
		t.Error("TotalTop")
	}
	if _, _, err := s.Scores(ctx, "r1", "q", []string{"u"}); err == nil {
		t.Error("Scores")
	}
	if _, err := s.Ranks(ctx, "r1", []string{"u"}); err == nil {
		t.Error("Ranks")
	}
}
