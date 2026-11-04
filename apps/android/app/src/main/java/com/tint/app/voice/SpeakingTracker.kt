package com.tint.app.voice

/**
 * Decide quién está hablando a partir del nivel de audio (0 a 1, el `audioLevel` de las estadísticas WebRTC) que
 * reporta cada conexión. Un nivel por encima del umbral cuenta como voz, y se mantiene [holdMs] después para que el
 * aro del avatar no parpadee entre sílabas.
 */
class SpeakingTracker(private val threshold: Double = 0.02, private val holdMs: Long = 500) {
    private val lastSpoke = mutableMapOf<String, Long>()

    fun update(levels: Map<String, Double>, nowMs: Long): Set<String> {
        levels.forEach { (id, level) -> if (level >= threshold) lastSpoke[id] = nowMs }
        lastSpoke.entries.removeAll { nowMs - it.value > holdMs }
        return lastSpoke.keys.toSet()
    }

    fun reset() = lastSpoke.clear()
}
