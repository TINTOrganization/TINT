package com.tint.app.ui

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.tint.app.AppContainer
import com.tint.app.join.JoinedRoom
import com.tint.app.live.EndReason
import com.tint.app.live.LiveStatus
import com.tint.app.live.LiveUiState
import com.tint.app.live.LiveViewerController
import com.tint.app.live.StreamApi
import com.tint.app.live.StreamScene
import com.tint.app.live.ViewerPeerFactory
import com.tint.app.live.WebRtcEnv
import com.tint.app.live.WebRtcViewerPeer
import com.tint.app.net.TokenClaims
import com.tint.app.social.SocialClient
import com.tint.app.sync.OkHttpSyncSocketFactory
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack

/**
 * Sala de transmisión en vivo (`roomKind` = `live`): el vídeo del host llega por WHEP desde stream-core y el chat, las
 * reacciones, la trivia y las encuestas siguen siendo las del Canal Social. Sin Canal Sync: aquí no hay película que
 * sincronizar. Cuando el evento termina se corta el vídeo y se avisa (AND-06 AC2).
 */
@Composable
fun LiveRoomScreen(room: JoinedRoom, container: AppContainer, onLeave: () -> Unit) {
    val context = LocalContext.current
    val activity = context as ComponentActivity
    val scope = rememberCoroutineScope()
    val clock = { SystemClock.elapsedRealtime() }
    val main = remember { Handler(Looper.getMainLooper()) }

    // Se declara primero para liberarse el último: el renderizador y la PeerConnection dependen de este entorno.
    val env = remember { WebRtcEnv(context) }
    DisposableEffect(env) { onDispose { env.release() } }

    var videoTrack by remember { mutableStateOf<VideoTrack?>(null) }
    val controller = remember(room.roomId) {
        LiveViewerController(
            roomId = room.roomId,
            signaling = StreamApi(container.endpoints.streamApiUrl, container.http) { container.tokens.guestToken },
            peers = ViewerPeerFactory { listener ->
                // libwebrtc avisa desde sus propios hilos: la pista de vídeo se publica en el hilo principal.
                WebRtcViewerPeer(env, listener) { track -> main.post { videoTrack = track } }
            },
            scope = scope,
        )
    }
    val social = remember(room.roomId) {
        SocialClient(
            roomId = room.roomId,
            token = { container.tokens.guestToken },
            urlFor = container.endpoints::socialUrl,
            sockets = OkHttpSyncSocketFactory(container.http),
            scope = scope,
            nowMs = clock,
            selfUserId = { TokenClaims.subject(container.tokens.guestToken) },
        )
    }
    val live by controller.state.collectAsState()
    val socialState by social.state.collectAsState()

    val renderer = remember {
        SurfaceViewRenderer(context).apply {
            init(env.eglBase.eglBaseContext, null)
            setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
            setEnableHardwareScaler(true)
        }
    }
    DisposableEffect(renderer) { onDispose { renderer.release() } }
    DisposableEffect(videoTrack, renderer) {
        val track = videoTrack
        track?.addSink(renderer)
        onDispose { track?.removeSink(renderer) }
    }

    // Segundo plano: se cierra la sesión de la transmisión (libera un lugar del cupo de 50) y al volver se reconecta.
    DisposableEffect(activity, controller, social) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> {
                    controller.start()
                    social.start()
                }
                Lifecycle.Event.ON_STOP -> {
                    controller.stop()
                    social.stop()
                }
                else -> Unit
            }
        }
        activity.lifecycle.addObserver(observer)
        onDispose {
            activity.lifecycle.removeObserver(observer)
            controller.stop()
            social.stop()
        }
    }
    // El cierre de la sala llega también por el Canal Social (4010): el evento terminó aunque el DataChannel no lo diga.
    LaunchedEffect(socialState.roomClosed) {
        if (socialState.roomClosed) controller.roomClosed()
    }

    // Al terminar el evento no debe quedar congelado el último fotograma detrás del aviso.
    LaunchedEffect(live.status) {
        if (live.status == LiveStatus.ENDED) renderer.clearImage()
    }

    // La posición de una reacción en vivo es el tiempo que lleva transmitiendo para este espectador.
    var liveSinceMs by remember { mutableLongStateOf(0L) }
    LaunchedEffect(live.status) {
        if (live.status == LiveStatus.LIVE && liveSinceMs == 0L) liveSinceMs = clock()
    }

    Column(
        modifier = Modifier.fillMaxSize().background(TintBackground).padding(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(room.title ?: "Evento en vivo", style = MaterialTheme.typography.titleMedium, color = TintAccent, maxLines = 1)
                Text("Entraste como ${room.nick}", color = Color.Gray, fontSize = 12.sp)
            }
            OutlinedButton(onClick = onLeave) { Text("Salir") }
        }
        Spacer(Modifier.height(8.dp))

        when {
            socialState.revoked -> Notice("Tu invitación ya no es válida. El host te retiró de la sala.")
            socialState.expired -> Notice("Tu invitación caducó. Vuelve a unirte con el link.")
            // Todo lo de la sala se desplaza: con tarjetas (encuesta, trivia, voz) el chat ya no se queda sin espacio.
            else -> Column(
                Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(Color.Black), contentAlignment = Alignment.Center) {
                    AndroidView(modifier = Modifier.fillMaxSize(), factory = { renderer })
                    LaserOverlay(socialState.laser, nowMs = clock, onPrune = social::pruneLaser, modifier = Modifier.fillMaxSize())
                    StatusOverlay(live)
                }
                Text(statusLine(live), color = Color.Gray, fontSize = 11.sp, textAlign = TextAlign.Center)
                if (live.status == LiveStatus.ERROR) {
                    Button(onClick = { controller.stop(); controller.start() }) { Text("Reintentar") }
                }
                socialState.trivia?.let { trivia ->
                    TriviaCard(trivia, nowMs = clock, onAnswer = { social.answerTrivia(it) }, onDismiss = social::dismissTrivia)
                }
                socialState.poll?.let { poll ->
                    PollCard(poll, wallNowMs = System::currentTimeMillis, onVote = { social.votePoll(it) }, onDismiss = social::dismissPoll)
                }
                ReactionBar(socialState) { emoji ->
                    social.sendReaction(emoji, if (liveSinceMs > 0) clock() - liveSinceMs else 0L)
                }
                VoicePanel(room.roomId, container, sharedEnv = env)
                ChatPanel(
                    state = socialState,
                    selfUserId = TokenClaims.subject(container.tokens.guestToken),
                    nowMs = clock,
                    onSend = social::send,
                    modifier = Modifier.fillMaxWidth().height(CHAT_HEIGHT),
                )
            }
        }
    }
}

