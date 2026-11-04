package com.tint.app.social

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FloatingReactionsTest {
    private fun at(atMs: Long, id: String = "e$atMs", emoji: String = "❤️") =
        ReactionArrival(Reaction(id, "u", "Ana", emoji, 0), atMs)

    @Test
    fun `sin reacciones no hay nada que dibujar`() {
        assertTrue(FloatingReactions.frame(emptyList(), 1_000).isEmpty())
    }

    @Test
    fun `una reaccion recien llegada empieza abajo y se ve entera`() {
        val item = FloatingReactions.frame(listOf(at(1_000)), 1_000).single()

        assertEquals("❤️", item.emoji)
        assertEquals(0f, item.progress, 0.001f)
        assertEquals(1f, item.alpha, 0.001f)
    }

    @Test
    fun `sube y se desvanece durante dos segundos`() {
        val arrivals = listOf(at(1_000))

        assertEquals(0.5f, FloatingReactions.frame(arrivals, 2_000).single().progress, 0.001f)
        val late = FloatingReactions.frame(arrivals, 2_800).single()
        assertTrue(late.alpha < 0.5f)
        assertTrue(FloatingReactions.frame(arrivals, 3_000).isEmpty())
    }

    @Test
    fun `el carril es el mismo cada vez y queda entre 0 y 1`() {
        val a = FloatingReactions.frame(listOf(at(1_000, "abc")), 1_500).single().lane
        val b = FloatingReactions.frame(listOf(at(1_000, "abc")), 1_900).single().lane

        assertEquals(a, b, 0f)
        assertTrue(a in 0f..1f)
    }

    @Test
    fun `reacciones distintas suelen caer en carriles distintos`() {
        val lanes = (0 until 20).map { FloatingReactions.frame(listOf(at(1_000, "id-$it")), 1_000).single().lane }.toSet()

        assertTrue(lanes.size > 5)
    }

    @Test
    fun `no se dibujan mas de doce a la vez y se quedan las mas nuevas`() {
        val arrivals = (0 until 20).map { at(1_000L + it, "r$it") }

        val frame = FloatingReactions.frame(arrivals, 1_100)

        assertEquals(12, frame.size)
        assertEquals("r19", frame.last().id)
        assertEquals("r8", frame.first().id)
    }

    @Test
    fun `solo se conservan las que aun se ven`() {
        assertTrue(FloatingReactions.isVisible(at(1_000), 2_999))
        assertFalse(FloatingReactions.isVisible(at(1_000), 3_000))
    }
}
