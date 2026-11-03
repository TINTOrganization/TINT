// Package logging configura los logs JSON de sync-core (ADR 0021).
package logging

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
)

// ParseLevel convierte LOG_LEVEL en un nivel de slog. Vacío = info.
func ParseLevel(raw string) (slog.Level, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "info":
		return slog.LevelInfo, nil
	case "debug":
		return slog.LevelDebug, nil
	case "warn":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("LOG_LEVEL inválido: %q (usa debug|info|warn|error)", raw)
	}
}

// NewHandler devuelve un handler JSON con las claves del contrato:
// timestamp, level, service y message.
func NewHandler(w io.Writer, level slog.Level) slog.Handler {
	return slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: level,
		ReplaceAttr: func(_ []string, attr slog.Attr) slog.Attr {
			switch attr.Key {
			case slog.TimeKey:
				attr.Key = "timestamp"
			case slog.MessageKey:
				attr.Key = "message"
			case slog.LevelKey:
				if value, ok := attr.Value.Any().(slog.Level); ok {
					attr.Value = slog.StringValue(strings.ToLower(value.String()))
				}
			}
			return attr
		},
	})
}

// Setup valida el nivel, configura el logger por defecto y devuelve el logger.
func Setup(service, raw string) (*slog.Logger, error) {
	level, err := ParseLevel(raw)
	if err != nil {
		return nil, err
	}
	logger := slog.New(NewHandler(os.Stdout, level)).With("service", service)
	slog.SetDefault(logger)
	return logger, nil
}
