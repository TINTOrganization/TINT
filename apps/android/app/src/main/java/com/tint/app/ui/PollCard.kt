package com.tint.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tint.app.social.PollState
import com.tint.app.social.SocialProtocol
import kotlinx.coroutines.delay

private val CardBg = TintSurface
private val BarBg = TintCard

/**
 * Encuesta de la sala. Mientras está abierta cada opción es un botón que vota (se puede cambiar el voto) y
 * muestra su porcentaje; al cerrar queda el resultado final hasta que se descarta. La cuenta atrás es solo
 * informativa: el servidor es quien cierra.
 */
@Composable
fun PollCard(poll: PollState, wallNowMs: () -> Long, onVote: (Int) -> Unit, onDismiss: () -> Unit) {
    var now by remember { mutableLongStateOf(wallNowMs()) }
    LaunchedEffect(poll.pollId, poll.closed) {
        while (!poll.closed) {
            now = wallNowMs()
            delay(250)
        }
    }
    val remaining = poll.remainingMs(now)
    val open = !poll.closed && remaining > 0
    val percents = SocialProtocol.pollPercentages(poll.counts)
    val total = poll.counts.sum()

    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp).background(CardBg, RoundedCornerShape(12.dp)).padding(12.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("ENCUESTA", color = TintAccent, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            Text(
                if (open) "Quedan ${clock(remaining)} · $total ${if (total == 1) "voto" else "votos"}" else "Cerrada · $total ${if (total == 1) "voto" else "votos"}",
                color = Color.Gray,
                fontSize = 12.sp,
            )
        }
        Text(poll.question, color = Color.White, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(vertical = 4.dp))

        poll.options.forEachIndexed { index, option ->
            val mine = poll.myVote == index
            Box(
                Modifier.fillMaxWidth().padding(vertical = 3.dp).height(44.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(BarBg)
                    .border(if (mine) 2.dp else 1.dp, if (mine) TintAccent else Color(0xFF3A3F4C), RoundedCornerShape(10.dp))
                    .then(if (open) Modifier.clickable { onVote(index) } else Modifier),
            ) {
                Box(
                    Modifier.fillMaxHeight().fillMaxWidth((percents.getOrElse(index) { 0 } / 100f).coerceIn(0f, 1f))
                        .background(TintAccent.copy(alpha = if (mine) 0.45f else 0.25f)),
                )
                Row(
                    Modifier.fillMaxWidth().fillMaxHeight().padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(if (mine) "✓ $option" else option, color = Color.White, fontWeight = if (mine) FontWeight.Bold else FontWeight.Normal)
                    Text("${percents.getOrElse(index) { 0 }} %", color = Color.White, fontSize = 13.sp)
                }
            }
        }

        if (!open) {
            Spacer(Modifier.height(6.dp))
            OutlinedButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text("Cerrar") }
        } else if (poll.myVote != null) {
            Text("Puedes cambiar tu voto mientras siga abierta.", color = Color.Gray, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))
        }
    }
}

private fun clock(ms: Long): String {
    val s = (ms + 999) / 1000
    return "%d:%02d".format(s / 60, s % 60)
}
