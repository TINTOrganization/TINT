package com.tint.app.ui

import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.util.Log
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
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import android.os.PowerManager
import android.provider.Settings
import com.tint.app.ambilight.AmbilightFrame
import androidx.compose.material3.TextButton
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import com.tint.app.AppContainer
import com.tint.app.BuildConfig
import com.tint.app.join.InviteLink
import com.tint.app.join.JoinedRoom
import com.tint.app.layout.RoomLayout
import com.tint.app.layout.VideoEnd
import com.tint.app.layout.VideoTime
import com.tint.app.net.TokenClaims
import com.tint.app.social.SocialClient
import com.tint.app.sync.ExoPlayerPort
import com.tint.app.sync.OkHttpSyncSocketFactory
import com.tint.app.sync.PositionTracker
import com.tint.app.sync.RoomController
import com.tint.app.sync.SyncBadge
import com.tint.app.sync.SyncClient
import com.tint.app.sync.SyncedPlayback
import kotlinx.coroutines.delay

/**
 * Sala de película sincronizada (AND-03 a AND-05, AND-10 a AND-12). La pantalla solo cablea: los clientes de red, el
 * reproductor y el estado; cómo se coloca todo según el tamaño de la ventana lo decide [RoomScaffold], y la pantalla
 * completa, [FullscreenOverlay]. El video es un único `PlayerView` que se mueve entre formatos sin recrearse.
 */
