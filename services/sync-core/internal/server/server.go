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
	shutdownTimeout = 10 * time.Second
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
		Handler:           NewRouter(ws.NewHandler(h, verifier, st, cfg.AllowedOrigins), reg.Handler()),
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
			return err
		}
		return nil
	}
}

// NewRouter construye el router HTTP del servicio. /metrics expone métricas
// Prometheus: en producción debe quedar detrás del ingress, no público.
func NewRouter(sync, metrics http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", healthz)
	mux.Handle("GET /ws/sync", sync)
	mux.Handle("GET /metrics", metrics)
	return withCorrelation(mux)
}

func healthz(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok", "service": "sync-core"})
}
