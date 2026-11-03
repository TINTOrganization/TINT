package com.tint.app.social

import com.tint.app.sync.SyncSocket
import com.tint.app.sync.SyncSocketFactory
import com.tint.app.sync.SyncSocketListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class SocialClientReactionsTest {
    private class FakeSocket(val listener: SyncSocketListener) : SyncSocket {
        override fun send(text: String) = true

        override fun close(code: Int, reason: String) = Unit
    }

    private val sockets = mutableListOf<FakeSocket>()
    private var clock = 10_000L
    private lateinit var client: SocialClient

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
        )
        client.start()
        sockets.last().listener.onOpen()
    }

    private fun reaction(id: String, emoji: String = "❤️") =
        """{"event_id":"$id","type":"reaction","user_id":"u1","nick":"Ana","emoji":"$emoji","position_ms":1000}"""

    @Test
    fun `una reaccion queda con su hora de llegada local`() {
        sockets.last().listener.onMessage(reaction("x1"))

        val a = client.state.value.floating.single()
        assertEquals("x1", a.reaction.eventId)
        assertEquals(10_000L, a.atMs)
        assertEquals(1, client.state.value.reactions.size)
    }

    @Test
    fun `una reaccion repetida no se dibuja dos veces`() {
        sockets.last().listener.onMessage(reaction("x1"))
        sockets.last().listener.onMessage(reaction("x1"))

        assertEquals(1, client.state.value.floating.size)
    }

    @Test
    fun `se guardan como mucho cuarenta`() {
        repeat(60) { clock += 5; sockets.last().listener.onMessage(reaction("r$it")) }

        val f = client.state.value.floating
        assertEquals(40, f.size)
        assertEquals("r59", f.last().reaction.eventId)
    }

    @Test
    fun `descartar las viejas deja solo las que aun se ven`() {
        sockets.last().listener.onMessage(reaction("viejo"))
        clock += 5_000
        sockets.last().listener.onMessage(reaction("nuevo"))

        client.pruneReactions()

        assertEquals(listOf("nuevo"), client.state.value.floating.map { it.reaction.eventId })
    }

    @Test
    fun `descartar sin nada que quitar no cambia el estado`() {
        sockets.last().listener.onMessage(reaction("x1"))
        val before = client.state.value

        client.pruneReactions()

        assertTrue(before === client.state.value)
    }
}
