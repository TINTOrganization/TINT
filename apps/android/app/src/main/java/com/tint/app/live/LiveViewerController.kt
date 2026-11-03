package com.tint.app.live

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException

/** Estado de la PeerConnection del espectador. Solo `FAILED` obliga a reconectar. */
enum class PeerState { CONNECTED, DISCONNECTED, FAILED, CLOSED }

/** Lo que la PeerConnection le cuenta al controlador. */
interface ViewerPeerListener {
    /** Un mensaje de texto del DataChannel `stream-events`. */
    fun onEvent(raw: String)

    fun onState(state: PeerState)
}

/**
 * La PeerConnection de un espectador (solo recibe). Es el único punto que toca WebRTC nativo: así la lógica de
 * reconexión se prueba sin él, igual que `ExoPlayerPort` con el reproductor.
 */
interface ViewerPeer {
    /** Crea las pistas de recepción y el DataChannel, espera a reunir los candidatos ICE y devuelve la oferta SDP completa. */
    suspend fun createOffer(iceServers: List<IceServer>): String

    suspend fun setAnswer(sdp: String)

    /** Oír o no el audio de la transmisión en este aparato (no afecta a nadie más). */
    fun setAudioEnabled(on: Boolean)

    fun close()
}

fun interface ViewerPeerFactory {
    fun create(listener: ViewerPeerListener): ViewerPeer
}

enum class LiveStatus { IDLE, CONNECTING, WAITING, LIVE, RECONNECTING, ENDED, ERROR }

data class LiveUiState(
    val status: LiveStatus = LiveStatus.IDLE,
    val viewerCount: Int? = null,
    val scene: StreamScene? = null,
    /** Por qué terminó el evento; null si la sala se cerró por otro canal. */
    val endReason: EndReason? = null,
    /** Hasta cuándo espera el servidor a que el host vuelva (reloj del servidor); solo informativo. */
    val graceDeadlineMs: Long? = null,
    val error: String? = null,
    val errorCode: String? = null,
)

/**
 * Espectador de una transmisión en vivo (espejo del modo viewer de `useLiveStream.ts`): negocia WHEP, sigue el
 * estado que anuncia stream-core por el DataChannel y, si la conexión se cae, la rehace con espera creciente.
 * Cada intento tiene un número de generación: lo que llega de uno viejo (un evento, una respuesta tardía) se
 * descarta.
 */
