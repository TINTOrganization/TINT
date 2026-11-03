package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/coder/websocket"
	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/bus"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/codec"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/hub"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/store"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/telemetry"
)

const (
	secret = "test-secret"
	room   = "room-1"
)

type server struct {
	url string
	mr  *miniredis.Miniredis
}

func newServer(t *testing.T, heartbeat time.Duration) *server {
	t.Helper()
	return newServerWithGate(t, heartbeat, nil)
}

// newServerWithGate permite sustituir la comprobación del handshake; gate
// recibe el store real (nil = usar el store tal cual).
func newServerWithGate(t *testing.T, heartbeat time.Duration, gate func(*store.Store) Gate) *server {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr(), MaxRetries: -1})
	t.Cleanup(func() { _ = rdb.Close() })
	b := bus.New(rdb)
	st := store.New(rdb, 12*time.Hour)
	h := hub.New(st, b, telemetry.New(rdb, 16)).WithHeartbeat(heartbeat)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	b.Start(ctx, h.Deliver)
	go h.Run(ctx)

	var g Gate = st
	if gate != nil {
		g = gate(st)
	}
	ts := httptest.NewServer(NewHandler(h, auth.NewVerifier(secret, "tint-identity", "tint:room"), g, []string{"tint.app"}))
	t.Cleanup(ts.Close)
	return &server{url: ts.URL, mr: mr}
}

func token(t *testing.T, role, roomID string) string {
	t.Helper()
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "u-" + role, "room_id": roomID, "role": role, "nick": role,
		"iss": "tint-identity", "aud": "tint:room", "exp": time.Now().Add(time.Hour).Unix(),
	}).SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

func (s *server) wsURL(roomID, tok string) string {
	return strings.Replace(s.url, "http", "ws", 1) + "/?room_id=" + roomID + "&token=" + tok
}

func dial(t *testing.T, s *server, role string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, s.wsURL(room, token(t, role, room)), nil)
	if err != nil {
		t.Fatalf("dial %s: %v", role, err)
	}
	t.Cleanup(func() { c.CloseNow() })
	return c
}

func read(t *testing.T, c *websocket.Conn) syncevent.Event {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var ev syncevent.Event
	if err := json.Unmarshal(data, &ev); err != nil {
		t.Fatalf("JSON %s: %v", data, err)
	}
	return ev
}

func readType(t *testing.T, c *websocket.Conn, typ syncevent.Type) syncevent.Event {
	t.Helper()
	for {
		if ev := read(t, c); ev.Type == typ {
			return ev
		}
	}
}

func sendJSON(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	data, _ := json.Marshal(v)
	if err := c.Write(context.Background(), websocket.MessageText, data); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestHandshakeRejections(t *testing.T) {
	s := newServer(t, time.Second)
	tests := []struct {
		name string
		url  string
		want int
	}{
		{"sin room_id", s.url + "/?token=x", http.StatusBadRequest},
		{"sin token", s.url + "/?room_id=" + room, http.StatusBadRequest},
		{"token inválido", s.url + "/?room_id=" + room + "&token=basura", http.StatusUnauthorized},
		{"token de otra sala", s.url + "/?room_id=" + room + "&token=" + token(t, "host", "otra"), http.StatusForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_, resp, err := websocket.Dial(ctx, strings.Replace(tt.url, "http", "ws", 1), nil)
			if err == nil {
				t.Fatal("el handshake debía fallar")
			}
			if resp == nil || resp.StatusCode != tt.want {
				t.Errorf("status = %v, want %d", resp, tt.want)
			}
		})
	}
}

func TestOriginNotAllowed(t *testing.T) {
	s := newServer(t, time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, s.wsURL(room, token(t, "participant", room)), &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {"https://evil.example"}},
	})
	if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Errorf("origen no permitido: err=%v resp=%v", err, resp)
	}
	_, resp, err = websocket.Dial(ctx, s.wsURL(room, token(t, "participant", room)), &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {"https://tint.app"}},
	})
	if err != nil {
		t.Errorf("origen permitido rechazado: %v (%v)", err, resp)
	}
}

