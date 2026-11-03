package com.tint.app.ui

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.movableContentOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
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
import com.tint.app.layout.RoomLayout
import com.tint.app.live.EndReason
import com.tint.app.live.LiveBadge
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
 * Sala de transmisión en vivo (`roomKind` = `live`, AND-06 y AND-24): el vídeo del host llega por WHEP desde stream-core y
 * el chat, las reacciones, la trivia y las encuestas siguen siendo las del Canal Social. Se organiza en los mismos cuatro
 * formatos y la misma pantalla completa que una película, sin barra de progreso porque lo que se ve es lo que el host
 * transmite. Cuando el evento termina se corta el vídeo y se avisa.
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
    val voice = rememberVoiceClient(room.roomId, container, sharedEnv = env)
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

    var fullscreen by rememberSaveable { mutableStateOf(false) }
    var tab by rememberSaveable { mutableStateOf(RoomTab.CHAT) }
    var audioMuted by rememberSaveable { mutableStateOf(false) }
    FullscreenEffect(fullscreen) { fullscreen = false }
    LaunchedEffect(audioMuted, controller) { controller.setAudioEnabled(!audioMuted) }

    // La posición de una reacción en vivo es el tiempo que lleva transmitiendo para este espectador.
    var liveSinceMs by remember { mutableLongStateOf(0L) }
    LaunchedEffect(live.status) {
        if (live.status == LiveStatus.LIVE && liveSinceMs == 0L) liveSinceMs = clock()
    }
    val reactionPosition = { if (liveSinceMs > 0) clock() - liveSinceMs else 0L }

    val video = remember {
        movableContentOf {
            LiveVideo(
                renderer = renderer,
                controller = controller,
                social = social,
                clock = clock,
                fullscreen = { fullscreen },
                onFullscreen = { fullscreen = true },
                audioMuted = { audioMuted },
                onToggleAudio = { audioMuted = !audioMuted },
            )
        }
    }

    val selfUserId = TokenClaims.subject(container.tokens.guestToken)
    val badge = LiveBadge.of(live)
    val title = room.title ?: "Evento en vivo"
    val onInvite: (() -> Unit)? = room.inviteCode?.let { code -> { shareInvite(context, room.title, code) } }

    BoxWithConstraints(Modifier.fillMaxSize().background(TintBackground)) {
        val layout = RoomLayout.of(maxWidth.value.toInt(), maxHeight.value.toInt())
        LaunchedEffect(socialState.trivia?.question?.triviaId) {
            if (socialState.trivia != null && layout.tabbed) tab = RoomTab.TRIVIA
        }
        when {
            socialState.revoked -> CenteredNotice("Tu invitación ya no es válida. El host te retiró de la sala.")
            socialState.expired -> CenteredNotice("Tu invitación caducó. Vuelve a unirte con el link.")
            fullscreen -> FullscreenOverlay(
                title = title,
                badge = badge,
                video = video,
                social = social,
                state = socialState,
                nowMs = clock,
                progress = null,
                liveLabel = live.viewerCount?.let { "EN VIVO · $it" } ?: "EN VIVO",
                audioMuted = audioMuted,
                onToggleAudio = { audioMuted = !audioMuted },
                onReact = { social.sendReaction(it, reactionPosition()) },
                onExit = { fullscreen = false },
            )
            else -> RoomScaffold(
                layout = layout,
                topBar = { overlay -> RoomTopBar(title, "Entraste como ${room.nick}", onLeave, onInvite, overlay) },
                video = video,
                status = {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { SyncChip(badge) }
                },
                reactions = { ReactionRow({ social.sendReaction(it, reactionPosition()) }) },
                voiceBar = { VoiceBar(voice) },
                tabs = { tabSet -> RoomPanels(tabSet, tab, { tab = it }, social, socialState, selfUserId, clock, voice) },
                chat = {
                    ChatPanel(
                        state = socialState,
                        selfUserId = selfUserId,
                        nowMs = clock,
                        onSend = social::send,
                        modifier = Modifier.fillMaxSize().padding(12.dp),
                    )
                },
                cards = { horizontal -> SideCards(horizontal, social, socialState, selfUserId, clock, voice) },
            )
        }
    }
}

