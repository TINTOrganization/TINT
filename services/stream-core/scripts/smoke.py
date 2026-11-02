#!/usr/bin/env python3
"""Prueba rápida de stream-core levantado (solo stdlib).

Uso:  python3 services/stream-core/scripts/smoke.py [--url http://localhost:8086] [--secret ...]
Recorre la tabla de respuestas de WHIP/WHEP (dominio-transmision §3) con tokens HS256 firmados
aquí, habilitando una sala por la ruta interna /internal/events/start/{id}.
"""
import argparse
import base64
import hashlib
import hmac
import json
import sys
import time
import urllib.error
import urllib.request
import uuid

OFFER_WHEP = (
    "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n"
    # Credenciales ICE/DTLS sintéticas: basta para negociar (la conexión no llega a establecerse).
    "a=ice-ufrag:smok\r\na=ice-pwd:smokesmokesmokesmokesmoke\r\n"
    "a=fingerprint:sha-256 " + ":".join(["AB"] * 32) + "\r\na=setup:actpass\r\n"
    "m=video 9 UDP/TLS/RTP/SAVPF 100\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=recvonly\r\n"
    "a=rtpmap:100 VP8/90000\r\n"
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=mid:1\r\n"
)


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def token(secret, room, role="participant", sub=None, exp_delta=3600):
    header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = b64(json.dumps({
        "sub": sub or f"guest:{uuid.uuid4()}", "room_id": room, "role": role, "nick": "smoke",
        "jti": str(uuid.uuid4()), "iss": "tint-identity", "aud": "tint:room",
        "exp": int(time.time()) + exp_delta,
    }).encode())
    sig = hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    return f"{header}.{payload}.{b64(sig)}"


def call(url, method="GET", tok=None, body=None, ctype=None):
    req = urllib.request.Request(url, method=method, data=body.encode() if body is not None else None)
    if tok:
        req.add_header("Authorization", f"Bearer {tok}")
    if ctype:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, dict(res.headers), res.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8086")
    ap.add_argument("--secret", default="test-secret")
    a = ap.parse_args()
    room = f"smoke-{uuid.uuid4()}"
    base = f"{a.url}/api/v1/stream/rooms/{room}"
    failures = 0

    def check(name, got, want):
        nonlocal failures
        ok = got == want
        failures += not ok
        print(f"{'OK ' if ok else 'ERR'} {name}: {got} (esperado {want})")

    check("healthz", call(f"{a.url}/healthz")[0], 200)
    check("sin token -> 401", call(f"{base}/whep", "POST", None, OFFER_WHEP, "application/sdp")[0], 401)
    guest = token(a.secret, room)
    check("sala sin transmisión -> 404", call(f"{base}/whep", "POST", guest, OFFER_WHEP, "application/sdp")[0], 404)
    check("alta interna -> 200", call(f"{a.url}/internal/events/start/{room}", "POST", None, "{}", "application/json")[0], 200)
    check("participante publica -> 403", call(f"{base}/whip", "POST", guest, OFFER_WHEP, "application/sdp")[0], 403)
    check("content-type -> 415", call(f"{base}/whep", "POST", guest, OFFER_WHEP, "text/plain")[0], 415)
    check("sdp basura -> 400", call(f"{base}/whep", "POST", guest, "hola", "application/sdp")[0], 400)
    check("token caducado -> 401", call(f"{base}/whep", "POST", token(a.secret, room, exp_delta=-5), OFFER_WHEP, "application/sdp")[0], 401)
    status, headers, body = call(f"{base}/whep", "POST", guest, OFFER_WHEP, "application/sdp")
    check("WHEP -> 201", status, 201)
    check("WHEP devuelve SDP", body.startswith("v=0"), True)
    check("WHEP Location", headers.get("Location", "").startswith("/api/v1/stream/sessions/"), True)
    if status == 201:
        check("DELETE sesión -> 200", call(f"{a.url}{headers['Location']}", "DELETE", guest)[0], 200)
    check("ice-servers -> 200", call(f"{base}/ice-servers", "GET", guest)[0], 200)
    check("baja interna -> 204", call(f"{a.url}/internal/events/start/{room}", "DELETE")[0], 204)
    print("smoke:", "OK" if failures == 0 else f"{failures} fallos")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
