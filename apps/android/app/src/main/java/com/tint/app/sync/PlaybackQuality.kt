package com.tint.app.sync

import java.util.Locale

/** Una versión del vídeo que publica identity-api en `qualities` de `GET /rooms/:id/playback` (`source`, `720p`, `360p`). */
data class PlaybackQuality(val id: String, val label: String, val url: String)

/** Lo que la persona elige en el menú de calidad (AND-17). Es personal: no se manda a nadie. */
enum class QualityPref(val wire: String, val label: String) {
    AUTO("auto", "Auto"),
    SOURCE("source", "Original"),
    Q720("720p", "720p"),
    Q360("360p", "360p"),
    ;

    companion object {
        /** Lo desconocido o ausente es `AUTO`. */
        fun fromWire(value: String?): QualityPref = entries.firstOrNull { it.wire == value } ?: AUTO
    }
}

/** Lo que `auto` mira de la red y la pantalla (equivale a `readNetworkHints` de la web). */
data class NetworkHints(val metered: Boolean = false, val dataSaver: Boolean = false, val widthDp: Int = Int.MAX_VALUE)

object QualityPolicy {
    private const val NARROW_DP = 640
    private const val SOURCE = "source"

    /**
     * Qué calidad reproducir. `auto` replica la heurística de la web: 360p con datos móviles o ahorro de datos, 720p
     * en pantallas estrechas y, sin medida del ancho de banda, también en wifi (arranca antes y evita cortes). Si la
     * elegida no existe se cae al original, y si tampoco hay original, a la primera que haya.
     */
    fun resolve(pref: QualityPref, qualities: List<PlaybackQuality>, hints: NetworkHints): PlaybackQuality? {
        val wanted = if (pref == QualityPref.AUTO) auto(hints).wire else pref.wire
        return qualities.firstOrNull { it.id == wanted } ?: qualities.firstOrNull { it.id == SOURCE } ?: qualities.firstOrNull()
    }

    private fun auto(hints: NetworkHints): QualityPref = when {
        hints.metered || hints.dataSaver -> QualityPref.Q360
        else -> QualityPref.Q720
    }

    // Tope de bitrate (vídeo + 128 kb/s de audio) con el que media-worker publica cada calidad: CRF con límite VBV.
    private val MAX_KBPS = mapOf("360p" to 1_128, "720p" to 3_128, SOURCE to 8_128)

    /** «hasta ≈ 1,4 GB por hora»: es un tope, el CRF suele quedar por debajo. `null` si no se conoce la calidad. */
    fun dataPerHour(id: String): String? {
        val kbps = MAX_KBPS[id] ?: return null
        val gb = kbps * 1000.0 / 8 * 3600 / 1_000_000_000
        return "hasta ≈ ${String.format(Locale.forLanguageTag("es"), "%.1f", gb)} GB por hora"
    }
}
