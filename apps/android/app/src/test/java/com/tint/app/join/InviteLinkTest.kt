package com.tint.app.join

import org.junit.Assert.assertEquals
import org.junit.Test

class InviteLinkTest {
    @Test
    fun `el link de invitacion lleva el host y el codigo`() {
        assertEquals("https://tint.jaucor.online/invite/6gl01VIcmDgM", InviteLink.build("tint.jaucor.online", "6gl01VIcmDgM"))
    }

    @Test
    fun `se limpian espacios y la barra final del host`() {
        assertEquals("https://h.example/invite/abc", InviteLink.build("  https://h.example/ ", " abc "))
        assertEquals("https://h.example/invite/abc", InviteLink.build("h.example/", "abc"))
    }

    @Test
    fun `el codigo se escapa`() {
        assertEquals("https://h/invite/a%2Fb", InviteLink.build("h", "a/b"))
    }

    @Test
    fun `sin host se usa el esquema propio de la app`() {
        assertEquals("tint://invite/abc", InviteLink.build("", "abc"))
    }

    @Test
    fun `el texto para compartir lleva el nombre de la sala`() {
        assertEquals("Te invito a «Noche de cine» en TINT: https://h/invite/abc", InviteLink.shareText("Noche de cine", "https://h/invite/abc"))
        assertEquals("Te invito a ver algo juntos en TINT: https://h/invite/abc", InviteLink.shareText(null, "https://h/invite/abc"))
    }
}
