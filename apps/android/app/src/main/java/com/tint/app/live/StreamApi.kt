package com.tint.app.live

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import kotlin.coroutines.cancellation.CancellationException

/** Respuesta de WHEP: la respuesta SDP y la URL de la sesión (para cerrarla con `DELETE`). */
data class WhepSession(val answerSdp: String, val sessionUrl: String)

/** Lo que el espectador necesita de stream-core (se sustituye en las pruebas). */
interface StreamSignaling {
    suspend fun iceServers(roomId: String): List<IceServer>

    suspend fun whep(roomId: String, offerSdp: String): WhepSession

    /** Libera el lugar en el cupo. Nunca falla: si la sesión ya no existe o no hay red, no hay nada que hacer. */
    suspend fun delete(sessionUrl: String)
}

/**
 * Señalización WHEP por HTTP contra stream-core (rutas bajo `/api/v1/stream`, directo o por el gateway) con el token de
 * invitado, igual que `useLiveStream.ts` de la web. `baseUrl` es el origen, sin la ruta.
 */
class StreamApi(
    baseUrl: String,
    private val http: OkHttpClient,
    private val token: () -> String?,
) : StreamSignaling {
    private val base = baseUrl.trimEnd('/')

    private class Reply(val code: Int, val body: String, val location: String?)

    override suspend fun iceServers(roomId: String): List<IceServer> {
        val reply = call(Request.Builder().url(roomUrl(roomId, "ice-servers")).get())
        if (reply.code !in 200..299) throw StreamProtocol.errorFor(reply.code, reply.body)
        return StreamProtocol.parseIceServers(reply.body)
    }

    override suspend fun whep(roomId: String, offerSdp: String): WhepSession {
        val body = offerSdp.toRequestBody(SDP)
        val reply = call(Request.Builder().url(roomUrl(roomId, "whep")).post(body))
        if (reply.code !in 200..299) throw StreamProtocol.errorFor(reply.code, reply.body)
        return WhepSession(reply.body, reply.location?.let { StreamProtocol.sessionUrl(base, it) }.orEmpty())
    }

    override suspend fun delete(sessionUrl: String) {
        if (sessionUrl.isEmpty()) return
        try {
            call(Request.Builder().url(sessionUrl).delete())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Sin red o sesión ya cerrada: el servidor libera el lugar por su cuenta cuando se cae la conexión.
        }
    }

    private fun roomUrl(roomId: String, action: String): HttpUrl =
        base.toHttpUrl().newBuilder()
            .addPathSegments("api/v1/stream/rooms")
            .addPathSegment(roomId)
            .addPathSegment(action)
            .build()

    private suspend fun call(builder: Request.Builder): Reply {
        val bearer = token() ?: throw StreamProtocol.errorFor(401, null)
        val request = builder.header("Authorization", "Bearer $bearer").build()
        return withContext(Dispatchers.IO) {
            try {
                http.newCall(request).execute().use { Reply(it.code, it.body?.string().orEmpty(), it.header("Location")) }
            } catch (e: IOException) {
                throw StreamError(0, "NETWORK", StreamProtocol.errorMessage("NETWORK"))
            }
        }
    }

    private companion object {
        val SDP = "application/sdp".toMediaType()
    }
}
