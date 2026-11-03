package com.tint.app.social

/** Un punto del láser con su hora de llegada en el reloj monótono local (nunca el reloj de quien lo mandó). */
data class LaserArrival(val point: LaserPoint, val atMs: Long)

/** Punto listo para pintar: posición normalizada (0..1 sobre el vídeo) y opacidad (1 = recién llegado). */
data class LaserDot(val x: Float, val y: Float, val alpha: Float)

/** Marcador fijo que queda al soltar el láser, con el nick de quien lo dibujó. */
data class LaserMarker(val x: Float, val y: Float, val nick: String, val alpha: Float)

/** Lo que hay que pintar en un instante: trazos (uno por cada vez que se pulsó) y marcadores. */
data class LaserFrame(val strokes: List<List<LaserDot>>, val markers: List<LaserMarker>)

/**
 * Convierte los puntos recibidos del láser en lo que se ve en cada momento. Mismos tiempos que la web
 * (`LaserOverlay.tsx`): el trazo se desvanece en 2,5 s y el marcador al soltar dura 3 s.
 */
object LaserTrail {
    const val FADE_MS = 2_500L
    const val MARKER_MS = 3_000L
    private const val MARKER_FADE_MS = 400L

    /** Si el punto aún aporta algo a la pantalla: se usa para tirar los viejos y no acumular memoria. */
    fun isVisible(arrival: LaserArrival, nowMs: Long): Boolean {
        val age = nowMs - arrival.atMs
        return age < if (arrival.point.end) MARKER_MS else FADE_MS
    }

    fun frame(arrivals: List<LaserArrival>, nowMs: Long): LaserFrame {
        val strokes = mutableListOf<List<LaserDot>>()
        val markers = mutableListOf<LaserMarker>()
        // Cada usuario dibuja su propio trazo: se agrupan sin perder el orden de llegada.
        for ((_, mine) in arrivals.groupBy { it.point.userId }) {
            var current = mutableListOf<LaserDot>()
            for (a in mine) {
                val age = maxOf(0L, nowMs - a.atMs)
                if (age < FADE_MS) current += LaserDot(a.point.x, a.point.y, 1f - age.toFloat() / FADE_MS)
                if (a.point.end) {
                    if (current.isNotEmpty()) strokes += current
                    current = mutableListOf()
                    if (age < MARKER_MS) markers += LaserMarker(a.point.x, a.point.y, a.point.nick, markerAlpha(age))
                }
            }
            if (current.isNotEmpty()) strokes += current
        }
        return LaserFrame(strokes, markers)
    }

    private fun markerAlpha(age: Long): Float =
        if (age <= MARKER_MS - MARKER_FADE_MS) 1f else (MARKER_MS - age).toFloat() / MARKER_FADE_MS
}
