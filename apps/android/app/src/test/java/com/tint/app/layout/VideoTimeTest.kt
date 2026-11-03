package com.tint.app.layout

import org.junit.Assert.assertEquals
import org.junit.Test

class VideoTimeTest {
    @Test
    fun `minutos y segundos`() {
        assertEquals("0:00", VideoTime.format(0))
        assertEquals("0:09", VideoTime.format(9_000))
        assertEquals("1:05", VideoTime.format(65_000))
        assertEquals("36:52", VideoTime.format(2_212_000))
    }

    @Test
    fun `con horas`() {
        assertEquals("1:00:00", VideoTime.format(3_600_000))
        assertEquals("1:59:09", VideoTime.format(7_149_000))
    }

    @Test
    fun `los milisegundos sobrantes se descartan y lo negativo es cero`() {
        assertEquals("0:01", VideoTime.format(1_999))
        assertEquals("0:00", VideoTime.format(-5_000))
    }

    @Test
    fun `la fraccion de avance se acota entre 0 y 1`() {
        assertEquals(0.5f, VideoTime.fraction(50, 100), 0.0001f)
        assertEquals(0f, VideoTime.fraction(-5, 100), 0f)
        assertEquals(1f, VideoTime.fraction(500, 100), 0f)
        assertEquals(0f, VideoTime.fraction(50, 0), 0f)
        assertEquals(0f, VideoTime.fraction(50, -1), 0f)
    }
}
