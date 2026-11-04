package com.tint.app.social

/** Una reacción con su hora de llegada en el reloj monótono local (nunca el reloj de quien reaccionó). */
data class ReactionArrival(val reaction: Reaction, val atMs: Long)

/**
 * Una reacción lista para dibujar flotando sobre el video: `lane` (0..1) es dónde cae en horizontal, `progress` (0..1)
 * cuánto lleva subiendo y `alpha` cuánto se ve.
 */
data class FloatingItem(val id: String, val emoji: String, val lane: Float, val progress: Float, val alpha: Float)

/** Las reacciones que suben sobre el video durante dos segundos (AND-16); como mucho se ven doce a la vez. */
object FloatingReactions {
    const val DURATION_MS = 2_000L
    const val MAX_VISIBLE = 12
    private const val FADE_FROM = 0.6f

    fun isVisible(arrival: ReactionArrival, nowMs: Long): Boolean = nowMs - arrival.atMs < DURATION_MS

    fun frame(arrivals: List<ReactionArrival>, nowMs: Long): List<FloatingItem> =
        arrivals.filter { isVisible(it, nowMs) }.takeLast(MAX_VISIBLE).map { a ->
            val progress = ((nowMs - a.atMs).coerceAtLeast(0L).toFloat() / DURATION_MS).coerceIn(0f, 1f)
            FloatingItem(
                id = a.reaction.eventId,
                emoji = a.reaction.emoji,
                lane = lane(a.reaction.eventId),
                progress = progress,
                alpha = if (progress < FADE_FROM) 1f else ((1f - progress) / (1f - FADE_FROM)).coerceIn(0f, 1f),
            )
        }

    /** Un carril estable por reacción, repartido de forma pareja entre 0 y 1. */
    private fun lane(id: String): Float = ((id.hashCode() and 0x7fffffff) % 1000) / 999f
}
