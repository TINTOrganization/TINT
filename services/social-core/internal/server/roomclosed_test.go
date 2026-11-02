package server

// Pruebas del ADR 0019 (salas live y cierre ROOM_CLOSED) y de la corrección
// del ADR 0014 en /ws/social (upgrade + 4001/4003 en lugar de 401).

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"nhooyr.io/websocket"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

// Códigos de cierre terminales esperados (literales: aún no hay constantes
// para 4003 y 4010 en social-core).
const (
	wantStatusTokenExpired websocket.StatusCode = 4003
	wantStatusRoomDisabled websocket.StatusCode = 4010
)

func roomClosedKey(roomID string) string { return "room:" + roomID + ":closed" }

// closedReplica arranca una réplica con Redis y devuelve la URL base HTTP y
// las dependencias.
func closedReplica(t *testing.T, mr *miniredis.Miniredis, secret string) (string, *Deps) {
	t.Helper()
	env := map[string]string{"REDIS_URL": "redis://" + mr.Addr(), "JWT_SECRET": secret}
	deps := DefaultDeps(func(k string) string { return env[k] })
	srv := httptest.NewServer(NewRouterWithDeps(deps))
	t.Cleanup(srv.Close)
	return srv.URL, deps
}

func wsSocialURL(base, roomID string) string {
	return "ws://" + strings.TrimPrefix(base, "http://") + "/ws/social?room_id=" + roomID
}

// dialUpgraded exige que el handshake haga upgrade (ADR 0014) y devuelve
// la conexión; falla si el servidor respondió con un status HTTP.
func dialUpgraded(t *testing.T, url, token string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: map[string][]string{"Authorization": {"Bearer " + token}},
	})
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
			resp.Body.Close()
		}
		t.Fatalf("el handshake debe hacer upgrade y cerrar con 4xxx (ADR 0014); status HTTP = %d: %v", status, err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return c
}

// closeCode lee hasta el cierre y devuelve el código y el primer mensaje
// recibido antes de él (nil si ninguno).
func closeCode(t *testing.T, c *websocket.Conn) (websocket.StatusCode, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var first []byte
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			return websocket.CloseStatus(err), first
		}
		if first == nil {
			first = data
		}
	}
}

// (c) ADR 0014/0019: un token caducado pero bien firmado hace upgrade y se
// cierra con 4003; uno revocado, con 4001. Antes respondía 401 antes del
// upgrade y el navegador solo veía 1006 (reconectaba para siempre).
func TestSocialTerminalTokensUpgradeAndClose(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	base, _ := closedReplica(t, mr, secret)
	url := wsSocialURL(base, "r1")

	t.Run("caducado 4003", func(t *testing.T) {
		c := dialUpgraded(t, url, guestToken(t, secret, "guest:exp", "r1", time.Now().Add(-time.Minute)))
		if code, first := closeCode(t, c); code != wantStatusTokenExpired || first != nil {
			t.Fatalf("cierre = %d (primer mensaje %s), want %d sin mensajes", code, first, wantStatusTokenExpired)
		}
	})
	t.Run("revocado 4001", func(t *testing.T) {
		if err := mr.Set(chat.RevokedKey("jti-guest:old"), "1"); err != nil {
			t.Fatal(err)
		}
		c := dialUpgraded(t, url, guestToken(t, secret, "guest:old", "r1", exp0()))
		if code, first := closeCode(t, c); code != StatusRevoked || first != nil {
			t.Fatalf("cierre = %d (primer mensaje %s), want %d sin mensajes", code, first, StatusRevoked)
		}
	})
	t.Run("caducado de otra sala sigue siendo 403", func(t *testing.T) {
		if got := dialStatus(t, url, guestToken(t, secret, "guest:x", "otra", time.Now().Add(-time.Minute))); got == 101 {
			t.Fatalf("token caducado de otra sala: status = %d, want rechazo antes del upgrade", got)
		}
	})
}

// (b) ADR 0019: con room:{id}:closed presente, el handshake hace upgrade y
// cierra con 4010 sin enviar el historial (HU-LIVE-08 AC3).
func TestSocialClosedRoomHandshakeClosesWith4010(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	base, _ := closedReplica(t, mr, secret)
	if err := mr.Set(roomClosedKey("r1"), "1"); err != nil {
		t.Fatal(err)
	}
	for name, tok := range map[string]string{
		"invitado": guestToken(t, secret, "guest:tarde", "r1", exp0()),
		"host":     roleTicket(t, secret, "host-1", "Ana", "host", "r1"),
	} {
		t.Run(name, func(t *testing.T) {
			c := dialUpgraded(t, wsSocialURL(base, "r1"), tok)
			if code, first := closeCode(t, c); code != wantStatusRoomDisabled || first != nil {
				t.Fatalf("cierre = %d (primer mensaje %s), want %d sin mensajes", code, first, wantStatusRoomDisabled)
			}
		})
	}
}

