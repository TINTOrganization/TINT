// Package auth valida tokens de host (Firebase) e invitado para /ws/social.
//
// Guest tokens: HS256 con el JWT_SECRET compartido con identity-api.
// Host tokens: Firebase ID tokens RS256 verificados contra los certificados
// públicos de Google (ver firebase.go). Ante cualquier duda, se rechaza.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// Claims mínimos necesarios para el chat.
type Claims struct {
	Subject string
	RoomID  string
	Role    string
	Nick    string
	IsGuest bool
	// JTI identifica el token HS256: permite revocarlo (token:revoked:{jti}).
	JTI string
}

var (
	ErrMissingToken = errors.New("falta token")
	ErrInvalidToken = errors.New("token inválido")
	ErrExpired      = errors.New("token expirado")
	ErrWrongRoom    = errors.New("token no pertenece a esta sala")
)

// Valores por defecto del contrato JWT con identity-api (JWT_ISSUER/JWT_AUDIENCE).
const (
	DefaultIssuer   = "tint-identity"
	DefaultAudience = "tint:room"
)

// GuestConfig es el contrato compartido con identity-api para tokens HS256.
type GuestConfig struct {
	Secret   string
	Issuer   string // vacío = DefaultIssuer
	Audience string // vacío = DefaultAudience
}

type guestPayload struct {
	Sub    string          `json:"sub"`
	RoomID string          `json:"room_id"`
	Role   string          `json:"role"`
	Nick   string          `json:"nick"`
	JTI    string          `json:"jti"`
	Iss    string          `json:"iss"`
	Aud    json.RawMessage `json:"aud"`
	Exp    int64           `json:"exp"`
}

// hasAudience acepta aud como texto o arreglo de textos (RFC 7519 §4.1.3).
func hasAudience(raw json.RawMessage, want string) bool {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return one == want
	}
	var many []string
	if json.Unmarshal(raw, &many) != nil {
		return false
	}
	for _, a := range many {
		if a == want {
			return true
		}
	}
	return false
}

// VerifyGuest verifica un token HS256 emitido por identity-api: firma, iss,
// aud, exp obligatorio, sub y jti no vacíos y que sea de wantRoom.
func VerifyGuest(token string, cfg GuestConfig, wantRoom string, now time.Time) (Claims, error) {
	secret := cfg.Secret
	parts := strings.Split(token, ".")
	if len(parts) != 3 || secret == "" {
		return Claims{}, ErrInvalidToken
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	wantSig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(wantSig), []byte(parts[2])) {
		return Claims{}, ErrInvalidToken
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return Claims{}, ErrInvalidToken
	}
	var p guestPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return Claims{}, ErrInvalidToken
	}
	issuer, audience := cfg.Issuer, cfg.Audience
	if issuer == "" {
		issuer = DefaultIssuer
	}
	if audience == "" {
		audience = DefaultAudience
	}
	if p.Sub == "" || p.JTI == "" || p.Iss != issuer || !hasAudience(p.Aud, audience) || p.Exp == 0 {
		return Claims{}, ErrInvalidToken
	}
	// La sala va antes que exp: ErrExpired solo sale para un token bien
	// firmado y de esta sala, que el handshake cierra con 4003 tras el
	// upgrade (ADR 0014); el de otra sala sigue siendo 403 sin upgrade.
	if wantRoom != "" && p.RoomID != wantRoom {
		return Claims{}, ErrWrongRoom
	}
	if now.Unix() > p.Exp {
		return Claims{}, ErrExpired
	}
	return Claims{Subject: p.Sub, RoomID: p.RoomID, Role: p.Role, Nick: p.Nick, IsGuest: true, JTI: p.JTI}, nil
}

// BearerToken extrae el token de un header Authorization o query ?token=.
func BearerToken(header, query string) (string, error) {
	if strings.HasPrefix(header, "Bearer ") && len(header) > 7 {
		return strings.TrimSpace(header[7:]), nil
	}
	if query != "" {
		return query, nil
	}
	return "", ErrMissingToken
}