/** Lo que tapa el vídeo según el estado: conectando, esperando al host, escena del host o fin del evento. */
@Composable
private fun StatusOverlay(live: LiveUiState) {
    val text = when {
        live.status == LiveStatus.ENDED -> endedMessage(live.endReason)
        live.status == LiveStatus.WAITING -> "Esperando a que el host empiece…"
        live.status == LiveStatus.RECONNECTING -> "Reconectando…"
        live.status == LiveStatus.LIVE && live.scene == StreamScene.BRB -> "Ya volvemos"
        live.status == LiveStatus.LIVE && live.scene == StreamScene.STARTING_SOON -> "Empezamos pronto"
        else -> null
    }
    when {
        live.status == LiveStatus.ERROR -> Text(live.error.orEmpty(), color = Color.White, textAlign = TextAlign.Center, modifier = Modifier.padding(16.dp))
        text != null -> Box(Modifier.fillMaxSize().background(Color(0xCC000000)), contentAlignment = Alignment.Center) {
            Text(text, color = Color.White, textAlign = TextAlign.Center, modifier = Modifier.padding(16.dp))
        }
        live.status == LiveStatus.CONNECTING || live.status == LiveStatus.IDLE -> CircularProgressIndicator(color = TintAccent)
    }
}

private fun endedMessage(reason: EndReason?): String = when (reason) {
    EndReason.GRACE_EXPIRED -> "El evento terminó: el host no volvió a tiempo."
    else -> "El evento terminó."
}

private fun statusLine(live: LiveUiState): String = when (live.status) {
    LiveStatus.IDLE, LiveStatus.CONNECTING -> "Conectando con la transmisión…"
    LiveStatus.WAITING -> "El host todavía no transmite"
    LiveStatus.LIVE -> live.viewerCount?.let { "En vivo · $it ${if (it == 1) "espectador" else "espectadores"}" } ?: "En vivo"
    LiveStatus.RECONNECTING -> live.error ?: "Reconectando con la transmisión…"
    LiveStatus.ENDED -> endedMessage(live.endReason)
    LiveStatus.ERROR -> "No se pudo ver la transmisión"
}

/** Alto del chat dentro de la sala, que ahora se desplaza. */
private val CHAT_HEIGHT = 320.dp
