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

class SocialLeaderboardRecapTest {
    private class FakeSocket(val listener: SyncSocketListener) : SyncSocket {
        val sent = mutableListOf<String>()

        override fun send(text: String): Boolean {
            sent += text
            return true
        }

        override fun close(code: Int, reason: String) = Unit
    }

    private val sockets = mutableListOf<FakeSocket>()
    private lateinit var client: SocialClient
    private val socket get() = sockets.last()

    @Before
    fun setUp() {
        client = SocialClient(
            roomId = "r1",
            token = { "guest-jwt" },
            urlFor = { room, t -> "ws://h/ws/social?room_id=$room&token=$t" },
            sockets = SyncSocketFactory { _, listener -> FakeSocket(listener).also { sockets += it } },
            scope = CoroutineScope(Dispatchers.Unconfined),
            nowMs = { 1L },
            selfUserId = { "guest:me" },
            sleep = { },
            newId = { "id-1" },
            wallClock = { "2026-11-03T12:00:00Z" },
        )
        client.start()
        socket.listener.onOpen()
    }

    private val ranking = """{"type":"trivia_leaderboard","leaderboard":[
        {"user_id":"u1","nick":"Sofi","score":2410},{"user_id":"u2","nick":"Andrés","score":1980}],"my_rank":3,"my_total":1640}"""

    // ---- Protocolo ----

    @Test
    fun `el ranking acumulado trae las filas y mi lugar`() {
        val msg = SocialProtocol.parse(ranking) as SocialMessage.LeaderboardMsg

        assertEquals(listOf(RankEntry("u1", "Sofi", 2410), RankEntry("u2", "Andrés", 1980)), msg.entries)
        assertEquals(3, msg.myRank)
        assertEquals(1640, msg.myTotal)
    }

    @Test
    fun `el ranking sin mis datos o con filas malas se acepta`() {
        val msg = SocialProtocol.parse("""{"type":"trivia_leaderboard","leaderboard":[7,{"user_id":"u1"},{"user_id":"u2","nick":"B","score":5}]}""") as SocialMessage.LeaderboardMsg

        assertEquals(listOf(RankEntry("u2", "B", 5)), msg.entries)
        assertNull(msg.myRank)
        assertNull(msg.myTotal)
    }

    @Test
    fun `el resumen trae reactor, momento pausado, pico y totales`() {
        val raw = """{"type":"recap","room_id":"r1","event_id_ref":"x",
            "top_emoji_user":{"user_id":"u1","nick":"Sofi","count":41},
            "most_paused":{"position_ms":2180000,"count":5},
            "peak_reactions":{"position_ms":3130000,"count":18,"laughs":9},
            "totals":{"reactions":132,"pauses":9,"rewinds":3,"polls":2}}"""

        val r = (SocialProtocol.parse(raw) as SocialMessage.RecapMsg).recap

        assertEquals(RecapReactor("u1", "Sofi", 41), r.topReactor)
        assertEquals(RecapMoment(2_180_000, 5), r.mostPaused)
        assertEquals(RecapPeak(3_130_000, 18, 9), r.peak)
        assertEquals(RecapTotals(132, 9, 3, 2), r.totals)
    }

    @Test
    fun `los bloques del resumen sin datos quedan en null y sin totales son cero`() {
        val r = (SocialProtocol.parse("""{"type":"recap","room_id":"r1","top_emoji_user":null,"most_paused":null,"peak_reactions":null}""") as SocialMessage.RecapMsg).recap

        assertNull(r.topReactor)
        assertNull(r.mostPaused)
        assertNull(r.peak)
        assertEquals(RecapTotals(0, 0, 0, 0), r.totals)
        assertTrue(r.isEmpty)
    }

    @Test
    fun `un resumen con algun dato no esta vacio`() {
        val r = (SocialProtocol.parse("""{"type":"recap","room_id":"r1","top_emoji_user":null,"most_paused":null,"peak_reactions":null,"totals":{"reactions":1,"pauses":0,"rewinds":0,"polls":0}}""") as SocialMessage.RecapMsg).recap

        assertFalse(r.isEmpty)
    }

    @Test
    fun `la peticion del resumen lleva la sala y el id del evento`() {
        val o = Json.parseToJsonElement(SocialProtocol.recapRequest("r1", "e-9")).jsonObject

        assertEquals("recap_request", o["type"]!!.jsonPrimitive.content)
        assertEquals("r1", o["room_id"]!!.jsonPrimitive.content)
        assertEquals("e-9", o["event_id"]!!.jsonPrimitive.content)
    }

    // ---- Cliente ----

    @Test
    fun `el ranking al entrar queda en el estado`() {
        socket.listener.onMessage(ranking)

        val s = client.state.value
        assertEquals(listOf("Sofi", "Andrés"), s.leaderboard.map { it.nick })
        assertEquals(3, s.myRank)
        assertEquals(1640, s.myTotal)
    }

    @Test
    fun `el resultado de una trivia actualiza el ranking acumulado`() {
        socket.listener.onMessage("""{"event_id":"q","type":"trivia_question","trivia_id":"t1","question":"?","options":["A","B"],"opens_at_ms":1,"closes_at_ms":2}""")
        socket.listener.onMessage(
            """{"event_id":"r","type":"trivia_result","trivia_id":"t1","correct":0,"top":[],
            "leaderboard":[{"user_id":"u9","nick":"Caro","score":900}],"my_score":500,"my_total":900}""",
        )

        val s = client.state.value
        assertEquals(listOf("Caro"), s.leaderboard.map { it.nick })
        assertEquals(900, s.myTotal)
    }

    @Test
    fun `el ranking sobrevive a descartar la trivia`() {
        socket.listener.onMessage(ranking)
        socket.listener.onMessage("""{"event_id":"q","type":"trivia_question","trivia_id":"t1","question":"?","options":["A","B"],"opens_at_ms":1,"closes_at_ms":2}""")

        client.dismissTrivia()

        assertEquals(2, client.state.value.leaderboard.size)
    }

    @Test
    fun `el resumen que llega queda en el estado y se puede descartar`() {
        socket.listener.onMessage("""{"type":"recap","room_id":"r1","top_emoji_user":{"user_id":"u1","nick":"Sofi","count":4},"most_paused":null,"peak_reactions":null,"totals":{"reactions":4,"pauses":0,"rewinds":0,"polls":0}}""")

        assertEquals("Sofi", client.state.value.recap!!.topReactor!!.nick)

        client.dismissRecap()
        assertNull(client.state.value.recap)
    }

    @Test
    fun `pedir el resumen manda recap_request`() {
        assertTrue(client.requestRecap())

        assertEquals("recap_request", Json.parseToJsonElement(socket.sent.last()).jsonObject["type"]!!.jsonPrimitive.content)
    }
}