@Composable
fun RoomScreen(room: JoinedRoom, container: AppContainer, onLeave: () -> Unit) {
    val context = LocalContext.current
    val activity = context as ComponentActivity
    val scope = rememberCoroutineScope()
    val clock = { SystemClock.elapsedRealtime() }
    val tracker = remember { PositionTracker(clock) }
    val sync = remember(room.roomId) {
        SyncClient(
            roomId = room.roomId,
            token = { container.tokens.guestToken },
            urlFor = container.endpoints::syncUrl,
            sockets = OkHttpSyncSocketFactory(container.http),
            scope = scope,
            nowMs = clock,
            localPositionMs = tracker::current,
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
    val controller = remember(room.roomId) { RoomController(room.roomId, sync, container.playback, scope) }
    val voice = rememberVoiceClient(room.roomId, container)
    val ui by controller.ui.collectAsState()
    val syncState by sync.state.collectAsState()
    val socialState by social.state.collectAsState()

    val player = remember { ExoPlayer.Builder(context).build() }
    val playback = remember(player) { SyncedPlayback(ExoPlayerPort(player), clock) }
    val playerView = remember(player) { PlayerView(context).apply { useController = false; this.player = player } }

    var fullscreen by rememberSaveable { mutableStateOf(false) }
    var tab by rememberSaveable { mutableStateOf(RoomTab.CHAT) }
    var audioMuted by rememberSaveable { mutableStateOf(false) }
    // El recap se pide una vez por final; volver a verla (alejarse del final) lo rearma.
    var recapAsked by remember { mutableStateOf(false) }
    val askRecapOnce = {
        if (!recapAsked) {
            recapAsked = true
            social.requestRecap()
        }
    }
    var positionMs by remember { mutableLongStateOf(0L) }
    var durationMs by remember { mutableLongStateOf(0L) }
    FullscreenEffect(fullscreen) { fullscreen = false }
    // Ambilight (AND-23): la paleta se descarga una vez por vídeo (la clave ignora la firma de la URL).
    var glowFrames by remember { mutableStateOf(emptyList<AmbilightFrame>()) }
    val ambilightKey = ui.ambilightUrl?.substringBefore('?')
    LaunchedEffect(ambilightKey) {
        glowFrames = ui.ambilightUrl?.let { container.ambilight.load(it) }.orEmpty()
    }
    val batterySaver = (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isPowerSaveMode
    var glowOn by remember { mutableStateOf(container.ambilightPrefs.isOn(batterySaver)) }
    val animationsOn = remember { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f }
    // El video vive en un `movableContentOf`: se lee desde un estado para que vea siempre la paleta vigente.
    val glow by rememberUpdatedState(
        GlowControl(glowFrames, glowOn, animationsOn) {
            glowOn = !glowOn
            container.ambilightPrefs.set(glowOn)
        },
    )
    val haloModifier = Modifier.ambilightHalo(glow) { player.currentPosition }
    val widthDp = LocalConfiguration.current.screenWidthDp
    NetworkHintsEffect(widthDp) { controller.setNetwork(it) }
    LaunchedEffect(audioMuted, player) { player.volume = if (audioMuted) 0f else 1f }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            // La URL prefirmada pudo caducar o la red falló: se pide una nueva.
            override fun onPlayerError(error: PlaybackException) = controller.recover()

            // Como la web: cuando el video termina se pide el resumen de la sesión.
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) askRecapOnce()
            }
        }
        player.addListener(listener)
        onDispose {
            player.removeListener(listener)
            player.release()
        }
    }

    // Segundo plano: se pausa y se cierra el canal; al volver llega un STATE nuevo y el vídeo salta a la sala.
    DisposableEffect(activity, controller, social) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> {
                    controller.start()
                    social.start()
                }
                Lifecycle.Event.ON_STOP -> {
                    player.pause()
                    tracker.clear()
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

    LaunchedEffect(ui.videoUrl) {
        val url = ui.videoUrl
        if (url == null) {
            player.stop()
            player.clearMediaItems()
        } else {
            // Al cambiar de calidad el mismo vídeo sigue por donde iba; la sincronía lo corrige enseguida.
            val resumeAt = if (player.mediaItemCount > 0) player.currentPosition else 0L
            player.setMediaItem(MediaItem.fromUri(url), resumeAt)
            player.prepare()
            syncState.snapshot?.let(playback::apply)
        }
    }
    LaunchedEffect(syncState.snapshot) {
        syncState.snapshot?.let {
            if (BuildConfig.DEBUG) {
                Log.d(TAG, "apply v=${it.state.version} status=${it.state.status} rate=${it.state.rate} pos=${it.state.positionMs}")
            }
            playback.apply(it)
        }
    }
    LaunchedEffect(syncState.correction?.seq) {
        syncState.correction?.let {
            if (BuildConfig.DEBUG) Log.d(TAG, "correction ${it.strategy} drift=${it.driftMs} target=${it.targetMs}")
            playback.onCorrection(it, syncState.snapshot?.state?.rate ?: 1.0)
        }
    }
    LaunchedEffect(player) {
        var ticks = 0
        while (true) {
            val advancing = player.playWhenReady && player.playbackState == Player.STATE_READY
            tracker.update(player.currentPosition, if (advancing) player.playbackParameters.speed.toDouble() else 0.0)
            positionMs = player.currentPosition
            durationMs = player.duration.coerceAtLeast(0L)
            if (VideoEnd.reached(positionMs, durationMs)) askRecapOnce() else if (VideoEnd.rearmed(positionMs, durationMs)) recapAsked = false
            playback.tick()
            // Solo en debug: una línea por segundo para observar la sincronía con `adb logcat -s TintSync`.
            if (BuildConfig.DEBUG && ticks++ % TICKS_PER_LOG == 0) {
                Log.d(
                    TAG,
                    "drift=${playback.driftMs()} speed=${player.playbackParameters.speed} advancing=$advancing " +
                        "room=${syncState.snapshot?.state?.status}@${syncState.snapshot?.state?.rate} " +
                        "srvDrift=${syncState.driftMs} rtt=${syncState.rttMs}",
                )
            }
            delay(POSITION_TICK_MS)
        }
    }

    // El video y todo lo que se dibuja encima. Se crea una sola vez y se mueve entre formatos y a pantalla completa.
    val video = remember {
        movableContentOf {
            WatchVideo(
                playerView = playerView,
                controller = controller,
                social = social,
                clock = clock,
                fullscreen = { fullscreen },
                onFullscreen = { fullscreen = true },
                audioMuted = { audioMuted },
                onToggleAudio = { audioMuted = !audioMuted },
                progress = { if (durationMs > 0) positionMs.toFloat() / durationMs else 0f },
                positionMs = { player.currentPosition },
                glow = { glow },
            )
        }
    }

    val selfUserId = TokenClaims.subject(container.tokens.guestToken)
    val badge = SyncBadge.of(ui.connected, ui.hostOnline, syncState.reconnectAttempt, syncState.rttMs, syncState.driftMs)
    val title = room.title ?: "Sala sin título"
    val onInvite: (() -> Unit)? = room.inviteCode?.let { code -> { shareInvite(context, room.title, code) } }

    BoxWithConstraints(Modifier.fillMaxSize().background(TintBackground)) {
        val layout = RoomLayout.of(maxWidth.value.toInt(), maxHeight.value.toInt())
        // Una pregunta de trivia dura segundos: en el móvil se pasa sola a su pestaña para no perdérsela.
        LaunchedEffect(socialState.trivia?.question?.triviaId) {
            if (socialState.trivia != null && layout.tabbed) tab = RoomTab.TRIVIA
        }
        when {
            ui.revoked || socialState.revoked -> CenteredNotice("Tu invitación ya no es válida. El host te retiró de la sala.")
            ui.expired || socialState.expired -> CenteredNotice("Tu invitación caducó. Vuelve a unirte con el link.")
            fullscreen -> FullscreenOverlay(
                title = title,
                badge = badge,
                video = video,
                social = social,
                state = socialState,
                nowMs = clock,
                progress = VideoProgress(positionMs, durationMs),
                liveLabel = null,
                audioMuted = audioMuted,
                onToggleAudio = { audioMuted = !audioMuted },
                onReact = { social.sendReaction(it, tracker.current() ?: 0) },
                onExit = { fullscreen = false },
                trailing = { QualityMenu(ui.qualities, ui.currentQuality, ui.autoQuality, ui.qualityPref, ui.metered, controller::setQuality) },
            )
            else -> RoomScaffold(
                layout = layout,
                videoHalo = haloModifier,
                topBar = { overlay -> RoomTopBar(title, "Entraste como ${room.nick}", onLeave, onInvite, overlay) },
                video = video,
                status = {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        SyncChip(badge, Modifier.weight(1f))
                        if (durationMs > 0) Text("${VideoTime.format(positionMs)} / ${VideoTime.format(durationMs)}", color = TintMuted, fontSize = 12.sp, maxLines = 1, softWrap = false)
                    }
                },
                reactions = { ReactionRow({ social.sendReaction(it, tracker.current() ?: 0) }) },
                voiceBar = { VoiceBar(voice) },
                tabs = { tabSet ->
                    RoomPanels(tabSet, tab, { tab = it }, social, socialState, selfUserId, clock, voice)
                },
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
                videoOverlay = { CardsOnVideo(social, socialState, clock) },
            )
        }

        socialState.recap?.takeIf { !it.isEmpty }?.let { recap ->
            RecapScreen(room.title, recap, onClose = { social.dismissRecap(); onLeave() })
        }
    }
}

