package com.tint.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import com.tint.app.social.LaserArrival
import com.tint.app.social.LaserTrail
import kotlinx.coroutines.delay

private val Halo = Color(0xFFFF6B1A)
private const val FRAME_MS = 33L
private const val PRUNE_EVERY_FRAMES = 30

/**
 * Puntero láser del host sobre el vídeo: el trazo se desvanece en 2,5 s y al soltar queda un marcador con su
 * nick. La geometría y los tiempos viven en `LaserTrail` (con pruebas); aquí solo se pinta.
 */
@Composable
fun LaserOverlay(arrivals: List<LaserArrival>, nowMs: () -> Long, onPrune: () -> Unit, modifier: Modifier = Modifier) {
    var now by remember { mutableLongStateOf(nowMs()) }
    val active = arrivals.isNotEmpty()
    LaunchedEffect(active) {
        var frames = 0
        while (active) {
            now = nowMs()
            delay(FRAME_MS)
            if (++frames % PRUNE_EVERY_FRAMES == 0) onPrune()
        }
    }
    if (!active) return

    val frame = LaserTrail.frame(arrivals, now)
    Canvas(modifier) {
        fun at(x: Float, y: Float) = Offset(x * size.width, y * size.height)
        for (stroke in frame.strokes) {
            for (i in 1 until stroke.size) {
                val a = stroke[i - 1]
                val b = stroke[i]
                val alpha = minOf(a.alpha, b.alpha)
                drawLine(Halo.copy(alpha = alpha * 0.55f), at(a.x, a.y), at(b.x, b.y), strokeWidth = 11.dp.toPx(), cap = StrokeCap.Round)
                drawLine(Color.White.copy(alpha = alpha), at(a.x, a.y), at(b.x, b.y), strokeWidth = 3.5.dp.toPx(), cap = StrokeCap.Round)
            }
            stroke.lastOrNull()?.let { head ->
                drawCircle(Halo.copy(alpha = head.alpha * 0.6f), radius = 8.dp.toPx(), center = at(head.x, head.y))
                drawCircle(Color.White.copy(alpha = head.alpha), radius = 4.dp.toPx(), center = at(head.x, head.y))
            }
        }
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { textSize = 12.dp.toPx() }
        for (m in frame.markers) {
            val c = at(m.x, m.y)
            drawCircle(Halo.copy(alpha = m.alpha), radius = 9.dp.toPx(), center = c, style = Stroke(width = 3.dp.toPx()))
            drawCircle(Color.White.copy(alpha = m.alpha), radius = 3.dp.toPx(), center = c)
            paint.color = Color.White.copy(alpha = m.alpha).toArgb()
            paint.setShadowLayer(4.dp.toPx(), 0f, 0f, Color.Black.copy(alpha = m.alpha).toArgb())
            // El nick va a la derecha del marcador; si no cabe antes del borde del vídeo, pasa a la izquierda.
            val label = m.nick.take(24)
            val gap = 14.dp.toPx()
            val width = paint.measureText(label)
            val x = if (c.x + gap + width > size.width) maxOf(0f, c.x - gap - width) else c.x + gap
            drawContext.canvas.nativeCanvas.drawText(label, x, c.y + 4.dp.toPx(), paint)
        }
    }
}
