package trivia

// Almacén Redis de trivias (multirréplica). Claves:
//
//   - room:{id}:trivia:questions        Hash trivia_id → JSON de la pregunta
//     (at_ms, question, options, correct, answer_window_s). TTL 12 h.
//   - room:{id}:trivia:{tid}:state      Hash launched, opens_at_ms,
//     closes_at_ms (Launch, HSETNX) y closed (Close, HSETNX). TTL 12 h.
//   - room:{id}:trivia:{tid}:answers    Hash user_id → opción (HSETNX: una
//     respuesta por usuario). TTL 12 h.
//   - room:{id}:trivia:{tid}:leaderboard ZSET user_id → puntos + fracción de
//     desempate (la respuesta más temprana gana). TTL 12 h + 1 h.
//   - room:{id}:trivia:leaderboard      ZSET acumulado user_id → puntos.
//     TTL 12 h + 1 h.
//   - room:{id}:trivia:nicks            Hash user_id → último nick.
//     TTL 12 h + 1 h.
//
// Las decisiones (lanzar una vez, responder una vez y solo con la pregunta
// abierta, cerrar una vez) se toman en Lua; "ahora" lo pasa el llamador
// (reloj inyectado del servidor), nunca el de Redis ni el del cliente.

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// DefaultTTL es el periodo de gracia de la sala (REQ-07).
const DefaultTTL = 12 * time.Hour

// MaxQuestions acota las preguntas programadas por sala.
const MaxQuestions = 50

var (
	ErrNotFound        = errors.New("la trivia no existe o no está abierta")
	ErrClosed          = errors.New("la trivia está cerrada")
	ErrAlreadyAnswered = errors.New("ya respondiste esta trivia")
	ErrOption          = errors.New("opción fuera de rango")
	ErrLimit           = errors.New("demasiadas trivias programadas")
)

// Question es una pregunta programada en una posición del vídeo.
type Question struct {
	ID            string   `json:"id"`
	AtMS          int64    `json:"at_ms"`
	Question      string   `json:"question"`
	Options       []string `json:"options"`
	Correct       int      `json:"correct"`
	AnswerWindowS int      `json:"answer_window_s"`
}

// State es el ciclo de vida de una pregunta.
type State struct {
	Launched   bool
	OpensAtMS  int64
	ClosesAtMS int64
	Closed     bool // cerrada por el timer (Close)
}

// Scheduled es una pregunta con su estado (List).
type Scheduled struct {
	Question
	State State
}

// AnswerResult es la evaluación de una respuesta.
type AnswerResult struct {
	Score      int
	Correct    bool
	ResponseMS int64
}

// Entry es una fila del ranking.
type Entry struct {
	UserID string
	Nick   string
	Score  int
}

// Store es el almacén Redis de trivias.
type Store struct {
	client *redis.Client
	ttl    time.Duration
}

// NewStore crea el store; ttl ≤ 0 = DefaultTTL.
func NewStore(client *redis.Client, ttl time.Duration) *Store {
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	return &Store{client: client, ttl: ttl}
}

func prefix(roomID string) string { return "room:" + roomID + ":trivia:" }

// QuestionsKey es el hash de preguntas programadas.
func QuestionsKey(roomID string) string { return prefix(roomID) + "questions" }

// StateKey es el hash de estado de una pregunta.
func StateKey(roomID, triviaID string) string { return prefix(roomID) + triviaID + ":state" }

// AnswersKey es el hash de respuestas de una pregunta.
func AnswersKey(roomID, triviaID string) string { return prefix(roomID) + triviaID + ":answers" }

// TotalKey es el ranking acumulado de la sala.
func TotalKey(roomID string) string { return prefix(roomID) + "leaderboard" }

// NicksKey guarda el último nick de cada usuario que respondió.
func NicksKey(roomID string) string { return prefix(roomID) + "nicks" }

func secs(d time.Duration) int64 { return int64(d / time.Second) }

func (s *Store) boardTTL() time.Duration { return s.ttl + LeaderboardTTL }

