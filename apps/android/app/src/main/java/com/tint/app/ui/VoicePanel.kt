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
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
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
import com.tint.app.voice.VoiceStatus
import com.tint.app.voice.WebRtcVoiceMesh

private val CardBg = Color(0xFF1B1E26)

/**
 * Voz de la sala. El micrófono se pide **al tocar «Unirme a la voz»**, no al abrir la app: la voz empieza solo si se
 * concede (AC1) y, si se niega, el resto de la sala sigue funcionando y se explica cómo darlo (AC2). Silenciarse corta
 * el audio al instante (AC3). En segundo plano se sale de la voz: Android no deja capturar el micrófono sin un servicio
 * en primer plano.
 */
@Composable
fun VoicePanel(roomId: String, container: AppContainer, sharedEnv: WebRtcEnv? = null) {
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
            meshes = VoiceMeshFactory { selfId, ice, send -> WebRtcVoiceMesh(env(), selfId, ice, send) },
            scope = scope,
        )
    }
    val state by voice.state.collectAsState()

    var micDenied by remember { mutableStateOf(false) }
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

    DisposableEffect(activity, voice) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) voice.leave() }
        activity.lifecycle.addObserver(observer)
        onDispose {
            activity.lifecycle.removeObserver(observer)
            voice.leave()
        }
    }
    // Mientras hay voz, el audio sale por el altavoz y se activa la cancelación de eco del modo «comunicación».
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
        onDispose {
            val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            audio.mode = AudioManager.MODE_NORMAL
        }
    }

    Column(
        Modifier.fillMaxWidth().padding(vertical = 4.dp).background(CardBg, RoundedCornerShape(12.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
            Text("VOZ", color = TintAccent, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            Text(headline(state.status, state.peers.size), color = Color.Gray, fontSize = 12.sp)
        }

        when (state.status) {
            VoiceStatus.IDLE, VoiceStatus.ENDED -> {
                if (state.status == VoiceStatus.IDLE || !state.roomClosed) {
                    Button(onClick = onJoin, modifier = Modifier.fillMaxWidth()) { Text("🎙 Unirme a la voz") }
                }
            }
            VoiceStatus.JOINING, VoiceStatus.RECONNECTING -> Text("Conectando con la voz…", color = Color.White, fontSize = 13.sp)
            VoiceStatus.CONNECTED -> {
                val names = buildList {
                    state.self?.let { add(if (state.muted) "Tú 🔇" else "Tú") }
                    state.peers.forEach { add(if (it.muted || it.hostMuted) "${it.nick} 🔇" else it.nick) }
                }
                Text(names.joinToString(" · "), color = Color.White, fontSize = 13.sp)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = voice::toggleMute, modifier = Modifier.weight(1f)) {
                        Text(if (state.muted) "🎙 Activar micrófono" else "🔇 Silenciarme")
                    }
                    OutlinedButton(onClick = voice::leave) { Text("Salir de la voz") }
                }
            }
        }

        if (state.hostMuted) Text("El host te silenció.", color = Color.Gray, fontSize = 12.sp)
        if (micDenied) {
            Text(
                "Sin permiso de micrófono no puedes hablar, pero el resto de la sala sigue funcionando.",
                color = ErrorText,
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

private val ErrorText = Color(0xFFF2B8B5)

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
