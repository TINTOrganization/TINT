// Package socialevent modela el contrato del Canal Social (/ws/social) para chat.
package socialevent

import (
	"errors"
	"time"
	"unicode/utf8"
)

// Tipos de mensaje que viajan por /ws/social (solo chat en este alcance).
type Type string

const (
	TypeChatSend     Type = "chat_send"
	TypeChatMessage  Type = "chat_message"
	TypeHistory      Type = "history"
	TypeNotice       Type = "notice"
	TypeReactionSend Type = "reaction_send"
	TypeReaction     Type = "reaction"
	TypeError        Type = "error"
)

// ReactionEmojis es el set de reacciones: REQ-20 del Dominio Social
// (risa, susto, sorpresa, aplauso, corazón) más 😢 (tristeza) por producto.
var ReactionEmojis = []string{"👏", "😂", "😮", "😱", "❤️", "😢"}

// ValidEmoji indica si el emoji pertenece al set del documento.
func ValidEmoji(e string) bool {
	for _, ok := range ReactionEmojis {
		if e == ok {
			return true
		}
	}
	return false
}

// TrimmedEmoji recorta espacios del emoji recibido (sin alterar el resto,
// incluidos los selectores de variación como el de ❤️).
func TrimmedEmoji(e string) string {
	return trim(e)
}

// MaxTextRunes es el largo máximo de un mensaje de chat (regla de producto).
const MaxTextRunes = 280

// HistoryLimit es el historial corto por sala.
const HistoryLimit = 50

var (
	ErrMissingEventID   = errors.New("event_id es obligatorio")
	ErrUnsupportedType  = errors.New("tipo de evento no soportado en /ws/social")
	ErrMissingRoom      = errors.New("room_id es obligatorio")
	ErrMissingUser      = errors.New("user_id es obligatorio")
	ErrMissingNick      = errors.New("nick es obligatorio")
	ErrInvalidKind      = errors.New("kind debe ser joined o left")
	ErrInvalidEmoji     = errors.New("emoji fuera del set permitido")
	ErrNegativePosition = errors.New("position_ms no puede ser negativa")
	ErrEmptyText        = errors.New("text no puede estar vacío")
	ErrTextTooLong      = errors.New("text supera los 280 caracteres")
	ErrMissingTimestamp = errors.New("occurred_at es obligatorio")
)

// ChatSend es el mensaje que envía el cliente.
type ChatSend struct {
	EventID string `json:"event_id"`
	Type    Type   `json:"type"`
	RoomID  string `json:"room_id"`
	Text    string `json:"text"`
	// Spoiler marca el mensaje para que la web lo difumine (opcional).
	Spoiler    bool      `json:"spoiler,omitempty"`
	OccurredAt time.Time `json:"occurred_at"`
}

// Validate verifica el contrato de un chat_send.
func (m ChatSend) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypeChatSend {
		return ErrUnsupportedType
	}
	if m.RoomID == "" {
		return ErrMissingRoom
	}
	if length := utf8.RuneCountInString(trim(m.Text)); length == 0 {
		return ErrEmptyText
	} else if length > MaxTextRunes {
		return ErrTextTooLong
	}
	if m.OccurredAt.IsZero() {
		return ErrMissingTimestamp
	}
	return nil
}

// ClampOccurred recorta un occurred_at del cliente que viene del futuro
// respecto al reloj del servidor. Los relojes de cliente y servidor difieren
// (igual que en sync-core): nunca se rechaza por eso.
func ClampOccurred(occurred, received time.Time) time.Time {
	if occurred.After(received) {
		return received
	}
	return occurred
}

// ChatMessage es el broadcast del servidor.
type ChatMessage struct {
	EventID string `json:"event_id"`
	Type    Type   `json:"type"`
	RoomID  string `json:"room_id"`
	UserID  string `json:"user_id"`
	Nick    string `json:"nick"`
	Text    string `json:"text"`
	// Spoiler viaja tal cual y se persiste en el historial (omitido = false).
	Spoiler    bool      `json:"spoiler,omitempty"`
	OccurredAt time.Time `json:"occurred_at"`
	ReceivedAt time.Time `json:"received_at"`
}

// Validate verifica un chat_message.
func (m ChatMessage) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypeChatMessage {
		return ErrUnsupportedType
	}
	if m.RoomID == "" {
		return ErrMissingRoom
	}
	if length := utf8.RuneCountInString(trim(m.Text)); length == 0 {
		return ErrEmptyText
	} else if length > MaxTextRunes {
		return ErrTextTooLong
	}
	if m.OccurredAt.IsZero() || m.ReceivedAt.IsZero() {
		return ErrMissingTimestamp
	}
	return nil
}

