package com.tint.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tint.app.layout.VideoTime
import com.tint.app.social.RecapSummary

/** «Fin de la función» (mockup M18, AND-21): lo más destacado de la sesión. Los bloques sin datos no se dibujan. */
@Composable
fun RecapScreen(roomTitle: String?, recap: RecapSummary, onClose: () -> Unit) {
    Box(
        Modifier.fillMaxSize().background(Brush.radialGradient(listOf(Color(0x57C4520A), TintBackground), radius = 1100f)).background(TintBackground.copy(alpha = 0.94f)),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            Modifier.widthIn(max = 520.dp).fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 40.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text((roomTitle ?: "TINT").uppercase(), color = TintAccentSoft, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 2.sp)
            Text("Fin de la función", color = Color.White, fontSize = 34.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
            Text("Así se vivió la sesión con tus amigos.", color = TintMuted, fontSize = 14.sp)

            recap.topReactor?.let { RecapCard("QUIEN MÁS REACCIONÓ", it.nick, "${it.count} reacciones") }
            recap.mostPaused?.let { RecapCard("MOMENTO MÁS PAUSADO", VideoTime.format(it.positionMs), "${it.count} pausas o retrocesos") }
            recap.peak?.let { RecapCard("PICO DE REACCIONES", VideoTime.format(it.positionMs), "${it.count} reacciones, ${it.laughs} risas") }

            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Total(recap.totals.reactions, "reacciones", Modifier.weight(1f))
                Total(recap.totals.pauses, "pausas", Modifier.weight(1f))
                Total(recap.totals.rewinds, "retrocesos", Modifier.weight(1f))
                Total(recap.totals.polls, "encuestas", Modifier.weight(1f))
            }
            Button(onClick = onClose, Modifier.fillMaxWidth().height(50.dp)) { Text("Cerrar", fontWeight = FontWeight.Bold, fontSize = 16.sp) }
        }
    }
}

@Composable
private fun RecapCard(label: String, headline: String, detail: String) {
    Column(Modifier.fillMaxWidth().background(TintSurface, RoundedCornerShape(18.dp)).padding(horizontal = 16.dp, vertical = 14.dp)) {
        Text(label, color = TintAccentSoft, fontSize = 12.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.4.sp)
        Text(headline, color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Text(detail, color = TintMuted, fontSize = 13.sp)
    }
}

@Composable
private fun Total(value: Int, label: String, modifier: Modifier = Modifier) {
    Column(modifier.background(TintSurface, RoundedCornerShape(14.dp)).padding(vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text("$value", color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Text(label, color = TintMuted, fontSize = 11.sp)
    }
}