/** El video, el estado cuando todavía no hay video y lo que se dibuja encima: láser, reacciones y los botones del borde. */
@Composable
private fun WatchVideo(
    playerView: PlayerView,
    controller: RoomController,
    social: SocialClient,
    clock: () -> Long,
    fullscreen: () -> Boolean,
    onFullscreen: () -> Unit,
    audioMuted: () -> Boolean,
    onToggleAudio: () -> Unit,
    progress: () -> Float,
    positionMs: () -> Long,
    glow: () -> GlowControl,
) {
    val ui by controller.ui.collectAsState()
    val socialState by social.state.collectAsState()
    Box(Modifier.fillMaxSize()) {
        AndroidView(modifier = Modifier.fillMaxSize(), factory = { playerView })
        LaserOverlay(socialState.laser, nowMs = clock, onPrune = social::pruneLaser, modifier = Modifier.fillMaxSize())
        FloatingReactionsLayer(socialState.floating, nowMs = clock, onPrune = social::pruneReactions, modifier = Modifier.fillMaxSize())

        if (ui.videoUrl == null) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                when {
                    ui.noVideo -> Text("La sala todavía no tiene vídeo", color = Color.White, textAlign = TextAlign.Center)
                    ui.error != null -> RetryMessage(ui.error!!, onRetry = controller::recover)
                    else -> CircularProgressIndicator(color = TintAccent)
                }
            }
        }
        if (ui.hostOnline == false) {
            Text(
                "Host desconectado",
                color = Color.White,
                fontSize = 12.sp,
                modifier = Modifier.align(Alignment.TopStart).padding(10.dp).background(Color(0xA6000000), RoundedCornerShape(12.dp)).padding(horizontal = 10.dp, vertical = 4.dp),
            )
        }
        if (!fullscreen()) {
            Row(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(44.dp).background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xA6000000)))),
                horizontalArrangement = Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (glow().frames.isNotEmpty()) {
                    TextButton(onClick = glow().onToggle, modifier = Modifier.semantics { contentDescription = if (glow().on) "Apagar el brillo Ambilight" else "Encender el brillo Ambilight" }) {
                        Text("Brillo", color = if (glow().on) TintAccentSoft else Color.White.copy(alpha = 0.6f), fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
                QualityMenu(ui.qualities, ui.currentQuality, ui.autoQuality, ui.qualityPref, ui.metered, controller::setQuality)
                IconButton(onClick = onToggleAudio) {
                    Icon(if (audioMuted()) TintIcons.VolumeOff else TintIcons.Volume, if (audioMuted()) "Activar el sonido" else "Silenciar solo para mí", tint = Color.White)
                }
                IconButton(onClick = onFullscreen) { Icon(TintIcons.Fullscreen, "Pantalla completa", tint = Color.White) }
            }
            Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(3.dp).background(Color(0x40FFFFFF))) {
                Box(Modifier.fillMaxWidth(progress().coerceIn(0f, 1f)).height(3.dp).background(TintAccent))
            }
        }
    }
}

@Composable
private fun RetryMessage(message: String, onRetry: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(16.dp)) {
        Text(message, color = Color.White, textAlign = TextAlign.Center)
        Button(onClick = onRetry, Modifier.padding(top = 8.dp)) { Text("Reintentar") }
    }
}

@Composable
internal fun CenteredNotice(text: String) {
    Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) { Notice(text) }
}

@Composable
internal fun Notice(text: String) {
    Text(text, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
}

/** Abre la hoja de compartir del sistema con el link de la sala (AND-22). */
internal fun shareInvite(context: Context, title: String?, code: String) {
    val link = InviteLink.build(BuildConfig.INVITE_HOST, code)
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, InviteLink.shareText(title, link))
    }
    context.startActivity(Intent.createChooser(send, "Invitar a la sala").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

private const val POSITION_TICK_MS = 200L
private const val TICKS_PER_LOG = 5
private const val TAG = "TintSync"
