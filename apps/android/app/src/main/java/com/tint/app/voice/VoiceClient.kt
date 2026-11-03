package com.tint.app.voice

import com.tint.app.live.IceServer
import com.tint.app.sync.ResilientSocket
import com.tint.app.sync.SyncSocketFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException

/**
 * La malla de conexiones de audio con los demás participantes: una PeerConnection por par. Es el único punto que toca
 * WebRTC nativo, así la lógica del canal se prueba sin él (igual que `ViewerPeer` en la transmisión).
 */
interface VoiceMesh {
    /** Empieza la conexión con un par que ya estaba en la voz: este cliente ofrece. */
    fun connectTo(peerId: String)

    /** Una oferta, respuesta o candidato de un par (puede crear su conexión si él ofreció primero). */
    suspend fun handleSignal(from: String, data: SignalData)

    /** Envía o deja de enviar el micrófono a todos. Apagado no manda audio, ni siquiera silencio. */
    fun setSending(on: Boolean)

    /** Oír o no oír a un par: el silencio del host se aplica en el receptor porque en P2P el servidor no corta el audio. */
    fun setPeerAudio(peerId: String, enabled: Boolean)

    fun remove(peerId: String)

    fun close()
}

fun interface VoiceMeshFactory {
    /** `sendSignal` entrega al canal lo que la malla necesita decirle a un par (oferta, respuesta, candidato). */
    fun create(
        selfId: String,
        iceServers: List<IceServer>,
        sendSignal: (to: String, data: SignalData) -> Unit,
        onLevels: (levels: Map<String, Double>) -> Unit,
    ): VoiceMesh
}

enum class VoiceStatus { IDLE, JOINING, CONNECTED, RECONNECTING, ENDED }

data class VoiceUiState(
    val status: VoiceStatus = VoiceStatus.IDLE,
    val self: VoicePeer? = null,
    val peers: List<VoicePeer> = emptyList(),
    /** Yo me silencié (o el host me silenció). */
    val muted: Boolean = false,
    /** El host me silenció: no puedo activarme hasta que lo levante. */
    val hostMuted: Boolean = false,
    val notice: String? = null,
    val noticeSeq: Int = 0,
    /** Una transmisión en vivo: solo hablan el host y quienes él invitó al escenario. */
    val notOnStage: Boolean = false,
    val roomClosed: Boolean = false,
    /** `peer_id` de quienes están hablando ahora (se llena con la energía del audio de cada conexión). */
    val speaking: Set<String> = emptySet(),
)

/**
 * Cliente del Canal de Voz como participante (espejo de `useVoiceChannel.ts`). Quien llega ofrece a cada uno de los
 * que ya estaban; el silencio propio se aplica al instante en el micrófono y después se avisa al servidor. Reconecta
 * con el mismo backoff que los demás canales y repite el silencio, que el servidor no guarda. El permiso del micrófono
 * lo pide la pantalla **antes** de llamar a `join` (AND-07 AC1).
 */
