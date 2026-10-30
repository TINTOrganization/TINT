#!/usr/bin/env python3
"""Prueba rápida de voice-core contra el servicio levantado (docker compose up -d voice-core).

Solo usa la biblioteca estándar: fabrica los JWT con JWT_SECRET, habla WebSocket, HTTP y
RESP (Redis) a mano. Comprueba HU-VOZ-01, 02, 04 y 05 (TURN contra coturn) de punta a punta salvo el audio,
que es de la web.

    python3 services/voice-core/scripts/smoke.py

Variables: VOICE_URL (http://localhost:8085), REDIS_HOST/REDIS_PORT (localhost:6379),
TURN_HOST/TURN_PORT (127.0.0.1:3478),
JWT_SECRET (si falta, se lee del .env de la raíz o se usa el valor por defecto de compose).
"""

import base64
import hashlib
import hmac
import json
import os
import pathlib
import socket
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

VOICE_URL = os.environ.get("VOICE_URL", "http://localhost:8085")
REDIS_HOST = os.environ.get("REDIS_HOST", "localhost")
REDIS_PORT = int(os.environ.get("REDIS_PORT", "6379"))
TURN_ADDR = (os.environ.get("TURN_HOST", "127.0.0.1"), int(os.environ.get("TURN_PORT", "3478")))
TIMEOUT = 5.0


