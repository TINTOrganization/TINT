package server

import (
	"strings"
	"testing"
	"time"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/chat"
)

func TestDefaultDepsMemoryAndRedis(t *testing.T) {
	mem := DefaultDeps(func(string) string { return "" })
	if mem.Hub == nil || mem.History == nil {
		t.Fatal("deps memoria incompletas")
	}
	if mem.Publish != nil || mem.Subscribe != nil || mem.TrackChat != nil || mem.TrackPresence != nil || mem.TrackReaction != nil || mem.analytics != nil {
		t.Fatal("sin REDIS_URL no debe haber publish/subscribe/track")
	}
	withRedis := DefaultDeps(func(k string) string {
		if k == "REDIS_URL" {
			return "redis://localhost:6379"
		}
		return ""
	})
	if withRedis.Publish == nil || withRedis.Subscribe == nil || withRedis.TrackChat == nil || withRedis.TrackPresence == nil || withRedis.TrackReaction == nil || withRedis.analytics == nil {
		t.Fatal("con REDIS_URL debe cablear publish/subscribe/track")
	}
	bad := DefaultDeps(func(k string) string {
		if k == "REDIS_URL" {
			return "://mal"
		}
		return ""
	})
	if bad.Publish != nil {
		t.Fatal("URL mala debe caer a memoria")
	}
}

func TestDepsDefaults(t *testing.T) {
	d := &Deps{Hub: chat.NewHub(), History: chat.NewMemoryStore(0)}
	if d.now().IsZero() {
		t.Fatal("now() default no debe ser cero")
	}
	a, b := d.newID(), d.newID()
	if a == "" || a == b || !strings.Contains(a, "-") {
		t.Fatalf("newID() = %q, %q, want uuid distintos", a, b)
	}
	if (&Deps{}).now().IsZero() {
		t.Fatal("now nil debe usar reloj real")
	}
	_ = time.Now
}

func TestDefaultDepsConfiguresReactionLimits(t *testing.T) {
	env := map[string]string{
		"SOCIAL_REACTION_LIMIT":     "2",
		"SOCIAL_REACTION_IP_LIMIT":  "3",
		"SOCIAL_REACTION_WINDOW_MS": "2000",
	}
	d := DefaultDeps(func(key string) string { return env[key] })
	base := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)

	for i := 0; i < 2; i++ {
		if !d.ReactionLimit.Allow("user", base) {
			t.Fatalf("user reaction %d should be allowed", i+1)
		}
	}
	if allowed, retry := d.ReactionLimit.AllowWithRetry("user", base); allowed || retry != 2*time.Second {
		t.Fatalf("user config = allowed %v, retry %v; want false, 2s", allowed, retry)
	}

	for i := 0; i < 3; i++ {
		if !d.ReactionIPLimit.Allow("ip", base) {
			t.Fatalf("IP reaction %d should be allowed", i+1)
		}
	}
	if allowed, retry := d.ReactionIPLimit.AllowWithRetry("ip", base); allowed || retry != 2*time.Second {
		t.Fatalf("IP config = allowed %v, retry %v; want false, 2s", allowed, retry)
	}
}
