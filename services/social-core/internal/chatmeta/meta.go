// Package chatmeta guarda en MongoDB los metadatos de cada intento de envío
// del chat (ADR 0025), nunca el texto ni el apodo.
//
// El envío no espera a MongoDB: Recorder deja el documento en una cola de
// Redis (chat:meta:outbox) y Writer lo escribe en segundo plano. Si MongoDB
// cae, el chat sigue funcionando y la cola se vacía cuando vuelve.
package chatmeta

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"
	"unicode/utf8"
)

// Status es el resultado del intento de envío.
type Status string

const (
	StatusAccepted Status = "accepted"
	StatusRejected Status = "rejected"
)

// Client son las familias de cliente derivadas del User-Agent (nunca el
// User-Agent completo).
type Client struct {
	Platform string `bson:"platform" json:"platform"`
	Browser  string `bson:"browser" json:"browser"`
	OS       string `bson:"os" json:"os"`
}

// Context es el estado de la sala cuando llegó el mensaje.
type Context struct {
	RoomKind       string // watch o live
	PositionMS     *int64 // watch: posición del vídeo
	StreamOffsetMS *int64 // live: minuto del directo
	SlowModeS      int
}

// Doc es el documento de chat_message_meta.
type Doc struct {
	ID             string    `bson:"_id" json:"_id"`
	RoomID         string    `bson:"room_id" json:"room_id"`
	Author         string    `bson:"author" json:"author"`
	Role           string    `bson:"role" json:"role"`
	IsGuest        bool      `bson:"is_guest" json:"is_guest"`
	Status         Status    `bson:"status" json:"status"`
	RejectReason   string    `bson:"reject_reason,omitempty" json:"reject_reason,omitempty"`
	Length         int       `bson:"length" json:"length"`
	Words          int       `bson:"words" json:"words"`
	Emojis         int       `bson:"emojis" json:"emojis"`
	HasLink        bool      `bson:"has_link" json:"has_link"`
	Spoiler        bool      `bson:"spoiler" json:"spoiler"`
	SentAt         time.Time `bson:"sent_at" json:"sent_at"`
	ReceivedAt     time.Time `bson:"received_at" json:"received_at"`
	LatencyMS      int64     `bson:"latency_ms" json:"latency_ms"`
	RoomKind       string    `bson:"room_kind" json:"room_kind"`
	PositionMS     *int64    `bson:"position_ms" json:"position_ms"`
	StreamOffsetMS *int64    `bson:"stream_offset_ms" json:"stream_offset_ms"`
	SlowModeS      int       `bson:"slow_mode_s" json:"slow_mode_s"`
	Client         Client    `bson:"client" json:"client"`
}

// Input es lo que el canal social sabe del intento. Text, Nick, Subject y
// UserAgent solo se usan para calcular el documento y no se guardan.
type Input struct {
	EventID      string
	RoomID       string
	Subject      string
	Nick         string
	Role         string
	IsGuest      bool
	Status       Status
	RejectReason string
	Text         string
	Spoiler      bool
	SentAt       time.Time
	ReceivedAt   time.Time
	Context      Context
	UserAgent    string
}

// Build calcula el documento. El autor es un seudónimo por sala.
func Build(pepper []byte, in Input) Doc {
	latency := in.ReceivedAt.Sub(in.SentAt).Milliseconds()
	if latency < 0 {
		latency = 0
	}
	return Doc{
		ID:             in.EventID,
		RoomID:         in.RoomID,
		Author:         Pseudonym(pepper, in.RoomID, in.Subject),
		Role:           in.Role,
		IsGuest:        in.IsGuest,
		Status:         in.Status,
		RejectReason:   in.RejectReason,
		Length:         Length(in.Text),
		Words:          Words(in.Text),
		Emojis:         Emojis(in.Text),
		HasLink:        HasLink(in.Text),
		Spoiler:        in.Spoiler,
		SentAt:         in.SentAt.UTC(),
		ReceivedAt:     in.ReceivedAt.UTC(),
		LatencyMS:      latency,
		RoomKind:       in.Context.RoomKind,
		PositionMS:     in.Context.PositionMS,
		StreamOffsetMS: in.Context.StreamOffsetMS,
		SlowModeS:      in.Context.SlowModeS,
		Client:         ParseUserAgent(in.UserAgent),
	}
}

// Pseudonym es HMAC-SHA256(pepper, roomID + ":" + value) en hex: estable en
// una sala, distinto entre salas e irreversible sin el secreto.
func Pseudonym(pepper []byte, roomID, value string) string {
	mac := hmac.New(sha256.New, pepper)
	_, _ = mac.Write([]byte(roomID + ":" + value))
	return hex.EncodeToString(mac.Sum(nil))
}

// Length cuenta runas, igual que message_length de analytics.
func Length(text string) int { return utf8.RuneCountInString(text) }

// Words cuenta palabras separadas por espacios.
func Words(text string) int { return len(strings.Fields(text)) }

// Emojis cuenta emojis de forma aproximada: pictogramas y símbolos; una
// bandera (dos indicadores regionales) cuenta uno; los modificadores de tono,
// el selector de variante y el ZWJ no cuentan.
func Emojis(text string) int {
	n, regional := 0, 0
	for _, r := range text {
		switch {
		case r >= 0x1F1E6 && r <= 0x1F1FF:
			regional++
			if regional%2 == 0 {
				n++
			}
		case r >= 0x1F3FB && r <= 0x1F3FF, r == 0xFE0F, r == 0x200D:
		case r >= 0x1F000 && r <= 0x1FAFF, r >= 0x2600 && r <= 0x27BF:
			n++
		}
	}
	return n
}

// HasLink indica si el texto contiene un enlace.
func HasLink(text string) bool {
	t := strings.ToLower(text)
	return strings.Contains(t, "http://") || strings.Contains(t, "https://") || strings.Contains(t, "www.")
}

// ParseUserAgent reduce el User-Agent a familias amplias.
func ParseUserAgent(ua string) Client {
	c := Client{Platform: "unknown", Browser: "other", OS: "other"}
	switch {
	case strings.HasPrefix(ua, "okhttp/"):
		return Client{Platform: "android", Browser: "other", OS: "android"}
	case strings.Contains(ua, "Mozilla/"):
		c.Platform = "web"
	default:
		return c
	}
	switch {
	case strings.Contains(ua, "Edg/"), strings.Contains(ua, "OPR/"):
		c.Browser = "other"
	case strings.Contains(ua, "Firefox/"), strings.Contains(ua, "FxiOS/"):
		c.Browser = "firefox"
	case strings.Contains(ua, "Chrome/"), strings.Contains(ua, "CriOS/"):
		c.Browser = "chrome"
	case strings.Contains(ua, "Safari/") && strings.Contains(ua, "Version/"):
		c.Browser = "safari"
	}
	switch {
	case strings.Contains(ua, "Android"):
		c.OS = "android"
	case strings.Contains(ua, "iPhone"), strings.Contains(ua, "iPad"), strings.Contains(ua, "iPod"):
		c.OS = "ios"
	case strings.Contains(ua, "Windows NT"):
		c.OS = "windows"
	case strings.Contains(ua, "Mac OS X"), strings.Contains(ua, "Macintosh"):
		c.OS = "macos"
	case strings.Contains(ua, "Linux"):
		c.OS = "linux"
	}
	return c
}
