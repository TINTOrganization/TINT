package syncevent

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"time"
)

func validEvent() Event {
	now := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	return Event{
		EventID:    "6f1c2a8e-8a4e-4d0a-9f5b-1c2d3e4f5a6b",
		Type:       Play,
		RoomID:     "room-1",
		PositionMs: 1500,
		OccurredAt: now,
		ReceivedAt: now.Add(40 * time.Millisecond),
	}
}

func TestValidate(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Event)
		want   error
	}{
		{"valid play", func(*Event) {}, nil},
		{"valid pause", func(e *Event) { e.Type = Pause }, nil},
		{"valid seek", func(e *Event) { e.Type = Seek }, nil},
		{"valid heartbeat", func(e *Event) { e.Type = Heartbeat }, nil},
		{"valid state", func(e *Event) { e.Type = State }, nil},
		{"valid sync check", func(e *Event) { e.Type = SyncCheck }, nil},
		{"valid correction", func(e *Event) { e.Type = SyncCorrection }, nil},
		{"valid host status", func(e *Event) { e.Type = HostStatus }, nil},
		{"valid ack", func(e *Event) { e.Type = Ack }, nil},
		{"valid error", func(e *Event) { e.Type = Error }, nil},
		{"missing id", func(e *Event) { e.EventID = "" }, ErrMissingEventID},
		{"missing room", func(e *Event) { e.RoomID = "" }, ErrMissingRoomID},
		{"chat not allowed", func(e *Event) { e.Type = "CHAT" }, ErrUnsupportedType},
		{"missing occurred_at", func(e *Event) { e.OccurredAt = time.Time{} }, ErrMissingTimestamp},
		{"missing received_at", func(e *Event) { e.ReceivedAt = time.Time{} }, ErrMissingTimestamp},
		{"received before occurred", func(e *Event) { e.ReceivedAt = e.OccurredAt.Add(-time.Second) }, ErrReceivedBefore},
		{"negative position", func(e *Event) { e.PositionMs = -1 }, ErrNegativePosition},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := validEvent()
			tt.mutate(&e)
			if err := e.Validate(); !errors.Is(err, tt.want) {
				t.Errorf("Validate() = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestLatency(t *testing.T) {
	if got := validEvent().Latency(); got != 40*time.Millisecond {
		t.Errorf("Latency() = %v, want 40ms", got)
	}
}

func TestStateKey(t *testing.T) {
	if got := StateKey("abc"); got != "room:abc:sync_state" {
		t.Errorf("StateKey() = %q", got)
	}
}

func TestValidateInbound(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Event)
		want   error
	}{
		{"play", func(*Event) {}, nil},
		{"sync check", func(e *Event) { e.Type = SyncCheck }, nil},
		// El reloj del cliente puede ir adelantado: no se comparan relojes distintos.
		{"cliente con reloj adelantado", func(e *Event) { e.ReceivedAt = e.OccurredAt.Add(-time.Hour) }, nil},
		{"received_at aún no asignado", func(e *Event) { e.ReceivedAt = time.Time{} }, nil},
		{"el cliente no emite STATE", func(e *Event) { e.Type = State }, ErrUnsupportedType},
		{"el cliente no emite HEARTBEAT", func(e *Event) { e.Type = Heartbeat }, ErrUnsupportedType},
		{"chat", func(e *Event) { e.Type = "CHAT" }, ErrUnsupportedType},
		{"missing id", func(e *Event) { e.EventID = "" }, ErrMissingEventID},
		{"missing room", func(e *Event) { e.RoomID = "" }, ErrMissingRoomID},
		{"missing occurred_at", func(e *Event) { e.OccurredAt = time.Time{} }, ErrMissingTimestamp},
		{"negative position", func(e *Event) { e.PositionMs = -5 }, ErrNegativePosition},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := validEvent()
			tt.mutate(&e)
			if err := e.ValidateInbound(); !errors.Is(err, tt.want) {
				t.Errorf("ValidateInbound() = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestIsCommand(t *testing.T) {
	for _, typ := range []Type{Play, Pause, Seek} {
		if !(Event{Type: typ}).IsCommand() {
			t.Errorf("%s debe ser comando", typ)
		}
	}
	for _, typ := range []Type{SyncCheck, Heartbeat, State, Ack} {
		if (Event{Type: typ}).IsCommand() {
			t.Errorf("%s no debe ser comando", typ)
		}
	}
}

func TestKeys(t *testing.T) {
	if got := EventKey("abc", "e1"); got != "room:abc:evt:e1" {
		t.Errorf("EventKey() = %q", got)
	}
	if got := ChannelKey("abc"); got != "room:abc:sync" {
		t.Errorf("ChannelKey() = %q", got)
	}
	if got := HostsKey("abc"); got != "room:abc:hosts_online" {
		t.Errorf("HostsKey() = %q", got)
	}
}

func TestJSONContract(t *testing.T) {
	e := validEvent()
	e.Type = SyncCorrection
	e.TargetMs = Int64(0) // seek al inicio: el 0 debe viajar explícito
	e.Strategy = "seek"
	e.DriftMs = -900
	raw, err := json.Marshal(e)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"event_id", "type", "room_id", "position_ms", "occurred_at", "received_at", "version", "target_ms", "strategy", "drift_ms"} {
		if _, ok := m[k]; !ok {
			t.Errorf("falta el campo %q en %s", k, raw)
		}
	}
	for _, k := range []string{"online", "code", "ref_event_id", "echo_server_ts", "duplicate"} {
		if _, ok := m[k]; ok {
			t.Errorf("el campo vacío %q no debe serializarse: %s", k, raw)
		}
	}
	if Bool(true) == nil || !*Bool(true) {
		t.Error("Bool helper")
	}
}

func TestValidateInboundV2(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Event)
		want   error
	}{
		{"rate válida", func(e *Event) { e.Type, e.Rate = Rate, 1.5 }, nil},
		{"rate mínima", func(e *Event) { e.Type, e.Rate = Rate, MinRate }, nil},
		{"rate máxima", func(e *Event) { e.Type, e.Rate = Rate, MaxRate }, nil},
		{"rate cero", func(e *Event) { e.Type, e.Rate = Rate, 0 }, ErrInvalidRate},
		{"rate demasiado alta", func(e *Event) { e.Type, e.Rate = Rate, 4.01 }, ErrInvalidRate},
		{"rate demasiado baja", func(e *Event) { e.Type, e.Rate = Rate, 0.2 }, ErrInvalidRate},
		{"load válido", func(e *Event) { e.Type, e.MediaID = Load, "media-1" }, nil},
		{"load sin media", func(e *Event) { e.Type = Load }, ErrInvalidMedia},
		{"load con media enorme", func(e *Event) { e.Type, e.MediaID = Load, strings.Repeat("m", MaxMediaIDLen+1) }, ErrInvalidMedia},
		{"el cliente no emite CONTROL", func(e *Event) { e.Type = Control }, ErrUnsupportedType},
		{"el cliente no emite REVOKED", func(e *Event) { e.Type = Revoked }, ErrUnsupportedType},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := validEvent()
			tt.mutate(&e)
			if err := e.ValidateInbound(); !errors.Is(err, tt.want) {
				t.Errorf("ValidateInbound() = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestValidateV2Types(t *testing.T) {
	for _, typ := range []Type{Rate, Load, Control, Revoked} {
		e := validEvent()
		e.Type = typ
		if err := e.Validate(); err != nil {
			t.Errorf("%s: %v", typ, err)
		}
	}
}

func TestIsCommandV2(t *testing.T) {
	for _, typ := range []Type{Rate, Load} {
		if !(Event{Type: typ}).IsCommand() {
			t.Errorf("%s debe ser comando", typ)
		}
	}
	for _, typ := range []Type{Control, Revoked} {
		if (Event{Type: typ}).IsCommand() {
			t.Errorf("%s no debe ser comando", typ)
		}
	}
}

func TestKeysV2(t *testing.T) {
	cases := map[string]string{
		RevokedKey("j1"):        "token:revoked:j1",
		MembersKey("abc"):       "room:abc:members",
		DelegateKey("abc"):      "room:abc:delegate",
		HostStatusKey("abc"):    "room:abc:host_online",
		HostlessSinceKey("abc"): "room:abc:hostless_since",
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("clave = %q, want %q", got, want)
		}
	}
}

func TestJSONContractV2(t *testing.T) {
	e := validEvent()
	e.Type = Control
	e.CanControl = Bool(false) // false debe viajar explícito
	raw, _ := json.Marshal(e)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	if v, ok := m["can_control"]; !ok || v != false {
		t.Errorf("can_control=false debe serializarse: %s", raw)
	}
	for _, k := range []string{"media_id", "rtt_ms", "holder", "jti"} {
		if _, ok := m[k]; ok {
			t.Errorf("el campo vacío %q no debe serializarse: %s", k, raw)
		}
	}
	e = validEvent()
	e.MediaID, e.RTTMs, e.Holder, e.JTI = "m1", 42, "guest:1", "j1"
	raw, _ = json.Marshal(e)
	m = nil
	_ = json.Unmarshal(raw, &m)
	for _, k := range []string{"media_id", "rtt_ms", "holder", "jti"} {
		if _, ok := m[k]; !ok {
			t.Errorf("falta %q en %s", k, raw)
		}
	}
}

func TestValidateInboundVolume(t *testing.T) {
	tests := []struct {
		name   string
		volume *float64
		want   error
	}{
		{"volumen medio", Float64(0.5), nil},
		{"silencio (0) es válido", Float64(0), nil},
		{"volumen máximo", Float64(1), nil},
		{"sin volumen", nil, ErrInvalidVolume},
		{"negativo", Float64(-0.01), ErrInvalidVolume},
		{"mayor que 1", Float64(1.01), ErrInvalidVolume},
		{"NaN", Float64(math.NaN()), ErrInvalidVolume},
		{"infinito", Float64(math.Inf(1)), ErrInvalidVolume},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := validEvent()
			e.Type, e.Volume = Volume, tt.volume
			if err := e.ValidateInbound(); !errors.Is(err, tt.want) {
				t.Errorf("ValidateInbound() = %v, want %v", err, tt.want)
			}
		})
	}
	e := validEvent()
	e.Type = Volume
	if err := e.Validate(); err != nil {
		t.Errorf("VOLUME debe ser un tipo válido: %v", err)
	}
	if !(Event{Type: Volume}).IsCommand() {
		t.Error("VOLUME debe ser comando")
	}
}