class LiveViewerController(
    private val roomId: String,
    private val signaling: StreamSignaling,
    private val peers: ViewerPeerFactory,
    private val scope: CoroutineScope,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
) {
    private val lock = Any()
    private val _state = MutableStateFlow(LiveUiState())
    val state: StateFlow<LiveUiState> = _state

    private var generation = 0
    private var active = false
    private var ended = false
    private var attempt = 0
    private var peer: ViewerPeer? = null
    private var sessionUrl = ""
    private var audioOn = true

    fun start() {
        val gen = synchronized(lock) {
            if (active || ended) return
            active = true
            attempt = 0
            ++generation
        }
        _state.value = LiveUiState(status = LiveStatus.CONNECTING)
        scope.launch { connect(gen) }
    }

    /** Sale de la transmisión: libera el lugar en el cupo, cierra la conexión y deja todo como al principio. */
    fun stop() {
        val (oldPeer, oldSession) = synchronized(lock) {
            generation++
            active = false
            ended = false
            val taken = peer to sessionUrl
            peer = null
            sessionUrl = ""
            taken
        }
        oldPeer?.close()
        if (oldSession.isNotEmpty()) scope.launch { signaling.delete(oldSession) }
        _state.value = LiveUiState()
    }

    /** Silencia o reactiva el audio de la transmisión solo en este aparato; se recuerda entre reconexiones. */
    fun setAudioEnabled(on: Boolean) {
        val current = synchronized(lock) {
            audioOn = on
            peer
        }
        current?.setAudioEnabled(on)
    }

    /** La sala se cerró por otro canal (`ROOM_CLOSED`, cierre 4010): el evento terminó. */
    fun roomClosed() = finishEnded(null)

    private fun current(gen: Int): Boolean = synchronized(lock) { gen == generation }

    private suspend fun connect(gen: Int) {
        try {
            val ice = signaling.iceServers(roomId)
            if (!current(gen)) return
            val created = peers.create(listenerFor(gen))
            synchronized(lock) { peer = created }
            created.setAudioEnabled(audioOn)
            val offer = created.createOffer(ice)
            if (!current(gen)) return
            val session = signaling.whep(roomId, offer)
            if (!current(gen)) {
                // Se paró mientras el servidor respondía: la sesión que creó no debe quedar ocupando un lugar.
                signaling.delete(session.sessionUrl)
                return
            }
            created.setAnswer(session.answerSdp)
            if (!current(gen)) return
            synchronized(lock) {
                sessionUrl = session.sessionUrl
                attempt = 0
            }
            _state.update { it.copy(status = LiveStatus.CONNECTING, error = null, errorCode = null) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            fail(gen, e as? StreamError ?: StreamError(0, "NETWORK", StreamProtocol.errorMessage("NETWORK")))
        }
    }

    private fun fail(gen: Int, error: StreamError) {
        if (!current(gen)) return
        if (error.code == "ROOM_DISABLED") {
            finishEnded(null)
            return
        }
        releasePeer()
        if (StreamProtocol.isTerminal(error)) {
            synchronized(lock) {
                generation++
                active = false
            }
            _state.value = LiveUiState(status = LiveStatus.ERROR, error = StreamProtocol.errorMessage(error.code), errorCode = error.code)
            return
        }
        reconnect(error)
    }

    /** Programa otro intento tras la espera creciente. `error` es lo que falló, o null si solo se cayó la conexión. */
    private fun reconnect(error: StreamError?) {
        val (gen, wait) = synchronized(lock) {
            val delayMs = StreamProtocol.reconnectDelayMs(attempt)
            attempt++
            ++generation to delayMs
        }
        _state.update {
            it.copy(
                status = LiveStatus.RECONNECTING,
                error = error?.let { e -> StreamProtocol.errorMessage(e.code) },
                errorCode = error?.code,
            )
        }
        scope.launch {
            sleep(wait)
            if (current(gen)) connect(gen)
        }
    }

    private fun listenerFor(gen: Int) = object : ViewerPeerListener {
        override fun onEvent(raw: String) {
            if (!current(gen)) return
            StreamProtocol.parseEvent(raw)?.let(::handle)
        }

        override fun onState(state: PeerState) {
            if (!current(gen) || state != PeerState.FAILED) return
            val old = releasePeer()
            if (old.isNotEmpty()) scope.launch { signaling.delete(old) }
            reconnect(null)
        }
    }

    private fun handle(event: StreamEvent) {
        when (event) {
            is StreamEvent.State -> when (event.state) {
                StreamState.WAITING -> _state.update { it.copy(status = LiveStatus.WAITING, graceDeadlineMs = null) }
                StreamState.LIVE -> _state.update { it.copy(status = LiveStatus.LIVE, graceDeadlineMs = null, error = null, errorCode = null) }
                StreamState.RECONNECTING ->
                    _state.update { it.copy(status = LiveStatus.RECONNECTING, graceDeadlineMs = event.graceDeadlineMs) }
                StreamState.ENDED -> finishEnded(event.reason)
            }
            is StreamEvent.ViewerCount -> _state.update { it.copy(viewerCount = event.count) }
            is StreamEvent.Scene -> _state.update { it.copy(scene = event.name) }
        }
    }

    /** Cierra la PeerConnection y devuelve la URL de la sesión que tenía (vacía si no llegó a crearse). */
    private fun releasePeer(): String {
        val (old, url) = synchronized(lock) {
            val taken = peer to sessionUrl
            peer = null
            sessionUrl = ""
            taken
        }
        old?.close()
        return url
    }

    /** Fin del evento: es terminal y no se hace `DELETE` (el servidor ya cerró todo por su lado). */
    private fun finishEnded(reason: EndReason?) {
        val first = synchronized(lock) {
            if (ended) return
            ended = true
            active = false
            generation++
            true
        }
        if (!first) return
        synchronized(lock) {
            peer?.close()
            peer = null
            sessionUrl = ""
        }
        _state.update { it.copy(status = LiveStatus.ENDED, endReason = reason, graceDeadlineMs = null, error = null, errorCode = null) }
    }
}
