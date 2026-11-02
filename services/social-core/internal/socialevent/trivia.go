package socialevent

import "errors"

// Trivias: el host o cohost programa preguntas en posiciones del vídeo; el
// servidor las lanza al llegar a esa posición, evalúa las respuestas y
// publica el resultado.
const (
	TypeTriviaSchedule      Type = "trivia_schedule"
	TypeTriviaUpdate        Type = "trivia_update"
	TypeTriviaDelete        Type = "trivia_delete"
	TypeTriviaList          Type = "trivia_list"
	TypeTriviaScheduleState Type = "trivia_schedule_state"
	TypeTriviaQuestion      Type = "trivia_question"
	TypeTriviaAnswer        Type = "trivia_answer"
	TypeTriviaAck           Type = "trivia_ack"
	TypeTriviaResult        Type = "trivia_result"
	TypeTriviaLeaderboard   Type = "trivia_leaderboard"
)

// Límites de producto de una trivia.
const (
	MinTriviaWindowS     = 10
	MaxTriviaWindowS     = 60
	DefaultTriviaWindowS = 20
	// MaxTriviaAtMS acota la posición programada (24 h de vídeo).
	MaxTriviaAtMS = 24 * 60 * 60 * 1000
	// TriviaTopN es el tamaño del top del resultado.
	TriviaTopN = 10
)

// Estados de una pregunta en trivia_schedule_state.
const (
	TriviaPending = "pending"
	TriviaOpen    = "open"
	TriviaClosed  = "closed"
)

var (
	ErrInvalidAtMS    = errors.New("at_ms debe estar entre 0 y 24 h")
	ErrInvalidCorrect = errors.New("correct debe ser el índice de una opción")
	ErrInvalidWindow  = errors.New("answer_window_s debe estar entre 10 y 60")
	ErrMissingTrivia  = errors.New("trivia_id es obligatorio")
)

// TriviaSchedule programa una pregunta en at_ms (posición del vídeo).
type TriviaSchedule struct {
	EventID       string   `json:"event_id"`
	Type          Type     `json:"type"`
	RoomID        string   `json:"room_id"`
	AtMS          *int64   `json:"at_ms"`
	Question      string   `json:"question"`
	Options       []string `json:"options"`
	Correct       *int     `json:"correct"`
	AnswerWindowS int      `json:"answer_window_s"`
}

// Validate verifica un trivia_schedule (con textos recortados).
func (m TriviaSchedule) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypeTriviaSchedule {
		return ErrUnsupportedType
	}
	if m.AtMS == nil || *m.AtMS < 0 || *m.AtMS > MaxTriviaAtMS {
		return ErrInvalidAtMS
	}
	question, options, window := m.Normalized()
	if !runesBetween(question, 1, MaxQuestionRunes) {
		return ErrInvalidQuestion
	}
	if len(options) < MinPollOptions || len(options) > MaxPollOptions {
		return ErrInvalidOptions
	}
	for _, o := range options {
		if !runesBetween(o, 1, MaxOptionRunes) {
			return ErrInvalidOptions
		}
	}
	if m.Correct == nil || *m.Correct < 0 || *m.Correct >= len(options) {
		return ErrInvalidCorrect
	}
	if window < MinTriviaWindowS || window > MaxTriviaWindowS {
		return ErrInvalidWindow
	}
	return nil
}

// Normalized devuelve pregunta y opciones recortadas y la ventana (0 = 20 s).
func (m TriviaSchedule) Normalized() (string, []string, int) {
	options := make([]string, len(m.Options))
	for i, o := range m.Options {
		options[i] = trim(o)
	}
	window := m.AnswerWindowS
	if window == 0 {
		window = DefaultTriviaWindowS
	}
	return trim(m.Question), options, window
}

// TriviaUpdate reemplaza una pregunta que aún no salió (misma forma que
// trivia_schedule más el trivia_id de la pregunta a editar).
type TriviaUpdate struct {
	EventID       string   `json:"event_id"`
	Type          Type     `json:"type"`
	RoomID        string   `json:"room_id"`
	TriviaID      string   `json:"trivia_id"`
	AtMS          *int64   `json:"at_ms"`
	Question      string   `json:"question"`
	Options       []string `json:"options"`
	Correct       *int     `json:"correct"`
	AnswerWindowS int      `json:"answer_window_s"`
}

// asSchedule reutiliza las reglas de trivia_schedule.
func (m TriviaUpdate) asSchedule() TriviaSchedule {
	return TriviaSchedule{
		EventID: m.EventID, Type: TypeTriviaSchedule, RoomID: m.RoomID, AtMS: m.AtMS,
		Question: m.Question, Options: m.Options, Correct: m.Correct, AnswerWindowS: m.AnswerWindowS,
	}
}

// Validate verifica un trivia_update.
func (m TriviaUpdate) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypeTriviaUpdate {
		return ErrUnsupportedType
	}
	if m.TriviaID == "" {
		return ErrMissingTrivia
	}
	return m.asSchedule().Validate()
}