/** El video de la transmisión con lo que se dibuja encima: el estado, la escena del host, el láser y las reacciones. */
@Composable
private fun LiveVideo(
    renderer: SurfaceViewRenderer,
    controller: LiveViewerController,
    social: SocialClient,
    clock: () -> Long,
    fullscreen: () -> Boolean,
    onFullscreen: () -> Unit,
    audioMuted: () -> Boolean,
    onToggleAudio: () -> Unit,
) {
    val live by controller.state.collectAsState()
    val socialState by social.state.collectAsState()
    Box(Modifier.fillMaxSize()) {
        AndroidView(modifier = Modifier.fillMaxSize(), factory = { renderer })
        LaserOverlay(socialState.laser, nowMs = clock, onPrune = social::pruneLaser, modifier = Modifier.fillMaxSize())
        FloatingReactionsLayer(socialState.floating, nowMs = clock, onPrune = social::pruneReactions, modifier = Modifier.fillMaxSize())
        StatusOverlay(live, onRetry = { controller.stop(); controller.start() })

        if (live.status == LiveStatus.LIVE) {
            Row(
                Modifier.align(Alignment.TopStart).padding(10.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text("EN VIVO", color = Color.White, fontSize = 11.sp, modifier = Modifier.background(TintDanger, RoundedCornerShape(5.dp)).padding(horizontal = 9.dp, vertical = 3.dp))
                live.viewerCount?.let {
                    Text("$it", color = Color.White, fontSize = 11.sp, modifier = Modifier.background(Color(0x99000000), RoundedCornerShape(5.dp)).padding(horizontal = 9.dp, vertical = 3.dp))
                }
            }
        }
        if (!fullscreen()) {
            Row(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(44.dp).background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xA6000000)))),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onToggleAudio) {
                    Icon(if (audioMuted()) TintIcons.VolumeOff else TintIcons.Volume, if (audioMuted()) "Activar el sonido" else "Silenciar solo para mí", tint = Color.White)
                }
                IconButton(onClick = onFullscreen) { Icon(TintIcons.Fullscreen, "Pantalla completa", tint = Color.White) }
            }
        }
    }
}

/** Lo que tapa el vídeo según el estado: conectando, esperando al host, escena del host o fin del evento. */
@Composable
private fun StatusOverlay(live: LiveUiState, onRetry: () -> Unit) {
    val text = when {
        live.status == LiveStatus.ENDED -> endedMessage(live.endReason)
        live.status == LiveStatus.WAITING -> "Esperando a que el host empiece…"
        live.status == LiveStatus.RECONNECTING -> "Reconectando…"
        live.status == LiveStatus.LIVE && live.scene == StreamScene.BRB -> "Ya volvemos"
        live.status == LiveStatus.LIVE && live.scene == StreamScene.STARTING_SOON -> "Empezamos pronto"
        else -> null
    }
    when {
        live.status == LiveStatus.ERROR -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(16.dp)) {
                Text(live.error.orEmpty(), color = Color.White, textAlign = TextAlign.Center)
                Button(onClick = onRetry, Modifier.padding(top = 8.dp)) { Text("Reintentar") }
            }
        }
        text != null -> Box(Modifier.fillMaxSize().background(Color(0xCC000000)), contentAlignment = Alignment.Center) {
            Text(text, color = Color.White, textAlign = TextAlign.Center, modifier = Modifier.padding(16.dp), fontSize = 18.sp)
        }
        live.status == LiveStatus.CONNECTING || live.status == LiveStatus.IDLE ->
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = TintAccent) }
    }
}

private fun endedMessage(reason: EndReason?): String = when (reason) {
    EndReason.GRACE_EXPIRED -> "El evento terminó: el host no volvió a tiempo."
    else -> "El evento terminó."
}
