package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/config"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/store"
)

func TestHealthz(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set("X-Correlation-ID", "trace-123")
	NewRouter(http.NotFoundHandler(), http.NotFoundHandler()).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if body["status"] != "ok" || body["service"] != "sync-core" {
		t.Errorf("unexpected body: %v", body)
	}
	if got := rec.Header().Get("X-Correlation-ID"); got != "trace-123" {
		t.Errorf("correlation ID = %q, want trace-123", got)
	}
}

func TestHealthzGeneratesCorrelationID(t *testing.T) {
	rec := httptest.NewRecorder()
	NewRouter(http.NotFoundHandler(), http.NotFoundHandler()).ServeHTTP(
		rec,
		httptest.NewRequest(http.MethodGet, "/healthz", nil),
	)
	if got := rec.Header().Get("X-Correlation-ID"); got == "" {
		t.Fatal("expected generated correlation ID")
	}
}

func TestHealthzRejectsPost(t *testing.T) {
	rec := httptest.NewRecorder()
	NewRouter(http.NotFoundHandler(), http.NotFoundHandler()).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/healthz", nil))

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

func TestWSRouteDelegatesToSyncHandler(t *testing.T) {
	sync := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	rec := httptest.NewRecorder()
	NewRouter(sync, http.NotFoundHandler()).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ws/sync?room_id=x", nil))
	if rec.Code != http.StatusTeapot {
		t.Errorf("GET /ws/sync status = %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	NewRouter(sync, http.NotFoundHandler()).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/ws/sync", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /ws/sync status = %d", rec.Code)
	}
}

func TestInternalEventStartAndStop(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	st := store.New(rdb, time.Hour)
	router := NewRouterWithDeps(http.NotFoundHandler(), http.NotFoundHandler(), st)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/internal/events/start/room-1", strings.NewReader(`{"hostId":"host-1"}`))
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("start status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["roomId"] != "room-1" || body["sessionId"] != "sync-room-1" {
		t.Fatalf("unexpected start body: %v", body)
	}

	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/internal/events/start/room-1", nil))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("stop status = %d, body = %s", rec.Code, rec.Body.String())
	}
}

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestRunFailsFast(t *testing.T) {
	mr := miniredis.RunT(t)
	tests := []struct {
		name string
		env  map[string]string
		want error
	}{
		{"sin JWT_SECRET", map[string]string{}, config.ErrMissingSecret},
		{"REDIS_URL inválida", map[string]string{"JWT_SECRET": "x", "REDIS_URL": "nope://"}, nil},
		{"Redis inalcanzable", map[string]string{"JWT_SECRET": "x", "REDIS_URL": "redis://127.0.0.1:1"}, nil},
		{"dirección inválida", map[string]string{"JWT_SECRET": "x", "REDIS_URL": "redis://" + mr.Addr(), "SYNC_CORE_ADDR": "invalid-addr"}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := Run(context.Background(), env(tt.env))
			if err == nil {
				t.Fatal("Run debía fallar")
			}
			if tt.want != nil && !errors.Is(err, tt.want) {
				t.Errorf("err = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestRunServesAndShutsDownGracefully(t *testing.T) {
	mr := miniredis.RunT(t)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	_ = l.Close()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- Run(ctx, env(map[string]string{"JWT_SECRET": "x", "REDIS_URL": "redis://" + mr.Addr(), "SYNC_CORE_ADDR": addr}))
	}()

	deadline := time.Now().Add(3 * time.Second)
	for {
		resp, err := http.Get("http://" + addr + "/healthz")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("el servidor no respondió: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	resp, err := http.Get("http://" + addr + "/ws/sync")
	if err != nil || resp.StatusCode != http.StatusBadRequest {
		t.Errorf("/ws/sync sin parámetros: %v %v", resp, err)
	}
	if resp != nil {
		_ = resp.Body.Close()
	}
	resp, err = http.Get("http://" + addr + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	for _, want := range []string{"sync_connections 0", "sync_store_conflicts_total 0", "sync_telemetry_dropped_total 0"} {
		if !strings.Contains(string(body), want) {
			t.Errorf("/metrics sin %q", want)
		}
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("apagado ordenado debe devolver nil, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run no terminó tras cancelar el contexto")
	}
}

func TestMetricsRoute(t *testing.T) {
	m := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(299) })
	rec := httptest.NewRecorder()
	NewRouter(http.NotFoundHandler(), m).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != 299 {
		t.Errorf("GET /metrics debe delegar en el handler de métricas: %d", rec.Code)
	}
}
