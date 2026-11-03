package com.tint.app.voice

import com.tint.app.live.IceServer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

/** Un participante de la voz. `hostMuted`: el host lo silenció y los demás dejan de oírlo aunque siga enviando. */
data class VoicePeer(
    val peerId: String,
    val userId: String,
    val nick: String,
    val role: String,
    val muted: Boolean,
    val hostMuted: Boolean,
)

/** Candidato ICE tal como lo manda la web (`RTCIceCandidate.toJSON()`). */
data class IceCandidateInit(
    val candidate: String,
    val sdpMid: String?,
    val sdpMLineIndex: Int?,
    val usernameFragment: String?,
)

/** Contenido de un `signal`: opaco para el servidor, igual que en `voiceProtocol.ts` de la web. */
sealed interface SignalData {
    /** `type` es `offer` o `answer`. */
    data class Description(val type: String, val sdp: String) : SignalData

    /** `candidate` null marca el fin de los candidatos. */
    data class Candidate(val candidate: IceCandidateInit?) : SignalData
}

sealed interface VoiceMessage {
    data class VoiceState(
        val roomId: String,
        val self: VoicePeer,
        val peers: List<VoicePeer>,
        val iceServers: List<IceServer>,
        val maxMembers: Int,
    ) : VoiceMessage

    data class PeerJoined(val peer: VoicePeer) : VoiceMessage

    data class PeerLeft(val peerId: String) : VoiceMessage

    data class Signal(val from: String, val data: SignalData) : VoiceMessage

    data class PeerMuted(val peerId: String, val userId: String, val muted: Boolean, val hostMuted: Boolean) : VoiceMessage

    data class Error(val code: String) : VoiceMessage
}

/**
 * Protocolo del Canal de Voz (`/ws/voice`, voice-core). El servidor solo autoriza, lleva la membresía y reenvía la
 * señalización; el audio va directo entre los dispositivos (malla P2P). Espejo de `apps/web/src/lib/voiceProtocol.ts`:
 * la forma de `signal` es la de la web, no la de la tabla de voice-core, para que Android y navegador se entiendan.
 */
object VoiceProtocol {
    /** Cierres en los que reconectar no sirve, además de los comunes (4001, 4003, 4010): voz llena y fuera del escenario. */
    val EXTRA_TERMINAL_CODES: Set<Int> = setOf(4008, 4009)

    const val CLOSE_VOICE_FULL = 4008
    const val CLOSE_NOT_ON_STAGE = 4009

    private const val GENERIC_ERROR = "Algo salió mal con la voz. Inténtalo de nuevo."

    private val ERROR_MESSAGES = mapOf(
        "HOST_MUTED" to "El host te silenció. Podrás hablar cuando te lo permita.",
        "VOICE_FULL" to "La voz está llena. Inténtalo cuando alguien salga.",
        "FORBIDDEN" to "Solo el host puede silenciar a otras personas.",
        "UNAVAILABLE" to "No se pudo guardar el cambio. Inténtalo de nuevo en un momento.",
        "NOT_ON_STAGE" to "No estás en el escenario. En una transmisión solo hablan el host y quienes él invite.",
    )

    fun errorMessage(code: String): String = ERROR_MESSAGES[code] ?: GENERIC_ERROR

    /** Aviso de un cierre sin reintento, o null si conviene reconectar. */
    fun closeNotice(code: Int): String? = when (code) {
        4001 -> "Ya no tienes acceso a esta sala."
        4003 -> "Tu invitación caducó. Pide al host un link nuevo."
        CLOSE_VOICE_FULL -> errorMessage("VOICE_FULL")
        CLOSE_NOT_ON_STAGE -> errorMessage("NOT_ON_STAGE")
        4010 -> "El evento terminó."
        else -> null
    }

    /** Parsea un mensaje del servidor; null si no es válido. */
    fun parse(raw: String): VoiceMessage? {
        val o = parseObject(raw) ?: return null
        return when (o.string("type")) {
            "voice_state" -> {
                val self = peer(o["self"]) ?: return null
                VoiceMessage.VoiceState(
                    roomId = o.string("room_id").orEmpty(),
                    self = self,
                    peers = (o["peers"] as? JsonArray).orEmpty().mapNotNull { peer(it) },
                    iceServers = (o["ice_servers"] as? JsonArray).orEmpty().mapNotNull { iceServer(it) },
                    maxMembers = o.number("max_members") ?: 0,
                )
            }
            "peer_joined" -> peer(o["peer"])?.let { VoiceMessage.PeerJoined(it) }
            "peer_left" -> o.nonEmpty("peer_id")?.let { VoiceMessage.PeerLeft(it) }
            "signal" -> {
                val from = o.nonEmpty("from") ?: return null
                signalData(o["data"])?.let { VoiceMessage.Signal(from, it) }
            }
            "peer_muted" -> {
                val muted = o.bool("muted") ?: return null
                val hostMuted = o.bool("host_muted") ?: return null
                o.nonEmpty("peer_id")?.let { VoiceMessage.PeerMuted(it, o.string("user_id").orEmpty(), muted, hostMuted) }
            }
            "error" -> o.nonEmpty("code")?.let { VoiceMessage.Error(it) }
            else -> null
        }
    }