// scheduleScript: 0 si se llegó al máximo (y la pregunta es nueva), 1 ok.
var scheduleScript = redis.NewScript(`
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then
  return 0
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
`)

// Schedule guarda (o reemplaza) una pregunta.
func (s *Store) Schedule(ctx context.Context, roomID string, q Question) error {
	raw, err := json.Marshal(q)
	if err != nil {
		return err
	}
	n, err := scheduleScript.Run(ctx, s.client, []string{QuestionsKey(roomID)},
		q.ID, string(raw), MaxQuestions, secs(s.ttl)).Int64()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrLimit
	}
	return nil
}

// updateScript: -1 no existe, -2 ya lanzada, 1 reemplazada.
var updateScript = redis.NewScript(`
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return -1 end
if redis.call('HEXISTS', KEYS[2], 'launched') == 1 then return -2 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return 1
`)

// Update reemplaza una pregunta que aún no salió (ErrNotFound si no existe,
// ErrClosed si ya se lanzó): la nueva versión es la que se dispara.
func (s *Store) Update(ctx context.Context, roomID string, q Question) error {
	raw, err := json.Marshal(q)
	if err != nil {
		return err
	}
	n, err := updateScript.Run(ctx, s.client,
		[]string{QuestionsKey(roomID), StateKey(roomID, q.ID)}, q.ID, string(raw), secs(s.ttl)).Int64()
	if err != nil {
		return err
	}
	switch n {
	case -1:
		return ErrNotFound
	case -2:
		return ErrClosed
	}
	return nil
}

// deleteScript: -1 no existe, -2 ya lanzada, 1 borrada.
var deleteScript = redis.NewScript(`
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return -1 end
if redis.call('HEXISTS', KEYS[2], 'launched') == 1 then return -2 end
redis.call('HDEL', KEYS[1], ARGV[1])
return 1
`)

// Delete borra una pregunta que aún no salió (ErrClosed si ya se lanzó).
func (s *Store) Delete(ctx context.Context, roomID, triviaID string) error {
	n, err := deleteScript.Run(ctx, s.client,
		[]string{QuestionsKey(roomID), StateKey(roomID, triviaID)}, triviaID).Int64()
	if err != nil {
		return err
	}
	switch n {
	case -1:
		return ErrNotFound
	case -2:
		return ErrClosed
	}
	return nil
}

func parseState(h map[string]string) State {
	opens, _ := strconv.ParseInt(h["opens_at_ms"], 10, 64)
	closes, _ := strconv.ParseInt(h["closes_at_ms"], 10, 64)
	return State{Launched: h["launched"] != "", OpensAtMS: opens, ClosesAtMS: closes, Closed: h["closed"] != ""}
}

// List devuelve las preguntas de la sala ordenadas por at_ms (y id).
func (s *Store) List(ctx context.Context, roomID string) ([]Scheduled, error) {
	h, err := s.client.HGetAll(ctx, QuestionsKey(roomID)).Result()
	if err != nil {
		return nil, err
	}
	out := make([]Scheduled, 0, len(h))
	for _, raw := range h {
		var q Question
		if json.Unmarshal([]byte(raw), &q) != nil {
			continue
		}
		out = append(out, Scheduled{Question: q})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].AtMS != out[j].AtMS {
			return out[i].AtMS < out[j].AtMS
		}
		return out[i].ID < out[j].ID
	})
	if len(out) == 0 {
		return out, nil
	}
	pipe := s.client.Pipeline()
	states := make([]*redis.MapStringStringCmd, len(out))
	for i := range out {
		states[i] = pipe.HGetAll(ctx, StateKey(roomID, out[i].ID))
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, err
	}
	for i := range out {
		out[i].State = parseState(states[i].Val())
	}
	return out, nil
}