// HU-SYNC-01 + HU-SYNC-02 de punta a punta.
func TestEndToEndPlayback(t *testing.T) {
	s := newServer(t, time.Second)
	host := dial(t, s, "host")
	if st := read(t, host); st.Type != syncevent.State || st.Status != "paused" {
		t.Fatalf("STATE host = %+v", st)
	}
	guest := dial(t, s, "participant")
	if st := read(t, guest); st.Type != syncevent.State || st.Online == nil || !*st.Online {
		t.Fatalf("STATE guest = %+v", st)
	}

	start := time.Now()
	sendJSON(t, host, map[string]any{
		"event_id": "e-play", "type": "PLAY", "room_id": room, "position_ms": 3000,
		"occurred_at": time.Now().UTC().Format(time.RFC3339Nano),
	})
	ev := readType(t, guest, syncevent.Play)
	if ev.EventID != "e-play" || ev.Status != "playing" || ev.PositionMs != 3000 || ev.Version != 1 {
		t.Errorf("PLAY recibido = %+v", ev)
	}
	if lat := time.Since(start); lat > 100*time.Millisecond {
		t.Errorf("retransmisión tardó %v (> 100 ms)", lat)
	}

	sendJSON(t, guest, map[string]any{
		"event_id": "e-evil", "type": "PAUSE", "room_id": room, "position_ms": 0,
		"occurred_at": time.Now().UTC().Format(time.RFC3339Nano),
	})
	if e := readType(t, guest, syncevent.Error); e.Code != syncevent.CodeForbidden {
		t.Errorf("ERROR = %+v", e)
	}
}

func TestHeartbeatAndStaleDisconnect(t *testing.T) {
	s := newServer(t, 30*time.Millisecond)
	c := dial(t, s, "participant")
	read(t, c) // STATE
	hb := readType(t, c, syncevent.Heartbeat)
	if hb.ServerTimeMs == 0 {
		t.Fatalf("HEARTBEAT sin server_time_ms: %+v", hb)
	}
	// No respondemos SYNC_CHECK: tras 3 latidos el servidor cierra.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for {
		if _, _, err := c.Read(ctx); err != nil {
			if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
				t.Errorf("cierre = %v, want policy violation", err)
			}
			return
		}
	}
}

// El intervalo respeta el límite propio de SYNC_CHECK (5/s, ventana fija de
// 1 s): con latidos más rápidos el hub descarta en silencio las respuestas
// que lo exceden, no renuevan el último SYNC_CHECK y la conexión se cierra
// por ErrStale aunque el cliente conteste a todo. Con 1 s/(5-1) = 250 ms
// caben 4 respuestas por ventana, y el margen de 3 latidos (750 ms) no
// depende del scheduler ni de -race.
func TestHeartbeatAnsweredKeepsAlive(t *testing.T) {
	interval := time.Second / (hub.MaxSyncChecksPerSecond - 1)
	s := newServer(t, interval)
	c := dial(t, s, "participant")
	read(t, c)
	for i := 0; i < 2*hub.MaxMissedChecks; i++ { // el doble del margen de latidos sin respuesta
		hb := readType(t, c, syncevent.Heartbeat)
		sendJSON(t, c, map[string]any{
			"event_id": fmt.Sprintf("c%d", i), "type": "SYNC_CHECK", "room_id": room, "position_ms": 0,
			"occurred_at": time.Now().UTC().Format(time.RFC3339Nano), "echo_server_ts": hb.ServerTimeMs,
		})
	}
}

func TestMessageTooLargeClosesConnection(t *testing.T) {
	s := newServer(t, time.Second)
	c := dial(t, s, "participant")
	read(t, c)
	_ = c.Write(context.Background(), websocket.MessageText, []byte(strings.Repeat("x", MaxMessageBytes+1)))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for {
		if _, _, err := c.Read(ctx); err != nil {
			if websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
				t.Errorf("cierre = %v, want message too big", err)
			}
			return
		}
	}
}

// passGate deja pasar el handshake sin tocar Redis.
type passGate struct{}

