package chatmeta

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

var (
	pepper = []byte("pepper-de-prueba")
	t0     = time.Date(2026, 11, 2, 18, 0, 0, 0, time.UTC)
)

func baseInput() Input {
	return Input{
		EventID: "e-1", RoomID: "r1", Subject: "sub-ana", Nick: "Ana", Role: "participant", IsGuest: true,
		Status: StatusAccepted, Text: "hola equipo 😂 mira https://tint.test", Spoiler: true,
		SentAt: t0.Add(-120 * time.Millisecond), ReceivedAt: t0,
		Context:   Context{RoomKind: "watch", PositionMS: ptr(int64(65_000)), SlowModeS: 10},
		UserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
	}
}

func ptr[T any](v T) *T { return &v }

func TestBuildFillsEveryMetadataField(t *testing.T) {
	d := Build(pepper, baseInput())
	if d.ID != "e-1" || d.RoomID != "r1" || d.Role != "participant" || !d.IsGuest {
		t.Errorf("identificación = %+v", d)
	}
	if d.Status != StatusAccepted || d.RejectReason != "" {
		t.Errorf("estado = %q %q", d.Status, d.RejectReason)
	}
	if d.Length != 36 || d.Words != 5 || d.Emojis != 1 || !d.HasLink || !d.Spoiler {
		t.Errorf("texto: length=%d words=%d emojis=%d link=%v spoiler=%v", d.Length, d.Words, d.Emojis, d.HasLink, d.Spoiler)
	}
	if !d.SentAt.Equal(t0.Add(-120*time.Millisecond)) || !d.ReceivedAt.Equal(t0) || d.LatencyMS != 120 {
		t.Errorf("horas: sent=%v received=%v latency=%d", d.SentAt, d.ReceivedAt, d.LatencyMS)
	}
	if d.RoomKind != "watch" || d.PositionMS == nil || *d.PositionMS != 65_000 || d.StreamOffsetMS != nil || d.SlowModeS != 10 {
		t.Errorf("contexto = %+v", d)
	}
	if d.Client != (Client{Platform: "web", Browser: "chrome", OS: "windows"}) {
		t.Errorf("client = %+v", d.Client)
	}
}

func TestBuildNeverStoresTextNickOrSubject(t *testing.T) {
	in := baseInput()
	d := Build(pepper, in)
	raw, err := bson.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	js, _ := json.Marshal(d)
	for _, forbidden := range []string{in.Text, "hola equipo", in.Nick, in.Subject, in.UserAgent} {
		if strings.Contains(string(raw), forbidden) || strings.Contains(string(js), forbidden) {
			t.Errorf("el documento contiene %q", forbidden)
		}
	}
	var m bson.M
	if err := bson.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"text", "nick", "sub", "user_agent", "ip"} {
		if _, ok := m[key]; ok {
			t.Errorf("el documento tiene el campo %q", key)
		}
	}
}

func TestAuthorIsAPseudonymPerRoom(t *testing.T) {
	a := Pseudonym(pepper, "r1", "sub-ana")
	if a != Pseudonym(pepper, "r1", "sub-ana") {
		t.Error("el mismo sub en la misma sala debe dar el mismo seudónimo")
	}
	if a == Pseudonym(pepper, "r2", "sub-ana") {
		t.Error("en otra sala debe ser distinto")
	}
	if a == Pseudonym([]byte("otro"), "r1", "sub-ana") {
		t.Error("con otro secreto debe ser distinto")
	}
	if len(a) != 64 || strings.Contains(a, "sub-ana") {
		t.Errorf("seudónimo = %q", a)
	}
	if Build(pepper, baseInput()).Author != a {
		t.Error("Build debe usar el seudónimo de la sala")
	}
}

func TestRejectedAttemptKeepsReason(t *testing.T) {
	in := baseInput()
	in.Status, in.RejectReason = StatusRejected, "SLOW_MODE"
	d := Build(pepper, in)
	if d.Status != StatusRejected || d.RejectReason != "SLOW_MODE" {
		t.Errorf("rechazo = %q %q", d.Status, d.RejectReason)
	}
}

func TestLiveRoomUsesStreamOffset(t *testing.T) {
	in := baseInput()
	in.Context = Context{RoomKind: "live", StreamOffsetMS: ptr(int64(90_000))}
	d := Build(pepper, in)
	if d.RoomKind != "live" || d.PositionMS != nil || d.StreamOffsetMS == nil || *d.StreamOffsetMS != 90_000 {
		t.Errorf("contexto live = %+v", d)
	}
}

func TestLatencyNeverNegative(t *testing.T) {
	in := baseInput()
	in.SentAt = t0.Add(time.Second) // reloj del navegador adelantado
	if d := Build(pepper, in); d.LatencyMS != 0 {
		t.Errorf("latency = %d", d.LatencyMS)
	}
}

func TestTextMetrics(t *testing.T) {
	cases := []struct {
		text          string
		length, words int
		emojis        int
		link          bool
	}{
		{"", 0, 0, 0, false},
		{"   hola   ", 10, 1, 0, false}, // Length cuenta runas; el servidor recorta antes
		{"ñandú café", 10, 2, 0, false},
		{"😂😂 👍🏽", 5, 2, 3, false},   // el tono de piel no cuenta como emoji aparte
		{"❤️ y 🇨🇴", 7, 3, 2, false}, // selector de variante y bandera (dos indicadores = 1)
		{"ver WWW.tint.test ya", 20, 3, 0, true},
		{"http:/roto", 10, 1, 0, false},
	}
	for _, c := range cases {
		if got := Length(c.text); got != c.length {
			t.Errorf("Length(%q) = %d, want %d", c.text, got, c.length)
		}
		if got := Words(c.text); got != c.words {
			t.Errorf("Words(%q) = %d, want %d", c.text, got, c.words)
		}
		if got := Emojis(c.text); got != c.emojis {
			t.Errorf("Emojis(%q) = %d, want %d", c.text, got, c.emojis)
		}
		if got := HasLink(c.text); got != c.link {
			t.Errorf("HasLink(%q) = %v, want %v", c.text, got, c.link)
		}
	}
}

func TestParseUserAgent(t *testing.T) {
	cases := []struct {
		ua   string
		want Client
	}{
		{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", Client{"web", "chrome", "windows"}},
		{"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0", Client{"web", "other", "windows"}},
		{"Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", Client{"web", "firefox", "linux"}},
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", Client{"web", "safari", "macos"}},
		{"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1", Client{"web", "chrome", "ios"}},
		{"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36", Client{"web", "chrome", "android"}},
		{"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 OPR/114.0", Client{"web", "other", "linux"}},
		{"okhttp/4.12.0", Client{"android", "other", "android"}},
		{"", Client{"unknown", "other", "other"}},
		{"curl/8.5.0", Client{"unknown", "other", "other"}},
	}
	for _, c := range cases {
		if got := ParseUserAgent(c.ua); got != c.want {
			t.Errorf("ParseUserAgent(%q) = %+v, want %+v", c.ua, got, c.want)
		}
	}
}