def jwt_secret():
    if os.environ.get("JWT_SECRET"):
        return os.environ["JWT_SECRET"]
    env_file = pathlib.Path(__file__).resolve().parents[3] / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("JWT_SECRET="):
                return line.split("=", 1)[1].strip().strip('"')
    return "dev-secret-change-in-prod"


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_token(room_id, nick, role="participant", jti=None, exp_in=3600, secret=None, sub=None):
    claims = {
        "sub": sub or f"u-{nick.lower()}-{uuid.uuid4().hex[:6]}",
        "room_id": room_id,
        "role": role,
        "nick": nick,
        "jti": jti or uuid.uuid4().hex,
        "iss": os.environ.get("JWT_ISSUER", "tint-identity"),
        "aud": os.environ.get("JWT_AUDIENCE", "tint:room"),
        "exp": int(time.time()) + exp_in,
    }
    head = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = b64url(json.dumps(claims).encode())
    sig = hmac.new((secret or jwt_secret()).encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"{head}.{body}.{b64url(sig)}", claims


# --- Redis (RESP mínimo) -------------------------------------------------------------------


def redis(*args):
    with socket.create_connection((REDIS_HOST, REDIS_PORT), timeout=TIMEOUT) as s:
        cmd = f"*{len(args)}\r\n" + "".join(f"${len(str(a).encode())}\r\n{a}\r\n" for a in args)
        s.sendall(cmd.encode())
        reply = s.recv(4096).decode()
        if reply.startswith("-"):
            raise RuntimeError(f"Redis: {reply.strip()}")
        return reply


# --- TURN (Allocate mínimo, RFC 5766 con autenticación de largo plazo) ---------------------


def turn_allocate(username, password):
    """Pide un relay UDP a coturn. Devuelve el código STUN: 0 si lo concedió, 401/438/… si no."""

    def attr(t, value):
        pad = (4 - len(value) % 4) % 4
        return struct.pack("!HH", t, len(value)) + value + b"\0" * pad

    def message(attrs, integrity_key=None):
        tid = os.urandom(12)
        body = b"".join(attrs)
        if integrity_key:
            # La longitud del encabezado ya cuenta el MESSAGE-INTEGRITY (24 bytes).
            head = struct.pack("!HHI", 0x0003, len(body) + 24, 0x2112A442) + tid
            mac = hmac.new(integrity_key, head + body, hashlib.sha1).digest()
            body += attr(0x0008, mac)
        return struct.pack("!HHI", 0x0003, len(body), 0x2112A442) + tid + body

    def parse(data):
        msg_type, length = struct.unpack("!HH", data[:4])
        attrs, i = {}, 20
        while i < 20 + length:
            t, n = struct.unpack("!HH", data[i : i + 4])
            attrs[t] = data[i + 4 : i + 4 + n]
            i += 4 + n + (4 - n % 4) % 4
        return msg_type, attrs

    transport = attr(0x0019, bytes([17, 0, 0, 0]))  # REQUESTED-TRANSPORT: UDP
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(TIMEOUT)
        s.sendto(message([transport]), TURN_ADDR)
        _, attrs = parse(s.recv(2048))  # 401 con REALM y NONCE
        realm, nonce = attrs[0x0014], attrs[0x0015]
        key = hashlib.md5(username.encode() + b":" + realm + b":" + password.encode()).digest()
        s.sendto(
            message([transport, attr(0x0006, username.encode()), attr(0x0014, realm), attr(0x0015, nonce)], key),
            TURN_ADDR,
        )
        msg_type, attrs = parse(s.recv(2048))
        if msg_type == 0x0103:  # Allocate success
            return 0
        err = attrs.get(0x0009, b"\0\0\0\0")
        return err[2] * 100 + err[3]


# --- WebSocket (cliente mínimo, RFC 6455) --------------------------------------------------


class HandshakeRejected(Exception):
    def __init__(self, status):
        super().__init__(f"HTTP {status}")
        self.status = status


class WS:
    def __init__(self, room_id, token, origin=None):
        u = urllib.parse.urlparse(VOICE_URL)
        self.sock = socket.create_connection((u.hostname, u.port or 80), timeout=TIMEOUT)
        query = urllib.parse.urlencode({"room_id": room_id, "token": token})
        key = base64.b64encode(os.urandom(16)).decode()
        lines = [
            f"GET /ws/voice?{query} HTTP/1.1",
            f"Host: {u.hostname}:{u.port}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
        ]
        if origin:
            lines.append(f"Origin: {origin}")
        self.sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(1)
            if not chunk:
                raise ConnectionError("el servidor cerró durante el handshake")
            head += chunk
        status = int(head.split(b" ", 2)[1])
        if status != 101:
            self.sock.close()
            raise HandshakeRejected(status)
        self.close_code = None

    def _recv_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("conexión cerrada")
            buf += chunk
        return buf

    def _send_frame(self, opcode, payload):
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            header = struct.pack("!BB", 0x80 | opcode, 0x80 | n)
        elif n < 65536:
            header = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, n)
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def send(self, obj):
        self._send_frame(0x1, json.dumps(obj).encode())

    def recv(self):
        """Devuelve el siguiente mensaje JSON, o None si el servidor cerró (close_code queda puesto)."""
        while True:
            b1, b2 = self._recv_exact(2)
            opcode, n = b1 & 0x0F, b2 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._recv_exact(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._recv_exact(8))[0]
            payload = self._recv_exact(n)
            if opcode == 0x1:
                return json.loads(payload)
            if opcode == 0x8:
                self.close_code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1005
                return None
            if opcode == 0x9:  # ping → pong
                self._send_frame(0xA, payload)

    def recv_type(self, wanted):
        msg = self.recv()
        if msg is None or msg.get("type") != wanted:
            raise AssertionError(f"esperaba {wanted}, llegó {msg if msg else f'cierre {self.close_code}'}")
        return msg

    def close(self):
        try:
            self._send_frame(0x8, struct.pack("!H", 1000))
        except OSError:
            pass
        self.sock.close()


def client_msg(type_, **fields):
    return {"type": type_, "event_id": uuid.uuid4().hex, "occurred_at": int(time.time() * 1000), **fields}


# --- Comprobaciones ------------------------------------------------------------------------

results = []


def check(name):
    def wrap(fn):
        try:
            fn()
            results.append((True, name, ""))
        except Exception as e:  # noqa: BLE001 — cualquier fallo se reporta y se sigue
            results.append((False, name, f"{type(e).__name__}: {e}"))
        return fn

    return wrap


ROOM = f"smoke-{uuid.uuid4().hex[:8]}"


@check("GET /healthz responde 200")
def _():
    with urllib.request.urlopen(f"{VOICE_URL}/healthz", timeout=TIMEOUT) as r:
        assert r.status == 200, r.status


@check("token con firma inválida → 401 antes del upgrade")
def _():
    token, _ = make_token(ROOM, "Mallory", secret="otro-secreto")
    try:
        WS(ROOM, token)
    except HandshakeRejected as e:
        assert e.status == 401, e.status
        return
    raise AssertionError("se aceptó el upgrade")


@check("room_id del token distinto al de la URL → 403")
def _():
    token, _ = make_token("otra-sala", "Ana")
    try:
        WS(ROOM, token)
    except HandshakeRejected as e:
        assert e.status == 403, e.status
        return
    raise AssertionError("se aceptó el upgrade")


