package com.tint.app.social

import com.tint.app.sync.SyncSocket
import com.tint.app.sync.SyncSocketFactory
import com.tint.app.sync.SyncSocketListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class SocialClientRoomClosedTest {
    private class FakeSocket(val listener: SyncSocketListener) : SyncSocket {
        override fun send(text: String) = true

        override fun close(code: Int, reason: String) = Unit
    }

    private val sockets = mutableListOf<FakeSocket>()
    private lateinit var client: SocialClient

    @Before
    fun setUp() {
        client = SocialClient(
            roomId = "r1",
            token = { "guest-jwt" },
            urlFor = { room, t -> "ws://h/ws/social?room_id=$room&token=$t" },
            sockets = SyncSocketFactory { _, listener -> FakeSocket(listener).also { sockets += it } },
            scope = CoroutineScope(Dispatchers.Unconfined),
            nowMs = { 0L },
            selfUserId = { "guest:me" },
            sleep = { },
        )
        client.start()
        sockets.last().listener.onOpen()
    }

    @Test
    fun `una sala abierta no esta cerrada`() {
        assertFalse(client.state.value.roomClosed)
    }

    @Test
    fun `el cierre 4010 es el fin de la sala y no se reconecta`() {
        sockets.last().listener.onClosed(4010)

        assertTrue(client.state.value.roomClosed)
        assertFalse(client.state.value.connected)
        assertEquals(1, sockets.size)
    }

    @Test
    fun `un corte normal si reconecta y no marca la sala como cerrada`() {
        sockets.last().listener.onClosed(1006)

        assertFalse(client.state.value.roomClosed)
        assertEquals(2, sockets.size)
    }
}
