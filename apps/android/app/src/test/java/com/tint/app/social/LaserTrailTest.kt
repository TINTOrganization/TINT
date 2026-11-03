package com.tint.app.social

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LaserTrailTest {
    private fun at(
        atMs: Long,
        id: String = "e$atMs",
        user: String = "u1",
        x: Float = 0.5f,
        y: Float = 0.5f,
        end: Boolean = false,
        nick: String = "Ana",
    ) = LaserArrival(LaserPoint(id, user, nick, x, y, end), atMs)

    @Test
    fun `sin puntos no hay nada que dibujar`() {
        val frame = LaserTrail.frame(emptyList(), 10_000)

        assertTrue(frame.strokes.isEmpty())
        assertTrue(frame.markers.isEmpty())
    }

    @Test
    fun `un punto recien llegado se ve entero y se desvanece con el tiempo`() {
        val arrivals = listOf(at(10_000))

        assertEquals(1f, LaserTrail.frame(arrivals, 10_000).strokes.single().single().alpha, 0.001f)
        assertEquals(0.5f, LaserTrail.frame(arrivals, 11_250).strokes.single().single().alpha, 0.001f)
        assertTrue(LaserTrail.frame(arrivals, 12_500).strokes.isEmpty())
        assertTrue(LaserTrail.frame(arrivals, 20_000).strokes.isEmpty())
    }

    @Test
    fun `la posicion del punto se conserva`() {
        val dot = LaserTrail.frame(listOf(at(1_000, x = 0.1f, y = 0.9f)), 1_000).strokes.single().single()

        assertEquals(0.1f, dot.x, 0f)
        assertEquals(0.9f, dot.y, 0f)
    }

    @Test
    fun `cada usuario dibuja su propio trazo`() {
        val arrivals = listOf(
            at(1_000, user = "a", x = 0.1f),
            at(1_010, user = "b", x = 0.9f),
            at(1_020, user = "a", x = 0.2f),
        )

        val strokes = LaserTrail.frame(arrivals, 1_030).strokes

        assertEquals(2, strokes.size)
        assertEquals(listOf(0.1f, 0.2f), strokes.first { it.first().x < 0.5f }.map { it.x })
        assertEquals(listOf(0.9f), strokes.first { it.first().x > 0.5f }.map { it.x })
    }

    @Test
    fun `un punto con end cierra el trazo y el siguiente empieza otro`() {
        val arrivals = listOf(
            at(1_000, x = 0.1f),
            at(1_010, x = 0.2f, end = true),
            at(1_500, x = 0.8f),
            at(1_510, x = 0.9f),
        )

        val strokes = LaserTrail.frame(arrivals, 1_600).strokes

        assertEquals(listOf(listOf(0.1f, 0.2f), listOf(0.8f, 0.9f)), strokes.map { s -> s.map { it.x } })
    }

    @Test
    fun `al soltar queda un marcador con el nick que se mantiene y luego se apaga`() {
        val arrivals = listOf(at(1_000, end = true, x = 0.3f, y = 0.4f, nick = "Ana"))

        val early = LaserTrail.frame(arrivals, 1_500).markers.single()
        assertEquals("Ana", early.nick)
        assertEquals(0.3f, early.x, 0f)
        assertEquals(0.4f, early.y, 0f)
        assertEquals(1f, early.alpha, 0.001f)

        assertEquals(1f, LaserTrail.frame(arrivals, 3_600).markers.single().alpha, 0.001f)
        assertEquals(0.5f, LaserTrail.frame(arrivals, 3_800).markers.single().alpha, 0.001f)
        assertTrue(LaserTrail.frame(arrivals, 4_000).markers.isEmpty())
    }

    @Test
    fun `sin end no hay marcador`() {
        assertTrue(LaserTrail.frame(listOf(at(1_000)), 1_100).markers.isEmpty())
    }

    @Test
    fun `cada usuario con end deja su marcador`() {
        val arrivals = listOf(
            at(1_000, user = "a", end = true, nick = "Ana"),
            at(1_050, user = "b", end = true, nick = "Beto"),
        )

        assertEquals(setOf("Ana", "Beto"), LaserTrail.frame(arrivals, 1_100).markers.map { it.nick }.toSet())
    }

    @Test
    fun `solo se conservan los puntos que aun pueden verse`() {
        assertTrue(LaserTrail.isVisible(at(10_000), 10_000))
        assertTrue(LaserTrail.isVisible(at(10_000, end = true), 12_900))
        assertFalse(LaserTrail.isVisible(at(10_000), 12_500))
        assertFalse(LaserTrail.isVisible(at(10_000, end = true), 13_000))
    }
}
