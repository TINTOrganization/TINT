package com.tint.app.sync

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class RoomUiState(
    val connected: Boolean = false,
    val hostOnline: Boolean? = null,
    /** Vídeo actual de la sala; null mientras no se conoce. */
    val mediaId: String? = null,
    val videoUrl: String? = null,
    /** Versiones del vídeo y la que se reproduce (AND-17); vacías con un servidor que no las publica. */
    val qualities: List<PlaybackQuality> = emptyList(),
    val currentQuality: PlaybackQuality? = null,
    val qualityPref: QualityPref = QualityPref.AUTO,
    /** Paleta del Ambilight del vídeo actual; null si no hay (AND-23). */
    val ambilightUrl: String? = null,
    /** La que `auto` elegiría ahora (para estimar sus datos aunque haya otra fijada). */
    val autoQuality: PlaybackQuality? = null,
    /** Datos móviles o ahorro de datos: se avisa en el menú de calidad. */
    val metered: Boolean = false,
    val loading: Boolean = false,
    /** La sala no tiene vídeo asignado todavía. */
    val noVideo: Boolean = false,
    val error: String? = null,
    val revoked: Boolean = false,
    val expired: Boolean = false,
)

/**
 * Une la sincronía con la URL del vídeo: cuando el estado maestro dice qué vídeo toca, pide su URL a
 * identity-api. Una respuesta tardía de un vídeo anterior no pisa al actual.
 */
class RoomController(
    private val roomId: String,
    private val session: SyncSession,
    private val playback: PlaybackSource,
    private val scope: CoroutineScope,
) {
    private val _ui = MutableStateFlow(RoomUiState())
    val ui: StateFlow<RoomUiState> = _ui

    private var currentMedia: String? = null
    private var hints = NetworkHints()

    init {
        scope.launch { session.state.collect(::onSync) }
    }

    fun start() = session.start()

    fun stop() = session.stop()

    /** Elige la calidad solo para este aparato: cambia la URL sin volver a pedir la reproducción. */
    fun setQuality(pref: QualityPref) {
        _ui.update { applyQuality(it.copy(qualityPref = pref)) }
    }

    /** La red o la pantalla cambió: solo afecta a `auto`. */
    fun setNetwork(newHints: NetworkHints) {
        hints = newHints
        _ui.update { applyQuality(it.copy(metered = newHints.metered || newHints.dataSaver)) }
    }

    private fun applyQuality(state: RoomUiState): RoomUiState {
        if (state.qualities.isEmpty()) return state
        val chosen = QualityPolicy.resolve(state.qualityPref, state.qualities, hints) ?: return state
        return state.copy(currentQuality = chosen, videoUrl = chosen.url, autoQuality = QualityPolicy.resolve(QualityPref.AUTO, state.qualities, hints))
    }

    /** Vuelve a pedir la URL del vídeo actual (reproductor con error, URL caducada, reintento manual). */
    fun recover() {
        val media = currentMedia?.takeIf { it.isNotEmpty() } ?: return
        load(media, reset = false)
    }

    private fun onSync(sync: SyncUiState) {
        _ui.update {
            it.copy(
                connected = sync.connected,
                hostOnline = sync.hostOnline,
                expired = sync.expired,
                revoked = it.revoked || sync.revoked,
            )
        }
        val media = sync.snapshot?.state?.mediaId ?: return
        if (media == currentMedia) return
        currentMedia = media
        if (media.isEmpty()) {
            _ui.update { it.copy(mediaId = null, videoUrl = null, loading = false, noVideo = true, error = null) }
        } else {
            load(media, reset = true)
        }
    }

    private fun load(media: String, reset: Boolean) {
        _ui.update {
            it.copy(
                mediaId = media,
                videoUrl = if (reset) null else it.videoUrl,
                qualities = if (reset) emptyList() else it.qualities,
                currentQuality = if (reset) null else it.currentQuality,
                autoQuality = if (reset) null else it.autoQuality,
                ambilightUrl = if (reset) null else it.ambilightUrl,
                loading = true,
                noVideo = false,
                error = null,
            )
        }
        scope.launch {
            val result = playback.get(roomId)
            if (currentMedia != media) return@launch
            _ui.update {
                when (result) {
                    is PlaybackResult.Loaded -> {
                        val url = result.playback.url
                        if (url == null) {
                            it.copy(loading = false, error = "El vídeo se está preparando. Intenta de nuevo en un momento.")
                        } else {
                            applyQuality(it.copy(loading = false, videoUrl = url, qualities = result.playback.qualities, ambilightUrl = result.playback.ambilightUrl))
                        }
                    }
                    PlaybackResult.Revoked -> it.copy(loading = false, revoked = true)
                    is PlaybackResult.Failure -> it.copy(loading = false, error = result.message)
                }
            }
        }
    }
}
