package com.tint.app.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import com.tint.app.ambilight.Ambilight
import com.tint.app.ambilight.AmbilightFrame
import kotlinx.coroutines.delay

/** Lo que el video necesita del Ambilight: la paleta, si está encendido y cómo apagarlo (AND-23). */
class GlowControl(val frames: List<AmbilightFrame>, val on: Boolean, val interpolate: Boolean, val onToggle: () -> Unit)

private const val SAMPLE_MS = 250L
private const val HALO_ALPHA = 0.7f
private val HALO_REACH = 14.dp

/**
 * Halo de color alrededor del recuadro del video con la paleta que ya extrajo media-worker (no se lee el video): cada
 * lado se ilumina con el color de su borde y se apaga hacia afuera, como el de la web, sin tapar la imagen. Se muestrea
 * ~4 veces por segundo y cada lado cambia suavemente; con las animaciones del sistema apagadas no se interpola. Se
 * dibuja fuera de los límites del recuadro, así que debe aplicarse **antes** del recorte de esquinas.
 */
@Composable
fun Modifier.ambilightHalo(glow: GlowControl, positionMs: () -> Long): Modifier {
    if (!glow.on || glow.frames.isEmpty()) return this
    var colors by remember(glow.frames) { mutableStateOf(Ambilight.colorsAt(glow.frames, positionMs(), glow.interpolate)) }
    LaunchedEffect(glow.frames, glow.interpolate) {
        while (true) {
            colors = Ambilight.colorsAt(glow.frames, positionMs(), glow.interpolate)
            delay(SAMPLE_MS)
        }
    }
    val current = colors ?: return this
    val spec = tween<Color>(if (glow.interpolate) 700 else 0)
    val top by animateColorAsState(Color(current.top), spec, label = "ambilight-top")
    val bottom by animateColorAsState(Color(current.bottom), spec, label = "ambilight-bottom")
    val left by animateColorAsState(Color(current.left), spec, label = "ambilight-left")
    val right by animateColorAsState(Color(current.right), spec, label = "ambilight-right")
    return drawBehind {
        val reach = HALO_REACH.toPx()
        val lit = { c: Color -> c.copy(alpha = HALO_ALPHA) }
        drawRect(Brush.verticalGradient(listOf(Color.Transparent, lit(top)), startY = -reach, endY = 0f), Offset(0f, -reach), Size(size.width, reach))
        drawRect(Brush.verticalGradient(listOf(lit(bottom), Color.Transparent), startY = size.height, endY = size.height + reach), Offset(0f, size.height), Size(size.width, reach))
        drawRect(Brush.horizontalGradient(listOf(Color.Transparent, lit(left)), startX = -reach, endX = 0f), Offset(-reach, 0f), Size(reach, size.height))
        drawRect(Brush.horizontalGradient(listOf(lit(right), Color.Transparent), startX = size.width, endX = size.width + reach), Offset(size.width, 0f), Size(reach, size.height))
    }
}
