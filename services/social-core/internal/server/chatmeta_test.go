package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chatmeta"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/moderation"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/recap"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

const testUA = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0"

func dialUA(t *testing.T, url, token, ua string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: map[string][]string{"Authorization": {"Bearer " + token}, "User-Agent": {ua}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestSocialRecordsMetadataOfAcceptedMessages(t *testing.T) {
	secret := "s3cr3t"
	fixed := time.Date(2026, 11, 2, 18, 0, 0, 0, time.UTC)
	deps := testDeps(secret)
	deps.Now = func() time.Time { return fixed }
	got := make(chan chatmeta.Input, 4)
	deps.RecordChat = func(in chatmeta.Input) { got <- in }
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	url := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	c := dialUA(t, url, guestTokenAs(t, secret, "guest:a", "Ana", "r1", time.Now().Add(time.Hour)), testUA)
	defer c.Close(websocket.StatusNormalClosure, "")
	_ = readJSON(t, c) // history
	_ = readJSON(t, c) // notice joined

	sent := fixed.Add(-300 * time.Millisecond)
	sendRaw(t, c, socialevent.ChatSend{EventID: "c1", Type: socialevent.TypeChatSend, RoomID: "r1", Text: "  hola 😂  ", OccurredAt: sent, Spoiler: true})
	msg := readJSON(t, c)
	in := recv(t, got, "metadatos")
	if in.EventID != msg["event_id"] || in.RoomID != "r1" || in.Subject != "guest:a" || in.Nick != "Ana" {
		t.Errorf("identificación = %+v (broadcast %v)", in, msg)
	}
	if in.Role != "participant" || !in.IsGuest || in.Status != chatmeta.StatusAccepted || in.RejectReason != "" {
		t.Errorf("rol/estado = %+v", in)
	}
	if in.Text != "hola 😂" || !in.Spoiler || !in.SentAt.Equal(sent) || !in.ReceivedAt.Equal(fixed) || in.UserAgent != testUA {
		t.Errorf("mensaje = %+v", in)
	}
}

func TestSocialRecordsModerationRejectionsButNotFloods(t *testing.T) {
	secret := "s3cr3t"
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()
	deps := testDeps(secret)
	deps.Moderation = moderation.NewStore(rdb, time.Hour)
	got := make(chan chatmeta.Input, 8)
	deps.RecordChat = func(in chatmeta.Input) { got <- in }
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	url := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	c := dialUA(t, url, guestToken(t, secret, "guest:a", "r1", time.Now().Add(time.Hour)), testUA)
	defer c.Close(websocket.StatusNormalClosure, "")
	_ = readJSON(t, c) // history
	_ = readJSON(t, c) // chat_settings
	_ = readJSON(t, c) // notice joined
	ctx := context.Background()

	// Modo lento: el primero pasa, el segundo se rechaza y se registra.
	if err := deps.Moderation.SetSlowMode(ctx, "r1", 30); err != nil {
		t.Fatal(err)
	}
	sendRaw(t, c, socialevent.ChatSend{EventID: "c1", Type: socialevent.TypeChatSend, RoomID: "r1", Text: "uno", OccurredAt: time.Now()})
	_ = readJSON(t, c)
	if in := recv(t, got, "aceptado"); in.Status != chatmeta.StatusAccepted {
		t.Fatalf("primero = %+v", in)
	}
	sendRaw(t, c, socialevent.ChatSend{EventID: "c2", Type: socialevent.TypeChatSend, RoomID: "r1", Text: "dos", OccurredAt: time.Now()})
	if e := readJSON(t, c); e["code"] != "SLOW_MODE" {
		t.Fatalf("segundo = %v", e)
	}
	if in := recv(t, got, "rechazo por modo lento"); in.Status != chatmeta.StatusRejected || in.RejectReason != "SLOW_MODE" || in.Text != "dos" || in.EventID == "" {
		t.Errorf("rechazo = %+v", in)
	}

	// Silenciado: se rechaza y se registra.
	if err := deps.Moderation.SetMuted(ctx, "r1", "guest:a", true); err != nil {
		t.Fatal(err)
	}
	sendRaw(t, c, socialevent.ChatSend{EventID: "c3", Type: socialevent.TypeChatSend, RoomID: "r1", Text: "tres", OccurredAt: time.Now()})
	if e := readJSON(t, c); e["code"] != "MUTED" {
		t.Fatalf("silenciado = %v", e)
	}
	if in := recv(t, got, "rechazo por silencio"); in.RejectReason != "MUTED" {
		t.Errorf("rechazo = %+v", in)
	}

	// Inválidos: no se registran (no consumen el límite y permitirían inundar).
	sendRaw(t, c, socialevent.ChatSend{EventID: "c4", Type: socialevent.TypeChatSend, RoomID: "r1", Text: "   ", OccurredAt: time.Now()})
	if e := readJSON(t, c); e["code"] != "INVALID_PAYLOAD" {
		t.Fatalf("vacío = %v", e)
	}
	sendRaw(t, c, socialevent.ChatSend{EventID: "c5", Type: socialevent.TypeChatSend, RoomID: "r1", Text: strings.Repeat("x", 5000), OccurredAt: time.Now()})
	_ = readJSON(t, c)
	expectNone(t, got, "metadatos de un intento inválido")
}

func TestSocialDoesNotRecordRateLimitedMessages(t *testing.T) {
	secret := "s3cr3t"
	deps := testDeps(secret)
	got := make(chan chatmeta.Input, 16)
	deps.RecordChat = func(in chatmeta.Input) { got <- in }
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	defer srv.Close()
	url := "ws://" + strings.TrimPrefix(srv.URL, "http://") + "/ws/social?room_id=r1"
	c := dialUA(t, url, guestToken(t, secret, "guest:a", "r1", time.Now().Add(time.Hour)), testUA)
	defer c.Close(websocket.StatusNormalClosure, "")
	_ = readJSON(t, c)
	_ = readJSON(t, c)
	limited := 0
	for i := 0; i < 8; i++ {
		sendRaw(t, c, socialevent.ChatSend{EventID: "c" + itoa(int64(i)), Type: socialevent.TypeChatSend, RoomID: "r1", Text: "spam", OccurredAt: time.Now()})
		if e := readJSON(t, c); e["code"] == "RATE_LIMITED" {
			limited++
		}
	}
	if limited == 0 {
		t.Fatal("el límite de 5/s debería frenar alguno")
	}
	accepted := 0
	for len(got) > 0 {
		in := <-got
		if in.Status != chatmeta.StatusAccepted {
			t.Errorf("solo se registran los aceptados: %+v", in)
		}
		accepted++
	}
	if accepted != 8-limited {
		t.Errorf("registrados = %d, aceptados = %d", accepted, 8-limited)
	}
}

func TestChatContextReadsTheRoomStateAtThatInstant(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer rdb.Close()
	ctx := context.Background()
	at := time.Date(2026, 11, 2, 18, 0, 0, 0, time.UTC)
	deps := testDeps("s")
	deps.Moderation = moderation.NewStore(rdb, time.Hour)
	deps.Recap = recap.NewStore(rdb, time.Hour)
	live := map[string]bool{"live-1": true}
	deps.IsLive = func(_ context.Context, room string) (bool, error) { return live[room], nil }
	deps.StreamStartedAt = func(_ context.Context, room string) (int64, bool, error) {
		if room == "live-1" {
			return at.Add(-90 * time.Second).UnixMilli(), true, nil
		}
		return 0, false, nil
	}
	_ = deps.Moderation.SetSlowMode(ctx, "watch-1", 10)
	rdb.HSet(ctx, recap.LastPosKey("watch-1"), "pos", 60_000, "status", "playing", "rate", "1", "seen_at_ms", at.Add(-5*time.Second).UnixMilli())

	w := deps.chatContext(ctx, "watch-1", at)
	if w.RoomKind != "watch" || w.PositionMS == nil || *w.PositionMS != 65_000 || w.StreamOffsetMS != nil || w.SlowModeS != 10 {
		t.Errorf("watch = %+v", w)
	}
	l := deps.chatContext(ctx, "live-1", at)
	if l.RoomKind != "live" || l.StreamOffsetMS == nil || *l.StreamOffsetMS != 90_000 || l.PositionMS != nil {
		t.Errorf("live = %+v", l)
	}
	empty := deps.chatContext(ctx, "nueva", at)
	if empty.RoomKind != "watch" || empty.PositionMS != nil || empty.SlowModeS != 0 {
		t.Errorf("sala sin estado = %+v", empty)
	}

	// Sin Redis (modo memoria) o con fallos: se guarda lo que se sabe, nunca falla.
	bare := testDeps("s")
	if c := bare.chatContext(ctx, "r", at); c.RoomKind != "watch" || c.PositionMS != nil {
		t.Errorf("sin Redis = %+v", c)
	}
	broken := testDeps("s")
	broken.IsLive = func(context.Context, string) (bool, error) { return false, errors.New("redis caído") }
	if c := broken.chatContext(ctx, "r", at); c.RoomKind != "" {
		t.Errorf("tipo desconocido debe quedar vacío: %+v", c)
	}
}

func TestHealthzReportsChatMetadataWithoutFailing(t *testing.T) {
	cases := []struct {
		name   string
		health func(context.Context) (chatmeta.Health, error)
		want   map[string]any
	}{
		{"desactivado", nil, nil},
		{"al día", func(context.Context) (chatmeta.Health, error) { return chatmeta.Health{}, nil }, map[string]any{"status": "ok", "backlog": float64(0)}},
		{"mongo caído", func(context.Context) (chatmeta.Health, error) {
			return chatmeta.Health{Degraded: true, Backlog: 3}, nil
		}, map[string]any{"status": "degraded", "backlog": float64(3)}},
		{"redis caído", func(context.Context) (chatmeta.Health, error) {
			return chatmeta.Health{}, errors.New("sin redis")
		}, map[string]any{"status": "degraded", "backlog": float64(-1)}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			deps := testDeps("s")
			deps.ChatMetaHealth = tc.health
			rec := httptest.NewRecorder()
			NewRouterWithDeps(deps).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d", rec.Code)
			}
			var body map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body["status"] != "ok" || body["service"] != "social-core" {
				t.Errorf("body = %v", body)
			}
			meta, has := body["chat_meta"].(map[string]any)
			if tc.want == nil {
				if has {
					t.Errorf("sin metadatos no debe aparecer chat_meta: %v", body)
				}
				return
			}
			for k, v := range tc.want {
				if meta[k] != v {
					t.Errorf("chat_meta[%s] = %v, want %v", k, meta[k], v)
				}
			}
		})
	}
}

