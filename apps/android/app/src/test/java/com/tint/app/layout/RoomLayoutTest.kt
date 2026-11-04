package com.tint.app.layout

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomLayoutTest {
    @Test
    fun `los cuatro tamaños de los mockups`() {
        assertEquals(RoomLayout.PHONE_PORTRAIT, RoomLayout.of(390, 844))
        assertEquals(RoomLayout.PHONE_LANDSCAPE, RoomLayout.of(844, 390))
        assertEquals(RoomLayout.TABLET_PORTRAIT, RoomLayout.of(800, 1280))
        assertEquals(RoomLayout.TABLET_LANDSCAPE, RoomLayout.of(1280, 800))
    }

    @Test
    fun `la tableta de pruebas a su resolucion fisica y reducida`() {
        // Galaxy Tab S6 Lite: 1200 × 2000 px a 240 dpi son 800 × 1333 dp.
        assertEquals(RoomLayout.TABLET_PORTRAIT, RoomLayout.of(800, 1333))
        assertEquals(RoomLayout.TABLET_LANDSCAPE, RoomLayout.of(1333, 800))
        // Con la pantalla en resolución reducida (600 × 1200 px) se ve como un móvil.
        assertEquals(RoomLayout.PHONE_PORTRAIT, RoomLayout.of(400, 800))
        assertEquals(RoomLayout.PHONE_LANDSCAPE, RoomLayout.of(800, 400))
    }

    @Test
    fun `en vertical manda el ancho`() {
        assertEquals(RoomLayout.PHONE_PORTRAIT, RoomLayout.of(599, 900))
        assertEquals(RoomLayout.TABLET_PORTRAIT, RoomLayout.of(600, 900))
        assertEquals(RoomLayout.TABLET_PORTRAIT, RoomLayout.of(1000, 1000))
    }

    @Test
    fun `en horizontal hace falta ancho y alto para el formato de tableta`() {
        assertEquals(RoomLayout.TABLET_LANDSCAPE, RoomLayout.of(840, 480))
        assertEquals(RoomLayout.PHONE_LANDSCAPE, RoomLayout.of(839, 600))
        assertEquals(RoomLayout.PHONE_LANDSCAPE, RoomLayout.of(1000, 479))
        assertEquals(RoomLayout.PHONE_LANDSCAPE, RoomLayout.of(700, 500))
    }

    @Test
    fun `el chat va en pestañas en el movil y fijo en la tableta`() {
        assertTrue(RoomLayout.PHONE_PORTRAIT.tabbed)
        assertTrue(RoomLayout.PHONE_LANDSCAPE.tabbed)
        assertFalse(RoomLayout.TABLET_PORTRAIT.tabbed)
        assertFalse(RoomLayout.TABLET_LANDSCAPE.tabbed)
    }

    @Test
    fun `en horizontal el panel social va al lado del video`() {
        assertFalse(RoomLayout.PHONE_PORTRAIT.sidePanel)
        assertTrue(RoomLayout.PHONE_LANDSCAPE.sidePanel)
        assertFalse(RoomLayout.TABLET_PORTRAIT.sidePanel)
        assertTrue(RoomLayout.TABLET_LANDSCAPE.sidePanel)
    }

    @Test
    fun `la cabecera se superpone al video solo en el movil horizontal`() {
        assertTrue(RoomLayout.PHONE_LANDSCAPE.overlayTopBar)
        assertFalse(RoomLayout.PHONE_PORTRAIT.overlayTopBar)
        assertFalse(RoomLayout.TABLET_LANDSCAPE.overlayTopBar)
    }
}
