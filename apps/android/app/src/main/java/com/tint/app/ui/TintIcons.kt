package com.tint.app.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/** Los iconos de los mockups que Material no trae en su paquete básico, dibujados a 24 × 24 con trazo. */
object TintIcons {
    private fun stroke(name: String, vararg paths: String, fill: Boolean = false): ImageVector =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
            paths.forEach { d ->
                addPath(
                    pathData = addPathNodes(d),
                    fill = if (fill) SolidColor(Color.White) else null,
                    stroke = if (fill) null else SolidColor(Color.White),
                    strokeLineWidth = 2.2f,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round,
                )
            }
        }.build()

    val Fullscreen: ImageVector by lazy { stroke("Fullscreen", "M4 9 V4 H9", "M15 4 H20 V9", "M20 15 V20 H15", "M9 20 H4 V15") }
    val ExitFullscreen: ImageVector by lazy { stroke("ExitFullscreen", "M9 4 V9 H4", "M20 9 H15 V4", "M15 20 V15 H20", "M4 15 H9 V20") }
    val Volume: ImageVector by lazy { stroke("Volume", "M4 9 H8 L13 5 V19 L8 15 H4 Z", "M16.5 8.5 Q19 12 16.5 15.5") }
    val VolumeOff: ImageVector by lazy { stroke("VolumeOff", "M4 9 H8 L13 5 V19 L8 15 H4 Z", "M17 9 L22 15", "M22 9 L17 15") }
    val Mic: ImageVector by lazy { stroke("Mic", "M9 3 H15 V12 A3 3 0 0 1 9 12 Z", "M5 11 Q5 18 12 18 Q19 18 19 11", "M12 18 V22") }
    val MicOff: ImageVector by lazy { stroke("MicOff", "M9 3 H15 V12 A3 3 0 0 1 9 12 Z", "M5 11 Q5 18 12 18 Q19 18 19 11", "M4 20 L20 4") }
    val EyeOff: ImageVector by lazy { stroke("EyeOff", "M3 12 Q12 4 21 12 Q12 20 3 12 Z", "M4 20 L20 4") }
}
