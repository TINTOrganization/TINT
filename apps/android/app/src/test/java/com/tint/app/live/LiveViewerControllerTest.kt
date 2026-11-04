package com.tint.app.live

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class LiveViewerControllerTest {
    private class FakePeer(val listener: ViewerPeerListener, val offer: String) : ViewerPeer {
        val answers = mutableListOf<String>()
        var closed = false
        var iceServers: List<IceServer> = emptyList()
        var failOffer: Exception? = null
        val audio = mutableListOf<Boolean>()

        override suspend fun createOffer(iceServers: List<IceServer>): String {
            failOffer?.let { throw it }
            this.iceServers = iceServers
            return offer
        }

        override suspend fun setAnswer(sdp: String) {
            answers += sdp
        }

        override fun setAudioEnabled(on: Boolean) {
            audio += on
        }

        override fun close() {
            closed = true
        }
    }

    private class FakeSignaling : StreamSignaling {
        val iceRooms = mutableListOf<String>()
        val offers = mutableListOf<String>()
        val deleted = mutableListOf<String>()
        var gate: CompletableDeferred<Unit>? = null
        val iceResults = ArrayDeque<() -> List<IceServer>>()
        val whepResults = ArrayDeque<() -> WhepSession>()
        private var seq = 0

        override suspend fun iceServers(roomId: String): List<IceServer> {
            iceRooms += roomId
            return iceResults.removeFirstOrNull()?.invoke() ?: listOf(IceServer(listOf("stun:s"), null, null))
        }

        override suspend fun whep(roomId: String, offerSdp: String): WhepSession {
            offers += offerSdp
            gate?.await()
            return whepResults.removeFirstOrNull()?.invoke() ?: WhepSession("answer-${++seq}", "http://h/sessions/s$seq")
        }

        override suspend fun delete(sessionUrl: String) {
            deleted += sessionUrl
        }
    }

    private val peers = mutableListOf<FakePeer>()
    private val sleeps = mutableListOf<Long>()
    private val statesWhileSleeping = mutableListOf<LiveUiState>()
    private lateinit var signaling: FakeSignaling
    private lateinit var controller: LiveViewerController

    private val peer get() = peers.last()

    @Before
    fun setUp() {
        signaling = FakeSignaling()
        controller = LiveViewerController(
            roomId = "r1",
            signaling = signaling,
            peers = ViewerPeerFactory { listener -> FakePeer(listener, "offer-${peers.size + 1}").also { peers += it } },
            scope = CoroutineScope(Dispatchers.Unconfined),
            sleep = {
                sleeps += it
                statesWhileSleeping += controller.state.value
            },
        )
    }

    private val state get() = controller.state.value

    private fun event(json: String) = peer.listener.onEvent(json)

    private fun live() = event("""{"type":"stream_state","state":"live"}""")

    // ---- Conectar ----

    @Test
    fun `al empezar nada esta conectado`() {
        assertEquals(LiveStatus.IDLE, state.status)
        assertTrue(peers.isEmpty())
    }

    @Test
    fun `empezar negocia WHEP con ICE, oferta y respuesta`() {
        controller.start()

        assertEquals(listOf("r1"), signaling.iceRooms)
        assertEquals(listOf("stun:s"), peer.iceServers.single().urls)
        assertEquals(listOf("offer-1"), signaling.offers)
        assertEquals(listOf("answer-1"), peer.answers)
        assertEquals(LiveStatus.CONNECTING, state.status)
    }

    @Test
    fun `empezar dos veces no abre otra conexion`() {
        controller.start()
        controller.start()

        assertEquals(1, peers.size)
        assertEquals(1, signaling.offers.size)
    }

    // ---- AC1: la transmision aparece ----

    @Test
    fun `cuando el host transmite el estado pasa a en vivo`() {
        controller.start()

        live()

        assertEquals(LiveStatus.LIVE, state.status)
        assertNull(state.error)
    }

    @Test
    fun `si el host aun no llega se espera sin error`() {
        controller.start()

        event("""{"type":"stream_state","state":"waiting"}""")

        assertEquals(LiveStatus.WAITING, state.status)
        live()
        assertEquals(LiveStatus.LIVE, state.status)
    }

    @Test
    fun `si el host se reconecta se avisa y luego vuelve`() {
        controller.start()
        live()

        event("""{"type":"stream_state","state":"reconnecting","grace_deadline_ms":1793719500000}""")
        assertEquals(LiveStatus.RECONNECTING, state.status)
        assertEquals(1_793_719_500_000L, state.graceDeadlineMs)

        live()
        assertEquals(LiveStatus.LIVE, state.status)
        assertNull(state.graceDeadlineMs)
    }

    @Test
    fun `espectadores y escena se reflejan`() {
        controller.start()
        live()

        event("""{"type":"viewer_count","count":7}""")
        event("""{"type":"scene","name":"brb"}""")

        assertEquals(7, state.viewerCount)
        assertEquals(StreamScene.BRB, state.scene)
    }

    @Test
    fun `un mensaje que no se entiende no cambia nada`() {
        controller.start()
        live()
        val before = state

        event("basura")
        event("""{"type":"host_stats","layers":[]}""")

        assertTrue(before === state)
    }

    // ---- AC2: el evento termina ----

    @Test
    fun `cuando el host termina se corta el video y no se reintenta ni se borra la sesion`() {
        controller.start()
        live()

        event("""{"type":"stream_state","state":"ended","reason":"host_ended"}""")

        assertEquals(LiveStatus.ENDED, state.status)
        assertEquals(EndReason.HOST_ENDED, state.endReason)
        assertTrue(peer.closed)
        assertTrue(signaling.deleted.isEmpty())
        assertTrue(sleeps.isEmpty())
        assertEquals(1, peers.size)
    }

    @Test
    fun `si el host no vuelve en la gracia tambien termina`() {
        controller.start()

        event("""{"type":"stream_state","state":"ended","reason":"grace_expired"}""")

        assertEquals(LiveStatus.ENDED, state.status)
        assertEquals(EndReason.GRACE_EXPIRED, state.endReason)
    }

    @Test
    fun `una sala deshabilitada al conectar es el fin del evento`() {
        signaling.whepResults += { throw StreamError(410, "ROOM_DISABLED", "El evento terminó y la sala fue deshabilitada.") }

        controller.start()

        assertEquals(LiveStatus.ENDED, state.status)
        assertTrue(peer.closed)
        assertTrue(sleeps.isEmpty())
    }

    @Test
    fun `el cierre de la sala por otro canal tambien termina la transmision`() {
        controller.start()
        live()

        controller.roomClosed()

        assertEquals(LiveStatus.ENDED, state.status)
        assertTrue(peer.closed)
        assertTrue(signaling.deleted.isEmpty())
    }

    @Test
    fun `tras terminar ya no se reconecta aunque la conexion caiga`() {
        controller.start()
        event("""{"type":"stream_state","state":"ended","reason":"host_ended"}""")

        peer.listener.onState(PeerState.FAILED)

        assertEquals(LiveStatus.ENDED, state.status)
        assertEquals(1, peers.size)
        assertTrue(sleeps.isEmpty())
    }

    // ---- AC3: reconectar sola ----

    @Test
    fun `si la conexion falla libera la sesion y reconecta tras la espera`() {
        controller.start()
        live()

        peers[0].listener.onState(PeerState.FAILED)

        assertEquals(listOf(1_000L), sleeps)
        assertEquals(listOf("http://h/sessions/s1"), signaling.deleted)
        assertTrue(peers[0].closed)
        assertEquals(2, peers.size)
        assertEquals(listOf("answer-2"), peers[1].answers)
        // El estado en vivo vuelve cuando el servidor lo confirma por el canal de eventos nuevo.
        event("""{"type":"stream_state","state":"live"}""")
        assertEquals(LiveStatus.LIVE, state.status)
    }

    @Test
    fun `mientras reconecta el estado lo dice`() {
        controller.start()
        live()
        signaling.gate = CompletableDeferred()

        peers[0].listener.onState(PeerState.FAILED)

        assertEquals(LiveStatus.RECONNECTING, state.status)
        signaling.gate!!.complete(Unit)
    }

    @Test
    fun `una caida momentanea sin fallo no reconecta`() {
        controller.start()
        live()

        peer.listener.onState(PeerState.DISCONNECTED)
        peer.listener.onState(PeerState.CONNECTED)

        assertEquals(1, peers.size)
        assertEquals(LiveStatus.LIVE, state.status)
        assertTrue(sleeps.isEmpty())
    }

    @Test
    fun `la espera crece con cada fallo seguido y se reinicia al lograr conectar`() {
        repeat(3) { signaling.whepResults += { throw StreamError(0, "NETWORK", "sin red") } }

        controller.start()

        // Tres intentos seguidos sin lograrlo: 1 s, 2 s y 4 s; el cuarto conecta.
        assertEquals(listOf(1_000L, 2_000L, 4_000L), sleeps)
        sleeps.clear()

        // Ya conectó: la siguiente caída vuelve a empezar desde 1 s.
        peers.last().listener.onState(PeerState.FAILED)
        assertEquals(listOf(1_000L), sleeps)
    }

    @Test
    fun `sin red al primer intento reintenta en vez de rendirse`() {
        signaling.iceResults += { throw StreamError(0, "NETWORK", "sin red") }

        controller.start()

        assertEquals(listOf(1_000L), sleeps)
        assertEquals(1, signaling.offers.size)
        assertEquals(listOf("answer-1"), peers.single().answers)
        assertEquals(LiveStatus.CONNECTING, state.status)
    }

    @Test
    fun `un error del servidor 5xx reintenta`() {
        signaling.whepResults += { throw StreamError(503, "UNAVAILABLE", "caído") }

        controller.start()

        assertEquals(listOf(1_000L), sleeps)
        assertTrue(peers[0].closed)
        assertEquals(2, peers.size)
    }

    @Test
    fun `mientras espera para reintentar muestra el motivo`() {
        signaling.whepResults += { throw StreamError(0, "NETWORK", "sin red") }

        controller.start()

        val during = statesWhileSleeping.single()
        assertEquals(LiveStatus.RECONNECTING, during.status)
        assertEquals(StreamProtocol.errorMessage("NETWORK"), during.error)
        // Al conectar, el aviso de error desaparece.
        assertNull(state.error)
    }

    // ---- Errores sin remedio ----

    @Test
    fun `una sala llena no se reintenta y lo explica`() {
        signaling.whepResults += { throw StreamError(409, "ROOM_FULL", "lleno") }

        controller.start()

        assertEquals(LiveStatus.ERROR, state.status)
        assertEquals("ROOM_FULL", state.errorCode)
        assertEquals(StreamProtocol.errorMessage("ROOM_FULL"), state.error)
        assertTrue(sleeps.isEmpty())
        assertTrue(peer.closed)
    }

    @Test
    fun `una sala sin transmision es un error terminal`() {
        signaling.whepResults += { throw StreamError(404, "STREAM_NOT_FOUND", "x") }

        controller.start()

        assertEquals(LiveStatus.ERROR, state.status)
        assertEquals("STREAM_NOT_FOUND", state.errorCode)
    }

    @Test
    fun `un token invalido es terminal`() {
        signaling.iceResults += { throw StreamError(401, "UNAUTHORIZED", "x") }

        controller.start()

        assertEquals(LiveStatus.ERROR, state.status)
        assertTrue(sleeps.isEmpty())
    }

    @Test
    fun `si el cliente WebRTC no puede crear la oferta se reintenta como un fallo de red`() {
        controller = LiveViewerController(
            "r1",
            signaling,
            ViewerPeerFactory { listener ->
                FakePeer(listener, "o").also { p ->
                    if (peers.isEmpty()) p.failOffer = IllegalStateException("sin EGL")
                    peers += p
                }
            },
            CoroutineScope(Dispatchers.Unconfined),
            sleep = { sleeps += it },
        )

        controller.start()

        assertEquals(listOf(1_000L), sleeps)
        assertEquals(2, peers.size)
        assertEquals(listOf("answer-1"), peers[1].answers)
    }

    // ---- Parar ----

    @Test
    fun `parar cierra la sesion y la conexion`() {
        controller.start()
        live()

        controller.stop()

        assertEquals(listOf("http://h/sessions/s1"), signaling.deleted)
        assertTrue(peer.closed)
        assertEquals(LiveStatus.IDLE, state.status)
    }

    @Test
    fun `parar antes de que responda el servidor descarta la respuesta tardia`() {
        signaling.gate = CompletableDeferred()
        controller.start()

        controller.stop()
        signaling.gate!!.complete(Unit)

        assertTrue(peer.closed)
        assertTrue(peer.answers.isEmpty())
        assertEquals(LiveStatus.IDLE, state.status)
        // La sesión que el servidor llegó a crear no se deja abierta ocupando un lugar del cupo.
        assertEquals(listOf("http://h/sessions/s1"), signaling.deleted)
    }

    @Test
    fun `parar sin haber empezado no hace nada`() {
        controller.stop()

        assertEquals(LiveStatus.IDLE, state.status)
        assertTrue(signaling.deleted.isEmpty())
    }

    @Test
    fun `se puede volver a empezar despues de parar`() {
        controller.start()
        controller.stop()

        controller.start()

        assertEquals(2, peers.size)
        assertFalse(peers[1].closed)
        assertEquals(LiveStatus.CONNECTING, state.status)
    }

    @Test
    fun `los eventos de una conexion vieja no cuentan`() {
        controller.start()
        val old = peers[0]
        old.listener.onState(PeerState.FAILED)

        old.listener.onEvent("""{"type":"stream_state","state":"ended","reason":"host_ended"}""")

        assertTrue(state.status != LiveStatus.ENDED)
    }

    // ---- Audio solo para mí (AND-17) ----

    @Test
    fun `silenciar el audio se lo dice a la conexion actual`() {
        controller.start()

        controller.setAudioEnabled(false)
        controller.setAudioEnabled(true)

        assertEquals(listOf(true, false, true), peer.audio)
    }

    @Test
    fun `la conexion nueva tras una caida respeta el silencio ya elegido`() {
        controller.start()
        controller.setAudioEnabled(false)

        peers[0].listener.onState(PeerState.FAILED)

        assertEquals(false, peers[1].audio.first())
    }

    @Test
    fun `sin haber empezado el audio queda listo para la primera conexion`() {
        controller.setAudioEnabled(false)

        controller.start()

        assertEquals(listOf(false), peer.audio)
    }
}
