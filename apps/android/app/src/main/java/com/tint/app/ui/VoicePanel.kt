package com.tint.app.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.tint.app.AppContainer
import com.tint.app.live.WebRtcEnv
import com.tint.app.sync.OkHttpSyncSocketFactory
import com.tint.app.voice.VoiceClient
import com.tint.app.voice.VoiceMeshFactory
import com.tint.app.voice.VoicePeer
import com.tint.app.voice.VoiceStatus
import com.tint.app.voice.WebRtcVoiceMesh

/**
 * El cliente de voz de la sala, ligado a la pantalla y no al panel: así cambiar de pestaña o de formato no te saca de la
 * voz. En segundo plano se sale (Android no deja capturar el micrófono sin un servicio en primer plano) y, mientras hay
 * voz, el audio sale por el altavoz con la cancelación de eco del modo «comunicación».
 */
@Composable
fun rememberVoiceClient(roomId: String, container: AppContainer, sharedEnv: WebRtcEnv? = null): VoiceClient {
    val context = LocalContext.current
    val activity = context as ComponentActivity
    val scope = rememberCoroutineScope()

    // libwebrtc se carga solo cuando alguien entra a la voz; si la pantalla ya tiene un entorno, se reutiliza.
    val own = remember { arrayOfNulls<WebRtcEnv>(1) }
    DisposableEffect(Unit) { onDispose { own[0]?.release() } }
    val env: () -> WebRtcEnv = { sharedEnv ?: own[0] ?: WebRtcEnv(context).also { own[0] = it } }

    val voice = remember(roomId) {
        VoiceClient(
            roomId = roomId,
            token = { container.tokens.guestToken },
            urlFor = container.endpoints::voiceUrl,
            sockets = OkHttpSyncSocketFactory(container.http),
            meshes = VoiceMeshFactory { selfId, ice, send, levels -> WebRtcVoiceMesh(env(), selfId, ice, send, levels) },
            scope = scope,
        )
    }
    val state by voice.state.collectAsState()

    DisposableEffect(activity, voice) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) voice.leave() }
        activity.lifecycle.addObserver(observer)
        onDispose {
            activity.lifecycle.removeObserver(observer)
            voice.leave()
        }
    }
    LaunchedEffect(state.status == VoiceStatus.CONNECTED) {
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (state.status == VoiceStatus.CONNECTED) {
            audio.mode = AudioManager.MODE_IN_COMMUNICATION
            @Suppress("DEPRECATION")
            audio.isSpeakerphoneOn = true
        } else {
            audio.mode = AudioManager.MODE_NORMAL
            @Suppress("DEPRECATION")
            audio.isSpeakerphoneOn = false
        }
    }
    DisposableEffect(Unit) {
        onDispose { (context.getSystemService(Context.AUDIO_SERVICE) as AudioManager).mode = AudioManager.MODE_NORMAL }
    }
    return voice
}

/**
 * Voz de la sala. El micrófono se pide **al tocar «Unirme a la voz»**, no al abrir la app: la voz empieza solo si se
 * concede (AC1) y, si se niega, el resto de la sala sigue funcionando y se explica cómo darlo (AC2). Silenciarse corta
 * el audio al instante (AC3).
 */
@Composable
fun VoicePanel(voice: VoiceClient, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val state by voice.state.collectAsState()

    var micDenied by rememberSaveable { mutableStateOf(false) }
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        micDenied = !granted
        if (granted) voice.join()
    }
    val onJoin = {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            micDenied = false
            voice.join()
        } else {
            askMic.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    Column(
        modifier.fillMaxWidth().background(TintSurface, RoundedCornerShape(16.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("VOZ", color = TintAccentSoft, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.4.sp)
            Text(headline(state.status, state.peers.size), color = TintMuted, fontSize = 12.sp)
        }

        when (state.status) {
            VoiceStatus.IDLE, VoiceStatus.ENDED -> {
                if (state.status == VoiceStatus.IDLE || !state.roomClosed) {
                    Button(onClick = onJoin, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Unirme a la voz", fontWeight = FontWeight.Bold) }
                }
            }
            VoiceStatus.JOINING, VoiceStatus.RECONNECTING -> Text("Conectando con la voz…", color = Color.White, fontSize = 13.sp)
            VoiceStatus.CONNECTED -> {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    state.self?.let { Avatar(it, you = true, muted = state.muted, speaking = it.peerId in state.speaking) }
                    state.peers.forEach { Avatar(it, you = false, muted = it.muted || it.hostMuted, speaking = it.peerId in state.speaking) }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = voice::toggleMute, modifier = Modifier.weight(1f).height(48.dp)) {
                        Icon(if (state.muted) TintIcons.Mic else TintIcons.MicOff, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(if (state.muted) "Activar micrófono" else "Silenciarme", fontWeight = FontWeight.Bold)
                    }
                    OutlinedButton(onClick = voice::leave, Modifier.height(48.dp)) { Text("Salir") }
                }
            }
        }

        if (state.hostMuted) Text("El host te silenció.", color = TintMuted, fontSize = 12.sp)
        if (micDenied) {
            Text(
                "Sin permiso de micrófono no puedes hablar, pero el resto de la sala sigue funcionando.",
                color = Color(0xFFF2B8B5),
                fontSize = 12.sp,
            )
            TextButton(onClick = { openAppSettings(context) }) { Text("Dar permiso en Ajustes") }
        }
        state.notice?.let { notice ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Text(notice, color = Color.White, fontSize = 12.sp, modifier = Modifier.weight(1f))
                TextButton(onClick = voice::dismissNotice) { Text("OK") }
            }
        }
    }
}

