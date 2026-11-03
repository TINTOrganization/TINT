// Package server — historial del chat por REST para el host (ADR 0019).
//
// GET /api/v1/social/rooms/{id}/chat devuelve los chat_message de la sala
// (del más antiguo al más nuevo, máx. ChatRESTLimit) al host o cohost con
// el sync-ticket HS256 de esa sala, también con la sala deshabilitada
// (HU-LIVE-09 AC3): lee mientras dure la clave de Redis (12 h).
package server

import (
	"errors"
	"net/http"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/auth"
	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
)

// ChatRESTLimit es el máximo de mensajes de GET …/chat; también es lo que
// guarda Redis por sala (el WebSocket sigue enviando los últimos 50).
const ChatRESTLimit = 100

type chatHistoryResponse struct {
	RoomID   string                    `json:"room_id"`
	Messages []socialevent.ChatMessage `json:"messages"`
}

func restError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

func (d *Deps) handleChatHistory(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	roomID := r.PathValue("roomID")
	token, err := auth.BearerToken(r.Header.Get("Authorization"), "")
	if err != nil {
		restError(w, http.StatusUnauthorized, "UNAUTHORIZED")
		return
	}
	claims, err := d.authenticate(ctx, token, roomID)
	switch {
	case errors.Is(err, auth.ErrWrongRoom):
		restError(w, http.StatusForbidden, "FORBIDDEN")
		return
	case err != nil:
		// Firma inválida, caducado o sin firma: nunca se confía en él.
		restError(w, http.StatusUnauthorized, "UNAUTHORIZED")
		return
	}
	if !isModerator(claims, roomID) {
		restError(w, http.StatusForbidden, "FORBIDDEN")
		return
	}
	// Sin Redis no hay historial compartido ni forma de comprobar la
	// revocación: falla cerrado.
	if d.IsRevoked == nil {
		restError(w, http.StatusServiceUnavailable, "UNAVAILABLE")
		return
	}
	revoked, err := d.checkRevoked(ctx, claims.JTI)
	if err != nil {
		restError(w, http.StatusServiceUnavailable, "UNAVAILABLE")
		return
	}
	if revoked {
		restError(w, http.StatusUnauthorized, "UNAUTHORIZED")
		return
	}
	msgs, err := d.History.Recent(ctx, roomID, ChatRESTLimit)
	if err != nil {
		restError(w, http.StatusServiceUnavailable, "UNAVAILABLE")
		return
	}
	if msgs == nil {
		msgs = []socialevent.ChatMessage{}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, chatHistoryResponse{RoomID: roomID, Messages: msgs})
}