// Normalized devuelve pregunta y opciones recortadas y la ventana (0 = 20 s).
func (m TriviaUpdate) Normalized() (string, []string, int) { return m.asSchedule().Normalized() }

// TriviaDelete borra una pregunta que aún no salió.
type TriviaDelete struct {
	EventID  string `json:"event_id"`
	Type     Type   `json:"type"`
	RoomID   string `json:"room_id"`
	TriviaID string `json:"trivia_id"`
}

// Validate verifica un trivia_delete.
func (m TriviaDelete) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypeTriviaDelete {
		return ErrUnsupportedType
	}
	if m.TriviaID == "" {
		return ErrMissingTrivia
	}
	return nil
}

// TriviaList pide las preguntas programadas.
type TriviaList struct {
	EventID string `json:"event_id"`
	Type    Type   `json:"type"`
	RoomID  string `json:"room_id"`
}

// Validate verifica un trivia_list.
func (m TriviaList) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypeTriviaList {
		return ErrUnsupportedType
	}
	return nil
}

// TriviaScheduled es una pregunta en trivia_schedule_state (con correct:
// solo la recibe el host o cohost).
type TriviaScheduled struct {
	TriviaID      string   `json:"trivia_id"`
	AtMS          int64    `json:"at_ms"`
	Question      string   `json:"question"`
	Options       []string `json:"options"`
	Correct       int      `json:"correct"`
	AnswerWindowS int      `json:"answer_window_s"`
	Status        string   `json:"status"`
}

// TriviaScheduleState es la lista de preguntas, dirigida solo al moderador
// que la pidió (o que acaba de entrar).
type TriviaScheduleState struct {
	Type       Type              `json:"type"`
	RoomID     string            `json:"room_id"`
	EventIDRef string            `json:"event_id_ref,omitempty"`
	Questions  []TriviaScheduled `json:"questions"`
}

// TriviaQuestion es la pregunta abierta (broadcast, sin la respuesta).
type TriviaQuestion struct {
	EventID    string   `json:"event_id"`
	Type       Type     `json:"type"`
	RoomID     string   `json:"room_id"`
	TriviaID   string   `json:"trivia_id"`
	Question   string   `json:"question"`
	Options    []string `json:"options"`
	OpensAtMS  int64    `json:"opens_at_ms"`
	ClosesAtMS int64    `json:"closes_at_ms"`
}

// TriviaAnswer es la respuesta de un participante (option = índice).
type TriviaAnswer struct {
	EventID  string `json:"event_id"`
	Type     Type   `json:"type"`
	RoomID   string `json:"room_id"`
	TriviaID string `json:"trivia_id"`
	Option   *int   `json:"option"`
}

// Validate verifica un trivia_answer (el rango de option lo comprueba el
// store contra la pregunta).
func (m TriviaAnswer) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypeTriviaAnswer {
		return ErrUnsupportedType
	}
	if m.TriviaID == "" {
		return ErrMissingTrivia
	}
	if m.Option == nil || *m.Option < 0 {
		return ErrInvalidOption
	}
	return nil
}

// TriviaAck confirma la respuesta solo a quien respondió.
type TriviaAck struct {
	Type       Type   `json:"type"`
	RoomID     string `json:"room_id"`
	EventIDRef string `json:"event_id_ref,omitempty"`
	TriviaID   string `json:"trivia_id"`
	Option     int    `json:"option"`
	Score      int    `json:"score"`
}

// TriviaScore es una fila del ranking.
type TriviaScore struct {
	UserID string `json:"user_id"`
	Nick   string `json:"nick"`
	Score  int    `json:"score"`
}

// TriviaResult cierra una pregunta. top = mejores respuestas de esta
// pregunta; leaderboard = ranking acumulado de la sala. my_score y
// my_total se agregan por cliente (cada réplica personaliza el mensaje
// para sus conexiones); entre réplicas viajan sin ellos.
type TriviaResult struct {
	EventID     string        `json:"event_id"`
	Type        Type          `json:"type"`
	RoomID      string        `json:"room_id"`
	TriviaID    string        `json:"trivia_id"`
	Correct     int           `json:"correct"`
	Top         []TriviaScore `json:"top"`
	Leaderboard []TriviaScore `json:"leaderboard"`
	MyScore     *int          `json:"my_score,omitempty"`
	MyTotal     *int          `json:"my_total,omitempty"`
	MyRank      *int          `json:"my_rank,omitempty"`
}

// TriviaLeaderboard es el ranking acumulado de la sala que recibe cada
// cliente al entrar (persiste en Redis, así que sobrevive a reinicios).
// my_rank y my_total se agregan por cliente; sin puntos no hay my_rank.
type TriviaLeaderboard struct {
	EventID     string        `json:"event_id"`
	Type        Type          `json:"type"`
	RoomID      string        `json:"room_id"`
	Leaderboard []TriviaScore `json:"leaderboard"`
	MyRank      *int          `json:"my_rank,omitempty"`
	MyTotal     *int          `json:"my_total,omitempty"`
}
