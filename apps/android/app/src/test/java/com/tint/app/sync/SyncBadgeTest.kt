package com.tint.app.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SyncBadgeTest {
    @Test
    fun `en sincronia con medidas`() {
        val b = SyncBadge.of(connected = true, hostOnline = true, attempt = 0, rttMs = 28, driftMs = 0)

        assertEquals(SyncLevel.GOOD, b.level)
        assertEquals("Sincronía buena", b.label)
        assertEquals("RTT 28 ms · desfase 0 ms", b.detail)
    }

    @Test
    fun `sin medidas todavia sigue siendo buena`() {
        val b = SyncBadge.of(connected = true, hostOnline = null, attempt = 0, rttMs = null, driftMs = null)

        assertEquals(SyncLevel.GOOD, b.level)
        assertEquals("Sincronía buena", b.label)
        assertNull(b.detail)
    }

    @Test
    fun `un desfase mayor de 500 ms es regular en cualquier sentido`() {
        assertEquals(SyncLevel.WARN, SyncBadge.of(true, true, 0, 30, 600).level)
        assertEquals(SyncLevel.WARN, SyncBadge.of(true, true, 0, 30, -700).level)
        assertEquals("Sincronía regular", SyncBadge.of(true, true, 0, 30, 600).label)
        assertEquals(SyncLevel.GOOD, SyncBadge.of(true, true, 0, 30, 500).level)
        assertEquals(SyncLevel.GOOD, SyncBadge.of(true, true, 0, 30, -500).level)
    }

    @Test
    fun `si el host no esta conectado se dice`() {
        val b = SyncBadge.of(connected = true, hostOnline = false, attempt = 0, rttMs = 30, driftMs = 10)

        assertEquals(SyncLevel.HOST_OFFLINE, b.level)
        assertEquals("Host desconectado", b.label)
    }

    @Test
    fun `conectando y reconectando`() {
        val first = SyncBadge.of(connected = false, hostOnline = null, attempt = 0, rttMs = null, driftMs = null)
        assertEquals(SyncLevel.CONNECTING, first.level)
        assertEquals("Conectando con la sala…", first.label)

        val retry = SyncBadge.of(connected = false, hostOnline = true, attempt = 3, rttMs = 30, driftMs = 0)
        assertEquals(SyncLevel.CONNECTING, retry.level)
        assertEquals("Reconectando… intento 3", retry.label)
    }

    @Test
    fun `sin conexion manda sobre el estado del host`() {
        val b = SyncBadge.of(connected = false, hostOnline = false, attempt = 0, rttMs = null, driftMs = null)

        assertEquals(SyncLevel.CONNECTING, b.level)
    }
}
