package com.tint.app.live

import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoTrack
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Entorno de libwebrtc compartido por la pantalla: el contexto EGL (para decodificar y pintar el vídeo en GPU) y la
 * fábrica de PeerConnections. Se crea al entrar a la sala y se libera al salir. Capa fina sobre la librería: no se
 * prueba con pruebas unitarias, sino en el dispositivo.
 */
class WebRtcEnv(context: Context) {
    val eglBase: EglBase = EglBase.create()
    val factory: PeerConnectionFactory

    init {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions(),
        )
        factory = PeerConnectionFactory.builder()
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .createPeerConnectionFactory()
    }

    fun release() {
        factory.dispose()
        eglBase.release()
    }
}

/**
 * La PeerConnection de un espectador de stream-core: solo recibe vídeo y audio, y abre el DataChannel `stream-events`
 * negociado con id 0 **antes** de la oferta (docs/dominio-transmision.md §4). Reúne todos los candidatos ICE antes
 * de ofrecer porque WHEP de stream-core no usa trickle en este flujo, igual que la web.
 */
class WebRtcViewerPeer(
    private val env: WebRtcEnv,
    private val listener: ViewerPeerListener,
    /** Llega (o se retira, con null) la pista de vídeo remota; se llama desde un hilo de WebRTC. */
    private val onVideo: (VideoTrack?) -> Unit,
) : ViewerPeer {
    private var connection: PeerConnection? = null
    private var channel: DataChannel? = null
    private val gathered = CompletableDeferred<Unit>()

    override suspend fun createOffer(iceServers: List<IceServer>): String {
        val servers = iceServers.map { s ->
            PeerConnection.IceServer.builder(s.urls).apply {
                s.username?.let(::setUsername)
                s.credential?.let(::setPassword)
            }.createIceServer()
        }
        val config = PeerConnection.RTCConfiguration(servers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
        }
        val pc = env.factory.createPeerConnection(config, observer)
            ?: throw IllegalStateException("No se pudo crear la PeerConnection")
        connection = pc

        val init = DataChannel.Init().apply {
            negotiated = true
            id = StreamProtocol.EVENTS_ID
        }
        channel = pc.createDataChannel(StreamProtocol.EVENTS_LABEL, init).also { it.registerObserver(channelObserver) }
        val recvOnly = RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY)
        pc.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO, recvOnly)
        pc.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO, recvOnly)

        val offer = createSdp { pc.createOffer(it, MediaConstraints()) }
        setSdp { pc.setLocalDescription(it, offer) }
        // Si la reunión de candidatos se atasca, se ofrece con los que haya: mejor eso que dejar esperando al espectador.
        withTimeoutOrNull(ICE_GATHER_TIMEOUT_MS) { gathered.await() }
        return pc.localDescription?.description ?: offer.description
    }

    override suspend fun setAnswer(sdp: String) {
        val pc = connection ?: throw IllegalStateException("La PeerConnection ya se cerró")
        setSdp { pc.setRemoteDescription(it, SessionDescription(SessionDescription.Type.ANSWER, sdp)) }
    }

    override fun close() {
        channel?.let {
            it.unregisterObserver()
            it.close()
            it.dispose()
        }
        channel = null
        connection?.let {
            it.close()
            it.dispose()
        }
        connection = null
        onVideo(null)
    }

    private suspend fun createSdp(start: (SdpObserver) -> Unit): SessionDescription = suspendCancellableCoroutine { cont ->
        start(
            object : SdpObserver {
                override fun onCreateSuccess(sdp: SessionDescription) = cont.resume(sdp)

                override fun onCreateFailure(error: String?) = cont.resumeWithException(IllegalStateException(error ?: "createOffer"))

                override fun onSetSuccess() = Unit

                override fun onSetFailure(error: String?) = Unit
            },
        )
    }

    private suspend fun setSdp(start: (SdpObserver) -> Unit): Unit = suspendCancellableCoroutine { cont ->
        start(
            object : SdpObserver {
                override fun onCreateSuccess(sdp: SessionDescription) = Unit

                override fun onCreateFailure(error: String?) = Unit

                override fun onSetSuccess() = cont.resume(Unit)

                override fun onSetFailure(error: String?) = cont.resumeWithException(IllegalStateException(error ?: "setDescription"))
            },
        )
    }

    private val channelObserver = object : DataChannel.Observer {
        override fun onBufferedAmountChange(previousAmount: Long) = Unit

        override fun onStateChange() = Unit

        override fun onMessage(buffer: DataChannel.Buffer) {
            if (buffer.binary) return
            val bytes = ByteArray(buffer.data.remaining())
            buffer.data.get(bytes)
            listener.onEvent(String(bytes, Charsets.UTF_8))
        }
    }

    private val observer = object : PeerConnection.Observer {
        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            when (newState) {
                PeerConnection.PeerConnectionState.CONNECTED -> listener.onState(PeerState.CONNECTED)
                PeerConnection.PeerConnectionState.DISCONNECTED -> listener.onState(PeerState.DISCONNECTED)
                PeerConnection.PeerConnectionState.FAILED -> listener.onState(PeerState.FAILED)
                PeerConnection.PeerConnectionState.CLOSED -> listener.onState(PeerState.CLOSED)
                else -> Unit
            }
        }

        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
            if (state == PeerConnection.IceGatheringState.COMPLETE) gathered.complete(Unit)
        }

        override fun onTrack(transceiver: RtpTransceiver) {
            (transceiver.receiver.track() as? VideoTrack)?.let(onVideo)
        }

        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit

        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit

        override fun onIceCandidate(candidate: IceCandidate) = Unit

        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit

        override fun onAddStream(stream: MediaStream) = Unit

        override fun onRemoveStream(stream: MediaStream) = Unit

        override fun onDataChannel(channel: DataChannel) = Unit

        override fun onRenegotiationNeeded() = Unit

        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) = Unit
    }

    private companion object {
        const val ICE_GATHER_TIMEOUT_MS = 5_000L
    }
}
