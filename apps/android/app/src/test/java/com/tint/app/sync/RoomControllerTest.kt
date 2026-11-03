package com.tint.app.sync

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomControllerTest {
    private class FakeSession : SyncSession {
        val flow = MutableStateFlow(SyncUiState())
        override val state: StateFlow<SyncUiState> = flow
        var starts = 0
        var stops = 0

        override fun start() {
            starts++
        }

        override fun stop() {
            stops++
        }
    }

    private class FakePlayback : PlaybackSource {
        val requests = mutableListOf<String>()
        var results = ArrayDeque<PlaybackResult>()
        var gate: CompletableDeferred<Unit>? = null

        override suspend fun get(roomId: String): PlaybackResult {
            requests += roomId
            val result = results.removeFirst()
            gate?.await()
            return result
        }
    }

    private fun loaded(media: String, url: String? = "https://v/$media.mp4") =
        PlaybackResult.Loaded(RoomPlayback(media, url, null, "ready"))

    private fun withMedia(media: String, version: Long = 1) = SyncUiState(
        connected = true,
        snapshot = SyncSnapshot(
            SyncState(PlaybackStatus.PAUSED, 0, 0, 1.0, version, 0, media, 1.0, "auto"),
            receivedAtMs = 0,
        ),
    )

    private val session = FakeSession()
    private val playback = FakePlayback()
    private val controller = RoomController("r1", session, playback, CoroutineScope(Dispatchers.Unconfined))

    @Test
    fun `empieza sin video ni errores`() {
        assertEquals(RoomUiState(), controller.ui.value)
    }

    @Test
    fun `al conocer el video de la sala pide la reproduccion una vez`() {
        playback.results += loaded("m1")

        session.flow.value = withMedia("m1")

        assertEquals(listOf("r1"), playback.requests)
        assertEquals("m1", controller.ui.value.mediaId)
        assertEquals("https://v/m1.mp4", controller.ui.value.videoUrl)
        assertFalse(controller.ui.value.loading)
        assertTrue(controller.ui.value.connected)
    }

    @Test
    fun `el mismo video no se vuelve a pedir y uno nuevo si`() {
        playback.results += loaded("m1")
        session.flow.value = withMedia("m1", 1)
        session.flow.value = withMedia("m1", 2)
        assertEquals(1, playback.requests.size)

        playback.results += loaded("m2")
        session.flow.value = withMedia("m2", 3)

        assertEquals(2, playback.requests.size)
        assertEquals("https://v/m2.mp4", controller.ui.value.videoUrl)
    }

    @Test
    fun `una sala sin video no pide nada y lo indica`() {
        session.flow.value = withMedia("")

        assertEquals(0, playback.requests.size)
        assertTrue(controller.ui.value.noVideo)
        assertNull(controller.ui.value.videoUrl)
    }

    @Test
    fun `un video nuevo despues de no tener quita el aviso`() {
        session.flow.value = withMedia("")
        playback.results += loaded("m1")

        session.flow.value = withMedia("m1", 2)

        assertFalse(controller.ui.value.noVideo)
        assertEquals("https://v/m1.mp4", controller.ui.value.videoUrl)
    }

    @Test
    fun `una invitacion revocada en la reproduccion se refleja`() {
        playback.results += PlaybackResult.Revoked

        session.flow.value = withMedia("m1")

        assertTrue(controller.ui.value.revoked)
        assertNull(controller.ui.value.videoUrl)
    }

    @Test
    fun `un fallo muestra el mensaje y recover reintenta`() {
        playback.results += PlaybackResult.Failure("No se pudo cargar el vídeo")
        session.flow.value = withMedia("m1")
        assertEquals("No se pudo cargar el vídeo", controller.ui.value.error)

        playback.results += loaded("m1", "https://v/nuevo.mp4")
        controller.recover()

        assertNull(controller.ui.value.error)
        assertEquals("https://v/nuevo.mp4", controller.ui.value.videoUrl)
        assertEquals(2, playback.requests.size)
    }

    @Test
    fun `sin url todavia explica que se esta preparando`() {
        playback.results += loaded("m1", url = null)

        session.flow.value = withMedia("m1")

        assertEquals("El vídeo se está preparando. Intenta de nuevo en un momento.", controller.ui.value.error)
        assertNull(controller.ui.value.videoUrl)
    }

    @Test
    fun `recover sin video conocido no hace nada`() {
        controller.recover()

        assertEquals(0, playback.requests.size)
    }

    @Test
    fun `revocado y expirado del canal sync se propagan`() {
        session.flow.value = SyncUiState(revoked = true)
        assertTrue(controller.ui.value.revoked)

        session.flow.value = SyncUiState(expired = true, hostOnline = false)
        assertTrue(controller.ui.value.expired)
        assertEquals(false, controller.ui.value.hostOnline)
    }

    @Test
    fun `una respuesta tardia de un video anterior no pisa al actual`() {
        val late = CompletableDeferred<Unit>()
        playback.gate = late
        playback.results += loaded("m1")
        playback.results += loaded("m2")
        session.flow.value = withMedia("m1", 1) // la respuesta de m1 queda retenida
        playback.gate = null
        session.flow.value = withMedia("m2", 2)
        late.complete(Unit) // m1 llega tarde, cuando la sala ya pasó a m2

        assertEquals("m2", controller.ui.value.mediaId)
        assertEquals("https://v/m2.mp4", controller.ui.value.videoUrl)
    }

    @Test
    fun `start y stop se delegan en la sesion`() {
        controller.start()
        controller.stop()

        assertEquals(1, session.starts)
        assertEquals(1, session.stops)
    }

    // ---- Calidad personal (AND-17) ----

    private val qualities = listOf(
        PlaybackQuality("source", "Original", "https://v/m1-source.mp4"),
        PlaybackQuality("720p", "720p", "https://v/m1-720.mp4"),
        PlaybackQuality("360p", "360p", "https://v/m1-360.mp4"),
    )

    private fun loadedWithQualities(media: String = "m1") =
        PlaybackResult.Loaded(RoomPlayback(media, "https://v/$media-source.mp4", null, "ready", qualities))

    @Test
    fun `con calidades elige la de auto segun la red`() {
        controller.setNetwork(NetworkHints(metered = true, dataSaver = false, widthDp = 411))
        playback.results += loadedWithQualities()

        session.flow.value = withMedia("m1")

        assertEquals("https://v/m1-360.mp4", controller.ui.value.videoUrl)
        assertEquals("360p", controller.ui.value.currentQuality?.id)
        assertEquals(qualities, controller.ui.value.qualities)
    }

    @Test
    fun `cambiar la calidad cambia la url sin pedir otra vez la reproduccion`() {
        playback.results += loadedWithQualities()
        session.flow.value = withMedia("m1")

        controller.setQuality(QualityPref.SOURCE)

        assertEquals("https://v/m1-source.mp4", controller.ui.value.videoUrl)
        assertEquals(QualityPref.SOURCE, controller.ui.value.qualityPref)
        assertEquals(1, playback.requests.size)
    }

    @Test
    fun `la calidad elegida se conserva al recuperar la url`() {
        playback.results += loadedWithQualities()
        session.flow.value = withMedia("m1")
        controller.setQuality(QualityPref.Q360)
        playback.results += loadedWithQualities()

        controller.recover()

        assertEquals("https://v/m1-360.mp4", controller.ui.value.videoUrl)
    }

    @Test
    fun `una red que cambia reevalua solo la calidad auto`() {
        playback.results += loadedWithQualities()
        session.flow.value = withMedia("m1")
        assertEquals("https://v/m1-720.mp4", controller.ui.value.videoUrl)

        controller.setNetwork(NetworkHints(metered = true, dataSaver = false, widthDp = 1000))
        assertEquals("https://v/m1-360.mp4", controller.ui.value.videoUrl)

        controller.setQuality(QualityPref.SOURCE)
        controller.setNetwork(NetworkHints(metered = false, dataSaver = false, widthDp = 1000))
        assertEquals("https://v/m1-source.mp4", controller.ui.value.videoUrl)
    }

    @Test
    fun `un servidor sin calidades sigue usando la url directa`() {
        playback.results += loaded("m1")

        session.flow.value = withMedia("m1")

        assertEquals("https://v/m1.mp4", controller.ui.value.videoUrl)
        assertEquals(emptyList<PlaybackQuality>(), controller.ui.value.qualities)
        assertNull(controller.ui.value.currentQuality)
    }
}
