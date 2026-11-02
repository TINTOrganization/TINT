// Package server — revocación de tokens de invitado (contrato con identity-api).
//
// identity-api revoca con SET token:revoked:{jti} (EXAT exp) y PUBLISH
// {"type":"REVOKED","jti":…} en room:{id}:sync. social-core comprueba la
// clave en el handshake y, por la suscripción de sala del relay, cierra con
// 4001 los sockets vivos de ese jti (borrar una sala revoca todos sus jti).
package server

import (
	"context"
	"net/http"
	"time"

	"nhooyr.io/websocket"
)

// Códigos de cierre terminales (dominio-transmision §6.1, ADR 0014/0019).
const (
	// StatusRevoked cierra una conexión cuyo token fue revocado (igual que sync-core).
	StatusRevoked websocket.StatusCode = 4001
	// StatusTokenExpired: el token, bien firmado y de esta sala, caducó.
	StatusTokenExpired websocket.StatusCode = 4003
	// StatusRoomDisabled: identity-api deshabilitó la sala (ROOM_CLOSED).
	StatusRoomDisabled websocket.StatusCode = 4010
)

// revocationTimeout acota el EXISTS del handshake.
const revocationTimeout = 2 * time.Second

// liveConn es una conexión local: revocable por jti y destinataria de los
// mensajes personalizados (trivia_result con my_score).
type liveConn struct {
	jti   string
	sub   string
	send  chan<- []byte
	close func(code websocket.StatusCode, reason string)
}

// checkRevoked consulta token:revoked:{jti}. Sin fuente de revocación
// (modo memoria, sin Redis) no hay nada que consultar.
func (d *Deps) checkRevoked(ctx context.Context, jti string) (bool, error) {
	if d.IsRevoked == nil || jti == "" {
		return false, nil
	}
	ctx, cancel := context.WithTimeout(ctx, revocationTimeout)
	defer cancel()
	return d.IsRevoked(ctx, jti)
}

// trackConn registra una conexión para poder revocarla; devuelve el untrack.
func (d *Deps) trackConn(roomID, connID string, lc liveConn) func() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.conns == nil {
		d.conns = make(map[string]map[string]liveConn)
	}
	room := d.conns[roomID]
	if room == nil {
		room = make(map[string]liveConn)
		d.conns[roomID] = room
	}
	room[connID] = lc
	return func() {
		d.mu.Lock()
		defer d.mu.Unlock()
		delete(d.conns[roomID], connID)
		if len(d.conns[roomID]) == 0 {
			delete(d.conns, roomID)
		}
	}
}

// revokeLocal cierra las conexiones locales de la sala con ese jti.
func (d *Deps) revokeLocal(roomID, jti string) {
	if jti == "" {
		return
	}
	d.closeLocal(roomID, StatusRevoked, "token revocado", func(c liveConn) bool { return c.jti == jti })
}

// closeRoomLocal cierra con 4010 todas las conexiones locales de la sala
// (ROOM_CLOSED; host incluido). Repetirlo no hace nada nuevo.
func (d *Deps) closeRoomLocal(roomID string) {
	d.closeLocal(roomID, StatusRoomDisabled, "sala deshabilitada", func(liveConn) bool { return true })
}

func (d *Deps) closeLocal(roomID string, code websocket.StatusCode, reason string, match func(liveConn) bool) {
	d.mu.Lock()
	var victims []func(websocket.StatusCode, string)
	for _, c := range d.conns[roomID] {
		if match(c) {
			victims = append(victims, c.close)
		}
	}
	d.mu.Unlock()
	for _, closeFn := range victims {
		closeFn(code, reason)
	}
}

// checkRoomClosed consulta room:{id}:closed. Sin Redis no hay fuente.
func (d *Deps) checkRoomClosed(ctx context.Context, roomID string) (bool, error) {
	if d.IsRoomClosed == nil {
		return false, nil
	}
	ctx, cancel := context.WithTimeout(ctx, revocationTimeout)
	defer cancel()
	return d.IsRoomClosed(ctx, roomID)
}

// acceptAndClose hace upgrade y cierra de inmediato con un código terminal
// (ADR 0014): rechazar antes del upgrade solo le muestra 1006 al navegador.
// El origen se comprueba igual en el upgrade (403 si no está permitido).
func (d *Deps) acceptAndClose(w http.ResponseWriter, r *http.Request, code websocket.StatusCode, reason string) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: d.AllowedOrigins})
	if err != nil {
		return
	}
	_ = c.Close(code, reason)
}
