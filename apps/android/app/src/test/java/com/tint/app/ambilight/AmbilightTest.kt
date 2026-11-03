package com.tint.app.ambilight

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AmbilightTest {
    private val json = """[
        {"t_ms":1000,"top":"#000000","right":"#ff0000","bottom":"#00ff00","left":"#0000ff"},
        {"t_ms":0,"top":"#ffffff","right":"#ffffff","bottom":"#ffffff","left":"#ffffff"},
        {"t_ms":2000,"top":"#ffffff","right":"#000000","bottom":"#00ff00","left":"#0000ff"}
    ]"""

    @Test
    fun `lee la paleta y la ordena por tiempo`() {
        assertEquals(listOf(0L, 1000L, 2000L), Ambilight.parse(json).map { it.tMs })
    }

    @Test
    fun `convierte los colores hex a ARGB opaco`() {
        val frame = Ambilight.parse(json).first { it.tMs == 1000L }
        assertEquals(0xFF000000.toInt(), frame.top)
        assertEquals(0xFFFF0000.toInt(), frame.right)
        assertEquals(0xFF00FF00.toInt(), frame.bottom)
        assertEquals(0xFF0000FF.toInt(), frame.left)
    }

    @Test
    fun `ignora entradas mal formadas y respuestas que no son una lista`() {
        val bad = """[{"t_ms":-5,"top":"#000000","right":"#000000","bottom":"#000000","left":"#000000"},
            {"t_ms":1,"top":"rojo","right":"#000000","bottom":"#000000","left":"#000000"},
            {"t_ms":2,"top":"#000000"},
            {"t_ms":3,"top":"#ABCDEF","right":"#000000","bottom":"#000000","left":"#000000"}]"""
        assertEquals(listOf(3L), Ambilight.parse(bad).map { it.tMs })
        assertEquals(emptyList<AmbilightFrame>(), Ambilight.parse("""{"no":"lista"}"""))
        assertEquals(emptyList<AmbilightFrame>(), Ambilight.parse("esto no es json"))
    }

    @Test
    fun `sin fotogramas no hay colores`() {
        assertNull(Ambilight.colorsAt(emptyList(), 500, true))
    }

    @Test
    fun `antes del primero y despues del ultimo usa el mas cercano`() {
        val frames = Ambilight.parse(json)
        assertEquals(frames.first().top, Ambilight.colorsAt(frames, -10, true)!!.top)
        assertEquals(frames.last().top, Ambilight.colorsAt(frames, 99_000, true)!!.top)
    }

    @Test
    fun `interpola entre fotogramas vecinos`() {
        val frames = Ambilight.parse(json)

        val mid = Ambilight.colorsAt(frames, 1500, true)!!

        // top: #000000 -> #ffffff a mitad de camino; right: #ff0000 -> #000000.
        assertEquals(0xFF808080.toInt(), mid.top)
        assertEquals(0xFF800000.toInt(), mid.right)
    }

    @Test
    fun `sin interpolar salta de fotograma en fotograma`() {
        val frames = Ambilight.parse(json)
        assertEquals(0xFF000000.toInt(), Ambilight.colorsAt(frames, 1500, false)!!.top)
    }
}
