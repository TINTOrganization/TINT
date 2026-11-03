package com.tint.app.social

import com.tint.app.sync.SyncSocket
import com.tint.app.sync.SyncSocketFactory
import com.tint.app.sync.SyncSocketListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class SocialClientPollLaserTest {
    private class FakeSocket(val listener: SyncSocketListener) : SyncSocket {
        val sent = mutableListOf<String>()
        override fun send(text: String): Boolean {
            sent += text
            return true
        }

        override fun close(code: Int, reason: String) = Unit
    }

    private val sockets = mutableListOf<FakeSocket>()
    private var clock = 50_000L
    private var wall = 1_793_719_470_000L
    private var ids = 0
    private lateinit var client: SocialClient
    private lateinit var socket: FakeSocket

    @Before
    fun setUp() {
        client = SocialClient(
            roomId = "r1",
            token = { "guest-jwt" },
            urlFor = { room, t -> "ws://h/ws/social?room_id=$room&token=$t" },
            sockets = SyncSocketFactory { _, listener -> FakeSocket(listener).also { sockets += it } },
            scope = CoroutineScope(Dispatchers.Unconfined),
            nowMs = { clock },
            selfUserId = { "guest:me" },
            sleep = { },
            newId = { "id-${ids++}" },
            wallClock = { "2026-11-03T12:00:00Z" },
            wallNowMs = { wall },
        )
        client.start()
        socket = sockets.last().also { it.listener.onOpen() }
    }

    private fun poll(
        id: String = "p1",
        counts: String = "[0,0]",
        closed: Boolean = false,
        myVote: Int? = null,
        closesAt: Long = 1_793_719_500_000L,
    ) = """{"event_id":"ev-$id-$counts-$closed","type":"poll_state","room_id":"r1","poll_id":"$id","question":"¿Te gusta $id?",
        "options":["Sí","No"],"counts":$counts,"closes_at_ms":$closesAt,"closed":$closed${myVote?.let { ",\"my_vote\":$it" } ?: ""}}"""

    private fun laser(id: String, x: Double = 0.5, y: Double = 0.5, end: Boolean = false, user: String = "host-1") =
        """{"event_id":"$id","type":"laser","room_id":"r1","user_id":"$user","nick":"Ana","x":$x,"y":$y,"end":$end}"""

    // ---- Encuestas ----

    @Test
    fun `sin encuesta no hay nada que votar`() {
        assertNull(client.state.value.poll)
        assertFalse(client.votePoll(0))
        assertTrue(socket.sent.isEmpty())
    }

    @Test
    fun `una encuesta que llega aparece con su voto previo`() {
        socket.listener.onMessage(poll(counts = "[2,1]", myVote = 1))

        val p = client.state.value.poll!!
        assertEquals("p1", p.pollId)
        assertEquals(listOf(2, 1), p.counts)
        assertEquals(1, p.myVote)
    }

    @Test
    fun `votar manda poll_vote con el poll_id y deja mi voto marcado`() {
        socket.listener.onMessage(poll())

        assertTrue(client.votePoll(1))

        val sent = Json.parseToJsonElement(socket.sent.last()).jsonObject
        assertEquals("poll_vote", sent["type"]!!.jsonPrimitive.content)
        assertEquals("p1", sent["poll_id"]!!.jsonPrimitive.content)
        assertEquals("1", sent["option"]!!.jsonPrimitive.content)
        assertEquals(1, client.state.value.poll!!.myVote)
        assertNull(client.state.value.error)
    }

    @Test
    fun `el broadcast sin my_vote conserva mi ultimo voto de esa encuesta`() {
        socket.listener.onMessage(poll(myVote = 0))
        socket.listener.onMessage(poll(counts = "[5,2]"))

        val p = client.state.value.poll!!
        assertEquals(listOf(5, 2), p.counts)
        assertEquals(0, p.myVote)
    }

    @Test
    fun `el my_vote del servidor corrige mi voto local`() {
        socket.listener.onMessage(poll())
        client.votePoll(0)
        socket.listener.onMessage(poll(counts = "[0,1]", myVote = 1))

        assertEquals(1, client.state.value.poll!!.myVote)
    }

    @Test
    fun `una encuesta nueva no hereda el voto de la anterior`() {
        socket.listener.onMessage(poll(id = "p1", myVote = 1))
        socket.listener.onMessage(poll(id = "p2"))

        val p = client.state.value.poll!!
        assertEquals("p2", p.pollId)
        assertNull(p.myVote)
    }

    @Test
    fun `se puede cambiar el voto mientras siga abierta`() {
        socket.listener.onMessage(poll())

        assertTrue(client.votePoll(0))
        assertTrue(client.votePoll(1))

        assertEquals(2, socket.sent.size)
        assertEquals(1, client.state.value.poll!!.myVote)
    }

    @Test
    fun `una opcion fuera de rango no se manda`() {
        socket.listener.onMessage(poll())

        assertFalse(client.votePoll(2))
        assertFalse(client.votePoll(-1))
        assertTrue(socket.sent.isEmpty())
    }

    @Test
    fun `una encuesta cerrada ya no acepta votos y lo explica`() {
        socket.listener.onMessage(poll(counts = "[3,1]", closed = true))

        assertFalse(client.votePoll(0))

        assertTrue(socket.sent.isEmpty())
        assertEquals("La encuesta ya está cerrada.", client.state.value.error)
        assertTrue(client.state.value.poll!!.closed)
    }

    @Test
    fun `si el reloj ya paso el cierre tampoco se manda`() {
        socket.listener.onMessage(poll())
        wall = 1_793_719_600_000L

        assertFalse(client.votePoll(0))

        assertTrue(socket.sent.isEmpty())
        assertEquals("La encuesta ya está cerrada.", client.state.value.error)
    }

    @Test
    fun `el cierre manual llega como closed true y se ve el resultado final`() {
        socket.listener.onMessage(poll(myVote = 0))
        socket.listener.onMessage(poll(counts = "[4,2]", closed = true))

        val p = client.state.value.poll!!
        assertTrue(p.closed)
        assertEquals(listOf(4, 2), p.counts)
        assertEquals(0, p.myVote)
    }

    @Test
    fun `descartar la encuesta la quita y no vuelve a salir al reconectar`() {
        socket.listener.onMessage(poll(closed = true))
        client.dismissPoll()
        assertNull(client.state.value.poll)

        socket.listener.onMessage(poll(counts = "[1,0]", closed = true))

        assertNull(client.state.value.poll)
    }

    @Test
    fun `descartar una encuesta no oculta la siguiente`() {
        socket.listener.onMessage(poll(id = "p1", closed = true))
        client.dismissPoll()

        socket.listener.onMessage(poll(id = "p2"))

        assertEquals("p2", client.state.value.poll!!.pollId)
    }

    @Test
    fun `los errores del servidor sobre encuestas se explican`() {
        socket.listener.onMessage("""{"type":"error","code":"POLL_NOT_FOUND"}""")

        assertEquals("La encuesta ya no existe.", client.state.value.error)
    }

    // ---- Láser ----

    @Test
    fun `un punto de laser queda con su hora de llegada local`() {
        socket.listener.onMessage(laser("l1", x = 0.2, y = 0.8))

        val a = client.state.value.laser.single()
        assertEquals("l1", a.point.eventId)
        assertEquals(0.2f, a.point.x, 0.0001f)
        assertEquals(50_000L, a.atMs)
    }

    @Test
    fun `un punto repetido no se duplica`() {
        socket.listener.onMessage(laser("l1"))
        socket.listener.onMessage(laser("l1"))

        assertEquals(1, client.state.value.laser.size)
    }

    @Test
    fun `los puntos se acumulan en orden y los viejos salen cuando se pasa del tope`() {
        repeat(150) { clock += 10; socket.listener.onMessage(laser("l$it", x = it / 150.0)) }

        val points = client.state.value.laser
        assertEquals(120, points.size)
        assertEquals("l149", points.last().point.eventId)
        assertEquals("l30", points.first().point.eventId)
    }

    @Test
    fun `descartar los puntos viejos deja solo los que aun se ven`() {
        socket.listener.onMessage(laser("viejo"))
        clock += 10_000
        socket.listener.onMessage(laser("nuevo"))

        client.pruneLaser()

        assertEquals(listOf("nuevo"), client.state.value.laser.map { it.point.eventId })
    }

    @Test
    fun `prune sin nada que quitar no cambia el estado`() {
        socket.listener.onMessage(laser("l1"))
        val before = client.state.value

        client.pruneLaser()

        assertTrue(before === client.state.value)
    }
}