func (passGate) IsRevoked(context.Context, string) (bool, error)    { return false, nil }
func (passGate) IsRoomClosed(context.Context, string) (bool, error) { return false, nil }

// Si Redis cae entre la comprobación del handshake (que con Redis caído
// responde 503, ver TestClosedRoomCheckFailsClosed) y Connect, el socket ya
// aceptado se cierra con 1011.
func TestRedisDownClosesWithInternalError(t *testing.T) {
	s := newServerWithGate(t, time.Second, func(*store.Store) Gate { return passGate{} })
	s.mr.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, s.wsURL(room, token(t, "participant", room)), nil)
	if err != nil {
		t.Fatalf("la comprobación pasó: el handshake debe completarse: %v", err)
	}
	defer c.CloseNow()
	if _, _, err := c.Read(ctx); websocket.CloseStatus(err) != websocket.StatusInternalError {
		t.Errorf("cierre = %v, want internal error", err)
	}
}

// Prueba de concurrencia (SYNC-BE-01): 50 clientes reciben el mismo comando.
func TestConcurrentClients(t *testing.T) {
	s := newServer(t, time.Second)
	host := dial(t, s, "host")
	read(t, host)

	const n = 50
	conns := make([]*websocket.Conn, n)
	var wg sync.WaitGroup
	for i := range conns {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			c, _, err := websocket.Dial(ctx, s.wsURL(room, token(t, "participant", room)), nil)
			if err != nil {
				t.Errorf("dial %d: %v", i, err)
				return
			}
			conns[i] = c
		}(i)
	}
	wg.Wait()
	for _, c := range conns {
		if c == nil {
			t.FailNow()
		}
		defer c.CloseNow()
		read(t, c) // STATE
	}

	sendJSON(t, host, map[string]any{
		"event_id": "e-seek", "type": "SEEK", "room_id": room, "position_ms": 90_000,
		"occurred_at": time.Now().UTC().Format(time.RFC3339Nano),
	})
	for i, c := range conns {
		wg.Add(1)
		go func(i int, c *websocket.Conn) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			for {
				_, data, err := c.Read(ctx)
				if err != nil {
					t.Errorf("cliente %d: %v", i, err)
					return
				}
				var ev syncevent.Event
				_ = json.Unmarshal(data, &ev)
				if ev.Type == syncevent.Seek {
					if ev.PositionMs != 90_000 {
						t.Errorf("cliente %d: %+v", i, ev)
					}
					return
				}
			}
		}(i, c)
	}
	wg.Wait()
}

func tokenWithJTI(t *testing.T, jti string) string {
	t.Helper()
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "guest:" + jti, "room_id": room, "role": "participant", "jti": jti,
		"iss": "tint-identity", "aud": "tint:room", "exp": time.Now().Add(time.Hour).Unix(),
	}).SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

// F5: un token revocado abre el socket y se cierra de inmediato con 4001
// (el navegador solo ve el código si hubo upgrade; un 401 llega como 1006 y
// el cliente reconectaría para siempre). Uno vivo se cierra con 4001 al
// llegar REVOKED por el bus.
func TestRevokedTokens(t *testing.T) {
	s := newServer(t, time.Second)
	_ = s.mr.Set(syncevent.RevokedKey("j-old"), "1")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	old, _, err := websocket.Dial(ctx, s.wsURL(room, tokenWithJTI(t, "j-old")), nil)
	if err != nil {
		t.Fatalf("token revocado debe hacer upgrade: %v", err)
	}
	defer old.CloseNow()
	if _, data, err := old.Read(ctx); websocket.CloseStatus(err) != StatusRevoked {
		t.Errorf("token revocado: lectura = %q %v, want cierre %d sin STATE", data, err, StatusRevoked)
	}

	c, _, err := websocket.Dial(ctx, s.wsURL(room, tokenWithJTI(t, "j-live")), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	read(t, c) // STATE
	s.mr.Publish(syncevent.ChannelKey(room), `{"event_id":"r","type":"REVOKED","room_id":"room-1","jti":"j-live","position_ms":0,"version":0,"occurred_at":"2026-10-10T18:00:00Z","received_at":"2026-10-10T18:00:00Z"}`)
	for {
		if _, _, err := c.Read(ctx); err != nil {
			if websocket.CloseStatus(err) != StatusRevoked {
				t.Errorf("cierre = %v, want %d", err, StatusRevoked)
			}
			return
		}
	}
}

func expiredToken(t *testing.T, roomID string) string {
	t.Helper()
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "u-x", "room_id": roomID, "role": "participant", "jti": "j-exp",
		"iss": "tint-identity", "aud": "tint:room", "exp": time.Now().Add(-time.Minute).Unix(),
	}).SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

