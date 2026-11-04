package com.tint.app.layout

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VideoEndTest {
    @Test
    fun `llegar justo al final cuenta, aunque el reproductor se quede a 1 ms`() {
        assertTrue(VideoEnd.reached(positionMs = 7_149_151, durationMs = 7_149_152))
        assertTrue(VideoEnd.reached(positionMs = 7_149_152, durationMs = 7_149_152))
    }

    @Test
    fun `dentro de la tolerancia de 1,5 s cuenta, fuera no`() {
        assertTrue(VideoEnd.reached(positionMs = 98_500, durationMs = 100_000))
        assertFalse(VideoEnd.reached(positionMs = 98_499, durationMs = 100_000))
    }

    @Test
    fun `sin duracion conocida no hay final`() {
        assertFalse(VideoEnd.reached(positionMs = 0, durationMs = 0))
        assertFalse(VideoEnd.reached(positionMs = 5_000, durationMs = -1))
    }

    @Test
    fun `volver a verla rearma solo si se aleja del final`() {
        assertTrue(VideoEnd.rearmed(positionMs = 0, durationMs = 100_000))
        assertTrue(VideoEnd.rearmed(positionMs = 94_999, durationMs = 100_000))
        assertFalse(VideoEnd.rearmed(positionMs = 95_000, durationMs = 100_000))
        assertFalse(VideoEnd.rearmed(positionMs = 0, durationMs = 0))
    }
}
