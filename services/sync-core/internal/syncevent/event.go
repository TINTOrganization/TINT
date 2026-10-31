// Package syncevent modela los mensajes que viajan por /ws/sync.
package syncevent

import (
	"errors"
	"fmt"
	"math"
	"time"
)

// Type es el tipo de mensaje del canal de sincronización.
type Type string

const (
	// Comandos del Host (cliente → servidor y broadcast servidor → clientes).
	Play  Type = "PLAY"
	Pause Type = "PAUSE"
	Seek  Type = "SEEK"
	Rate  Type = "RATE" // cambia la velocidad de reproducción
	Load  Type = "LOAD" // carga otro vídeo (media_id) y pausa
	// Volume fija el volumen de la sala (volume ∈ [0, 1]).
	Volume Type = "VOLUME"
	// Quality fija la calidad de reproducción de la sala (ver Qualities).
	Quality Type = "QUALITY"

	// Latido servidor → cliente; el cliente responde con SYNC_CHECK.
	Heartbeat Type = "HEARTBEAT"
	SyncCheck Type = "SYNC_CHECK"

	// Mensajes servidor → cliente.
	State          Type = "STATE"
	SyncCorrection Type = "SYNC_CORRECTION"
	HostStatus     Type = "HOST_STATUS"
	Ack            Type = "ACK"
	Error          Type = "ERROR"
	// Control indica a cada cliente si puede emitir comandos (delegación).
	Control Type = "CONTROL"

	// Revoked solo viaja por el bus entre réplicas (lo publica identity-api):
	// cierra las conexiones del token revocado y nunca llega a los clientes.
	Revoked Type = "REVOKED"

	// Buffering (cliente → servidor) informa un stall del reproductor. Solo
	// alimenta la telemetría: sin ACK, sin broadcast y sin tocar el estado.
	Buffering Type = "BUFFERING"
)

// Límites de los comandos RATE, LOAD y VOLUME.
const (
	MinRate       = 0.25
	MaxRate       = 4.0
	MaxMediaIDLen = 128
	MinVolume     = 0.0
	MaxVolume     = 1.0
)

// Calidades aceptadas por QUALITY.
const (
	QualityAuto   = "auto"
	QualitySource = "source"
	Quality720p   = "720p"
	Quality360p   = "360p"
)

// MaxBufferingMs es la duración máxima aceptada en BUFFERING (2 min).
const (
	MaxBufferingMs = 120_000
)

// Códigos de error enviados en mensajes ERROR.
const (
	CodeForbidden   = "FORBIDDEN"
	CodeInvalid     = "INVALID"
	CodeRateLimited = "RATE_LIMITED"
	CodeInternal    = "INTERNAL"
)