@check("Origin no permitido → 403")
def _():
    token, _ = make_token(ROOM, "Ana")
    try:
        WS(ROOM, token, origin="http://evil.example")
    except HandshakeRejected as e:
        assert e.status == 403, e.status
        return
    raise AssertionError("se aceptó el upgrade")


@check("token caducado → upgrade y cierre 4003")
def _():
    token, _ = make_token(ROOM, "Ana", exp_in=-60)
    ws = WS(ROOM, token)
    assert ws.recv() is None and ws.close_code == 4003, ws.close_code


@check("AC1: entrar, peer_joined y reenvío de signal con from del servidor")
def _():
    ta, _ = make_token(ROOM, "Ana", role="host")
    tl, _ = make_token(ROOM, "Luis")
    ana = WS(ROOM, ta)
    sa = ana.recv_type("voice_state")
    assert sa["peers"] == [] and sa["self"]["nick"] == "Ana", sa
    assert "jti" not in json.dumps(sa), "voice_state expone el jti"
    luis = WS(ROOM, tl)
    sl = luis.recv_type("voice_state")
    assert [p["nick"] for p in sl["peers"]] == ["Ana"], sl["peers"]
    joined = ana.recv_type("peer_joined")
    assert joined["peer"]["peer_id"] == sl["self"]["peer_id"], joined

    # El que llega ofrece; from lo fija el servidor aunque el cliente intente otro.
    luis.send(client_msg("signal", to=sa["self"]["peer_id"], data={"sdp": {"type": "offer", "sdp": "v=0"}},
                         **{"from": "suplantado"}))
    sig = ana.recv_type("signal")
    assert sig["from"] == sl["self"]["peer_id"] and sig["data"]["sdp"]["type"] == "offer", sig

    luis.send(client_msg("signal", to="no-existe", data={}))
    err = luis.recv_type("error")
    assert err["code"] == "PEER_NOT_FOUND", err

    # AC3: al salir, el otro recibe peer_left.
    luis.send(client_msg("leave"))
    assert luis.recv() is None and luis.close_code == 1000, luis.close_code
    left = ana.recv_type("peer_left")
    assert left["peer_id"] == sl["self"]["peer_id"], left
    ana.close()


@check("AC3: cerrar la conexión sin leave → peer_left")
def _():
    ta, _ = make_token(ROOM, "Ana")
    tl, _ = make_token(ROOM, "Luis")
    ana = WS(ROOM, ta)
    ana.recv_type("voice_state")
    luis = WS(ROOM, tl)
    luis_id = luis.recv_type("voice_state")["self"]["peer_id"]
    ana.recv_type("peer_joined")
    luis.sock.close()  # como cerrar la pestaña
    assert ana.recv_type("peer_left")["peer_id"] == luis_id
    ana.close()


@check("AC2: jti revocado → upgrade y cierre 4001")
def _():
    token, claims = make_token(ROOM, "Bloqueado")
    redis("SET", f"token:revoked:{claims['jti']}", "1", "EX", "60")
    ws = WS(ROOM, token)
    assert ws.recv() is None and ws.close_code == 4001, ws.close_code


@check("AC2: REVOKED en vivo saca al que ya hablaba (4001 + peer_left)")
def _():
    ta, _ = make_token(ROOM, "Ana")
    tl, claims = make_token(ROOM, "Luis")
    ana = WS(ROOM, ta)
    ana.recv_type("voice_state")
    luis = WS(ROOM, tl)
    luis_id = luis.recv_type("voice_state")["self"]["peer_id"]
    ana.recv_type("peer_joined")
    redis("SET", f"token:revoked:{claims['jti']}", "1", "EX", "60")
    redis("PUBLISH", f"room:{ROOM}:sync", json.dumps({"type": "REVOKED", "jti": claims["jti"]}))
    assert luis.recv() is None and luis.close_code == 4001, luis.close_code
    assert ana.recv_type("peer_left")["peer_id"] == luis_id
    ana.close()