// volume=0 (silencio) debe viajar explícito; sin volumen el campo se omite.
func TestJSONVolume(t *testing.T) {
	e := validEvent()
	raw, _ := json.Marshal(e)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	if _, ok := m["volume"]; ok {
		t.Errorf("volume ausente no debe serializarse: %s", raw)
	}
	e.Volume = Float64(0)
	raw, _ = json.Marshal(e)
	m = nil
	_ = json.Unmarshal(raw, &m)
	if v, ok := m["volume"]; !ok || v != 0.0 {
		t.Errorf("volume=0 debe serializarse: %s", raw)
	}
}

func TestValidateInboundQuality(t *testing.T) {
	for _, q := range []string{"auto", "source", "720p", "360p"} {
		e := validEvent()
		e.Type, e.Quality = Quality, q
		if err := e.ValidateInbound(); err != nil {
			t.Errorf("quality %q: %v", q, err)
		}
	}
	for _, q := range []string{"", "1080p", "AUTO", "720"} {
		e := validEvent()
		e.Type, e.Quality = Quality, q
		if err := e.ValidateInbound(); !errors.Is(err, ErrInvalidQuality) {
			t.Errorf("quality %q = %v, want ErrInvalidQuality", q, err)
		}
	}
	e := validEvent()
	e.Type = Quality
	if err := e.Validate(); err != nil {
		t.Errorf("QUALITY debe ser un tipo válido: %v", err)
	}
	if !(Event{Type: Quality}).IsCommand() {
		t.Error("QUALITY debe ser comando")
	}
	e = validEvent()
	e.Quality = "720p"
	raw, _ := json.Marshal(e)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	if m["quality"] != "720p" {
		t.Errorf("quality debe serializarse: %s", raw)
	}
}

