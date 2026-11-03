package com.tint.app.join

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant

class InviteExpiryTest {
    private val now = Instant.parse("2026-11-03T12:00:00Z").toEpochMilli()

    @Test
    fun `dice cuanto falta en dias, horas o minutos`() {
        assertEquals("Vence en 7 días", InviteExpiry.text("2026-11-10T12:00:00.000Z", now))
        assertEquals("Vence en 1 día", InviteExpiry.text("2026-11-04T13:00:00Z", now))
        assertEquals("Vence en 5 horas", InviteExpiry.text("2026-11-03T17:30:00Z", now))
        assertEquals("Vence en 1 hora", InviteExpiry.text("2026-11-03T13:00:00Z", now))
        assertEquals("Vence en 20 minutos", InviteExpiry.text("2026-11-03T12:20:00Z", now))
        assertEquals("Vence en menos de un minuto", InviteExpiry.text("2026-11-03T12:00:30Z", now))
    }

    @Test
    fun `una fecha pasada o ilegible no inventa nada`() {
        assertEquals("Esta invitación ya venció", InviteExpiry.text("2026-11-03T11:00:00Z", now))
        assertEquals(null, InviteExpiry.text("mañana", now))
    }
}