    fun signal(to: String, data: SignalData, eventId: String, occurredAtMs: Long): String =
        command("signal", eventId, occurredAtMs) {
            put("to", to)
            put(
                "data",
                buildJsonObject {
                    when (data) {
                        is SignalData.Description -> put(
                            "description",
                            buildJsonObject {
                                put("type", data.type)
                                put("sdp", data.sdp)
                            },
                        )
                        is SignalData.Candidate -> {
                            val c = data.candidate
                            if (c == null) {
                                put("candidate", JsonNull)
                            } else {
                                put(
                                    "candidate",
                                    buildJsonObject {
                                        put("candidate", c.candidate)
                                        c.sdpMid?.let { put("sdpMid", it) }
                                        c.sdpMLineIndex?.let { put("sdpMLineIndex", it) }
                                        c.usernameFragment?.let { put("usernameFragment", it) }
                                    },
                                )
                            }
                        }
                    }
                },
            )
        }

    fun selfMute(muted: Boolean, eventId: String, occurredAtMs: Long): String =
        command("self_mute", eventId, occurredAtMs) { put("muted", muted) }

    fun leave(eventId: String, occurredAtMs: Long): String = command("leave", eventId, occurredAtMs) {}

    private fun command(type: String, eventId: String, occurredAtMs: Long, fields: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit): String =
        buildJsonObject {
            put("type", type)
            put("event_id", eventId)
            put("occurred_at", occurredAtMs)
            fields()
        }.toString()

    private fun signalData(element: kotlinx.serialization.json.JsonElement?): SignalData? {
        val o = element as? JsonObject ?: return null
        (o["description"] as? JsonObject)?.let { d ->
            return SignalData.Description(d.string("type") ?: return null, d.string("sdp") ?: return null)
        }
        if (!o.containsKey("candidate")) return null
        return when (val c = o["candidate"]) {
            is JsonNull -> SignalData.Candidate(null)
            is JsonObject -> SignalData.Candidate(
                IceCandidateInit(
                    candidate = c.string("candidate") ?: return null,
                    sdpMid = c.string("sdpMid"),
                    sdpMLineIndex = c.number("sdpMLineIndex"),
                    usernameFragment = c.string("usernameFragment"),
                ),
            )
            else -> null
        }
    }

    private fun peer(element: kotlinx.serialization.json.JsonElement?): VoicePeer? {
        val o = element as? JsonObject ?: return null
        return VoicePeer(
            peerId = o.nonEmpty("peer_id") ?: return null,
            userId = o.nonEmpty("user_id") ?: return null,
            nick = o.string("nick").orEmpty(),
            role = o.string("role") ?: "participant",
            muted = o.bool("muted") ?: false,
            hostMuted = o.bool("host_muted") ?: false,
        )
    }

    private fun iceServer(element: kotlinx.serialization.json.JsonElement?): IceServer? {
        val o = element as? JsonObject ?: return null
        val urls = when (val u = o["urls"]) {
            is JsonPrimitive -> if (u.isString && u.content.isNotEmpty()) listOf(u.content) else return null
            is JsonArray -> {
                if (u.isEmpty()) return null
                u.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString && p.content.isNotEmpty() }?.content ?: return null }
            }
            else -> return null
        }
        return IceServer(urls, o.nonEmpty("username"), o.nonEmpty("credential"))
    }

    private fun parseObject(text: String): JsonObject? = try {
        Json.parseToJsonElement(text) as? JsonObject
    } catch (e: Exception) {
        null
    }

    private fun JsonArray?.orEmpty(): List<kotlinx.serialization.json.JsonElement> = this ?: emptyList()

    private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun JsonObject.nonEmpty(key: String): String? = string(key)?.takeIf { it.isNotEmpty() }

    private fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

    private fun JsonObject.number(key: String): Int? =
        (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() }?.toInt()
}
