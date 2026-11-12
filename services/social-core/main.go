// Command social-core expone el Canal Social (/ws/social) de TINT: chat en vivo.
package main

import (
	"log/slog"
	"os"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/logging"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/server"
)

func main() {
	if _, err := logging.Setup("social-core", os.Getenv("LOG_LEVEL")); err != nil {
		slog.Error("configuración inválida", "error", err)
		os.Exit(2)
	}
	if err := server.Run(os.Getenv); err != nil {
		slog.Error("social-core terminó con error", "error", err)
		os.Exit(1)
	}
}
