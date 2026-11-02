// Command sync-core expone el canal de sincronización de reproducción de TINT.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/logging"
	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/server"
)

func main() {
	if _, err := logging.Setup("sync-core", os.Getenv("LOG_LEVEL")); err != nil {
		slog.Error("configuración inválida", "error", err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := server.Run(ctx, os.Getenv); err != nil {
		slog.Error("sync-core terminó con error", "error", err)
		os.Exit(1)
	}
}
