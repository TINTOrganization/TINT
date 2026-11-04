package com.tint.app.layout

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ControlsVisibilityTest {
    private val controls = ControlsVisibility(hideAfterMs = 3_000)

    @Test
    fun `al entrar en pantalla completa los controles se ven`() {
        controls.show(nowMs = 1_000)

        assertTrue(controls.visible(1_000))
        assertTrue(controls.visible(3_999))
    }

    @Test
    fun `se ocultan solos pasado el tiempo sin tocar nada`() {
        controls.show(1_000)

        assertFalse(controls.visible(4_000))
        assertFalse(controls.visible(60_000))
    }

    @Test
    fun `un toque con los controles a la vista los oculta al instante`() {
        controls.show(1_000)

        controls.tap(1_500)

        assertFalse(controls.visible(1_500))
    }

    @Test
    fun `un toque con los controles ocultos los muestra y reinicia la cuenta`() {
        controls.show(1_000)
        assertFalse(controls.visible(5_000))

        controls.tap(5_000)

        assertTrue(controls.visible(5_000))
        assertTrue(controls.visible(7_999))
        assertFalse(controls.visible(8_000))
    }

    @Test
    fun `usar un control reinicia la cuenta`() {
        controls.show(1_000)

        controls.activity(3_500)

        assertTrue(controls.visible(6_000))
        assertFalse(controls.visible(6_500))
    }

    @Test
    fun `mientras se escribe los controles no se ocultan`() {
        controls.show(1_000)
        controls.hold(true, 1_500)

        assertTrue(controls.visible(60_000))

        controls.hold(false, 61_000)
        assertTrue(controls.visible(63_999))
        assertFalse(controls.visible(64_000))
    }

    @Test
    fun `un toque mientras se escribe no oculta los controles`() {
        controls.show(1_000)
        controls.hold(true, 1_200)

        controls.tap(2_000)

        assertTrue(controls.visible(2_000))
    }

    @Test
    fun `cuanto falta para ocultarlos`() {
        controls.show(1_000)

        assertTrue(controls.remainingMs(2_000) == 2_000L)
        assertTrue(controls.remainingMs(4_000) == 0L)
    }
}
