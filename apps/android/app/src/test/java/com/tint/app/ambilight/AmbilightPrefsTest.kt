package com.tint.app.ambilight

import com.tint.app.store.MemoryStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AmbilightPrefsTest {
    private val store = MemoryStore()

    @Test
    fun `por defecto esta encendido`() {
        assertTrue(AmbilightPrefs(store).isOn(batterySaver = false))
    }

    @Test
    fun `con ahorro de bateria arranca apagado si nadie lo eligio`() {
        assertFalse(AmbilightPrefs(store).isOn(batterySaver = true))
    }

    @Test
    fun `lo que la persona eligio manda sobre el ahorro de bateria y se recuerda`() {
        AmbilightPrefs(store).set(true)
        assertTrue(AmbilightPrefs(store).isOn(batterySaver = true))

        AmbilightPrefs(store).set(false)
        assertFalse(AmbilightPrefs(store).isOn(batterySaver = false))
    }

    @Test
    fun `guarda la misma clave que la web`() {
        AmbilightPrefs(store).set(false)
        assertEquals("off", store.get("tint_ambilight"))
    }
}
