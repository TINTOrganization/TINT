package com.tint.app.config

import org.junit.Assert.assertEquals
import org.junit.Test

class EndpointsTest {
    private val endpoints = Endpoints(
        identityApiUrl = "http://localhost:8081/api/v1",
        syncWsUrl = "ws://localhost:8083/ws/sync",
        socialWsUrl = "ws://localhost:8082/ws/social",
    )

    @Test
    fun `el canal sync lleva sala y token en la query`() {
        assertEquals(
            "ws://localhost:8083/ws/sync?room_id=abc&token=h.p.s",
            endpoints.syncUrl("abc", "h.p.s"),
        )
    }

    @Test
    fun `el canal social lleva sala y token en la query`() {
        assertEquals(
            "ws://localhost:8082/ws/social?room_id=abc&token=h.p.s",
            endpoints.socialUrl("abc", "h.p.s"),
        )
    }

    @Test
    fun `escapa los caracteres reservados de la query`() {
        assertEquals(
            "ws://localhost:8083/ws/sync?room_id=a%26b&token=x%3Dy",
            endpoints.syncUrl("a&b", "x=y"),
        )
    }

    @Test
    fun `quita la barra final de las bases`() {
        val trimmed = Endpoints("http://h/api/v1/", "ws://h/ws/sync/", "ws://h/ws/social/")
        assertEquals("http://h/api/v1", trimmed.identityApiUrl)
        assertEquals("ws://h/ws/sync?room_id=r&token=t", trimmed.syncUrl("r", "t"))
        assertEquals("ws://h/ws/social?room_id=r&token=t", trimmed.socialUrl("r", "t"))
    }

    @Test
    fun `la API de transmision por defecto cuelga del origen de identity-api`() {
        val behindGateway = Endpoints("https://tint.jaucor.online/api/v1", "wss://h/ws/sync", "wss://h/ws/social")

        assertEquals("https://tint.jaucor.online", behindGateway.streamApiUrl)
    }

    @Test
    fun `la API de transmision se puede apuntar a stream-core directo`() {
        val direct = Endpoints(
            "http://192.168.1.7:8081/api/v1",
            "ws://192.168.1.7:8083/ws/sync",
            "ws://192.168.1.7:8082/ws/social",
            streamApiUrl = "http://192.168.1.7:8086/",
        )

        assertEquals("http://192.168.1.7:8086", direct.streamApiUrl)
    }

    @Test
    fun `una API de transmision vacia usa la del origen de identity-api`() {
        val blank = Endpoints("http://h:8081/api/v1/", "ws://h/ws/sync", "ws://h/ws/social", streamApiUrl = "  ")

        assertEquals("http://h:8081", blank.streamApiUrl)
    }
}
