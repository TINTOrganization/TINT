package com.tint.app.voice

import com.tint.app.live.IceServer
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

class VoiceClientTest {
    private class FakeSocket(val url: String, val listener: SyncSocketListener) : SyncSocket {
        val sent = mutableListOf<String>()
        var closed = false

        override fun send(text: String): Boolean {
            sent += text
            return true
        }

        override fun close(code: Int, reason: String) {
            closed = true
        }
    }

    private class FakeMesh(val selfId: String, val ice: List<IceServer>, val sendSignal: (String, SignalData) -> Unit) : VoiceMesh {
        val connected = mutableListOf<String>()
        val signals = mutableListOf<Pair<String, SignalData>>()
        val sending = mutableListOf<Boolean>()
        val peerAudio = mutableListOf<Pair<String, Boolean>>()
        val removed = mutableListOf<String>()
        var closed = false

        override fun connectTo(peerId: String) {
            connected += peerId
        }

        override suspend fun handleSignal(from: String, data: SignalData) {
            signals += from to data
        }

        override fun setSending(on: Boolean) {
            sending += on
        }

        override fun setPeerAudio(peerId: String, enabled: Boolean) {
            peerAudio += peerId to enabled
        }

        override fun remove(peerId: String) {
            removed += peerId
        }

        override fun close() {
            closed = true
        }
    }

    private val sockets = mutableListOf<FakeSocket>()
    private val meshes = mutableListOf<FakeMesh>()
    private var token: String? = "guest-jwt"
    private var ids = 0
    private lateinit var client: VoiceClient

    private val socket get() = sockets.last()
    private val mesh get() = meshes.last()
    private val state get() = client.state.value

    @Before
    fun setUp() {
        client = VoiceClient(
            roomId = "r1",
            token = { token },
            urlFor = { room, t -> "ws://h/ws/voice?room_id=$room&token=$t" },
            sockets = SyncSocketFactory { url, listener -> FakeSocket(url, listener).also { sockets += it } },
            meshes = VoiceMeshFactory { selfId, ice, send -> FakeMesh(selfId, ice, send).also { meshes += it } },
            scope = CoroutineScope(Dispatchers.Unconfined),
            sleep = { },
            newId = { "id-${ids++}" },
            wallNowMs = { 1_793_719_500_000L },
        )
    }

    private fun peerJson(id: String, nick: String, muted: Boolean = false, hostMuted: Boolean = false, role: String = "participant") =
        """{"peer_id":"$id","user_id":"u-$id","nick":"$nick","role":"$role","muted":$muted,"host_muted":$hostMuted}"""

    private fun voiceState(
        self: String = peerJson("me", "Yo"),
        peers: List<String> = listOf(peerJson("p1", "Ana"), peerJson("p2", "Beto")),
    ) = """{"type":"voice_state","room_id":"r1","self":$self,"peers":[${peers.joinToString(",")}],
        "ice_servers":[{"urls":"stun:s:3478"}],"max_members":8}"""

    private fun joined(self: String = peerJson("me", "Yo"), peers: List<String> = listOf(peerJson("p1", "Ana"), peerJson("p2", "Beto"))) {
        client.join()
        socket.listener.onOpen()
        socket.listener.onMessage(voiceState(self, peers))
    }

    private fun sentTypes(s: FakeSocket = socket) = s.sent.map { Json.parseToJsonElement(it).jsonObject["type"]!!.jsonPrimitive.content }

    private fun lastSent(): kotlinx.serialization.json.JsonObject = Json.parseToJsonElement(socket.sent.last()).jsonObject

    // ---- Entrar ----

    @Test
    fun `al empezar no hay voz`() {
        assertEquals(VoiceStatus.IDLE, state.status)
        assertTrue(sockets.isEmpty())
    }

    @Test
    fun `unirse abre el canal con el token de invitado y queda uniendose`() {
        client.join()

        assertEquals("ws://h/ws/voice?room_id=r1&token=guest-jwt", socket.url)
        assertEquals(VoiceStatus.JOINING, state.status)
    }

    @Test
    fun `unirse dos veces no abre otro canal`() {
        client.join()
        client.join()

        assertEquals(1, sockets.size)
    }

    @Test
    fun `sin token no se abre nada y se explica`() {
        token = null

        client.join()

        assertTrue(sockets.isEmpty())
        assertEquals(VoiceStatus.IDLE, state.status)
        assertEquals("Tu acceso a la voz no es válido. Vuelve a entrar a la sala.", state.notice)
    }

    @Test
    fun `voice_state conecta, crea la malla y ofrece a cada uno de los que ya estaban`() {
        joined()

        assertEquals(VoiceStatus.CONNECTED, state.status)
        assertEquals("me", mesh.selfId)
        assertEquals(listOf("stun:s:3478"), mesh.ice.single().urls)
        assertEquals(listOf("p1", "p2"), mesh.connected)
        assertEquals("me", state.self!!.peerId)
        assertEquals(listOf("p1", "p2"), state.peers.map { it.peerId })
        assertFalse(state.muted)
        assertEquals(listOf(true), mesh.sending)
    }

