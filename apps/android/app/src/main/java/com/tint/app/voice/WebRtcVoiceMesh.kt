package com.tint.app.voice

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.tint.app.BuildConfig
import com.tint.app.live.IceServer
import com.tint.app.live.WebRtcEnv
import com.tint.app.live.awaitCreateAnswer
import com.tint.app.live.awaitCreateOffer
import com.tint.app.live.awaitSetLocal
import com.tint.app.live.awaitSetRemote
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SessionDescription
import java.util.concurrent.ConcurrentHashMap

/**
 * Malla de voz sobre libwebrtc: una PeerConnection por par, con la misma negociación que `voiceMesh.ts` de la web
 * (*perfect negotiation*: ante ofertas cruzadas cede el de `peer_id` menor y el otro ignora la ajena). Quien llega
 * ofrece; los que ya estaban crean su conexión al recibir la oferta. Silenciarse quita la pista del emisor, así que no
 * se manda audio, ni siquiera silencio. Capa fina sobre la librería: se prueba en el dispositivo.
 */
class WebRtcVoiceMesh(
    private val env: WebRtcEnv,
    private val selfId: String,
    private val iceServers: List<IceServer>,
    private val sendSignal: (to: String, data: SignalData) -> Unit,
) : VoiceMesh {
    private val links = ConcurrentHashMap<String, Link>()
    private val deafTo: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val main = Handler(Looper.getMainLooper())

    @Volatile private var sending = true

    @Volatile private var closed = false

    private val audioSource: AudioSource = env.factory.createAudioSource(MediaConstraints())
    private val localTrack: AudioTrack = env.factory.createAudioTrack("tint-voice-$selfId", audioSource)

    private fun outgoing(): AudioTrack? = if (sending) localTrack else null

    /** Solo en debug: cada 2 s una línea por par con los paquetes de audio (`adb logcat -s TintVoice`). */
    private val statsLogger = object : Runnable {
        override fun run() {
            if (closed) return
            links.forEach { (peerId, link) ->
                link.pc.getStats { report ->
                    var received = -1L
                    var sent = -1L
                    var level = 0.0
                    report.statsMap.values.forEach { st ->
                        if (st.members["kind"] != "audio") return@forEach
                        when (st.type) {
                            "inbound-rtp" -> {
                                received = (st.members["packetsReceived"] as? Number)?.toLong() ?: -1L
                                level = (st.members["audioLevel"] as? Number)?.toDouble() ?: 0.0
                            }
                            "outbound-rtp" -> sent = (st.members["packetsSent"] as? Number)?.toLong() ?: -1L
                        }
                    }
                    Log.d(TAG, "peer=$peerId in=$received level=${"%.4f".format(level)} out=$sent sending=$sending")
                }
            }
            main.postDelayed(this, STATS_LOG_MS)
        }
    }

    init {
        if (BuildConfig.DEBUG) main.postDelayed(statsLogger, STATS_LOG_MS)
    }

    override fun connectTo(peerId: String) {
        if (closed || links.containsKey(peerId)) return
        val link = createLink(peerId)
        val init = RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV)
        // Añadir la pista (o una vacía) dispara `onRenegotiationNeeded`, que manda la primera oferta.
        outgoing()?.let { link.pc.addTransceiver(it, init) } ?: link.pc.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO, init)
    }

    override suspend fun handleSignal(from: String, data: SignalData) {
        if (closed) return
        val link = links[from] ?: createLink(from)
        val pc = link.pc
        when (data) {
            is SignalData.Description -> {
                val type = if (data.type == "offer") SessionDescription.Type.OFFER else SessionDescription.Type.ANSWER
                val collision = type == SessionDescription.Type.OFFER &&
                    (link.makingOffer || pc.signalingState() != PeerConnection.SignalingState.STABLE)
                link.ignoreOffer = !link.polite && collision
                if (link.ignoreOffer) return
                pc.awaitSetRemote(SessionDescription(type, data.sdp))
                link.drainCandidates()
                if (type != SessionDescription.Type.OFFER) return
                prepareAnswer(pc)
                val answer = pc.awaitCreateAnswer()
                pc.awaitSetLocal(answer)
                sendSignal(from, SignalData.Description("answer", answer.description))
            }
            is SignalData.Candidate -> {
                val c = data.candidate ?: return // fin de candidatos
                link.addCandidate(IceCandidate(c.sdpMid, c.sdpMLineIndex ?: 0, c.candidate))
            }
        }
    }

    override fun setSending(on: Boolean) {
        sending = on
        val track = outgoing()
        links.values.forEach { link ->
            link.pc.transceivers.filter { it.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO }
                .forEach { it.sender.setTrack(track, false) }
        }
    }

    override fun setPeerAudio(peerId: String, enabled: Boolean) {
        if (enabled) deafTo.remove(peerId) else deafTo.add(peerId)
        links[peerId]?.applyRemoteAudio()
    }

    override fun remove(peerId: String) {
        val link = links.remove(peerId) ?: return
        link.dispose()
    }

    override fun close() {
        closed = true
        main.removeCallbacks(statsLogger)
        links.keys.toList().forEach(::remove)
        localTrack.dispose()
        audioSource.dispose()
    }

    /** Al responder, la conexión también envía (si no estoy silenciado). */
    private fun prepareAnswer(pc: PeerConnection) {
        val transceiver = pc.transceivers.firstOrNull { it.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO } ?: return
        transceiver.direction = RtpTransceiver.RtpTransceiverDirection.SEND_RECV
        transceiver.sender.setTrack(outgoing(), false)
    }

    private fun createLink(peerId: String): Link = links.getOrPut(peerId) { Link(peerId) }

    private inner class Link(val peerId: String) : PeerConnection.Observer {
        val polite = selfId < peerId

        @Volatile var makingOffer = false

        @Volatile var ignoreOffer = false
        private val pending = mutableListOf<IceCandidate>()
        private var graceTimer: Runnable? = null
        val pc: PeerConnection

        init {
            val servers = iceServers.map { s ->
                PeerConnection.IceServer.builder(s.urls).apply {
                    s.username?.let(::setUsername)
                    s.credential?.let(::setPassword)
                }.createIceServer()
            }
            val config = PeerConnection.RTCConfiguration(servers).apply {
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            }
            pc = env.factory.createPeerConnection(config, this) ?: throw IllegalStateException("No se pudo crear la PeerConnection")
        }

        /** Los candidatos que llegan antes de la descripción remota se guardan: libwebrtc los rechazaría. */
        @Synchronized
        fun addCandidate(candidate: IceCandidate) {
            if (pc.remoteDescription == null) {
                pending += candidate
                return
            }
            if (!pc.addIceCandidate(candidate) && !ignoreOffer) throw IllegalStateException("candidato rechazado")
        }

        @Synchronized
        fun drainCandidates() {
            pending.forEach { pc.addIceCandidate(it) }
            pending.clear()
        }

        fun applyRemoteAudio() {
            val enabled = peerId !in deafTo
            pc.transceivers.filter { it.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO }
                .forEach { it.receiver.track()?.setEnabled(enabled) }
        }

        fun dispose() {
            graceTimer?.let(main::removeCallbacks)
            pc.close()
            pc.dispose()
        }

        // ---- Observador de la PeerConnection ----

        override fun onRenegotiationNeeded() {
            if (closed || pc.signalingState() != PeerConnection.SignalingState.STABLE) return
            makingOffer = true
            pc.createOffer(
                object : org.webrtc.SdpObserver {
                    override fun onCreateSuccess(sdp: SessionDescription) {
                        pc.setLocalDescription(
                            object : org.webrtc.SdpObserver {
                                override fun onCreateSuccess(s: SessionDescription) = Unit

                                override fun onCreateFailure(e: String?) = Unit

                                override fun onSetSuccess() {
                                    makingOffer = false
                                    pc.localDescription?.let { sendSignal(peerId, SignalData.Description("offer", it.description)) }
                                }

                                override fun onSetFailure(e: String?) {
                                    makingOffer = false
                                }
                            },
                            sdp,
                        )
                    }

                    override fun onCreateFailure(error: String?) {
                        makingOffer = false
                    }

                    override fun onSetSuccess() = Unit

                    override fun onSetFailure(error: String?) = Unit
                },
                MediaConstraints(),
            )
        }

        override fun onIceCandidate(candidate: IceCandidate) {
            sendSignal(
                peerId,
                SignalData.Candidate(IceCandidateInit(candidate.sdp, candidate.sdpMid, candidate.sdpMLineIndex, null)),
            )
        }

        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
            if (state == PeerConnection.IceGatheringState.COMPLETE) sendSignal(peerId, SignalData.Candidate(null))
        }

        override fun onTrack(transceiver: RtpTransceiver) = applyRemoteAudio()

        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            graceTimer?.let(main::removeCallbacks)
            graceTimer = null
            when (newState) {
                PeerConnection.PeerConnectionState.FAILED -> pc.restartIce()
                PeerConnection.PeerConnectionState.DISCONNECTED -> {
                    // `disconnected` suele recuperarse solo: se espera antes de reiniciar ICE.
                    val restart = Runnable {
                        if (pc.connectionState() == PeerConnection.PeerConnectionState.DISCONNECTED) pc.restartIce()
                    }
                    graceTimer = restart
                    main.postDelayed(restart, DISCONNECT_GRACE_MS)
                }
                else -> Unit
            }
        }

        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit

        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit

        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit

        override fun onAddStream(stream: MediaStream) = Unit

        override fun onRemoveStream(stream: MediaStream) = Unit

        override fun onDataChannel(channel: DataChannel) = Unit

        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) = Unit
    }

    private companion object {
        const val DISCONNECT_GRACE_MS = 3_000L
        const val STATS_LOG_MS = 2_000L
        const val TAG = "TintVoice"
    }
}
