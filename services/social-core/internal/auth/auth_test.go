package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

func signGuest(payload map[string]any, secret string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	raw, _ := json.Marshal(payload)
	body := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(header + "." + body))
	return header + "." + body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

var guestCfg = GuestConfig{Secret: "secret", Issuer: "tint-identity", Audience: "tint:room"}

func guestClaims(now time.Time, mutate func(map[string]any)) map[string]any {
	c := map[string]any{
		"sub": "guest:1", "room_id": "r1", "role": "participant", "nick": "Invitado",
		"jti": "jti-1", "iss": "tint-identity", "aud": "tint:room",
		"iat": now.Unix(), "exp": now.Add(time.Hour).Unix(),
	}
	if mutate != nil {
		mutate(c)
	}
	return c
}

func TestVerifyGuestOKAndWrongRoom(t *testing.T) {
	now := time.Now()
	token := signGuest(guestClaims(now, nil), "secret")
	got, err := VerifyGuest(token, guestCfg, "r1", now)
	if err != nil {
		t.Fatalf("VerifyGuest = %v", err)
	}
	if got.Subject != "guest:1" || !got.IsGuest || got.Nick != "Invitado" || got.JTI != "jti-1" {
		t.Fatalf("claims = %+v", got)
	}
	if _, err := VerifyGuest(token, guestCfg, "otra", now); err != ErrWrongRoom {
		t.Fatalf("sala distinta debe dar ErrWrongRoom, got %v", err)
	}
	bad := guestCfg
	bad.Secret = "otra"
	if _, err := VerifyGuest(token, bad, "r1", now); err != ErrInvalidToken {
		t.Fatalf("firma mala debe dar ErrInvalidToken, got %v", err)
	}
	expired := signGuest(guestClaims(now, func(c map[string]any) { c["exp"] = now.Add(-time.Hour).Unix() }), "secret")
	if _, err := VerifyGuest(expired, guestCfg, "r1", now); err != ErrExpired {
		t.Fatalf("expirado debe dar ErrExpired, got %v", err)
	}
	// Caducado y de otra sala: ErrWrongRoom (403 sin upgrade, ADR 0014).
	if _, err := VerifyGuest(expired, guestCfg, "otra", now); err != ErrWrongRoom {
		t.Fatalf("expirado de otra sala debe dar ErrWrongRoom, got %v", err)
	}
	// aud como arreglo (RFC 7519) también vale si contiene la audiencia.
	arr := signGuest(guestClaims(now, func(c map[string]any) { c["aud"] = []string{"otra", "tint:room"} }), "secret")
	if _, err := VerifyGuest(arr, guestCfg, "r1", now); err != nil {
		t.Fatalf("aud arreglo = %v", err)
	}
}

// Sin jti el token no se puede revocar; sin iss/aud/exp no es de identity-api.
func TestVerifyGuestRequiresRegisteredClaims(t *testing.T) {
	now := time.Now()
	cases := map[string]func(map[string]any){
		"sin jti":        func(c map[string]any) { delete(c, "jti") },
		"sin exp":        func(c map[string]any) { delete(c, "exp") },
		"iss ajeno":      func(c map[string]any) { c["iss"] = "otro" },
		"sin iss":        func(c map[string]any) { delete(c, "iss") },
		"aud ajena":      func(c map[string]any) { c["aud"] = "otra" },
		"aud arreglo":    func(c map[string]any) { c["aud"] = []string{"otra"} },
		"aud no texto":   func(c map[string]any) { c["aud"] = 3 },
		"sin sub":        func(c map[string]any) { c["sub"] = "" },
		"payload basura": func(c map[string]any) { c["exp"] = "mañana" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := VerifyGuest(signGuest(guestClaims(now, mutate), "secret"), guestCfg, "r1", now); err == nil {
				t.Fatal("debe fallar")
			}
		})
	}
}

func TestGuestConfigDefaults(t *testing.T) {
	now := time.Now()
	token := signGuest(guestClaims(now, nil), "secret")
	if _, err := VerifyGuest(token, GuestConfig{Secret: "secret"}, "r1", now); err != nil {
		t.Fatalf("iss/aud por defecto (tint-identity, tint:room) = %v", err)
	}
}

func TestVerifyGuestRejectsEmptySecret(t *testing.T) {
	now := time.Now()
	token := signGuest(guestClaims(now, nil), "")
	if _, err := VerifyGuest(token, GuestConfig{}, "r1", now); err != ErrInvalidToken {
		t.Fatalf("secreto vacío debe fallar cerrado, got %v", err)
	}
}

func TestBearerToken(t *testing.T) {
	got, err := BearerToken("Bearer abc", "")
	if err != nil || got != "abc" {
		t.Fatalf("header = %q, %v", got, err)
	}
	got, err = BearerToken("", "q123")
	if err != nil || got != "q123" {
		t.Fatalf("query = %q, %v", got, err)
	}
	if _, err := BearerToken("", ""); err != ErrMissingToken {
		t.Fatalf("sin token debe dar ErrMissingToken, got %v", err)
	}
}