func TestDefaultDepsEnablesChatMetadataOnlyWithMongoAndPepper(t *testing.T) {
	mr := miniredis.RunT(t)
	env := func(kv map[string]string) func(string) string {
		return func(k string) string { return kv[k] }
	}
	base := map[string]string{"JWT_SECRET": "s", "REDIS_URL": "redis://" + mr.Addr()}

	if d := DefaultDeps(env(base)); d.RecordChat != nil || d.ChatMetaHealth != nil {
		t.Error("sin MONGO_URI no se registran metadatos")
	}
	noPepper := map[string]string{"MONGO_URI": "mongodb://127.0.0.1:1"}
	for k, v := range base {
		noPepper[k] = v
	}
	if d := DefaultDeps(env(noPepper)); d.RecordChat != nil {
		t.Error("sin CHAT_META_PEPPER no se registran metadatos (nunca seudónimos con clave vacía)")
	}
	full := map[string]string{"CHAT_META_PEPPER": "p", "CHAT_META_RETENTION_DAYS": "30"}
	for k, v := range noPepper {
		full[k] = v
	}
	d := DefaultDeps(env(full))
	if d.RecordChat == nil || d.ChatMetaHealth == nil || d.chatMeta == nil {
		t.Fatal("con MONGO_URI y CHAT_META_PEPPER deben activarse")
	}
	if d.chatMeta.retention != 30*24*time.Hour {
		t.Errorf("retención = %v", d.chatMeta.retention)
	}
	onlyMongo := map[string]string{"JWT_SECRET": "s", "MONGO_URI": "mongodb://127.0.0.1:1", "CHAT_META_PEPPER": "p"}
	if d := DefaultDeps(env(onlyMongo)); d.RecordChat != nil {
		t.Error("sin REDIS_URL no hay cola: no se registran metadatos")
	}
}

func TestRetentionDays(t *testing.T) {
	for raw, want := range map[string]time.Duration{"": 90 * 24 * time.Hour, "7": 7 * 24 * time.Hour, "0": 90 * 24 * time.Hour, "-3": 90 * 24 * time.Hour, "x": 90 * 24 * time.Hour} {
		if got := retentionDays(raw); got != want {
			t.Errorf("retentionDays(%q) = %v, want %v", raw, got, want)
		}
	}
}