    @Test
    fun `quien llega despues ofrece y un peer_joined solo se anota`() {
        joined()

        socket.listener.onMessage("""{"type":"peer_joined","peer":${peerJson("p3", "Caro")}}""")

        assertEquals(listOf("p1", "p2", "p3"), state.peers.map { it.peerId })
        assertEquals(listOf("p1", "p2"), mesh.connected)
    }

    @Test
    fun `un peer_joined repetido no duplica al par`() {
        joined()

        socket.listener.onMessage("""{"type":"peer_joined","peer":${peerJson("p1", "Ana Nueva")}}""")

        assertEquals(listOf("Ana Nueva", "Beto"), state.peers.map { it.nick })
    }

    @Test
    fun `cuando alguien sale se cierra su conexion y desaparece`() {
        joined()

        socket.listener.onMessage("""{"type":"peer_left","peer_id":"p1"}""")

        assertEquals(listOf("p1"), mesh.removed)
        assertEquals(listOf("p2"), state.peers.map { it.peerId })
    }

    // ---- Señalizacion ----

    @Test
    fun `la senal de un par llega a la malla`() {
        joined()

        socket.listener.onMessage("""{"type":"signal","from":"p1","data":{"description":{"type":"answer","sdp":"v=0"}}}""")

        assertEquals(listOf("p1" to SignalData.Description("answer", "v=0")), mesh.signals)
    }

    @Test
    fun `lo que la malla quiere mandar sale por el canal con su destino`() {
        joined()

        mesh.sendSignal("p1", SignalData.Description("offer", "v=0 oferta"))

        val sent = lastSent()
        assertEquals("signal", sent["type"]!!.jsonPrimitive.content)
        assertEquals("p1", sent["to"]!!.jsonPrimitive.content)
        assertEquals("1793719500000", sent["occurred_at"]!!.jsonPrimitive.content)
    }

    // ---- AC3: silenciarse ----

    @Test
    fun `silenciarse corta el audio y avisa al servidor al instante`() {
        joined()

        client.toggleMute()

        assertTrue(state.muted)
        assertEquals(listOf(true, false), mesh.sending)
        assertEquals("self_mute", lastSent()["type"]!!.jsonPrimitive.content)
        assertEquals("true", lastSent()["muted"]!!.jsonPrimitive.content)
    }

    @Test
    fun `volver a activarse devuelve el audio`() {
        joined()
        client.toggleMute()

        client.toggleMute()

        assertFalse(state.muted)
        assertEquals(listOf(true, false, true), mesh.sending)
        assertEquals("false", lastSent()["muted"]!!.jsonPrimitive.content)
    }

    @Test
    fun `sin estar conectado no se puede silenciar`() {
        client.toggleMute()

        assertFalse(state.muted)
        assertTrue(sockets.isEmpty())
    }

    @Test
    fun `si el host me silencio no puedo activarme y se explica`() {
        joined(self = peerJson("me", "Yo", muted = true, hostMuted = true))

        client.toggleMute()

        assertTrue(state.muted)
        assertTrue(state.hostMuted)
        assertEquals(listOf(false), mesh.sending)
        assertEquals(VoiceProtocol.errorMessage("HOST_MUTED"), state.notice)
        assertFalse(sentTypes().contains("self_mute"))
    }

    @Test
    fun `cuando el host me silencia se corta mi audio`() {
        joined()

        socket.listener.onMessage("""{"type":"peer_muted","peer_id":"me","user_id":"u-me","muted":true,"host_muted":true}""")

        assertTrue(state.muted)
        assertTrue(state.hostMuted)
        assertEquals(false, mesh.sending.last())
    }

    @Test
    fun `cuando el host me levanta el silencio sigo silenciado hasta activarme`() {
        joined(self = peerJson("me", "Yo", muted = true, hostMuted = true))

        socket.listener.onMessage("""{"type":"peer_muted","peer_id":"me","user_id":"u-me","muted":true,"host_muted":false}""")

        assertTrue(state.muted)
        assertFalse(state.hostMuted)
        assertEquals(false, mesh.sending.last())

        client.toggleMute()
        assertFalse(state.muted)
        assertEquals(true, mesh.sending.last())
    }

    @Test
    fun `si otro se silencia o el host lo silencia, se refleja y su audio se corta de mi lado`() {
        joined()

        socket.listener.onMessage("""{"type":"peer_muted","peer_id":"p1","user_id":"u-p1","muted":true,"host_muted":true}""")

        val p1 = state.peers.first { it.peerId == "p1" }
        assertTrue(p1.muted)
        assertTrue(p1.hostMuted)
        assertEquals(listOf("p1" to false), mesh.peerAudio)

        // Si solo se silenció él mismo, su audio ya no llega y no hace falta tocar la reproducción.
        socket.listener.onMessage("""{"type":"peer_muted","peer_id":"p2","user_id":"u-p2","muted":true,"host_muted":false}""")
        assertTrue(state.peers.first { it.peerId == "p2" }.muted)
        assertEquals(listOf("p1" to false, "p2" to true), mesh.peerAudio)
    }

