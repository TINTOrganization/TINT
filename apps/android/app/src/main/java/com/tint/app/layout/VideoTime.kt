package com.tint.app.layout

/** Tiempos del video como se ven en el reproductor: `36:52` o `1:59:09`. */
object VideoTime {
    fun format(ms: Long): String {
        val total = (ms.coerceAtLeast(0L)) / 1_000
        val h = total / 3_600
        val m = (total % 3_600) / 60
        val s = total % 60
        return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
    }

    /** Qué parte del video va vista, de 0 a 1 (0 si aún no se conoce la duración). */
    fun fraction(positionMs: Long, durationMs: Long): Float =
        if (durationMs <= 0) 0f else (positionMs.toFloat() / durationMs).coerceIn(0f, 1f)
}
