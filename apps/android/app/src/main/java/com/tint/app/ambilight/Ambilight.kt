package com.tint.app.ambilight

import com.tint.app.net.ApiJson
import com.tint.app.store.KeyValueStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import kotlin.coroutines.cancellation.CancellationException
import kotlin.math.roundToInt

/** Un instante de la paleta que extrajo media-worker (`{id}/ambilight.json`): el color promedio de cada borde, en ARGB. */
data class AmbilightFrame(val tMs: Long, val top: Int, val right: Int, val bottom: Int, val left: Int)

object Ambilight {
    private val HEX = Regex("^#[0-9a-fA-F]{6}$")

    /** Como `parseAmbilight` de la web: ignora lo mal formado, y lo que no sea una lista da una paleta vacía. */
    fun parse(json: String): List<AmbilightFrame> {
        val root = try {
            ApiJson.parseToJsonElement(json)
        } catch (_: Exception) {
            return emptyList()
        }
        if (root !is JsonArray) return emptyList()
        return root.mapNotNull(::toFrame).sortedBy { it.tMs }
    }

    private fun toFrame(element: JsonElement): AmbilightFrame? {
        val obj = element as? JsonObject ?: return null
        val t = (obj["t_ms"] as? JsonPrimitive)?.doubleOrNull ?: return null
        if (t < 0 || t.isNaN() || t.isInfinite()) return null
        fun color(key: String): Int? {
            val text = (obj[key] as? JsonPrimitive)?.contentOrNull ?: return null
            return if (HEX.matches(text)) (0xFF000000L or text.substring(1).toLong(16)).toInt() else null
        }
        return AmbilightFrame(t.toLong(), color("top") ?: return null, color("right") ?: return null, color("bottom") ?: return null, color("left") ?: return null)
    }

    /** Colores en el instante `tMs`, mezclando los dos fotogramas vecinos (o el vigente si `interpolate` es falso). */
    fun colorsAt(frames: List<AmbilightFrame>, tMs: Long, interpolate: Boolean): AmbilightFrame? {
        if (frames.isEmpty()) return null
        var lo = 0
        var hi = frames.lastIndex
        while (lo < hi) {
            val mid = (lo + hi + 1) / 2
            if (frames[mid].tMs <= tMs) lo = mid else hi = mid - 1
        }
        val a = frames[lo]
        val b = frames.getOrNull(lo + 1)
        if (!interpolate || b == null || tMs <= a.tMs) return a.copy(tMs = tMs)
        val f = ((tMs - a.tMs).toDouble() / (b.tMs - a.tMs)).coerceIn(0.0, 1.0)
        return AmbilightFrame(tMs, mix(a.top, b.top, f), mix(a.right, b.right, f), mix(a.bottom, b.bottom, f), mix(a.left, b.left, f))
    }

    private fun mix(a: Int, b: Int, f: Double): Int {
        fun ch(shift: Int): Int {
            val x = (a shr shift) and 0xFF
            val y = (b shr shift) and 0xFF
            return (x + (y - x) * f).roundToInt()
        }
        return (0xFF shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
    }
}

/**
 * La preferencia del brillo, con la misma clave que la web (`tint_ambilight`: `off` lo apaga). Si nadie la eligió, arranca
 * apagado con el ahorro de batería activo (AND-23 AC2); lo que la persona eligió manda siempre y se recuerda (AC3).
 */
class AmbilightPrefs(private val store: KeyValueStore) {
    fun isOn(batterySaver: Boolean): Boolean = when (store.get(KEY)) {
        "off" -> false
        "on" -> true
        else -> !batterySaver
    }

    fun set(on: Boolean) = store.put(KEY, if (on) "on" else "off")

    private companion object {
        const val KEY = "tint_ambilight"
    }
}

/** Descarga la paleta de la URL firmada (sin credenciales: la firma ya autoriza). Si falla, no hay brillo. */
class AmbilightRepository(private val http: OkHttpClient) {
    suspend fun load(url: String): List<AmbilightFrame> = withContext(Dispatchers.IO) {
        try {
            http.newCall(Request.Builder().url(url).build()).execute().use { res ->
                if (res.isSuccessful) Ambilight.parse(res.body?.string().orEmpty()) else emptyList()
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptyList()
        }
    }
}