func TestValidateInboundBuffering(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Event)
		want   error
	}{
		{"buffering válido", func(e *Event) { e.DurationMs = 850 }, nil},
		{"duración cero", func(e *Event) { e.DurationMs = 0 }, nil},
		{"duración máxima", func(e *Event) { e.DurationMs = MaxBufferingMs }, nil},
		{"duración negativa", func(e *Event) { e.DurationMs = -1 }, ErrInvalidBuffering},
		{"duración excesiva", func(e *Event) { e.DurationMs = MaxBufferingMs + 1 }, ErrInvalidBuffering},
		{"posición negativa", func(e *Event) { e.PositionMs = -1 }, ErrNegativePosition},
		{"sin occurred_at", func(e *Event) { e.OccurredAt = time.Time{} }, ErrMissingTimestamp},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := validEvent()
			e.Type = Buffering
			tt.mutate(&e)
			if err := e.ValidateInbound(); !errors.Is(err, tt.want) {
				t.Errorf("ValidateInbound() = %v, want %v", err, tt.want)
			}
		})
	}
	// BUFFERING no es un comando: no cambia el Reloj Maestro.
	if (Event{Type: Buffering}).IsCommand() {
		t.Error("BUFFERING no debe ser comando")
	}
}

func TestJSONContractBuffering(t *testing.T) {
	var e Event
	raw := `{"event_id":"6f1c2a8e-8a4e-4d0a-9f5b-1c2d3e4f5a6b","type":"BUFFERING","room_id":"room-1","position_ms":12345,"duration_ms":850,"occurred_at":"2026-10-10T18:00:00.123Z"}`
	if err := json.Unmarshal([]byte(raw), &e); err != nil {
		t.Fatal(err)
	}
	if e.Type != Buffering || e.DurationMs != 850 || e.PositionMs != 12345 {
		t.Errorf("BUFFERING JSON = %+v", e)
	}
	out, _ := json.Marshal(validEvent())
	if strings.Contains(string(out), "duration_ms") {
		t.Errorf("duration_ms vacío no debe serializarse: %s", out)
	}
}

func TestValidRoomClosed(t *testing.T) {
	ok := Event{Type: RoomClosed, RoomID: "r1", Reason: ReasonGraceExpired}
	if !ok.ValidRoomClosed("r1") {
		t.Error("ROOM_CLOSED válido rechazado")
	}
	for name, ev := range map[string]Event{
		"otra sala":   {Type: RoomClosed, RoomID: "r2", Reason: ReasonHostEnded},
		"sin reason":  {Type: RoomClosed, RoomID: "r1"},
		"reason raro": {Type: RoomClosed, RoomID: "r1", Reason: "kicked"},
		"otro tipo":   {Type: Revoked, RoomID: "r1", Reason: ReasonHostEnded},
	} {
		if ev.ValidRoomClosed("r1") {
			t.Errorf("%s: debe descartarse", name)
		}
	}
	if ClosedKey("r1") != "room:r1:closed" {
		t.Errorf("ClosedKey = %q", ClosedKey("r1"))
	}
}
