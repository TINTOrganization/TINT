package com.tint.app.social

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SocialPollLaserProtocolTest {
    private fun poll(extra: String = "", counts: String = "[2,1]") =
        """{"event_id":"e1","type":"poll_state","room_id":"r1","poll_id":"p1","question":"¿Te gusta?",
        "options":["Sí","No"],"counts":$counts,"closes_at_ms":1793719500000,"closed":false$extra}"""

    @Test
    fun `poll_state trae pregunta, opciones, conteos y mi voto`() {
        val msg = SocialProtocol.parse(poll(""","my_vote":1""")) as SocialMessage.PollStateMsg

        val p = msg.poll
        assertEquals("p1", p.pollId)
        assertEquals("¿Te gusta?", p.question)
        assertEquals(listOf("Sí", "No"), p.options)
        assertEquals(listOf(2, 1), p.counts)
        assertEquals(1_793_719_500_000L, p.closesAtMs)
        assertFalse(p.closed)
        assertEquals(1, p.myVote)
    }

    @Test
    fun `sin my_vote el voto queda desconocido`() {
        val msg = SocialProtocol.parse(poll()) as SocialMessage.PollStateMsg
        assertNull(msg.poll.myVote)
    }

    @Test
    fun `closed true se respeta`() {
        val raw = poll().replace("\"closed\":false", "\"closed\":true")
        assertTrue((SocialProtocol.parse(raw) as SocialMessage.PollStateMsg).poll.closed)
    }

    @Test
    fun `conteos faltantes o cortos se completan con ceros`() {
        val short = SocialProtocol.parse(poll(counts = "[3]")) as SocialMessage.PollStateMsg
        assertEquals(listOf(3, 0), short.poll.counts)

        val none = poll().replace("\"counts\":[2,1],", "")
        assertEquals(listOf(0, 0), (SocialProtocol.parse(none) as SocialMessage.PollStateMsg).poll.counts)
    }

    @Test
    fun `una encuesta incompleta se descarta`() {
        assertNull(SocialProtocol.parse("""{"type":"poll_state","question":"x","options":["a","b"],"closes_at_ms":1}"""))
        assertNull(SocialProtocol.parse("""{"type":"poll_state","poll_id":"p","question":"x","options":[],"closes_at_ms":1}"""))
        assertNull(SocialProtocol.parse("""{"type":"poll_state","poll_id":"p","question":"x","options":["a","b"]}"""))
    }

    @Test
    fun `laser trae el punto normalizado y quien lo dibuja`() {
        val raw = """{"event_id":"l1","type":"laser","room_id":"r1","user_id":"host-1","nick":"Ana","x":0.25,"y":0.75,"end":true}"""

        val point = (SocialProtocol.parse(raw) as SocialMessage.LaserMsg).point

        assertEquals("l1", point.eventId)
        assertEquals("host-1", point.userId)
        assertEquals("Ana", point.nick)
        assertEquals(0.25f, point.x, 0.0001f)
        assertEquals(0.75f, point.y, 0.0001f)
        assertTrue(point.end)
    }

    @Test
    fun `laser sin end es parte de un trazo y las coordenadas se acotan a 0 y 1`() {
        val raw = """{"event_id":"l2","type":"laser","user_id":"h","nick":"Ana","x":1.7,"y":-0.3}"""

        val point = (SocialProtocol.parse(raw) as SocialMessage.LaserMsg).point

        assertFalse(point.end)
        assertEquals(1f, point.x, 0f)
        assertEquals(0f, point.y, 0f)
    }

    @Test
    fun `laser incompleto se descarta`() {
        assertNull(SocialProtocol.parse("""{"event_id":"l","type":"laser","user_id":"h","nick":"Ana","y":0.5}"""))
        assertNull(SocialProtocol.parse("""{"event_id":"l","type":"laser","user_id":"h","nick":"Ana","x":"a","y":0.5}"""))
        assertNull(SocialProtocol.parse("""{"type":"laser","user_id":"h","nick":"Ana","x":0.1,"y":0.5}"""))
    }

    @Test
    fun `el voto lleva el poll_id y el indice de la opcion`() {
        val o = Json.parseToJsonElement(SocialProtocol.pollVote("r1", "p1", 1, "id-7")).jsonObject

        assertEquals("poll_vote", o["type"]!!.jsonPrimitive.content)
        assertEquals("r1", o["room_id"]!!.jsonPrimitive.content)
        assertEquals("p1", o["poll_id"]!!.jsonPrimitive.content)
        assertEquals("1", o["option"]!!.jsonPrimitive.content)
        assertEquals("id-7", o["event_id"]!!.jsonPrimitive.content)
        assertEquals(5, o.size)
    }

    @Test
    fun `porcentajes enteros por opcion y ceros sin votos`() {
        assertEquals(listOf(25, 25, 50), SocialProtocol.pollPercentages(listOf(1, 1, 2)))
        assertEquals(listOf(67, 33), SocialProtocol.pollPercentages(listOf(2, 1)))
        assertEquals(listOf(0, 0), SocialProtocol.pollPercentages(listOf(0, 0)))
        assertEquals(emptyList<Int>(), SocialProtocol.pollPercentages(emptyList()))
    }

    @Test
    fun `restante de la encuesta cuenta hacia el cierre y es cero si ya cerro`() {
        val p = (SocialProtocol.parse(poll()) as SocialMessage.PollStateMsg).poll

        assertEquals(30_000L, p.remainingMs(1_793_719_470_000L))
        assertEquals(0L, p.remainingMs(1_793_719_600_000L))
        assertEquals(0L, p.copy(closed = true).remainingMs(1_793_719_470_000L))
    }

    @Test
    fun `mensajes de error de encuestas en palabras simples`() {
        assertEquals("La encuesta ya está cerrada.", SocialProtocol.errorMessage("POLL_CLOSED"))
        assertEquals("La encuesta ya no existe.", SocialProtocol.errorMessage("POLL_NOT_FOUND"))
        assertTrue(SocialProtocol.errorMessage("POLL_ACTIVE").isNotBlank())
        assertTrue(SocialProtocol.errorMessage("POLL_ACTIVE") != SocialProtocol.errorMessage("DESCONOCIDO"))
    }
}
