package socialevent

import (
	"strings"
	"testing"
)

func TestTriviaScheduleValidate(t *testing.T) {
	at := func(n int64) *int64 { return &n }
	idx := func(n int) *int { return &n }
	ok := TriviaSchedule{EventID: "e", Type: TypeTriviaSchedule, AtMS: at(0), Question: " ¿q? ", Options: []string{"a", " b "}, Correct: idx(1)}
	if err := ok.Validate(); err != nil {
		t.Fatalf("ok = %v", err)
	}
	if q, o, w := ok.Normalized(); q != "¿q?" || o[1] != "b" || w != DefaultTriviaWindowS {
		t.Fatalf("Normalized = %q %v %d", q, o, w)
	}
	mod := func(f func(*TriviaSchedule)) TriviaSchedule { m := ok; f(&m); return m }
	cases := []struct {
		name string
		m    TriviaSchedule
		want error
	}{
		{"sin event", mod(func(m *TriviaSchedule) { m.EventID = "" }), ErrMissingEventID},
		{"tipo malo", mod(func(m *TriviaSchedule) { m.Type = "x" }), ErrUnsupportedType},
		{"sin at_ms", mod(func(m *TriviaSchedule) { m.AtMS = nil }), ErrInvalidAtMS},
		{"at_ms negativo", mod(func(m *TriviaSchedule) { m.AtMS = at(-1) }), ErrInvalidAtMS},
		{"at_ms enorme", mod(func(m *TriviaSchedule) { m.AtMS = at(MaxTriviaAtMS + 1) }), ErrInvalidAtMS},
		{"pregunta vacía", mod(func(m *TriviaSchedule) { m.Question = "  " }), ErrInvalidQuestion},
		{"pregunta larga", mod(func(m *TriviaSchedule) { m.Question = strings.Repeat("q", MaxQuestionRunes+1) }), ErrInvalidQuestion},
		{"una opción", mod(func(m *TriviaSchedule) { m.Options = []string{"a"} }), ErrInvalidOptions},
		{"cinco opciones", mod(func(m *TriviaSchedule) { m.Options = []string{"a", "b", "c", "d", "e"} }), ErrInvalidOptions},
		{"opción vacía", mod(func(m *TriviaSchedule) { m.Options = []string{"a", " "} }), ErrInvalidOptions},
		{"sin correct", mod(func(m *TriviaSchedule) { m.Correct = nil }), ErrInvalidCorrect},
		{"correct fuera", mod(func(m *TriviaSchedule) { m.Correct = idx(2) }), ErrInvalidCorrect},
		{"correct negativo", mod(func(m *TriviaSchedule) { m.Correct = idx(-1) }), ErrInvalidCorrect},
		{"ventana corta", mod(func(m *TriviaSchedule) { m.AnswerWindowS = 9 }), ErrInvalidWindow},
		{"ventana larga", mod(func(m *TriviaSchedule) { m.AnswerWindowS = 61 }), ErrInvalidWindow},
		{"ventana 60", mod(func(m *TriviaSchedule) { m.AnswerWindowS = 60 }), nil},
	}
	for _, c := range cases {
		if err := c.m.Validate(); err != c.want {
			t.Errorf("%s: %v, want %v", c.name, err, c.want)
		}
	}
}

func TestTriviaSmallMessagesValidate(t *testing.T) {
	one := 1
	neg := -1
	cases := []struct {
		name string
		err  error
		want error
	}{
		{"delete ok", TriviaDelete{EventID: "e", Type: TypeTriviaDelete, TriviaID: "t"}.Validate(), nil},
		{"delete sin event", TriviaDelete{Type: TypeTriviaDelete, TriviaID: "t"}.Validate(), ErrMissingEventID},
		{"delete tipo", TriviaDelete{EventID: "e", Type: "x", TriviaID: "t"}.Validate(), ErrUnsupportedType},
		{"delete sin id", TriviaDelete{EventID: "e", Type: TypeTriviaDelete}.Validate(), ErrMissingTrivia},
		{"list ok", TriviaList{EventID: "e", Type: TypeTriviaList}.Validate(), nil},
		{"list sin event", TriviaList{Type: TypeTriviaList}.Validate(), ErrMissingEventID},
		{"list tipo", TriviaList{EventID: "e", Type: "x"}.Validate(), ErrUnsupportedType},
		{"answer ok", TriviaAnswer{EventID: "e", Type: TypeTriviaAnswer, TriviaID: "t", Option: &one}.Validate(), nil},
		{"answer sin event", TriviaAnswer{Type: TypeTriviaAnswer, TriviaID: "t", Option: &one}.Validate(), ErrMissingEventID},
		{"answer tipo", TriviaAnswer{EventID: "e", Type: "x", TriviaID: "t", Option: &one}.Validate(), ErrUnsupportedType},
		{"answer sin id", TriviaAnswer{EventID: "e", Type: TypeTriviaAnswer, Option: &one}.Validate(), ErrMissingTrivia},
		{"answer sin option", TriviaAnswer{EventID: "e", Type: TypeTriviaAnswer, TriviaID: "t"}.Validate(), ErrInvalidOption},
		{"answer negativa", TriviaAnswer{EventID: "e", Type: TypeTriviaAnswer, TriviaID: "t", Option: &neg}.Validate(), ErrInvalidOption},
	}
	for _, c := range cases {
		if c.err != c.want {
			t.Errorf("%s: %v, want %v", c.name, c.err, c.want)
		}
	}
}

func TestTriviaUpdateValidate(t *testing.T) {
	at, idx := int64(5), 1
	ok := TriviaUpdate{EventID: "e", Type: TypeTriviaUpdate, TriviaID: "t1", AtMS: &at, Question: " ¿q? ", Options: []string{"a", " b "}, Correct: &idx}
	if err := ok.Validate(); err != nil {
		t.Fatalf("ok = %v", err)
	}
	if q, o, w := ok.Normalized(); q != "¿q?" || o[1] != "b" || w != DefaultTriviaWindowS {
		t.Fatalf("Normalized = %q %v %d", q, o, w)
	}
	cases := map[string]struct {
		mod  func(*TriviaUpdate)
		want error
	}{
		"sin event":  {func(m *TriviaUpdate) { m.EventID = "" }, ErrMissingEventID},
		"tipo malo":  {func(m *TriviaUpdate) { m.Type = TypeTriviaSchedule }, ErrUnsupportedType},
		"sin id":     {func(m *TriviaUpdate) { m.TriviaID = "" }, ErrMissingTrivia},
		"sin at_ms":  {func(m *TriviaUpdate) { m.AtMS = nil }, ErrInvalidAtMS},
		"una opción": {func(m *TriviaUpdate) { m.Options = []string{"a"} }, ErrInvalidOptions},
		"ventana":    {func(m *TriviaUpdate) { m.AnswerWindowS = 5 }, ErrInvalidWindow},
	}
	for name, c := range cases {
		m := ok
		c.mod(&m)
		if err := m.Validate(); err != c.want {
			t.Errorf("%s = %v, want %v", name, err, c.want)
		}
	}
}