// Get devuelve una pregunta con su estado (ok=false si no existe).
func (s *Store) Get(ctx context.Context, roomID, triviaID string) (Question, State, bool, error) {
	pipe := s.client.Pipeline()
	qc := pipe.HGet(ctx, QuestionsKey(roomID), triviaID)
	sc := pipe.HGetAll(ctx, StateKey(roomID, triviaID))
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return Question{}, State{}, false, err
	}
	raw := qc.Val()
	if raw == "" {
		return Question{}, State{}, false, nil
	}
	var q Question
	if err := json.Unmarshal([]byte(raw), &q); err != nil {
		return Question{}, State{}, false, err
	}
	return q, parseState(sc.Val()), true, nil
}

// launchScript: -1 no existe; 0 ya estaba lanzada; 1 la lancé yo.
var launchScript = redis.NewScript(`
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 then return -1 end
if redis.call('HSETNX', KEYS[2], 'launched', '1') == 0 then return 0 end
redis.call('HSET', KEYS[2], 'opens_at_ms', ARGV[2], 'closes_at_ms', ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[4])
return 1
`)

// Launch abre la pregunta en nowMS (una sola réplica gana). Devuelve el
// estado vigente y won = true si esta llamada la lanzó.
func (s *Store) Launch(ctx context.Context, roomID, triviaID string, nowMS int64) (State, bool, error) {
	q, _, ok, err := s.Get(ctx, roomID, triviaID)
	if err != nil {
		return State{}, false, err
	}
	if !ok {
		return State{}, false, ErrNotFound
	}
	closes := nowMS + int64(q.AnswerWindowS)*1000
	n, err := launchScript.Run(ctx, s.client, []string{QuestionsKey(roomID), StateKey(roomID, triviaID)},
		triviaID, nowMS, closes, secs(s.ttl)).Int64()
	if err != nil {
		return State{}, false, err
	}
	if n == -1 {
		return State{}, false, ErrNotFound
	}
	st, err := s.client.HGetAll(ctx, StateKey(roomID, triviaID)).Result()
	if err != nil {
		return State{}, false, err
	}
	return parseState(st), n == 1, nil
}

// answerScript: -1 no lanzada, -2 cerrada o vencida, -3 ya respondió, 1 ok.
var answerScript = redis.NewScript(`
local st = redis.call('HMGET', KEYS[1], 'launched', 'closed', 'closes_at_ms')
if not st[1] then return -1 end
if st[2] or tonumber(st[3]) <= tonumber(ARGV[3]) then return -2 end
if redis.call('HSETNX', KEYS[2], ARGV[1], ARGV[2]) == 0 then return -3 end
redis.call('EXPIRE', KEYS[2], ARGV[7])
redis.call('ZADD', KEYS[3], ARGV[5], ARGV[1])
redis.call('ZINCRBY', KEYS[4], ARGV[4], ARGV[1])
redis.call('HSET', KEYS[5], ARGV[1], ARGV[6])
for i = 3, 5 do redis.call('EXPIRE', KEYS[i], ARGV[8]) end
return 1
`)

// Answer registra la única respuesta de userID y devuelve su puntaje
// (Score con elapsed = nowMS − opens_at_ms, ambos del reloj del servidor).
func (s *Store) Answer(ctx context.Context, roomID, triviaID, userID, nick string, option int, nowMS int64) (AnswerResult, error) {
	q, st, ok, err := s.Get(ctx, roomID, triviaID)
	if err != nil {
		return AnswerResult{}, err
	}
	if !ok || !st.Launched {
		return AnswerResult{}, ErrNotFound
	}
	if st.Closed || nowMS >= st.ClosesAtMS {
		return AnswerResult{}, ErrClosed
	}
	if option < 0 || option >= len(q.Options) {
		return AnswerResult{}, ErrOption
	}
	elapsed := nowMS - st.OpensAtMS
	if elapsed < 0 {
		elapsed = 0
	}
	res := AnswerResult{Correct: option == q.Correct, ResponseMS: elapsed}
	res.Score = Score(res.Correct, time.Duration(elapsed)*time.Millisecond)
	// Desempate: fracción < 1 mayor cuanto antes se respondió.
	window := st.ClosesAtMS - st.OpensAtMS
	if elapsed > window {
		elapsed = window
	}
	ranked := float64(res.Score) + float64(window-elapsed+1)/float64(window+2)
	keys := []string{StateKey(roomID, triviaID), AnswersKey(roomID, triviaID),
		LeaderboardKey(roomID, triviaID), TotalKey(roomID), NicksKey(roomID)}
	n, err := answerScript.Run(ctx, s.client, keys, userID, option, nowMS, res.Score,
		strconv.FormatFloat(ranked, 'f', -1, 64), nick, secs(s.ttl), secs(s.boardTTL())).Int64()
	if err != nil {
		return AnswerResult{}, err
	}
	switch n {
	case -1:
		return AnswerResult{}, ErrNotFound
	case -2:
		return AnswerResult{}, ErrClosed
	case -3:
		return AnswerResult{}, ErrAlreadyAnswered
	}
	return res, nil
}

