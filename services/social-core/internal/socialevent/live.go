package socialevent

// Salas live y cierre de sala (ADR 0019, dominio-transmision §6.1).

// Tipos del bus de Redis (UPPER_SNAKE, como REVOKED).
const (
	// RoomClosed lo publica identity-api en room:{id}:sync al deshabilitar
	// la sala.
	RoomClosed = "ROOM_CLOSED"
	// StreamStarted y StreamEnded los publica stream-core en room:{id}:stream.
	StreamStarted = "STREAM_STARTED"
	StreamEnded   = "STREAM_ENDED"
)

// Valores de reason de ROOM_CLOSED y STREAM_ENDED.
const (
	ReasonHostEnded    = "host_ended"
	ReasonGraceExpired = "grace_expired"
)

// TypeTriviaLaunchNow abre ya una trivia programada (solo host/cohost).
const TypeTriviaLaunchNow Type = "trivia_launch_now"

// ValidCloseReason indica si reason es uno de los valores del contrato.
func ValidCloseReason(reason string) bool {
	return reason == ReasonHostEnded || reason == ReasonGraceExpired
}

// BusClosed es el ROOM_CLOSED leído de room:{id}:sync (solo los campos que
// se validan; occurred_at es informativo).
type BusClosed struct {
	Type    string `json:"type"`
	EventID string `json:"event_id"`
	RoomID  string `json:"room_id"`
	Reason  string `json:"reason"`
}

// Valid indica si el mensaje cumple §6.1 y es de roomID.
func (m BusClosed) Valid(roomID string) bool {
	return m.Type == RoomClosed && m.EventID != "" && m.RoomID == roomID && ValidCloseReason(m.Reason)
}

// StreamEvent es un STREAM_STARTED o STREAM_ENDED de room:{id}:stream.
// StartedAtMS solo viene en STREAM_STARTED; Reason, en STREAM_ENDED.
type StreamEvent struct {
	Type        string `json:"type"`
	EventID     string `json:"event_id"`
	RoomID      string `json:"room_id"`
	StartedAtMS int64  `json:"started_at_ms,omitempty"`
	Reason      string `json:"reason,omitempty"`
}

// Valid indica si el mensaje cumple §6.1 y es de roomID.
func (m StreamEvent) Valid(roomID string) bool {
	if m.EventID == "" || m.RoomID != roomID {
		return false
	}
	switch m.Type {
	case StreamStarted:
		return m.StartedAtMS > 0
	case StreamEnded:
		return ValidCloseReason(m.Reason)
	}
	return false
}

// TriviaLaunchNow abre de inmediato una trivia programada que aún no salió.
type TriviaLaunchNow struct {
	EventID  string `json:"event_id"`
	Type     Type   `json:"type"`
	RoomID   string `json:"room_id"`
	TriviaID string `json:"trivia_id"`
}

// Validate verifica un trivia_launch_now.
func (m TriviaLaunchNow) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypeTriviaLaunchNow {
		return ErrUnsupportedType
	}
	if m.TriviaID == "" {
		return ErrMissingTrivia
	}
	return nil
}