def mute_api(method, room_id, user_id, token=None, origin=None):
    """PUT/DELETE /api/v1/voice/rooms/{id}/mutes/{user_id} → código HTTP."""
    url = f"{VOICE_URL}/api/v1/voice/rooms/{urllib.parse.quote(room_id)}/mutes/{urllib.parse.quote(user_id, safe='')}"
    req = urllib.request.Request(url, method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if origin:
        req.add_header("Origin", origin)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


@check("HU-VOZ-02: silenciarse y activarse llega a los demás (peer_muted)")
def _():
    ta, _ = make_token(ROOM, "Ana")
    tl, _ = make_token(ROOM, "Luis")
    ana = WS(ROOM, ta)
    ana.recv_type("voice_state")
    luis = WS(ROOM, tl)
    luis_id = luis.recv_type("voice_state")["self"]["peer_id"]
    ana.recv_type("peer_joined")
    luis.send(client_msg("self_mute", muted=True))
    m = ana.recv_type("peer_muted")
    assert m["peer_id"] == luis_id and m["muted"] is True and m["host_muted"] is False, m
    assert luis.recv_type("peer_muted")["muted"] is True, "el propio también recibe la confirmación"
    luis.send(client_msg("self_mute", muted=False))
    assert ana.recv_type("peer_muted")["muted"] is False
    ana.close()
    luis.close()


@check("HU-VOZ-04: el host silencia por REST (204), no puede quitárselo y persiste al volver")
def _():
    room = f"{ROOM}-mute"
    th, _ = make_token(room, "Host", role="host")
    ta, ca = make_token(room, "Ana")
    host = WS(room, th)
    host.recv_type("voice_state")
    ana = WS(room, ta)
    ana.recv_type("voice_state")
    host.recv_type("peer_joined")

    assert mute_api("PUT", room, ca["sub"], th) == 204
    for ws in (host, ana):
        m = ws.recv_type("peer_muted")
        assert m["host_muted"] is True and m["muted"] is True, m
    ana.send(client_msg("self_mute", muted=False))
    assert ana.recv_type("error")["code"] == "HOST_MUTED"

    # Persistencia: sale y vuelve (otro token, mismo usuario) y sigue silenciada.
    ana.send(client_msg("leave"))
    ana.recv()
    host.recv_type("peer_left")
    ta2, _ = make_token(room, "Ana", sub=ca["sub"])
    ana = WS(room, ta2)
    self_state = ana.recv_type("voice_state")["self"]
    assert self_state["host_muted"] is True and self_state["muted"] is True, self_state
    host.recv_type("peer_joined")

    assert mute_api("DELETE", room, ca["sub"], th) == 204
    lifted = ana.recv_type("peer_muted")
    assert lifted["host_muted"] is False and lifted["muted"] is True, lifted
    host.close()
    ana.close()


@check("HU-VOZ-04 AC3: un participante que intenta silenciar recibe 403")
def _():
    tl, _ = make_token(ROOM, "Luis")
    assert mute_api("PUT", ROOM, "u-cualquiera", tl) == 403
    assert mute_api("PUT", ROOM, "u-cualquiera") == 401
    th, _ = make_token(ROOM, "Host", role="host")
    assert mute_api("PUT", ROOM, "u-cualquiera", th, origin="http://evil.example") == 403
    luis = WS(ROOM, tl)
    luis.recv_type("voice_state")
    luis.send(client_msg("host_mute", user_id="u-cualquiera", muted=True))
    assert luis.recv_type("error")["code"] == "FORBIDDEN"
    luis.close()


@check("HU-VOZ-05: ice_servers trae TURN con credencial efímera que coturn acepta (y rechaza una falsa)")
def _():
    token, claims = make_token(ROOM, "Ana")
    ws = WS(ROOM, token)
    servers = ws.recv_type("voice_state")["ice_servers"]
    ws.close()
    assert any("username" not in s for s in servers), f"falta STUN: {servers}"
    turn = next(s for s in servers if "username" in s)
    expires, user = turn["username"].split(":", 1)
    assert user == claims["sub"], turn["username"]
    assert 0 < int(expires) - time.time() <= 24 * 3600, "caduca según TURN_TTL_SECONDS"
    assert turn_allocate(turn["username"], turn["credential"]) == 0, "coturn no concedió el relay"
    assert turn_allocate(turn["username"], "clave-falsa") == 401


ok = all(r[0] for r in results)
for passed, name, detail in results:
    print(f"{'✔' if passed else '✘'} {name}" + (f"\n    {detail}" if detail else ""))
print(f"\n{sum(r[0] for r in results)}/{len(results)} en verde · sala {ROOM}")
sys.exit(0 if ok else 1)