// Event es el payload transmitido por el canal de sincronización. Los campos
// opcionales se omiten cuando no aplican al tipo de mensaje.
type Event struct {
	EventID    string    `json:"event_id"`
	Type       Type      `json:"type"`
	RoomID     string    `json:"room_id"`
	PositionMs int64     `json:"position_ms"`
	OccurredAt time.Time `json:"occurred_at"`
	ReceivedAt time.Time `json:"received_at"`
	// Version es el orden total del estado de la sala. En SYNC_CHECK
	// (opcional) es la última versión aplicada por el cliente: si es menor
	// que la del servidor, ese SYNC_CHECK no se corrige.
	Version int64 `json:"version"`

	// Ancla del Reloj Maestro (STATE y broadcasts de comandos).
	Status       string  `json:"status,omitempty"`
	Rate         float64 `json:"rate,omitempty"`
	UpdatedAtMs  int64   `json:"updated_at_ms,omitempty"`
	ServerTimeMs int64   `json:"server_time_ms,omitempty"`

	// Medición de RTT y drift.
	EchoServerTs int64  `json:"echo_server_ts,omitempty"`
	TargetMs     *int64 `json:"target_ms,omitempty"`
	Strategy     string `json:"strategy,omitempty"`
	DriftMs      int64  `json:"drift_ms,omitempty"`

	// Presencia del Host, confirmaciones y errores.
	Online     *bool  `json:"online,omitempty"`
	RefEventID string `json:"ref_event_id,omitempty"`
	Code       string `json:"code,omitempty"`
	Duplicate  bool   `json:"duplicate,omitempty"`

	// Vídeo actual de la sala (STATE y broadcasts de comandos).
	MediaID string `json:"media_id,omitempty"`
	// Volumen de la sala (VOLUME, STATE, broadcasts y SYNC_CORRECTION).
	// Puntero: 0 (silencio) es válido y debe viajar explícito.
	Volume *float64 `json:"volume,omitempty"`
	// Calidad de la sala (QUALITY, STATE, broadcasts y SYNC_CORRECTION).
	Quality string `json:"quality,omitempty"`
	// RTT suavizado de este cliente (HEARTBEAT).
	RTTMs int64 `json:"rtt_ms,omitempty"`
	// Delegación de control: can_control va al cliente; holder (sub del
	// delegado) solo viaja por el bus entre réplicas.
	CanControl *bool  `json:"can_control,omitempty"`
	Holder     string `json:"holder,omitempty"`
	// Token revocado (REVOKED, solo bus).
	JTI string `json:"jti,omitempty"`
	// Duración del stall en BUFFERING (solo cliente → servidor).
	DurationMs int64 `json:"duration_ms,omitempty"`
}

var (
	ErrMissingEventID   = errors.New("event_id es obligatorio")
	ErrMissingRoomID    = errors.New("room_id es obligatorio")
	ErrUnsupportedType  = errors.New("tipo de evento no soportado en /ws/sync")
	ErrMissingTimestamp = errors.New("occurred_at y received_at son obligatorios")
	ErrNegativePosition = errors.New("position_ms no puede ser negativo")
	ErrReceivedBefore   = errors.New("received_at no puede ser anterior a occurred_at")
	ErrInvalidRate      = errors.New("rate debe estar entre 0.25 y 4")
	ErrInvalidMedia     = errors.New("media_id es obligatorio y de máximo 128 caracteres")
	ErrInvalidVolume    = errors.New("volume es obligatorio y debe estar entre 0 y 1")
	ErrInvalidQuality   = errors.New("quality debe ser auto, source, 720p o 360p")
	ErrInvalidBuffering = errors.New("duration_ms debe estar entre 0 y 120000")
)

// Validate verifica que un evento completo (ya sellado por el servidor)
// cumpla el contrato del canal de sync.
func (e Event) Validate() error {
	if err := e.validateBase(); err != nil {
		return err
	}
	switch e.Type {
	case Play, Pause, Seek, Rate, Load, Volume, Quality, Heartbeat, SyncCheck, State, SyncCorrection, HostStatus, Ack, Error, Control, Revoked, Buffering:
	default:
		return fmt.Errorf("%w: %q", ErrUnsupportedType, e.Type)
	}
	if e.OccurredAt.IsZero() || e.ReceivedAt.IsZero() {
		return ErrMissingTimestamp
	}
	if e.ReceivedAt.Before(e.OccurredAt) {
		return ErrReceivedBefore
	}
	return nil
}

// ValidateInbound verifica un mensaje enviado por un cliente. No compara
// occurred_at con received_at: son relojes distintos y el del cliente puede
// estar adelantado; esa diferencia se audita, no se rechaza.
func (e Event) ValidateInbound() error {
	if err := e.validateBase(); err != nil {
		return err
	}
	switch e.Type {
	case Play, Pause, Seek, Rate, Load, Volume, Quality, SyncCheck, Buffering:
	default:
		return fmt.Errorf("%w: %q", ErrUnsupportedType, e.Type)
	}
	if e.OccurredAt.IsZero() {
		return ErrMissingTimestamp
	}
	return e.validateArgs()
}

