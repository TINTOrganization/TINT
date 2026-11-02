// Package server — metadatos del chat en MongoDB (ADR 0025).
package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chatmeta"
)

const (
	// chatMetaBuffer es la cola en memoria del registrador: si Redis se
	// atrasa más de esto, los metadatos se descartan (y se cuentan).
	chatMetaBuffer         = 4096
	defaultRetentionDays   = 90
	chatMetaMongoURIEnv    = "MONGO_URI"
	chatMetaPepperEnv      = "CHAT_META_PEPPER"
	chatMetaRetentionEnv   = "CHAT_META_RETENTION_DAYS"
	chatMetaConsumerPrefix = "social-core-"
)

// chatMetaRuntime son las goroutines que Run arranca.
type chatMetaRuntime struct {
	recorder  *chatmeta.Recorder
	writer    *chatmeta.Writer
	retention time.Duration
}

func retentionDays(raw string) time.Duration {
	days, err := strconv.Atoi(raw)
	if err != nil || days <= 0 {
		days = defaultRetentionDays
	}
	return time.Duration(days) * 24 * time.Hour
}

// useChatMeta activa los metadatos si hay MONGO_URI y CHAT_META_PEPPER. Sin
// el secreto no se activan: nunca se seudonimiza con una clave vacía.
func (d *Deps) useChatMeta(getenv func(string) string, rdb *redis.Client) {
	uri, pepper := getenv(chatMetaMongoURIEnv), getenv(chatMetaPepperEnv)
	if uri == "" {
		return
	}
	if pepper == "" {
		slog.Error("MONGO_URI sin CHAT_META_PEPPER: no se guardan metadatos del chat")
		return
	}
	retention := retentionDays(getenv(chatMetaRetentionEnv))
	store, err := chatmeta.Open(uri, chatmeta.DatabaseName, retention)
	if err != nil {
		slog.Error("MONGO_URI inválida: no se guardan metadatos del chat", "error", err)
		return
	}
	recorder := chatmeta.NewRecorder(rdb, []byte(pepper), d.chatContext, chatMetaBuffer)
	writer := chatmeta.NewWriter(rdb, store, consumerName())
	d.chatMeta = &chatMetaRuntime{recorder: recorder, writer: writer, retention: retention}
	d.RecordChat = func(in chatmeta.Input) { recorder.Record(in) }
	d.ChatMetaHealth = writer.Status
}

func consumerName() string {
	if host, err := os.Hostname(); err == nil && host != "" {
		return chatMetaConsumerPrefix + host
	}
	return chatMetaConsumerPrefix + newUUID()
}

// chatContext lee el estado de la sala en el instante del mensaje. Nunca
// falla: lo que no se pueda leer queda vacío.
func (d *Deps) chatContext(ctx context.Context, roomID string, at time.Time) chatmeta.Context {
	var c chatmeta.Context
	live := false
	if d.IsLive == nil {
		c.RoomKind = "watch"
	} else if l, err := d.IsLive(ctx, roomID); err == nil {
		live = l
		c.RoomKind = "watch"
		if live {
			c.RoomKind = "live"
		}
	}
	switch {
	case live && d.StreamStartedAt != nil:
		if start, ok, err := d.StreamStartedAt(ctx, roomID); err == nil && ok && at.UnixMilli() >= start {
			offset := at.UnixMilli() - start
			c.StreamOffsetMS = &offset
		}
	case !live && c.RoomKind == "watch" && d.Recap != nil:
		if p, ok, err := d.Recap.Position(ctx, roomID, at); err == nil && ok {
			pos := p.PositionMS
			c.PositionMS = &pos
		}
	}
	if d.Moderation != nil {
		if s, err := d.Moderation.Settings(ctx, roomID); err == nil {
			c.SlowModeS = s.SlowModeS
		}
	}
	return c
}

// recordChat registra un intento de envío sin bloquear el chat.
func (d *Deps) recordChat(claims auth.Claims, in chatmeta.Input) {
	if d.RecordChat == nil {
		return
	}
	in.Subject, in.Nick, in.Role = claims.Subject, claims.Nick, claims.Role
	in.IsGuest = claims.IsGuest && claims.Role == "participant"
	d.RecordChat(in)
}

// healthz responde siempre 200: los metadatos del chat son opcionales y su
// estado se informa aparte (degraded si MongoDB o la cola fallan).
func (d *Deps) healthz(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{"status": "ok", "service": "social-core"}
	if d.ChatMetaHealth != nil {
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		meta := map[string]any{"status": "ok"}
		h, err := d.ChatMetaHealth(ctx)
		switch {
		case err != nil:
			meta["status"], meta["backlog"] = "degraded", -1
		default:
			if h.Degraded {
				meta["status"] = "degraded"
			}
			meta["backlog"] = h.Backlog
		}
		body["chat_meta"] = meta
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(body)
}
