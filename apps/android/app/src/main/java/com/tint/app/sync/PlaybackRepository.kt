package com.tint.app.sync

import com.tint.app.net.ApiAuth
import com.tint.app.net.ApiClient
import com.tint.app.net.ApiError
import com.tint.app.net.TokenStore
import kotlinx.serialization.Serializable
import java.net.URLEncoder
import kotlin.coroutines.cancellation.CancellationException

/** `GET /rooms/:id/playback`; `mediaId` y `url` son nulos si la sala no tiene vídeo. */
data class RoomPlayback(
    val mediaId: String?,
    val url: String?,
    val expiresAt: String?,
    val status: String?,
    /** Versiones del vídeo; vacío con un servidor viejo (entonces solo sirve `url`). */
    val qualities: List<PlaybackQuality> = emptyList(),
    /** Paleta del Ambilight (`{id}/ambilight.json` firmada); solo cuando el vídeo está `ready`. */
    val ambilightUrl: String? = null,
)

sealed interface PlaybackResult {
    data class Loaded(val playback: RoomPlayback) : PlaybackResult

    /** El token de invitado ya no vale (retirado por el host). */
    data object Revoked : PlaybackResult

    data class Failure(val message: String) : PlaybackResult
}

/** Lo que la sala necesita para obtener el vídeo (se sustituye en las pruebas). */
interface PlaybackSource {
    suspend fun get(roomId: String): PlaybackResult
}

@Serializable
private class PlaybackDto(
    val mediaId: String? = null,
    val url: String? = null,
    val expiresAt: String? = null,
    val status: String? = null,
    val qualities: List<QualityDto> = emptyList(),
    val ambilightUrl: String? = null,
)

@Serializable
private class QualityDto(val id: String? = null, val label: String? = null, val url: String? = null)

private val KNOWN_QUALITIES = QualityPref.entries.filter { it != QualityPref.AUTO }.associateBy { it.wire }

/** Como `normalizeQualities` de la web: solo `source`, `720p` y `360p` y con url. */
private fun QualityDto.toQuality(): PlaybackQuality? {
    val known = KNOWN_QUALITIES[id] ?: return null
    if (url.isNullOrEmpty()) return null
    return PlaybackQuality(known.wire, label?.takeIf { it.isNotEmpty() } ?: known.label, url)
}

/** Pide la URL del vídeo con el token de invitado, aunque el dispositivo tenga una sesión de host. */
class PlaybackRepository(private val api: ApiClient, private val tokens: TokenStore) : PlaybackSource {
    override suspend fun get(roomId: String): PlaybackResult = try {
        val dto = api.get<PlaybackDto>("/rooms/${URLEncoder.encode(roomId, "UTF-8")}/playback", ApiAuth.GUEST)
        PlaybackResult.Loaded(RoomPlayback(dto.mediaId, dto.url, dto.expiresAt, dto.status, dto.qualities.mapNotNull { it.toQuality() }, dto.ambilightUrl))
    } catch (e: CancellationException) {
        throw e
    } catch (e: ApiError) {
        when (e.status) {
            401, 403 -> {
                // Falla cerrado: el invitado fue retirado, el token no sirve más.
                tokens.guestToken = null
                PlaybackResult.Revoked
            }
            404, 410 -> PlaybackResult.Failure("La sala ya no está disponible.")
            0 -> PlaybackResult.Failure("No se pudo conectar con el servidor. Revisa tu conexión.")
            else -> PlaybackResult.Failure("No se pudo cargar el vídeo")
        }
    } catch (e: Exception) {
        PlaybackResult.Failure("No se pudo cargar el vídeo")
    }
}
