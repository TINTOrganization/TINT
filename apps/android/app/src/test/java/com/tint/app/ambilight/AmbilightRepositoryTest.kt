package com.tint.app.ambilight

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

class AmbilightRepositoryTest {
    private lateinit var server: MockWebServer
    private lateinit var repo: AmbilightRepository

    @Before
    fun setUp() {
        server = MockWebServer().apply { start() }
        repo = AmbilightRepository(OkHttpClient())
    }

    @After
    fun tearDown() = server.shutdown()

    @Test
    fun `descarga la paleta de la url firmada sin credenciales`() = runBlocking {
        server.enqueue(MockResponse().setBody("""[{"t_ms":0,"top":"#111111","right":"#222222","bottom":"#333333","left":"#444444"}]"""))

        val frames = repo.load(server.url("/v1/ambilight.json?sig=abc").toString())

        assertEquals(1, frames.size)
        val request = server.takeRequest()
        assertEquals("/v1/ambilight.json?sig=abc", request.path)
        assertEquals(null, request.getHeader("Authorization"))
    }

    @Test
    fun `si falla la descarga no hay brillo pero tampoco error`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(403))
        assertEquals(emptyList<AmbilightFrame>(), repo.load(server.url("/x").toString()))
    }
}