// Un token expirado pero bien firmado hace upgrade y se cierra con 4003
// (terminal: el cliente debe pedir otro token en lugar de reconectar).
func TestExpiredTokenClosesWith4003(t *testing.T) {
	s := newServer(t, time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, s.wsURL(room, expiredToken(t, room)), nil)
	if err != nil {
		t.Fatalf("token expirado debe hacer upgrade: %v", err)
	}
	defer c.CloseNow()
	if _, data, err := c.Read(ctx); websocket.CloseStatus(err) != StatusTokenExpired {
		t.Errorf("lectura = %q %v, want cierre %d", data, err, StatusTokenExpired)
	}
}

// Los cierres terminales no se saltan las demás validaciones del handshake.
func TestTerminalClosesKeepPreUpgradeChecks(t *testing.T) {
	s := newServer(t, time.Second)
	_ = s.mr.Set(syncevent.RevokedKey("j-old"), "1")
	evil := &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://evil.example"}}}
	tests := []struct {
		name string
		url  string
		opts *websocket.DialOptions
		want int
	}{
		{"revocado desde otro origen", s.wsURL(room, tokenWithJTI(t, "j-old")), evil, http.StatusForbidden},
		{"expirado desde otro origen", s.wsURL(room, expiredToken(t, room)), evil, http.StatusForbidden},
		{"expirado de otra sala", s.wsURL(room, expiredToken(t, "otra")), nil, http.StatusForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_, resp, err := websocket.Dial(ctx, tt.url, tt.opts)
			if err == nil || resp == nil || resp.StatusCode != tt.want {
				t.Errorf("err=%v resp=%v, want %d", err, resp, tt.want)
			}
		})
	}
}

func TestRevocationCheckFailsClosed(t *testing.T) {
	s := newServer(t, time.Second)
	s.mr.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, resp, err := websocket.Dial(ctx, s.wsURL(room, tokenWithJTI(t, "j-x")), nil); err == nil || resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("sin Redis no se puede verificar la revocación: err=%v resp=%v", err, resp)
	}
}

// O6: el subprotocolo tint.sync.msgpack activa frames binarios MessagePack.
func TestMsgPackSubprotocol(t *testing.T) {
	s := newServer(t, time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, s.wsURL(room, token(t, "host", room)), &websocket.DialOptions{
		Subprotocols: []string{codec.SubprotocolMsgPack},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if c.Subprotocol() != codec.SubprotocolMsgPack {
		t.Fatalf("subprotocolo = %q", c.Subprotocol())
	}
	typ, raw, err := c.Read(ctx)
	if err != nil || typ != websocket.MessageBinary {
		t.Fatalf("frame = %v %v", typ, err)
	}
	var st syncevent.Event
	if err := codec.MsgPack.Decode(raw, &st); err != nil || st.Type != syncevent.State {
		t.Fatalf("STATE msgpack = %+v (%v)", st, err)
	}
	cmd, _ := codec.MsgPack.Encode(syncevent.Event{EventID: "m1", Type: syncevent.Play, RoomID: room, OccurredAt: time.Now()})
	if err := c.Write(ctx, websocket.MessageBinary, cmd); err != nil {
		t.Fatal(err)
	}
	for {
		_, raw, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var ev syncevent.Event
		if codec.MsgPack.Decode(raw, &ev) == nil && ev.Type == syncevent.Ack {
			return
		}
	}
}
