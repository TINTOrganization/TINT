package com.tint.app.config

import java.net.URLEncoder

/**
 * URLs del backend. Son las mismas que usa la web (`apps/web/.env.example`): identity-api
 * por REST, los dos canales WebSocket de sync-core y social-core y la API de transmisión de stream-core. Las bases se normalizan
 * sin barra final.
 */
class Endpoints(
    identityApiUrl: String,
    syncWsUrl: String,
    socialWsUrl: String,
    streamApiUrl: String? = null,
    voiceWsUrl: String? = null,
) {
    val identityApiUrl: String = identityApiUrl.trimEnd('/')

    /**
     * Origen de stream-core (las rutas cuelgan de `/api/v1/stream`). Sin valor, el mismo origen que identity-api:
     * detrás del gateway las dos APIs comparten dominio; en desarrollo se apunta al puerto 8086.
     */
    val streamApiUrl: String = streamApiUrl?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }
        ?: this.identityApiUrl.removeSuffix("/api/v1")
    private val syncBase: String = syncWsUrl.trimEnd('/')
    private val socialBase: String = socialWsUrl.trimEnd('/')

    /** Canal de voz de voice-core. Sin valor, el mismo host que el Canal Social (detrás del gateway comparten dominio). */
    private val voiceBase: String = voiceWsUrl?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }
        ?: (socialBase.removeSuffix("/ws/social") + "/ws/voice")

    /** `GET /ws/sync?room_id=&token=` (el token va en la query, igual que en la web). */
    fun syncUrl(roomId: String, token: String): String = channelUrl(syncBase, roomId, token)

    /** `GET /ws/social?room_id=&token=`. */
    fun socialUrl(roomId: String, token: String): String = channelUrl(socialBase, roomId, token)

    /** `GET /ws/voice?room_id=&token=`. */
    fun voiceUrl(roomId: String, token: String): String = channelUrl(voiceBase, roomId, token)

    private fun channelUrl(base: String, roomId: String, token: String): String =
        "$base?room_id=${encode(roomId)}&token=${encode(token)}"

    private fun encode(value: String): String = URLEncoder.encode(value, "UTF-8")
}