// validateArgs valida los argumentos propios de RATE, LOAD, VOLUME, QUALITY y BUFFERING.
func (e Event) validateArgs() error {
	switch e.Type {
	case Rate:
		return ValidateRate(e.Rate)
	case Load:
		return ValidateMedia(e.MediaID)
	case Volume:
		if e.Volume == nil {
			return ErrInvalidVolume
		}
		return ValidateVolume(*e.Volume)
	case Quality:
		return ValidateQuality(e.Quality)
	case Buffering:
		if e.DurationMs < 0 || e.DurationMs > MaxBufferingMs {
			return ErrInvalidBuffering
		}
	}
	return nil
}

// ValidateQuality verifica que la calidad sea una de las aceptadas.
func ValidateQuality(q string) error {
	switch q {
	case QualityAuto, QualitySource, Quality720p, Quality360p:
		return nil
	}
	return ErrInvalidQuality
}

// ValidateVolume verifica que el volumen esté en [MinVolume, MaxVolume].
func ValidateVolume(v float64) error {
	if math.IsNaN(v) || v < MinVolume || v > MaxVolume {
		return ErrInvalidVolume
	}
	return nil
}

// ValidateRate verifica que la velocidad esté en [MinRate, MaxRate].
func ValidateRate(rate float64) error {
	if rate < MinRate || rate > MaxRate {
		return ErrInvalidRate
	}
	return nil
}

// ValidateMedia verifica el identificador de vídeo de LOAD.
func ValidateMedia(mediaID string) error {
	if mediaID == "" || len(mediaID) > MaxMediaIDLen {
		return ErrInvalidMedia
	}
	return nil
}

func (e Event) validateBase() error {
	if e.EventID == "" {
		return ErrMissingEventID
	}
	if e.RoomID == "" {
		return ErrMissingRoomID
	}
	if e.PositionMs < 0 {
		return ErrNegativePosition
	}
	return nil
}

// IsCommand indica si el evento es un comando de reproducción del Host.
func (e Event) IsCommand() bool {
	switch e.Type {
	case Play, Pause, Seek, Rate, Load, Volume, Quality:
		return true
	}
	return false
}

// Latency devuelve el tiempo de tránsito del evento.
func (e Event) Latency() time.Duration {
	return e.ReceivedAt.Sub(e.OccurredAt)
}

// StateKey devuelve la clave Redis del estado maestro de una sala.
func StateKey(roomID string) string {
	return "room:" + roomID + ":sync_state"
}

// EventKey devuelve la clave de idempotencia de un event_id.
func EventKey(roomID, eventID string) string {
	return "room:" + roomID + ":evt:" + eventID
}

// ChannelKey devuelve el canal Pub/Sub de la sala entre réplicas.
func ChannelKey(roomID string) string {
	return "room:" + roomID + ":sync"
}

// HostsKey devuelve el set de conexiones de host/co-host activas.
func HostsKey(roomID string) string {
	return "room:" + roomID + ":hosts_online"
}

// RevokedKey marca un jti revocado por identity-api.
func RevokedKey(jti string) string {
	return "token:revoked:" + jti
}

// MembersKey es el ZSET de participantes vivos (miembro = sub, score = último latido).
func MembersKey(roomID string) string {
	return "room:" + roomID + ":members"
}

// DelegateKey guarda el sub del participante con control delegado.
func DelegateKey(roomID string) string {
	return "room:" + roomID + ":delegate"
}

// HostStatusKey guarda el último HOST_STATUS publicado ("1"/"0") para
// publicar solo transiciones aunque varias réplicas lo evalúen.
func HostStatusKey(roomID string) string {
	return "room:" + roomID + ":host_online"
}

// HostlessSinceKey guarda desde cuándo (unix ms) la sala no tiene host.
func HostlessSinceKey(roomID string) string {
	return "room:" + roomID + ":hostless_since"
}

// Int64, Float64 y Bool crean punteros para campos opcionales donde el
// cero es válido.
func Int64(v int64) *int64       { return &v }
func Float64(v float64) *float64 { return &v }
func Bool(v bool) *bool          { return &v }