// closeScript: -1 no lanzada; si no, el resultado de HSETNX (1 = la cerré).
var closeScript = redis.NewScript(`
if redis.call('HEXISTS', KEYS[1], 'launched') == 0 then return -1 end
return redis.call('HSETNX', KEYS[1], 'closed', '1')
`)

// Close cierra la pregunta: true = esta llamada la cerró (idempotente
// entre réplicas).
func (s *Store) Close(ctx context.Context, roomID, triviaID string) (bool, error) {
	n, err := closeScript.Run(ctx, s.client, []string{StateKey(roomID, triviaID)}).Int64()
	if err != nil {
		return false, err
	}
	if n == -1 {
		return false, ErrNotFound
	}
	return n == 1, nil
}

func (s *Store) top(ctx context.Context, roomID, key string, n int) ([]Entry, error) {
	zs, err := s.client.ZRevRangeWithScores(ctx, key, 0, int64(n-1)).Result()
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(zs))
	if len(zs) == 0 {
		return out, nil
	}
	ids := make([]string, len(zs))
	for i, z := range zs {
		ids[i], _ = z.Member.(string)
	}
	nicks, err := s.client.HMGet(ctx, NicksKey(roomID), ids...).Result()
	if err != nil {
		return nil, err
	}
	for i, z := range zs {
		nick, _ := nicks[i].(string)
		out = append(out, Entry{UserID: ids[i], Nick: nick, Score: int(math.Floor(z.Score))})
	}
	return out, nil
}

// Top devuelve las n mejores respuestas de una pregunta (desempate: la más
// temprana).
func (s *Store) Top(ctx context.Context, roomID, triviaID string, n int) ([]Entry, error) {
	return s.top(ctx, roomID, LeaderboardKey(roomID, triviaID), n)
}

// TotalTop devuelve los n mejores del ranking acumulado de la sala.
func (s *Store) TotalTop(ctx context.Context, roomID string, n int) ([]Entry, error) {
	return s.top(ctx, roomID, TotalKey(roomID), n)
}

// Scores devuelve, para cada usuario, sus puntos en la pregunta y en el
// acumulado (0 si no respondió).
func (s *Store) Scores(ctx context.Context, roomID, triviaID string, users []string) (map[string]int, map[string]int, error) {
	scores, totals := make(map[string]int, len(users)), make(map[string]int, len(users))
	if len(users) == 0 {
		return scores, totals, nil
	}
	pipe := s.client.Pipeline()
	qs := make([]*redis.FloatCmd, len(users))
	ts := make([]*redis.FloatCmd, len(users))
	for i, u := range users {
		qs[i] = pipe.ZScore(ctx, LeaderboardKey(roomID, triviaID), u)
		ts[i] = pipe.ZScore(ctx, TotalKey(roomID), u)
	}
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, nil, err
	}
	for i, u := range users {
		scores[u] = int(math.Floor(qs[i].Val()))
		totals[u] = int(math.Floor(ts[i].Val()))
	}
	return scores, totals, nil
}
