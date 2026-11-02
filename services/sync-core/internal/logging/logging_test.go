package logging

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

func TestParseLevel(t *testing.T) {
	tests := []struct {
		raw   string
		want  slog.Level
		fails bool
	}{
		{"", slog.LevelInfo, false},
		{"info", slog.LevelInfo, false},
		{"DEBUG", slog.LevelDebug, false},
		{" Warn ", slog.LevelWarn, false},
		{"error", slog.LevelError, false},
		{"verbose", 0, true},
	}
	for _, tt := range tests {
		got, err := ParseLevel(tt.raw)
		if tt.fails {
			if err == nil {
				t.Fatalf("ParseLevel(%q) debía fallar", tt.raw)
			}
			continue
		}
		if err != nil {
			t.Fatalf("ParseLevel(%q): %v", tt.raw, err)
		}
		if got != tt.want {
			t.Fatalf("ParseLevel(%q) = %v, want %v", tt.raw, got, tt.want)
		}
	}
}

func TestNewHandlerEmitsContractJSON(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(NewHandler(&buf, slog.LevelInfo)).With("service", "sync-core")

	logger.Info("http_request", "correlation_id", "trace-1", "duration_ms", 3)

	var entry map[string]any
	if err := json.Unmarshal(buf.Bytes(), &entry); err != nil {
		t.Fatalf("salida no es JSON: %v (%q)", err, buf.String())
	}
	for _, key := range []string{"timestamp", "level", "service", "message"} {
		if _, ok := entry[key]; !ok {
			t.Fatalf("falta %q en %v", key, entry)
		}
	}
	if entry["level"] != "info" || entry["service"] != "sync-core" || entry["message"] != "http_request" {
		t.Fatalf("campos inesperados: %v", entry)
	}
	if entry["correlation_id"] != "trace-1" {
		t.Fatalf("falta el contexto: %v", entry)
	}
}

func TestNewHandlerFiltersBelowLevel(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(NewHandler(&buf, slog.LevelWarn))

	logger.Debug("hidden")
	logger.Info("hidden")
	logger.Warn("shown")
	logger.Error("shown")

	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("esperaba 2 líneas, hay %d: %q", len(lines), buf.String())
	}
	for _, line := range lines {
		if !strings.Contains(line, `"level":"warn"`) && !strings.Contains(line, `"level":"error"`) {
			t.Fatalf("nivel inesperado en %q", line)
		}
	}
}