// (a) ADR 0019 / HU-LIVE-09 AC1: ROOM_CLOSED en room:{id}:sync cierra con
// 4010 todos los sockets sociales de la sala (host incluido); otra sala
// sigue abierta.
func TestSocialRoomClosedClosesAllWith4010(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	base, _ := closedReplica(t, mr, secret)
	// Sin collector: closeCode es el único lector de estas conexiones (dos
	// lectores concurrentes se roban el frame de cierre).
	h := dial(t, wsSocialURL(base, "r1"), roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.CloseNow()
	g := dial(t, wsSocialURL(base, "r1"), guestToken(t, secret, "guest:a", "r1", exp0()))
	defer g.CloseNow()
	o, colO := joinCol(t, wsSocialURL(base, "r2"), guestToken(t, secret, "guest:o", "r2", exp0()))
	defer o.CloseNow()
	waitSubscribed(t, mr, chat.SyncChannelKey("r1"))

	pub := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer pub.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := mr.Set(roomClosedKey("r1"), "1"); err != nil {
		t.Fatal(err)
	}
	// Formato exacto de dominio-transmision §6.1.
	msg := `{"type":"ROOM_CLOSED","event_id":"5b0f8a52-9c1e-4c55-8f0e-2f7d8c1a6b01","room_id":"r1","reason":"host_ended","occurred_at":"2026-11-01T18:00:00.000Z"}`
	if err := pub.Publish(ctx, chat.SyncChannelKey("r1"), msg).Err(); err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]*websocket.Conn{"host": h, "invitado": g} {
		if code, _ := closeCode(t, c); code != wantStatusRoomDisabled {
			t.Errorf("%s: cierre = %d, want %d", name, code, wantStatusRoomDisabled)
		}
	}
	sendRaw(t, o, socialevent.ChatSend{
		EventID: "c-o", Type: socialevent.TypeChatSend, RoomID: "r2", Text: "sigo aquí", OccurredAt: time.Now().UTC(),
	})
	if m := nextOfType(t, colO, "chat_message"); m["text"] != "sigo aquí" {
		t.Fatalf("otra sala: %v", m)
	}
}

func getChat(t *testing.T, base, roomID, token string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, base+"/api/v1/social/rooms/"+roomID+"/chat", nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, body
}

