package com.tint.app.live

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/** Servidor STUN/TURN que stream-core entrega al cliente (las credenciales TURN son nuevas en cada llamada). */
data class IceServer(val urls: List<String>, val username: String?, val credential: String?)

enum class StreamState { WAITING, LIVE, RECONNECTING, ENDED }

enum class EndReason { HOST_ENDED, GRACE_EXPIRED }

/** Escena que el host muestra: transmitiendo, "empezamos pronto" o "ya volvemos". */
enum class StreamScene { LIVE, STARTING_SOON, BRB }

/** Mensajes del DataChannel `stream-events` que le importan a un espectador. */
sealed interface StreamEvent {
    /** `reason` solo viene con `ENDED`; `graceDeadlineMs` solo con `RECONNECTING` (reloj del servidor). */
    data class State(
        val state: StreamState,
        val reason: EndReason? = null,
        val graceDeadlineMs: Long? = null,
    ) : StreamEvent

    data class ViewerCount(val count: Int) : StreamEvent

    data class Scene(val name: StreamScene) : StreamEvent
}

/** Error de stream-core: `status` HTTP (0 = sin red) y `code` en MAYÚSCULAS (`ROOM_FULL`, `ROOM_DISABLED`…). */
class StreamError(val status: Int, val code: String, message: String) : Exception(message)

/**
 * API de transmisión de stream-core vista por un espectador (`docs/dominio-transmision.md` §3 y §4). Espejo de
 * `apps/web/src/lib/streamProtocol.ts`: todo lo que viene del servidor se parsea a la defensiva.
 */
object StreamProtocol {
    /** DataChannel negociado: id fijo 0, creado antes de la oferta. */
    const val EVENTS_LABEL = "stream-events"
    const val EVENTS_ID = 0

    private const val RECONNECT_BASE_MS = 1_000L
    private const val RECONNECT_MAX_MS = 10_000L
    private const val GENERIC_ERROR = "Algo salió mal con la transmisión. Inténtalo de nuevo."

    private val ERROR_MESSAGES = mapOf(
        "ROOM_FULL" to "La transmisión está llena (50 espectadores). Inténtalo de nuevo en un rato.",
        "ROOM_DISABLED" to "El evento terminó y la sala fue deshabilitada.",
        "FORBIDDEN" to "No tienes acceso a la transmisión de esta sala.",
        "STREAM_NOT_FOUND" to "Esta sala no tiene transmisión en vivo.",
        "INVALID_SDP" to "No se pudo negociar el vídeo con el servidor.",
        "DATACHANNEL_REQUIRED" to "No se pudo abrir el canal de eventos de la transmisión.",
        "UNSUPPORTED_MEDIA_TYPE" to "No se pudo negociar la transmisión. Vuelve a entrar a la sala.",
        "UNAUTHORIZED" to "Tu acceso a la transmisión no es válido. Vuelve a entrar a la sala.",
        "TOKEN_EXPIRED" to "Tu acceso a la transmisión caducó. Vuelve a entrar a la sala.",
        "TOKEN_REVOKED" to "Ya no tienes acceso a esta sala.",
        "UNAVAILABLE" to "La transmisión no está disponible en este momento. Reintentando…",
        "NETWORK" to "No se pudo conectar con el servidor de la transmisión. Revisa tu conexión.",
    )

    fun errorMessage(code: String): String = ERROR_MESSAGES[code] ?: GENERIC_ERROR

    /** Arma el error de una respuesta fallida: el `{error}` del cuerpo manda; si no, se deduce del estado HTTP. */
    fun errorFor(status: Int, body: String?): StreamError {
        val fromBody = (parseObject(body)?.get("error") as? JsonPrimitive)?.takeIf { it.isString }?.content
        val code = fromBody?.takeIf { it.isNotBlank() } ?: when {
            status == 401 -> "UNAUTHORIZED"
            status == 403 -> "FORBIDDEN"
            status == 404 -> "STREAM_NOT_FOUND"
            status == 409 -> "ROOM_FULL"
            status == 410 -> "ROOM_DISABLED"
            status == 415 -> "UNSUPPORTED_MEDIA_TYPE"
            status >= 500 -> "UNAVAILABLE"
            else -> "HTTP_$status"
        }
        return StreamError(status, code, errorMessage(code))
    }

    /** Reintentar solo sirve con la red caída, un 5xx o demasiadas peticiones; el resto no cambia solo. */
    fun isTerminal(error: StreamError): Boolean = error.status != 0 && error.status < 500 && error.status != 429

    fun parseIceServers(body: String): List<IceServer> {
        val list = parseObject(body)?.get("ice_servers") as? JsonArray ?: return emptyList()
        return list.mapNotNull { element ->
            val o = element as? JsonObject ?: return@mapNotNull null
            val urls = when (val u = o["urls"]) {
                is JsonPrimitive -> if (u.isString) listOf(u.content) else return@mapNotNull null
                is JsonArray -> u.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: return@mapNotNull null }
                else -> return@mapNotNull null
            }
            IceServer(urls, o.string("username"), o.string("credential"))
        }
    }

    /** Parsea un mensaje del DataChannel; null si no es de un espectador o está mal formado. */
    fun parseEvent(raw: String): StreamEvent? {
        val o = parseObject(raw) ?: return null
        return when (o.string("type")) {
            "stream_state" -> {
                val state = when (o.string("state")) {
                    "waiting" -> StreamState.WAITING
                    "live" -> StreamState.LIVE
                    "reconnecting" -> StreamState.RECONNECTING
                    "ended" -> StreamState.ENDED
                    else -> return null
                }
                val reason = when (o.string("reason")) {
                    "host_ended" -> EndReason.HOST_ENDED
                    "grace_expired" -> EndReason.GRACE_EXPIRED
                    else -> null
                }
                StreamEvent.State(state, reason, o.count("grace_deadline_ms"))
            }
            "viewer_count" -> o.count("count")?.let { StreamEvent.ViewerCount(it.toInt()) }
            "scene" -> when (o.string("name")) {
                "live" -> StreamScene.LIVE
                "starting_soon" -> StreamScene.STARTING_SOON
                "brb" -> StreamScene.BRB
                else -> null
            }?.let { StreamEvent.Scene(it) }
            else -> null
        }
    }

    /** `Location` relativo (`/api/v1/stream/sessions/{sid}`) → URL absoluta contra la base. */
    fun sessionUrl(base: String, location: String): String {
        if (location.startsWith("http://", ignoreCase = true) || location.startsWith("https://", ignoreCase = true)) return location
        return base.trimEnd('/') + (if (location.startsWith("/")) "" else "/") + location
    }

    /** Espera antes del intento número `attempt` (0, 1, 2…): se duplica desde `baseMs` hasta `maxMs`. */
    fun reconnectDelayMs(attempt: Int, baseMs: Long = RECONNECT_BASE_MS, maxMs: Long = RECONNECT_MAX_MS): Long =
        minOf(baseMs shl attempt.coerceIn(0, 20), maxMs)

    private fun parseObject(text: String?): JsonObject? = try {
        text?.let { Json.parseToJsonElement(it) as? JsonObject }
    } catch (e: Exception) {
        null
    }

    private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** Entero no negativo (JSON número, no texto); null si falta o no cumple. */
    private fun JsonObject.count(key: String): Long? =
        (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
            ?.takeIf { it.isFinite() && it >= 0 && it == Math.floor(it) }?.toLong()
}
