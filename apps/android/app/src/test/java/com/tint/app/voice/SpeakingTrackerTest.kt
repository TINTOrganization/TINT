package com.tint.app.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class SpeakingTrackerTest {
    private val tracker = SpeakingTracker(threshold = 0.02, holdMs = 500)

    @Test
    fun `quien supera el umbral esta hablando`() {
        assertEquals(setOf("a"), tracker.update(mapOf("a" to 0.2, "b" to 0.001), nowMs = 0))
    }

    @Test
    fun `el ruido de fondo no cuenta`() {
        assertEquals(emptySet<String>(), tracker.update(mapOf("a" to 0.019), nowMs = 0))
    }

    @Test
    fun `sigue contando medio segundo despues de callar para que el aro no parpadee`() {
        tracker.update(mapOf("a" to 0.2), nowMs = 0)

        assertEquals(setOf("a"), tracker.update(mapOf("a" to 0.0), nowMs = 400))
        assertEquals(emptySet<String>(), tracker.update(mapOf("a" to 0.0), nowMs = 501))
    }

    @Test
    fun `hablar de nuevo renueva el plazo`() {
        tracker.update(mapOf("a" to 0.2), nowMs = 0)
        tracker.update(mapOf("a" to 0.2), nowMs = 400)

        assertEquals(setOf("a"), tracker.update(mapOf("a" to 0.0), nowMs = 800))
    }

    @Test
    fun `un par que ya no reporta se olvida cuando vence su plazo`() {
        tracker.update(mapOf("a" to 0.2), nowMs = 0)

        assertEquals(emptySet<String>(), tracker.update(emptyMap(), nowMs = 600))
    }

    @Test
    fun `reiniciar borra a todos`() {
        tracker.update(mapOf("a" to 0.2), nowMs = 0)
        tracker.reset()
        assertEquals(emptySet<String>(), tracker.update(emptyMap(), nowMs = 1))
    }
}
