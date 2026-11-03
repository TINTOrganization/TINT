package com.tint.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tint.app.social.ChatItem
import com.tint.app.social.SocialProtocol
import com.tint.app.social.SocialUiState
import kotlinx.coroutines.delay

private val Bubble = TintCard

/** Tira con las reacciones de la sala y los botones para reaccionar. */
@Composable
fun ReactionBar(state: SocialUiState, onReact: (String) -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
            SocialProtocol.REACTION_EMOJIS.forEach { emoji ->
                TextButton(onClick = { onReact(emoji) }) { Text(emoji, fontSize = 22.sp) }
            }
        }
        val recent = state.reactions.takeLast(6)
        if (recent.isNotEmpty()) {
            Text(
                recent.joinToString("   ") { "${it.emoji} ${it.nick}" },
                color = Color.Gray,
                fontSize = 12.sp,
                maxLines = 1,
                modifier = Modifier.padding(horizontal = 8.dp),
            )
        }
    }
}

/**
 * Chat de la sala: historial al entrar, mensajes nuevos, avisos de presencia y spoilers (se tocan para ver).
 * Si el host me silenció o hay modo lento, el campo lo dice en lugar de fallar en silencio.
 */
@Composable
fun ChatPanel(
    state: SocialUiState,
    selfUserId: String?,
    nowMs: () -> Long,
    onSend: (text: String, spoiler: Boolean) -> Boolean,
    modifier: Modifier = Modifier,
) {
    var draft by rememberSaveable { mutableStateOf("") }
    var spoiler by rememberSaveable { mutableStateOf(false) }
    val revealed = remember { mutableStateListOf<String>() }
    val listState = rememberLazyListState()

    // Segundos que faltan por el modo lento; se refresca mientras dure la espera.
    var waitS by remember { mutableStateOf(0) }
    LaunchedEffect(state.cooldownUntilMs) {
        val until = state.cooldownUntilMs
        while (until != null && nowMs() < until) {
            waitS = ((until - nowMs() + 999) / 1000).toInt()
            delay(250)
        }
        waitS = 0
    }
    LaunchedEffect(state.messages.size) {
        if (state.messages.isNotEmpty()) listState.animateScrollToItem(state.messages.size - 1)
    }

    Column(modifier) {
        LazyColumn(state = listState, modifier = Modifier.weight(1f).fillMaxWidth()) {
            items(state.messages, key = { it.eventId }) { item ->
                when (item) {
                    is ChatItem.Notice -> Text(
                        item.text,
                        color = Color.Gray,
                        fontStyle = FontStyle.Italic,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(vertical = 2.dp, horizontal = 4.dp),
                    )
                    is ChatItem.Message -> MessageRow(
                        item = item,
                        mine = selfUserId != null && item.userId == selfUserId,
                        hidden = item.spoiler && item.eventId !in revealed,
                        onReveal = { revealed.add(item.eventId) },
                    )
                }
            }
        }
        if (state.error != null) {
            Text(state.error, color = MaterialTheme.colorScheme.error, fontSize = 12.sp, modifier = Modifier.padding(vertical = 2.dp))
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth().padding(top = 6.dp)) {
            OutlinedTextField(
                value = draft,
                onValueChange = { if (it.length <= SocialProtocol.CHAT_MAX_LENGTH) draft = it },
                enabled = !state.muted,
                singleLine = true,
                shape = RoundedCornerShape(24.dp),
                placeholder = { Text(if (state.muted) "El host te silenció" else "Escribe un mensaje", maxLines = 1, softWrap = false) },
                modifier = Modifier.weight(1f),
            )
            // El spoiler es un interruptor de icono: en el panel estrecho del móvil horizontal no cabe una palabra.
            IconButton(
                onClick = { spoiler = !spoiler },
                enabled = !state.muted,
                modifier = Modifier.size(48.dp).clip(CircleShape).background(if (spoiler) TintAccent.copy(alpha = 0.3f) else TintCard)
                    .semantics { contentDescription = if (spoiler) "Enviar como spoiler: activado" else "Enviar como spoiler" },
            ) { Icon(TintIcons.EyeOff, null, tint = if (spoiler) TintAccentSoft else TintText) }
            IconButton(
                enabled = !state.muted && draft.isNotBlank() && waitS == 0,
                onClick = {
                    if (onSend(draft, spoiler)) {
                        draft = ""
                        spoiler = false
                    }
                },
                modifier = Modifier.size(48.dp).clip(CircleShape).background(if (!state.muted && draft.isNotBlank() && waitS == 0) TintAccent else TintCard),
            ) {
                if (waitS > 0) Text("${waitS}s", color = TintMuted, fontSize = 12.sp)
                else Icon(Icons.AutoMirrored.Filled.Send, "Enviar", tint = if (draft.isNotBlank() && !state.muted) TintBackground else TintMuted)
            }
        }
        if (state.slowModeS > 0) {
            Text("Modo lento: 1 mensaje cada ${state.slowModeS} s", color = Color.Gray, fontSize = 11.sp)
        }
    }
}

@Composable
private fun MessageRow(item: ChatItem.Message, mine: Boolean, hidden: Boolean, onReveal: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 2.dp),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start,
    ) {
        Column(
            Modifier.background(if (mine) TintAccent.copy(alpha = 0.18f) else Bubble, RoundedCornerShape(10.dp))
                .padding(horizontal = 10.dp, vertical = 6.dp),
        ) {
            Text(item.nick, color = TintAccent, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            if (hidden) {
                Text("Spoiler · toca para ver", color = Color.Gray, fontStyle = FontStyle.Italic, modifier = Modifier.clickable(onClick = onReveal))
            } else {
                Text(item.text, color = Color.White)
            }
        }
    }
}
