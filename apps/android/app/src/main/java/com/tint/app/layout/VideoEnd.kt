package com.tint.app.layout

/**
 * Cuándo el video «terminó» para pedir el recap (AND-21). ExoPlayer solo pasa a `STATE_ENDED` si llega al final
 * reproduciendo; con la sala en pausa en el último instante (el host manda `PAUSE` en la duración redondeada) se queda a
 * 1 ms y nunca termina, así que se mira la posición.
 */
object VideoEnd {
    private const val END_TOLERANCE_MS = 1_500L
    private const val REARM_DISTANCE_MS = 5_000L

    fun reached(positionMs: Long, durationMs: Long): Boolean = durationMs > 0 && positionMs >= durationMs - END_TOLERANCE_MS

    /** Se alejó lo bastante del final como para que el próximo final vuelva a pedir el recap («Volver a verla»). */
    fun rearmed(positionMs: Long, durationMs: Long): Boolean = durationMs > 0 && positionMs < durationMs - REARM_DISTANCE_MS
}
