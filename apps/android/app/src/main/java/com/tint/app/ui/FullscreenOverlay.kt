package com.tint.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tint.app.layout.ControlsVisibility
import com.tint.app.layout.VideoTime
import com.tint.app.social.ChatItem
import com.tint.app.social.SocialClient
import com.tint.app.social.SocialProtocol
import com.tint.app.social.SocialUiState
import com.tint.app.sync.SyncBadge
import kotlinx.coroutines.delay

/** Dónde va el video: se muestra en la barra de la pantalla completa. Es `null` en una transmisión en vivo. */
data class VideoProgress(val positionMs: Long, val durationMs: Long)

/**
 * Pantalla completa horizontal (mockups M09 y M10, AND-11): el video ocupa todo y los controles aparecen al tocar y se
 * ocultan solos a los 3 s. Lo que importa de la sala no se esconde: reacciones, láser, trivia, encuesta y los últimos
 * mensajes se dibujan encima. El invitado no mueve el video, así que la barra solo informa.
 */
@Composable
fun FullscreenOverlay(
    title: String,
    badge: SyncBadge,
    video: @Composable () -> Unit,
    social: SocialClient,
    state: SocialUiState,
    nowMs: () -> Long,
    progress: VideoProgress?,
    liveLabel: String?,
    audioMuted: Boolean,
    onToggleAudio: () -> Unit,
    onReact: (String) -> Unit,
    onExit: () -> Unit,
    trailing: @Composable () -> Unit = {},
) {
    val controls = remember { ControlsVisibility() }
    var now by remember { mutableLongStateOf(nowMs()) }
    LaunchedEffect(Unit) {
        controls.show(nowMs())
        while (true) {
            now = nowMs()
            delay(250)
        }
    }
    var typing by remember { mutableStateOf(false) }
    LaunchedEffect(typing) { controls.hold(typing, nowMs()) }
    val visible = controls.visible(now)
    val touch = { controls.activity(nowMs()); now = nowMs() }

    Box(
        Modifier.fillMaxSize().background(Color.Black)
            .pointerInput(Unit) { detectTapGestures(onTap = { controls.tap(nowMs()); now = nowMs() }) },
    ) {
        video()
        LaserOverlay(state.laser, nowMs = nowMs, onPrune = social::pruneLaser, modifier = Modifier.fillMaxSize())
        FloatingReactionsLayer(state.floating, nowMs = nowMs, onPrune = social::pruneReactions, modifier = Modifier.fillMaxSize())

        // Cartas que no se esconden con los controles: son lo que el host lanzó para todos.
        // Una encuesta que ya cerró no es urgente: se ve en su pestaña, no tapando el video.
        state.poll?.takeIf { !it.closed }?.let { poll ->
            Box(Modifier.align(Alignment.TopStart).padding(start = 16.dp, top = 68.dp).widthIn(max = 330.dp)) {
                PollCard(poll, wallNowMs = System::currentTimeMillis, onVote = { social.votePoll(it) }, onDismiss = social::dismissPoll)
            }
        }
        state.trivia?.let { trivia ->
            Box(Modifier.align(Alignment.TopCenter).padding(top = 68.dp).widthIn(max = 440.dp)) {
                TriviaCard(trivia, nowMs = nowMs, onAnswer = { social.answerTrivia(it) }, onDismiss = social::dismissTrivia)
            }
        }

        ChatPeek(state.messages, Modifier.align(Alignment.BottomStart).padding(start = 16.dp, bottom = if (visible) 76.dp else 16.dp))

        if (visible) {
            Row(
                Modifier.align(Alignment.TopCenter).fillMaxWidth().height(60.dp)
                    .background(Brush.verticalGradient(listOf(Color(0xBF000000), Color.Transparent))).padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onExit, Modifier.size(48.dp)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Salir de la pantalla completa", tint = Color.White) }
                Text(title, color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold, maxLines = 1, modifier = Modifier.weight(1f))
                Row(
                    Modifier.clip(RoundedCornerShape(15.dp)).background(Color(0x8C000000)).padding(horizontal = 12.dp, vertical = 5.dp),
                ) { SyncChip(badge) }
                trailing()
                IconButton(onClick = { touch(); onToggleAudio() }, Modifier.size(48.dp)) {
                    Icon(if (audioMuted) TintIcons.VolumeOff else TintIcons.Volume, if (audioMuted) "Activar el sonido" else "Silenciar solo para mí", tint = Color.White)
                }
                IconButton(onClick = onExit, Modifier.size(48.dp)) { Icon(TintIcons.ExitFullscreen, "Salir de la pantalla completa", tint = Color.White) }
            }

            Column(
                Modifier.align(Alignment.CenterEnd).padding(end = 8.dp).clip(RoundedCornerShape(26.dp)).background(Color(0x991E1F22)),
            ) {
                SocialProtocol.REACTION_EMOJIS.forEach { emoji ->
                    Box(
                        Modifier.size(48.dp).clickable { touch(); onReact(emoji) }.semantics { contentDescription = "Reaccionar con $emoji" },
                        contentAlignment = Alignment.Center,
                    ) { Text(emoji, fontSize = 22.sp) }
                }
            }

            BottomBar(
                progress = progress,
                liveLabel = liveLabel,
                typing = typing,
                onTyping = { typing = it },
                onSend = { text -> social.send(text, false).also { if (it) touch() } },
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        }
    }
}

@Composable
private fun BottomBar(
    progress: VideoProgress?,
    liveLabel: String?,
    typing: Boolean,
    onTyping: (Boolean) -> Unit,
    onSend: (String) -> Boolean,
    modifier: Modifier = Modifier,
) {
    var draft by remember { mutableStateOf("") }
    Row(
        modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xCC000000)))).padding(horizontal = 16.dp, vertical = 10.dp).imePadding(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (typing) {
            OutlinedTextField(
                value = draft,
                onValueChange = { if (it.length <= SocialProtocol.CHAT_MAX_LENGTH) draft = it },
                singleLine = true,
                placeholder = { Text("Escribe un mensaje") },
                modifier = Modifier.weight(1f),
            )
            IconButton(
                onClick = { if (onSend(draft)) { draft = ""; onTyping(false) } },
                enabled = draft.isNotBlank(),
                modifier = Modifier.size(48.dp).clip(CircleShape).background(TintAccent),
            ) { Icon(Icons.AutoMirrored.Filled.Send, "Enviar", tint = TintBackground) }
            IconButton(onClick = { draft = ""; onTyping(false) }, Modifier.size(48.dp)) { Text("✕", color = Color.White) }
        } else {
            Box(
                Modifier.height(48.dp).clip(RoundedCornerShape(24.dp)).border(1.dp, Color(0x59FFFFFF), RoundedCornerShape(24.dp)).background(Color(0xB31E1F22))
                    .clickable { onTyping(true) }.padding(horizontal = 22.dp),
                contentAlignment = Alignment.Center,
            ) { Text("Escribir…", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold) }
            if (progress != null) {
                Text(VideoTime.format(progress.positionMs), color = Color.White, fontSize = 13.sp)
                Box(Modifier.weight(1f).height(6.dp).clip(RoundedCornerShape(3.dp)).background(Color(0x47FFFFFF))) {
                    Box(Modifier.fillMaxWidth(VideoTime.fraction(progress.positionMs, progress.durationMs)).height(6.dp).background(TintAccent))
                }
                Text(VideoTime.format(progress.durationMs), color = Color.White, fontSize = 13.sp)
                Text("El host controla", color = TintText, fontSize = 12.sp)
            } else {
                Box(Modifier.weight(1f))
                // Una cadena vacía es «no está en vivo» (terminó o reconecta): no se muestra el rótulo rojo.
                if (liveLabel != "") {
                    Row(Modifier.clip(RoundedCornerShape(6.dp)).background(TintDanger).padding(horizontal = 10.dp, vertical = 4.dp)) {
                        Text(liveLabel ?: "EN VIVO", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

/** Los últimos tres mensajes sobre el video, que se desvanecen hacia arriba. */
@Composable
private fun ChatPeek(messages: List<ChatItem>, modifier: Modifier = Modifier) {
    val recent = messages.filterIsInstance<ChatItem.Message>().takeLast(3)
    if (recent.isEmpty()) return
    Column(
        modifier.widthIn(max = 380.dp)
            .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
            .drawWithContent {
                drawContent()
                drawRect(Brush.verticalGradient(0f to Color.Transparent, 0.4f to Color.Black), blendMode = BlendMode.DstIn)
            },
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        recent.forEach { m ->
            Text(
                if (m.spoiler) "${m.nick}: spoiler oculto" else "${m.nick}: ${m.text}",
                color = Color.White,
                fontSize = 14.sp,
                maxLines = 2,
                modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(Color(0xB81E1F22)).padding(horizontal = 12.dp, vertical = 6.dp),
            )
        }
    }
}
