package chat

import (
	"strings"
	"testing"
)

// Los broadcasts de moderación y trivia viajan entre réplicas
// re-serializados por tipo; los mensajes dirigidos (trivia_ack,
// trivia_schedule_state con la respuesta correcta) nunca.
func TestDecodeInboundModerationAndTrivia(t *testing.T) {
	allowed := map[string]string{
		"chat_settings":   `{"event_id":"e1","type":"chat_settings","room_id":"r1","slow_mode_s":10,"muted_user_ids":["u"],"extra":1}`,
		"trivia_question": `{"event_id":"e2","type":"trivia_question","room_id":"r1","trivia_id":"t","question":"q","options":["a","b"],"opens_at_ms":1,"closes_at_ms":2,"correct":1}`,
		"trivia_result":   `{"event_id":"e3","type":"trivia_result","room_id":"r1","trivia_id":"t","correct":1,"top":[],"leaderboard":[]}`,
	}
	for typ, raw := range allowed {
		in, ok := decodeInbound(sourceSocial, "r1", []byte(raw))
		if !ok || string(in.Type) != typ || in.EventID == "" {
			t.Fatalf("%s = %+v %v, want aceptado", typ, in, ok)
		}
		if strings.Contains(string(in.Payload), "extra") {
			t.Fatalf("%s: campos desconocidos no deben reenviarse: %s", typ, in.Payload)
		}
	}
	// Un trivia_question con "correct" inyectado se re-serializa sin él.
	in, _ := decodeInbound(sourceSocial, "r1", []byte(allowed["trivia_question"]))
	if strings.Contains(string(in.Payload), `"correct"`) {
		t.Fatalf("trivia_question reenviado con correct: %s", in.Payload)
	}
	for _, raw := range []string{
		`{"event_id":"e4","type":"trivia_ack","trivia_id":"t","option":1,"score":1500}`,
		`{"event_id":"e5","type":"trivia_schedule_state","questions":[]}`,
		`{"event_id":"e6","type":"chat_mute","user_id":"u","muted":true}`,
	} {
		if _, ok := decodeInbound(sourceSocial, "r1", []byte(raw)); ok {
			t.Fatalf("%s debe rechazarse", raw)
		}
	}
}
