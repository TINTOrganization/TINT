package com.tint.app.live

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamProtocolTest {
    // ---- ICE ----

    @Test
    fun `lee los servidores ICE con urls en texto o en lista y credenciales TURN`() {
        val body = """{"ice_servers":[
            {"urls":"stun:s.example:3478"},
            {"urls":["turn:t.example:3478?transport=udp","turn:t.example:3478?transport=tcp"],"username":"u1","credential":"c1"}
        ]}"""

        val servers = StreamProtocol.parseIceServers(body)

        assertEquals(2, servers.size)
        assertEquals(listOf("stun:s.example:3478"), servers[0].urls)
        assertNull(servers[0].username)
        assertEquals(listOf("turn:t.example:3478?transport=udp", "turn:t.example:3478?transport=tcp"), servers[1].urls)
        assertEquals("u1", servers[1].username)
        assertEquals("c1", servers[1].credential)
    }

    @Test
    fun `ignora los servidores ICE mal formados y un cuerpo que no es JSON`() {
        assertTrue(StreamProtocol.parseIceServers("no es json").isEmpty())
        assertTrue(StreamProtocol.parseIceServers("""{"otra":1}""").isEmpty())
        val servers = StreamProtocol.parseIceServers(
            """{"ice_servers":[7,{"urls":5},{"urls":[1,"x"]},{"urls":"stun:ok"},{"nada":true}]}""",
        )
        assertEquals(listOf("stun:ok"), servers.single().urls)
    }

    // ---- DataChannel `stream-events` ----

    @Test
    fun `stream_state con cada estado`() {
        assertEquals(StreamEvent.State(StreamState.WAITING), StreamProtocol.parseEvent("""{"type":"stream_state","state":"waiting"}"""))
        assertEquals(StreamEvent.State(StreamState.LIVE), StreamProtocol.parseEvent("""{"type":"stream_state","state":"live"}"""))
        assertEquals(
            StreamEvent.State(StreamState.RECONNECTING, graceDeadlineMs = 1_793_719_500_000),
            StreamProtocol.parseEvent("""{"type":"stream_state","state":"reconnecting","grace_deadline_ms":1793719500000}"""),
        )
    }

    @Test
    fun `stream_state ended trae el motivo`() {
        assertEquals(
            StreamEvent.State(StreamState.ENDED, EndReason.HOST_ENDED),
            StreamProtocol.parseEvent("""{"type":"stream_state","state":"ended","reason":"host_ended"}"""),
        )
        assertEquals(
            StreamEvent.State(StreamState.ENDED, EndReason.GRACE_EXPIRED),
            StreamProtocol.parseEvent("""{"type":"stream_state","state":"ended","reason":"grace_expired"}"""),
        )
        // Un motivo desconocido no invalida el fin.
        assertEquals(
            StreamEvent.State(StreamState.ENDED),
            StreamProtocol.parseEvent("""{"type":"stream_state","state":"ended","reason":"otro"}"""),
        )
    }

    @Test
    fun `contador de espectadores y escena`() {
        assertEquals(StreamEvent.ViewerCount(12), StreamProtocol.parseEvent("""{"type":"viewer_count","count":12}"""))
        assertEquals(StreamEvent.Scene(StreamScene.BRB), StreamProtocol.parseEvent("""{"type":"scene","name":"brb"}"""))
        assertEquals(StreamEvent.Scene(StreamScene.STARTING_SOON), StreamProtocol.parseEvent("""{"type":"scene","name":"starting_soon"}"""))
        assertEquals(StreamEvent.Scene(StreamScene.LIVE), StreamProtocol.parseEvent("""{"type":"scene","name":"live"}"""))
    }

    @Test
    fun `los eventos invalidos o ajenos al espectador se descartan`() {
        assertNull(StreamProtocol.parseEvent("no es json"))
        assertNull(StreamProtocol.parseEvent("[1]"))
        assertNull(StreamProtocol.parseEvent("""{"type":"stream_state","state":"raro"}"""))
        assertNull(StreamProtocol.parseEvent("""{"type":"viewer_count","count":-1}"""))
        assertNull(StreamProtocol.parseEvent("""{"type":"viewer_count","count":"3"}"""))
        assertNull(StreamProtocol.parseEvent("""{"type":"scene","name":"otra"}"""))
        assertNull(StreamProtocol.parseEvent("""{"type":"host_stats","layers":[]}"""))
        assertNull(StreamProtocol.parseEvent("""{"type":"desconocido"}"""))
    }

    // ---- Errores ----

    @Test
    fun `el codigo del cuerpo manda sobre el del estado`() {
        val e = StreamProtocol.errorFor(409, """{"error":"ROOM_FULL","message":"lleno"}""")

        assertEquals(409, e.status)
        assertEquals("ROOM_FULL", e.code)
        assertEquals(StreamProtocol.errorMessage("ROOM_FULL"), e.message)
    }

    @Test
    fun `sin cuerpo util se deduce el codigo del estado HTTP`() {
        assertEquals("UNAUTHORIZED", StreamProtocol.errorFor(401, "").code)
        assertEquals("FORBIDDEN", StreamProtocol.errorFor(403, "no json").code)
        assertEquals("STREAM_NOT_FOUND", StreamProtocol.errorFor(404, null).code)
        assertEquals("ROOM_FULL", StreamProtocol.errorFor(409, "").code)
        assertEquals("ROOM_DISABLED", StreamProtocol.errorFor(410, "").code)
        assertEquals("UNSUPPORTED_MEDIA_TYPE", StreamProtocol.errorFor(415, "").code)
        assertEquals("UNAVAILABLE", StreamProtocol.errorFor(502, "<html>").code)
        assertEquals("HTTP_418", StreamProtocol.errorFor(418, "").code)
    }

    @Test
    fun `los mensajes estan en palabras simples y los desconocidos tienen uno generico`() {
        assertEquals("El evento terminó y la sala fue deshabilitada.", StreamProtocol.errorMessage("ROOM_DISABLED"))
        assertEquals("Esta sala no tiene transmisión en vivo.", StreamProtocol.errorMessage("STREAM_NOT_FOUND"))
        assertTrue(StreamProtocol.errorMessage("ROOM_FULL").contains("50"))
        assertEquals("Algo salió mal con la transmisión. Inténtalo de nuevo.", StreamProtocol.errorMessage("RARO"))
    }

    @Test
    fun `reintentar solo sirve con red caida, 5xx o demasiadas peticiones`() {
        assertFalse(StreamProtocol.isTerminal(StreamError(0, "NETWORK", "x")))
        assertFalse(StreamProtocol.isTerminal(StreamError(503, "UNAVAILABLE", "x")))
        assertFalse(StreamProtocol.isTerminal(StreamError(429, "RATE", "x")))
        assertTrue(StreamProtocol.isTerminal(StreamError(401, "UNAUTHORIZED", "x")))
        assertTrue(StreamProtocol.isTerminal(StreamError(409, "ROOM_FULL", "x")))
        assertTrue(StreamProtocol.isTerminal(StreamError(410, "ROOM_DISABLED", "x")))
    }

    // ---- URLs y reconexion ----

    @Test
    fun `el Location relativo se resuelve contra la base y el absoluto se respeta`() {
        assertEquals("http://h:8086/api/v1/stream/sessions/s1", StreamProtocol.sessionUrl("http://h:8086", "/api/v1/stream/sessions/s1"))
        assertEquals("http://h:8086/api/v1/stream/sessions/s1", StreamProtocol.sessionUrl("http://h:8086", "api/v1/stream/sessions/s1"))
        assertEquals("https://otro/x", StreamProtocol.sessionUrl("http://h:8086", "https://otro/x"))
    }

    @Test
    fun `la espera para reconectar se duplica desde 1 s hasta 10 s`() {
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 10_000L, 10_000L), (0..5).map { StreamProtocol.reconnectDelayMs(it) })
        assertEquals(500L, StreamProtocol.reconnectDelayMs(0, baseMs = 500, maxMs = 2_000))
        assertEquals(2_000L, StreamProtocol.reconnectDelayMs(30, baseMs = 500, maxMs = 2_000))
    }

    @Test
    fun `el canal de eventos es el negociado con id 0`() {
        assertEquals("stream-events", StreamProtocol.EVENTS_LABEL)
        assertEquals(0, StreamProtocol.EVENTS_ID)
    }
}
