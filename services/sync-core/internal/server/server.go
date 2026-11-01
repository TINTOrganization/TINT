// Package server define las rutas HTTP de sync-core y arma sus dependencias.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/bus"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/config"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/hub"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/store"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/telemetry"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/ws"
)

const (
	telemetryBuffer = 1024
	startupTimeout  = 3 * time.Second
	shutdownTimeout = 3 * time.Second
)

// Run arranca el servicio y bloquea hasta que falle o ctx se cancele, en
// cuyo caso apaga el servidor HTTP de forma ordenada.
func Run(ctx context.Context, getenv func(string) string) error {
	cfg, err := config.Load(getenv)
	if err != nil {
		return err
	}
	opts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return fmt.Errorf("REDIS_URL: %w", err)
	}
	rdb := redis.NewClient(opts)
	defer rdb.Close()
	pingCtx, cancelPing := context.WithTimeout(ctx, startupTimeout)
	defer cancelPing()
	if err := rdb.Ping(pingCtx).Err(); err != nil {
		return fmt.Errorf("redis no disponible: %w", err)
	}

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	b := bus.New(rdb)
	tel := telemetry.New(rdb, telemetryBuffer)
	st := store.New(rdb, cfg.RoomTTL)
	h := hub.New(st, b, tel).WithHandoff(cfg.HandoffAfter)
	b.Start(runCtx, h.Deliver)
	defer b.Close()
	go tel.Run(runCtx)
	go h.Run(runCtx)
	reg := h.Registry()
	reg.CounterFunc("sync_store_conflicts_total", "Reintentos de escritura por conflicto entre réplicas.", func() float64 { return float64(st.Conflicts()) })
	reg.CounterFunc("sync_telemetry_dropped_total", "Muestras de drift descartadas por buffer lleno.", func() float64 { return float64(tel.Dropped()) })
	reg.CounterFunc("sync_telemetry_failed_total", "Muestras de drift que no se pudieron escribir en Redis.", func() float64 { return float64(tel.Failed()) })

	verifier := auth.NewVerifier(cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience)
	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           NewRouterWithDeps(ws.NewHandler(h, verifier, st, cfg.AllowedOrigins), reg.Handler(), st),
		ReadHeaderTimeout: 5 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		log.Printf("sync-core escuchando en %s", cfg.Addr)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		// Shutdown no espera los WebSockets (conexiones secuestradas): los
		// clientes reconectan y reciben STATE desde Redis en otra réplica.
		shutCtx, cancelShut := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancelShut()
		if err := srv.Shutdown(shutCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
			// Shutdown no cierra conexiones que hayan sido secuestradas por
			// WebSocket. Fuerza el cierre al vencer el deadline para que una
			// conexión defectuosa no impida apagar la réplica.
			if closeErr := srv.Close(); closeErr != nil && !errors.Is(closeErr, http.ErrServerClosed) {
				return fmt.Errorf("shutdown: %w; close: %v", err, closeErr)
			}
		}
		return nil
	}
}

// NewRouter construye el router HTTP del servicio. /metrics expone métricas
// Prometheus: en producción debe quedar detrás del ingress, no público.
func NewRouter(sync, metrics http.Handler) http.Handler {
	return NewRouterWithDeps(sync, metrics, nil)
}

func NewRouterWithDeps(sync, metrics http.Handler, st *store.Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthz)
	mux.Handle("GET /ws/sync", sync)
	mux.Handle("GET /metrics", metrics)
	if st != nil {
		mux.HandleFunc("POST /internal/events/start", startEvent(st))
		mux.HandleFunc("POST /internal/events/start/{roomID}", startEvent(st))
		mux.HandleFunc("DELETE /internal/events/start/{roomID}", stopEvent(st))
	}
	return withCorrelation(mux)
}

func startEvent(st *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			RoomID string `json:"roomId"`
			HostID string `json:"hostId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			http.Error(w, "roomId y hostId son obligatorios", http.StatusBadRequest)
			return
		}
		if input.RoomID == "" {
			input.RoomID = r.PathValue("roomID")
		}
		if input.RoomID == "" || input.HostID == "" {
			http.Error(w, "roomId y hostId son obligatorios", http.StatusBadRequest)
			return
		}
		state, err := st.Init(r.Context(), input.RoomID, input.HostID, time.Now().UnixMilli())
		if err != nil {
			http.Error(w, "no se pudo iniciar sync", http.StatusServiceUnavailable)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"roomId":    input.RoomID,
			"sessionId": "sync-" + input.RoomID,
			"wsUrl":     "/ws/sync?room_id=" + input.RoomID,
			"state":     state,
		})
	}
}

func stopEvent(st *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if roomID := r.PathValue("roomID"); roomID == "" {
			http.Error(w, "roomId es obligatorio", http.StatusBadRequest)
			return
		} else if err := st.Remove(r.Context(), roomID); err != nil {
			http.Error(w, "no se pudo compensar sync", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "service": "sync-core"})
}