// NoticeKind distingue entradas y salidas de la sala.
type NoticeKind string

const (
	NoticeJoined NoticeKind = "joined"
	NoticeLeft   NoticeKind = "left"
)

// Notice es el aviso de presencia que emite el servidor (solo en vivo,
// no se guarda en el historial).
type Notice struct {
	EventID    string     `json:"event_id"`
	Type       Type       `json:"type"`
	RoomID     string     `json:"room_id"`
	UserID     string     `json:"user_id"`
	Nick       string     `json:"nick"`
	Kind       NoticeKind `json:"kind"`
	Text       string     `json:"text"`
	OccurredAt time.Time  `json:"occurred_at"`
}

// Validate verifica un notice de presencia.
func (m Notice) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypeNotice {
		return ErrUnsupportedType
	}
	if m.RoomID == "" {
		return ErrMissingRoom
	}
	if m.UserID == "" {
		return ErrMissingUser
	}
	if trim(m.Nick) == "" {
		return ErrMissingNick
	}
	if m.Kind != NoticeJoined && m.Kind != NoticeLeft {
		return ErrInvalidKind
	}
	if m.OccurredAt.IsZero() {
		return ErrMissingTimestamp
	}
	return nil
}

// ReactionSend es la reacción que envía el cliente.
type ReactionSend struct {
	EventID    string    `json:"event_id"`
	Type       Type      `json:"type"`
	RoomID     string    `json:"room_id"`
	Emoji      string    `json:"emoji"`
	PositionMS int64     `json:"position_ms"`
	OccurredAt time.Time `json:"occurred_at"`
}

// Validate verifica el contrato de un reaction_send.
func (m ReactionSend) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypeReactionSend {
		return ErrUnsupportedType
	}
	if m.RoomID == "" {
		return ErrMissingRoom
	}
	if trim(m.Emoji) == "" || !ValidEmoji(trim(m.Emoji)) {
		return ErrInvalidEmoji
	}
	if m.PositionMS < 0 {
		return ErrNegativePosition
	}
	if m.OccurredAt.IsZero() {
		return ErrMissingTimestamp
	}
	return nil
}

// Reaction es el broadcast del servidor para una reacción.
type Reaction struct {
	EventID    string    `json:"event_id"`
	Type       Type      `json:"type"`
	RoomID     string    `json:"room_id"`
	UserID     string    `json:"user_id"`
	Nick       string    `json:"nick"`
	Emoji      string    `json:"emoji"`
	PositionMS int64     `json:"position_ms"`
	OccurredAt time.Time `json:"occurred_at"`
	ReceivedAt time.Time `json:"received_at"`
}

// Validate verifica un reaction broadcast.
func (m Reaction) Validate() error {
	if m.EventID == "" {
		return ErrMissingEventID
	}
	if m.Type != TypeReaction {
		return ErrUnsupportedType
	}
	if m.RoomID == "" {
		return ErrMissingRoom
	}
	if m.UserID == "" {
		return ErrMissingUser
	}
	if trim(m.Emoji) == "" || !ValidEmoji(trim(m.Emoji)) {
		return ErrInvalidEmoji
	}
	if m.PositionMS < 0 {
		return ErrNegativePosition
	}
	if m.OccurredAt.IsZero() || m.ReceivedAt.IsZero() {
		return ErrMissingTimestamp
	}
	return nil
}

// HistoryEnvelope es el historial corto enviado al hacer join.
type HistoryEnvelope struct {
	Type     Type          `json:"type"`
	RoomID   string        `json:"room_id"`
	Messages []ChatMessage `json:"messages"`
}

// ErrorEnvelope es un error dirigido a un cliente.
type ErrorEnvelope struct {
	Type       Type   `json:"type"`
	Code       string `json:"code"`
	EventIDRef string `json:"event_id_ref,omitempty"`
	// RetryAfterMS informa los ms que faltan para reintentar un límite.
	RetryAfterMS int64 `json:"retry_after_ms,omitempty"`
}

func trim(s string) string {
	// Trim mínimo sin importar unicode/strings para mensajes con espacios.
	start := 0
	for start < len(s) && (s[start] == ' ' || s[start] == '\n' || s[start] == '\r' || s[start] == '\t') {
		start++
	}
	end := len(s)
	for end > start && (s[end-1] == ' ' || s[end-1] == '\n' || s[end-1] == '\r' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}