class VoiceClient(
    private val roomId: String,
    token: () -> String?,
    urlFor: (roomId: String, token: String) -> String,
    sockets: SyncSocketFactory,
    private val meshes: VoiceMeshFactory,
    private val scope: CoroutineScope,
    sleep: suspend (Long) -> Unit = { delay(it) },
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val wallNowMs: () -> Long = { System.currentTimeMillis() },
) {
    private val lock = Any()
    private val _state = MutableStateFlow(VoiceUiState())
    val state: StateFlow<VoiceUiState> = _state

    private var active = false
    private var wantMuted = false
    private var hostMuted = false
    private var selfId = ""
    private var mesh: VoiceMesh? = null
    private val speakingTracker = SpeakingTracker()

    private val connection: ResilientSocket = ResilientSocket(
        token = token,
        urlFor = { urlFor(roomId, it) },
        sockets = sockets,
        scope = scope,
        sleep = sleep,
        extraTerminalCodes = VoiceProtocol.EXTRA_TERMINAL_CODES,
        listener = object : ResilientSocket.Listener {
            override fun onNoToken() {
                synchronized(lock) { active = false }
                connection.stop()
                _state.value = VoiceUiState(notice = NO_TOKEN, noticeSeq = _state.value.noticeSeq + 1)
            }

            override fun onMessage(text: String) {
                VoiceProtocol.parse(text)?.let(::handle)
            }

            override fun onClosed(code: Int, reconnectAttempt: Int?) = handleClosed(code, reconnectAttempt != null)
        },
    )

    /** Entra a la voz. La pantalla ya tiene el permiso del micrófono. */
    fun join() {
        synchronized(lock) {
            if (active) return
            active = true
            wantMuted = false
            hostMuted = false
        }
        _state.value = VoiceUiState(status = VoiceStatus.JOINING, noticeSeq = _state.value.noticeSeq)
        connection.stop() // tras un cierre sin reintento el socket queda "en marcha": se reinicia
        connection.start()
    }

    fun leave() {
        val wasActive = synchronized(lock) { active.also { active = false } }
        if (!wasActive) return
        connection.send(VoiceProtocol.leave(newId(), wallNowMs()))
        connection.stop()
        closeMesh()
        synchronized(lock) {
            wantMuted = false
            hostMuted = false
            selfId = ""
        }
        _state.value = VoiceUiState(noticeSeq = _state.value.noticeSeq)
    }

    /** Silencia o reactiva mi micrófono. Se corta (o se devuelve) primero el audio y después se avisa al servidor. */
    fun toggleMute() {
        if (_state.value.status != VoiceStatus.CONNECTED) return
        if (hostMuted && wantMuted) {
            notice(VoiceProtocol.errorMessage("HOST_MUTED"))
            return
        }
        wantMuted = !wantMuted
        applySending()
        connection.send(VoiceProtocol.selfMute(wantMuted, newId(), wallNowMs()))
        _state.update { it.copy(muted = wantMuted, self = it.self?.copy(muted = wantMuted)) }
    }

    fun dismissNotice() {
        _state.update { it.copy(notice = null) }
    }

    private fun handle(msg: VoiceMessage) {
        when (msg) {
            is VoiceMessage.VoiceState -> onVoiceState(msg)
            is VoiceMessage.PeerJoined -> {
                if (msg.peer.hostMuted) mesh?.setPeerAudio(msg.peer.peerId, false)
                _state.update { s ->
                    val exists = s.peers.any { it.peerId == msg.peer.peerId }
                    s.copy(peers = if (exists) s.peers.map { if (it.peerId == msg.peer.peerId) msg.peer else it } else s.peers + msg.peer)
                }
            }
            is VoiceMessage.PeerLeft -> {
                mesh?.remove(msg.peerId)
                _state.update { s -> s.copy(peers = s.peers.filter { it.peerId != msg.peerId }) }
            }
            is VoiceMessage.Signal -> {
                val target = mesh ?: return
                scope.launch {
                    try {
                        target.handleSignal(msg.from, msg.data)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        // Un candidato tardío o inválido no debe tumbar la voz: ICE se reintenta solo.
                    }
                }
            }
            is VoiceMessage.PeerMuted -> onPeerMuted(msg)
            is VoiceMessage.Error -> notice(VoiceProtocol.errorMessage(msg.code))
        }
    }

    private fun onVoiceState(msg: VoiceMessage.VoiceState) {
        closeMesh()
        selfId = msg.self.peerId
        hostMuted = msg.self.hostMuted
        if (msg.self.hostMuted) wantMuted = true
        speakingTracker.reset()
        val created = meshes.create(
            msg.self.peerId,
            msg.iceServers,
            { to, data -> connection.send(VoiceProtocol.signal(to, data, newId(), wallNowMs())) },
            ::onLevels,
        )
        mesh = created
        applySending()
        // Quien llega ofrece a cada uno de los que ya estaban.
        msg.peers.forEach { peer ->
            created.connectTo(peer.peerId)
            if (peer.hostMuted) created.setPeerAudio(peer.peerId, false)
        }
        // El silencio propio no lo guarda el servidor: se repite tras reconectar.
        if (wantMuted && !msg.self.muted) connection.send(VoiceProtocol.selfMute(true, newId(), wallNowMs()))
        _state.update {
            it.copy(
                status = VoiceStatus.CONNECTED,
                self = msg.self.copy(muted = wantMuted || msg.self.muted),
                peers = msg.peers,
                muted = wantMuted,
                hostMuted = hostMuted,
            )
        }
    }

    private fun onPeerMuted(msg: VoiceMessage.PeerMuted) {
        if (msg.peerId == selfId) {
            wantMuted = msg.muted
            hostMuted = msg.hostMuted
            applySending()
            _state.update { it.copy(muted = msg.muted, hostMuted = msg.hostMuted, self = it.self?.copy(muted = msg.muted, hostMuted = msg.hostMuted)) }
        } else {
            mesh?.setPeerAudio(msg.peerId, !msg.hostMuted)
            _state.update { s ->
                s.copy(peers = s.peers.map { if (it.peerId == msg.peerId) it.copy(muted = msg.muted, hostMuted = msg.hostMuted) else it })
            }
        }
    }

    private fun handleClosed(code: Int, willReconnect: Boolean) {
        closeMesh()
        if (!synchronized(lock) { active }) return
        if (willReconnect) {
            _state.update { it.copy(status = VoiceStatus.RECONNECTING, self = null, peers = emptyList()) }
            return
        }
        synchronized(lock) { active = false }
        _state.update {
            it.copy(
                status = VoiceStatus.ENDED,
                self = null,
                peers = emptyList(),
                notice = VoiceProtocol.closeNotice(code) ?: it.notice,
                noticeSeq = it.noticeSeq + 1,
                notOnStage = code == VoiceProtocol.CLOSE_NOT_ON_STAGE,
                roomClosed = code == ROOM_CLOSED,
            )
        }
    }

    /** Niveles de audio de la malla: se convierten en los aros de quien habla. Mi aro solo cuenta si mi micrófono está abierto. */
    private fun onLevels(levels: Map<String, Double>) {
        val sending = !wantMuted && !hostMuted
        val speaking = speakingTracker.update(levels.filterKeys { it != selfId || sending }, wallNowMs())
        _state.update { if (it.speaking == speaking) it else it.copy(speaking = speaking) }
    }

    private fun applySending() {
        mesh?.setSending(!wantMuted && !hostMuted)
    }

    private fun closeMesh() {
        val old = mesh
        mesh = null
        speakingTracker.reset()
        old?.close()
    }

    private fun notice(text: String) {
        _state.update { it.copy(notice = text, noticeSeq = it.noticeSeq + 1) }
    }

    private companion object {
        const val ROOM_CLOSED = 4010
        const val NO_TOKEN = "Tu acceso a la voz no es válido. Vuelve a entrar a la sala."
    }
}
