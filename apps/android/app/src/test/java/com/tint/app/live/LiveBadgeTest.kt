package com.tint.app.live

import com.tint.app.sync.SyncLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LiveBadgeTest {
    private fun state(status: LiveStatus, viewers: Int? = null, error: String? = null) =
        LiveUiState(status = status, viewerCount = viewers, error = error)

    @Test
    fun `en vivo con y sin espectadores`() {
        val none = LiveBadge.of(state(LiveStatus.LIVE))
        assertEquals(SyncLevel.LIVE, none.level)
        assertEquals("En vivo", none.label)
        assertNull(none.detail)

        assertEquals("1 espectador", LiveBadge.of(state(LiveStatus.LIVE, 1)).detail)
        assertEquals("38 espectadores", LiveBadge.of(state(LiveStatus.LIVE, 38)).detail)
    }

    @Test
    fun `conectando y esperando al host`() {
        assertEquals("Conectando con la transmisión…", LiveBadge.of(state(LiveStatus.CONNECTING)).label)
        assertEquals("Conectando con la transmisión…", LiveBadge.of(state(LiveStatus.IDLE)).label)
        assertEquals(SyncLevel.CONNECTING, LiveBadge.of(state(LiveStatus.CONNECTING)).level)

        val waiting = LiveBadge.of(state(LiveStatus.WAITING))
        assertEquals("El host todavía no transmite", waiting.label)
        assertEquals(SyncLevel.CONNECTING, waiting.level)
    }

    @Test
    fun `reconectando muestra el motivo`() {
        val b = LiveBadge.of(state(LiveStatus.RECONNECTING, error = "No se pudo conectar"))

        assertEquals(SyncLevel.WARN, b.level)
        assertEquals("Reconectando con la transmisión…", b.label)
        assertEquals("No se pudo conectar", b.detail)
    }

    @Test
    fun `el evento terminado y los errores`() {
        val ended = LiveBadge.of(state(LiveStatus.ENDED))
        assertEquals(SyncLevel.HOST_OFFLINE, ended.level)
        assertEquals("El evento terminó", ended.label)

        val failed = LiveBadge.of(state(LiveStatus.ERROR, error = "La transmisión está llena"))
        assertEquals(SyncLevel.HOST_OFFLINE, failed.level)
        assertEquals("No se pudo ver la transmisión", failed.label)
        assertEquals("La transmisión está llena", failed.detail)
    }
}
