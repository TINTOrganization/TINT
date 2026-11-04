package com.tint.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.tint.app.join.InviteExpiry
import com.tint.app.join.InvitePreview
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.tint.app.join.JoinState
import com.tint.app.join.RecentRoom
import com.tint.app.join.RoomKind
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.IconButton
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import kotlinx.coroutines.delay
import androidx.compose.ui.graphics.Color

/**
 * Entrar a una sala con un link o código (mockups M01/M02, AND-14). Al pegar el código se consulta la invitación y se
 * dice a qué sala invitan y cuándo vence; si ya no sirve se avisa antes de pedir el nick. `initialCode` viene de un deep link.
 */
@Composable
fun JoinScreen(
    state: JoinState,
    preview: InvitePreview,
    initialCode: String?,
    onLookup: (String) -> Unit,
    recents: List<RecentRoom>,
    onForget: (String) -> Unit,
    onSubmit: (code: String, nick: String) -> Unit,
    onBack: () -> Unit,
) {
    var code by remember(initialCode) { mutableStateOf(initialCode.orEmpty()) }
    var nick by remember { mutableStateOf("") }
    // Se espera un momento tras la última tecla para no consultar al servidor por cada letra.
    LaunchedEffect(code) {
        delay(400)
        onLookup(code)
    }
    Box(Modifier.fillMaxSize().background(TintBackground), contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier.widthIn(max = 480.dp).fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("TINT", style = MaterialTheme.typography.displaySmall, color = TintAccent, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(4.dp))
            Text("Mira, comenta y compite en sincronía", color = TintMuted, fontSize = 14.sp, textAlign = TextAlign.Center)
            Spacer(Modifier.height(20.dp))
            InvitePreviewCard(preview)
            Spacer(Modifier.height(16.dp))
            if (recents.isNotEmpty() && code.isBlank()) {
                RecentRoomsList(recents, onPick = { code = it }, onForget = onForget)
                Spacer(Modifier.height(16.dp))
            }
            OutlinedTextField(
                value = code,
                onValueChange = { code = it },
                label = { Text("Link o código de invitación") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = nick,
                onValueChange = { nick = it },
                label = { Text("Tu nick") },
                supportingText = { Text("Así te verán en el chat y las reacciones.") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(16.dp))
            if (state is JoinState.Error) {
                Text(state.message, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
                Spacer(Modifier.height(12.dp))
            }
            if (state == JoinState.Joining) {
                CircularProgressIndicator(color = TintAccent)
            } else {
                Button(
                    onClick = { onSubmit(code, nick) },
                    enabled = preview !is InvitePreview.Unavailable,
                    modifier = Modifier.fillMaxWidth().height(52.dp),
                ) {
                    Text(if (state is JoinState.Error) "Reintentar" else "Entrar a la sala")
                }
                Spacer(Modifier.height(8.dp))
                OutlinedButton(onClick = onBack, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text("Volver") }
            }
        }
    }
}

/** "Te invitaron a …": la sala y el vencimiento, o el motivo por el que la invitación no sirve. */
@Composable
private fun InvitePreviewCard(preview: InvitePreview) {
    when (preview) {
        InvitePreview.Idle -> Unit
        InvitePreview.Loading -> PreviewBox {
            Text("Buscando la invitación…", color = TintMuted, fontSize = 14.sp)
        }
        is InvitePreview.Ready -> PreviewBox {
            Text("TE INVITARON A", color = TintAccentSoft, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.4.sp)
            Spacer(Modifier.height(4.dp))
            Text(preview.title, color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            InviteExpiry.text(preview.expiresAt, System.currentTimeMillis())?.let {
                Spacer(Modifier.height(2.dp))
                Text(it, color = TintMuted, fontSize = 13.sp)
            }
        }
        is InvitePreview.Unavailable -> PreviewBox {
            Text(preview.message, color = TintDangerText, fontSize = 14.sp)
        }
    }
}

@Composable
private fun PreviewBox(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().background(TintSurface, RoundedCornerShape(16.dp)).padding(16.dp)) { content() }
}

/** Las últimas salas de este aparato (AND-15): tocar una rellena su código; la vista previa dice si aún sirve. */
@Composable
private fun RecentRoomsList(rooms: List<RecentRoom>, onPick: (String) -> Unit, onForget: (String) -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        Text("SALAS RECIENTES", color = TintAccentSoft, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.4.sp)
        Spacer(Modifier.height(6.dp))
        rooms.forEach { room ->
            Row(
                Modifier.fillMaxWidth().padding(vertical = 3.dp).background(TintSurface, RoundedCornerShape(12.dp))
                    .clickable { onPick(room.code) }.padding(start = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f).padding(vertical = 10.dp)) {
                    Text(room.title, color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                    Text(if (room.kind == RoomKind.LIVE) "En vivo" else "Película sincronizada", color = TintMuted, fontSize = 12.sp)
                }
                IconButton(onClick = { onForget(room.code) }, Modifier.size(48.dp).semantics { contentDescription = "Quitar ${room.title} de recientes" }) {
                    Text("✕", color = TintMuted)
                }
            }
        }
    }
}
