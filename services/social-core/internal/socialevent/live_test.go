package socialevent

import "testing"

func TestBusClosedValid(t *testing.T) {
	ok := BusClosed{Type: RoomClosed, EventID: "e", RoomID: "r1", Reason: ReasonHostEnded}
	if !ok.Valid("r1") {
		t.Fatal("ROOM_CLOSED válido rechazado")
	}
	for name, m := range map[string]BusClosed{
		"tipo":     {Type: "REVOKED", EventID: "e", RoomID: "r1", Reason: ReasonHostEnded},
		"event_id": {Type: RoomClosed, RoomID: "r1", Reason: ReasonHostEnded},
		"sala":     {Type: RoomClosed, EventID: "e", RoomID: "r2", Reason: ReasonHostEnded},
		"reason":   {Type: RoomClosed, EventID: "e", RoomID: "r1", Reason: "x"},
	} {
		if m.Valid("r1") {
			t.Errorf("%s: aceptado %+v", name, m)
		}
	}
}

func TestStreamEventValid(t *testing.T) {
	for name, tc := range map[string]struct {
		m    StreamEvent
		want bool
	}{
		"started":          {StreamEvent{Type: StreamStarted, EventID: "e", RoomID: "r1", StartedAtMS: 1}, true},
		"ended":            {StreamEvent{Type: StreamEnded, EventID: "e", RoomID: "r1", Reason: ReasonGraceExpired}, true},
		"started sin ms":   {StreamEvent{Type: StreamStarted, EventID: "e", RoomID: "r1"}, false},
		"ended sin reason": {StreamEvent{Type: StreamEnded, EventID: "e", RoomID: "r1"}, false},
		"sin event_id":     {StreamEvent{Type: StreamStarted, RoomID: "r1", StartedAtMS: 1}, false},
		"otra sala":        {StreamEvent{Type: StreamStarted, EventID: "e", RoomID: "r2", StartedAtMS: 1}, false},
		"otro tipo":        {StreamEvent{Type: "STREAM_X", EventID: "e", RoomID: "r1", StartedAtMS: 1}, false},
	} {
		if got := tc.m.Valid("r1"); got != tc.want {
			t.Errorf("%s: Valid = %v, want %v", name, got, tc.want)
		}
	}
}

func TestTriviaLaunchNowValidate(t *testing.T) {
	if err := (TriviaLaunchNow{EventID: "e", Type: TypeTriviaLaunchNow, TriviaID: "t"}).Validate(); err != nil {
		t.Fatal(err)
	}
	if (TriviaLaunchNow{Type: TypeTriviaLaunchNow, TriviaID: "t"}).Validate() != ErrMissingEventID {
		t.Fatal("sin event_id")
	}
	if (TriviaLaunchNow{EventID: "e", Type: TypeTriviaList, TriviaID: "t"}).Validate() != ErrUnsupportedType {
		t.Fatal("tipo")
	}
	if (TriviaLaunchNow{EventID: "e", Type: TypeTriviaLaunchNow}).Validate() != ErrMissingTrivia {
		t.Fatal("sin trivia_id")
	}
}
