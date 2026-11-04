package com.tint.app.live

import kotlinx.coroutines.suspendCancellableCoroutine
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Las operaciones de SDP de libwebrtc devuelven su resultado por un observador: aquí se vuelven funciones suspendibles
 * para escribir la negociación como una secuencia. Capa fina sobre la librería (se prueba en el dispositivo).
 */
internal suspend fun PeerConnection.awaitCreateOffer(constraints: MediaConstraints = MediaConstraints()): SessionDescription =
    awaitCreate { createOffer(it, constraints) }

internal suspend fun PeerConnection.awaitCreateAnswer(constraints: MediaConstraints = MediaConstraints()): SessionDescription =
    awaitCreate { createAnswer(it, constraints) }

internal suspend fun PeerConnection.awaitSetLocal(sdp: SessionDescription) = awaitSet { setLocalDescription(it, sdp) }

internal suspend fun PeerConnection.awaitSetRemote(sdp: SessionDescription) = awaitSet { setRemoteDescription(it, sdp) }

private suspend fun awaitCreate(start: (SdpObserver) -> Unit): SessionDescription = suspendCancellableCoroutine { cont ->
    start(
        object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) = cont.resume(sdp)

            override fun onCreateFailure(error: String?) = cont.resumeWithException(IllegalStateException(error ?: "create"))

            override fun onSetSuccess() = Unit

            override fun onSetFailure(error: String?) = Unit
        },
    )
}

private suspend fun awaitSet(start: (SdpObserver) -> Unit): Unit = suspendCancellableCoroutine { cont ->
    start(
        object : SdpObserver {
            override fun onCreateSuccess(sdp: SessionDescription) = Unit

            override fun onCreateFailure(error: String?) = Unit

            override fun onSetSuccess() = cont.resume(Unit)

            override fun onSetFailure(error: String?) = cont.resumeWithException(IllegalStateException(error ?: "set"))
        },
    )
}