/** Barra compacta que se ve sobre las pestañas mientras hay voz: quién habla y el botón de silenciarme (mockup M05). */
@Composable
fun VoiceBar(voice: VoiceClient, modifier: Modifier = Modifier) {
    val state by voice.state.collectAsState()
    if (state.status != VoiceStatus.CONNECTED) return
    val everyone = listOfNotNull(state.self) + state.peers
    val speaker = everyone.firstOrNull { it.peerId in state.speaking }
    Row(
        modifier.fillMaxWidth().height(52.dp).background(TintSurface, RoundedCornerShape(14.dp)).padding(start = 12.dp, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(TintIcons.Mic, null, Modifier.size(18.dp), tint = TintAccentSoft)
        Row(horizontalArrangement = Arrangement.spacedBy((-6).dp)) {
            everyone.take(4).forEach { Avatar(it, you = it.peerId == state.self?.peerId, muted = false, speaking = it.peerId in state.speaking, size = 30.dp) }
        }
        Text(
            if (speaker != null) "${if (speaker.peerId == state.self?.peerId) "Tú" else speaker.nick} está hablando" else "${everyone.size} en la voz",
            color = TintMuted,
            fontSize = 12.sp,
            modifier = Modifier.weight(1f),
            maxLines = 1,
        )
        OutlinedButton(
            onClick = voice::toggleMute,
            modifier = Modifier.height(40.dp),
            border = BorderStroke(1.dp, TintAccent),
        ) { Text(if (state.muted) "Activarme" else "Silenciarme", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = TintAccentSoft) }
    }
}

@Composable
private fun Avatar(peer: VoicePeer, you: Boolean, muted: Boolean, speaking: Boolean, size: Dp = 44.dp) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(contentAlignment = Alignment.Center) {
            Box(
                Modifier.size(size).clip(CircleShape)
                    .background(if (you) TintAccent else Color(0xFF3B4C5A))
                    .border(2.dp, if (speaking) TintGood else TintCard, CircleShape),
                contentAlignment = Alignment.Center,
            ) { Text((peer.nick.firstOrNull() ?: '?').uppercase(), color = if (you) TintBackground else Color.White, fontWeight = FontWeight.Bold, fontSize = (size.value * 0.36f).sp) }
            if (muted) {
                Box(Modifier.align(Alignment.BottomEnd).size(18.dp).clip(CircleShape).background(TintDanger), contentAlignment = Alignment.Center) {
                    Icon(TintIcons.MicOff, null, Modifier.size(11.dp), tint = Color.White)
                }
            }
        }
        if (size >= 40.dp) Text(if (you) "Tú" else peer.nick, color = TintText, fontSize = 11.sp, maxLines = 1)
    }
}

private fun headline(status: VoiceStatus, others: Int): String = when (status) {
    VoiceStatus.IDLE -> "Hablen mientras ven"
    VoiceStatus.JOINING, VoiceStatus.RECONNECTING -> "Conectando…"
    VoiceStatus.CONNECTED -> if (others == 0) "Solo tú por ahora" else "$others ${if (others == 1) "persona" else "personas"} más"
    VoiceStatus.ENDED -> "Voz terminada"
}

private fun openAppSettings(context: Context) {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
}