// (d) ADR 0019 / HU-LIVE-09 AC3: el host lee el historial del chat por REST
// aunque la sala esté deshabilitada; nadie más puede.
func TestSocialChatHistoryRESTForHost(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	base, deps := closedReplica(t, mr, secret)
	ctx := context.Background()
	at := time.Date(2026, 11, 1, 18, 0, 0, 0, time.UTC)
	for i, text := range []string{"hola", "qué buen evento"} {
		msg := socialevent.ChatMessage{
			EventID: "m" + itoa(int64(i+1)), Type: socialevent.TypeChatMessage, RoomID: "r1",
			UserID: "guest:a", Nick: "Ana", Text: text, OccurredAt: at, ReceivedAt: at,
		}
		if err := deps.History.Push(ctx, "r1", msg); err != nil {
			t.Fatal(err)
		}
	}
	if err := mr.Set(roomClosedKey("r1"), "1"); err != nil {
		t.Fatal(err)
	}

	t.Run("host de la sala deshabilitada", func(t *testing.T) {
		status, body := getChat(t, base, "r1", roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
		if status != http.StatusOK {
			t.Fatalf("status = %d (%s), want 200", status, body)
		}
		var got struct {
			RoomID   string                    `json:"room_id"`
			Messages []socialevent.ChatMessage `json:"messages"`
		}
		if err := json.Unmarshal(body, &got); err != nil {
			t.Fatalf("JSON %s: %v", body, err)
		}
		if got.RoomID != "r1" {
			t.Fatalf("room_id = %q, want r1", got.RoomID)
		}
		if len(got.Messages) != 2 || got.Messages[0].Text != "hola" || got.Messages[1].Text != "qué buen evento" {
			t.Fatalf("messages = %+v, want [hola, qué buen evento] en orden", got.Messages)
		}
	})

	for name, tc := range map[string]struct {
		token string
		want  int
	}{
		"participante":        {guestToken(t, secret, "guest:a", "r1", exp0()), http.StatusForbidden},
		"host de otra sala":   {roleTicket(t, secret, "host-2", "Beto", "host", "r2"), http.StatusForbidden},
		"sin token":           {"", http.StatusUnauthorized},
		"firma inválida":      {roleTicket(t, "otro-secreto", "host-1", "Ana", "host", "r1"), http.StatusUnauthorized},
		"host token caducado": {signGuestToken(t, secret, map[string]any{"sub": "host-1", "room_id": "r1", "role": "host", "nick": "Ana", "jti": "jti-h", "iss": "tint-identity", "aud": "tint:room", "exp": time.Now().Add(-time.Minute).Unix()}), http.StatusUnauthorized},
	} {
		t.Run(name, func(t *testing.T) {
			if status, body := getChat(t, base, "r1", tc.token); status != tc.want {
				t.Fatalf("status = %d (%s), want %d", status, body, tc.want)
			}
		})
	}
}

// publishStream publica en room:{id}:stream como stream-core.
func publishStream(t *testing.T, mr *miniredis.Miniredis, roomID, payload string) {
	t.Helper()
	waitSubs(t, mr, "room:"+roomID+":stream", 1)
	pub := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	defer pub.Close()
	if err := pub.Publish(context.Background(), "room:"+roomID+":stream", payload).Err(); err != nil {
		t.Fatal(err)
	}
}

// streamStarted arma un STREAM_STARTED con el formato exacto de §6.1.
func streamStarted(roomID string, startedMS int64) string {
	at := time.UnixMilli(startedMS).UTC().Format("2006-01-02T15:04:05.000Z")
	return `{"type":"STREAM_STARTED","event_id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","room_id":"` + roomID +
		`","started_at":"` + at + `","started_at_ms":` + itoa(startedMS) + `,"occurred_at":"` + at + `"}`
}

// markLive marca la sala como live, igual que identity-api.
func markLive(t *testing.T, mr *miniredis.Miniredis, roomID string) {
	t.Helper()
	if err := mr.Set("room:"+roomID+":kind", "live"); err != nil {
		t.Fatal(err)
	}
}

// (e) Trivia por minuto del stream: en una sala live (room:{id}:kind=live),
// tras STREAM_STARTED una pregunta con at_ms se dispara en
// started_at_ms + at_ms según el reloj del servidor (sin comandos de sync:
// una sala live no tiene vídeo sincronizado).
func TestTriviaFiresAtStreamMinute(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	markLive(t, mr, "r1")
	clock, timers := newTestClock(), &fakeTimers{}
	url, _ := redisReplica(t, mr, secret, clock, timers)
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	nextOfType(t, colH, "trivia_schedule_state")
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")

	schedule(t, h, 45_000, 15)
	tid := questions(nextOfType(t, colH, "trivia_schedule_state"))[0]["trivia_id"].(string)

	// El stream empezó hace 10 s: la pregunta sale dentro de 35 s.
	started := clock.UnixMilli() - 10_000
	publishStream(t, mr, "r1", streamStarted("r1", started))
	launch := timers.take(t, 35*time.Second)
	if len(launch) != 1 {
		t.Fatalf("timers de disparo = %d, want 1", len(launch))
	}
	clock.Advance(35 * time.Second)
	launch[0].f()
	m := nextOfType(t, colG, "trivia_question")
	if m["trivia_id"] != tid || m["opens_at_ms"] != float64(started+45_000) || m["closes_at_ms"] != float64(started+45_000+15_000) {
		t.Fatalf("trivia_question = %v, want abierta en started_at_ms + at_ms", m)
	}
}

// (e) "Lanzar ahora": el host abre una pregunta programada de inmediato; un
// invitado no puede.
func TestTriviaLaunchNow(t *testing.T) {
	const secret = "s3cr3t"
	mr := miniredis.RunT(t)
	clock, timers := newTestClock(), &fakeTimers{}
	url, _ := redisReplica(t, mr, secret, clock, timers)
	h, colH := joinCol(t, url, roleTicket(t, secret, "host-1", "Ana", "host", "r1"))
	defer h.Close(websocket.StatusNormalClosure, "")
	nextOfType(t, colH, "trivia_schedule_state")
	g, colG := joinCol(t, url, guestTokenAs(t, secret, "guest:beto", "Beto", "r1", exp0()))
	defer g.Close(websocket.StatusNormalClosure, "")

	schedule(t, h, 600_000, 20)
	tid := questions(nextOfType(t, colH, "trivia_schedule_state"))[0]["trivia_id"].(string)

	sendRaw(t, g, map[string]any{"event_id": "lg", "type": "trivia_launch_now", "trivia_id": tid})
	if m := nextOfType(t, colG, "error"); m["code"] != "FORBIDDEN" || m["event_id_ref"] != "lg" {
		t.Fatalf("invitado lanza = %v, want FORBIDDEN", m)
	}
	sendRaw(t, h, map[string]any{"event_id": "lh", "type": "trivia_launch_now", "trivia_id": tid})
	opens := clock.UnixMilli()
	m := nextOfType(t, colG, "trivia_question")
	if m["trivia_id"] != tid || m["opens_at_ms"] != float64(opens) || m["closes_at_ms"] != float64(opens+20_000) {
		t.Fatalf("trivia_question = %v, want abierta ya (opens_at_ms = %d)", m, opens)
	}
}