    @Test
    fun `un par que ya llega silenciado por el host no se oye desde el principio`() {
        joined(peers = listOf(peerJson("p1", "Ana", muted = true, hostMuted = true)))

        assertEquals(listOf("p1" to false), mesh.peerAudio)
    }

    @Test
    fun `un error del servidor se muestra como aviso`() {
        joined()

        socket.listener.onMessage("""{"type":"error","code":"VOICE_FULL"}""")

        assertEquals(VoiceProtocol.errorMessage("VOICE_FULL"), state.notice)
    }

    @Test
    fun `descartar el aviso lo quita`() {
        joined()
        socket.listener.onMessage("""{"type":"error","code":"UNAVAILABLE"}""")

        client.dismissNotice()

        assertNull(state.notice)
    }

    // ---- Reconexion ----

    @Test
    fun `un corte de red reconecta, rehace la malla y repite mi silencio`() {
        joined()
        client.toggleMute()
        val firstMesh = mesh

        socket.listener.onClosed(1006)

        assertEquals(VoiceStatus.RECONNECTING, state.status)
        assertTrue(firstMesh.closed)
        assertTrue(state.peers.isEmpty())
        assertEquals(2, sockets.size)

        socket.listener.onOpen()
        socket.listener.onMessage(voiceState(peers = listOf(peerJson("p1", "Ana"))))

        assertEquals(VoiceStatus.CONNECTED, state.status)
        assertEquals(2, meshes.size)
        assertEquals(listOf("p1"), mesh.connected)
        assertTrue(state.muted)
        assertEquals(false, mesh.sending.last())
        // El silencio propio no lo guarda el servidor: se vuelve a decir.
        assertEquals("true", lastSent()["muted"]!!.jsonPrimitive.content)
    }

    // ---- Cierres sin remedio ----

    @Test
    fun `retirado de la sala no se reconecta`() {
        joined()

        socket.listener.onClosed(4001)

        assertEquals(VoiceStatus.ENDED, state.status)
        assertEquals("Ya no tienes acceso a esta sala.", state.notice)
        assertTrue(mesh.closed)
        assertEquals(1, sockets.size)
    }

    @Test
    fun `voz llena y fuera del escenario terminan sin reintentar`() {
        client.join()
        socket.listener.onClosed(4008)
        assertEquals(VoiceStatus.ENDED, state.status)
        assertEquals(VoiceProtocol.errorMessage("VOICE_FULL"), state.notice)
        assertEquals(1, sockets.size)

        client.leave()
        client.join()
        socket.listener.onClosed(4009)
        assertEquals(VoiceStatus.ENDED, state.status)
        assertTrue(state.notOnStage)
        assertEquals(2, sockets.size)
    }

    @Test
    fun `cuando la sala se cierra la voz termina y lo marca`() {
        joined()

        socket.listener.onClosed(4010)

        assertEquals(VoiceStatus.ENDED, state.status)
        assertTrue(state.roomClosed)
        assertEquals("El evento terminó.", state.notice)
    }

    @Test
    fun `una invitacion caducada termina con su aviso`() {
        client.join()

        socket.listener.onClosed(4003)

        assertEquals(VoiceStatus.ENDED, state.status)
        assertEquals("Tu invitación caducó. Pide al host un link nuevo.", state.notice)
    }

    // ---- Salir ----

    @Test
    fun `salir avisa, cierra la malla y el canal y lo deja todo como al principio`() {
        joined()
        client.toggleMute()

        client.leave()

        assertEquals("leave", lastSent()["type"]!!.jsonPrimitive.content)
        assertTrue(socket.closed)
        assertTrue(mesh.closed)
        assertEquals(VoiceStatus.IDLE, state.status)
        assertFalse(state.muted)
        assertTrue(state.peers.isEmpty())
        assertNull(state.self)
    }

    @Test
    fun `salir sin haber entrado no hace nada`() {
        client.leave()

        assertEquals(VoiceStatus.IDLE, state.status)
        assertTrue(sockets.isEmpty())
    }

    @Test
    fun `se puede volver a entrar despues de salir`() {
        joined()
        client.leave()

        client.join()

        assertEquals(2, sockets.size)
        assertEquals(VoiceStatus.JOINING, state.status)
    }

    @Test
    fun `lo que llega de un canal viejo ya no cuenta`() {
        joined()
        val old = socket
        client.leave()
        client.join()

        old.listener.onMessage("""{"type":"peer_left","peer_id":"p1"}""")
        old.listener.onClosed(4001)

        assertEquals(VoiceStatus.JOINING, state.status)
    }

    @Test
    fun `un mensaje que no se entiende no cambia nada`() {
        joined()
        val before = state

        socket.listener.onMessage("basura")
        socket.listener.onMessage("""{"type":"desconocido"}""")

        assertTrue(before === state)
    }
}
