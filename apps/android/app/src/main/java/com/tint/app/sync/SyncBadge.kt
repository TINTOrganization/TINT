package com.tint.app.sync

enum class SyncLevel { GOOD, WARN, HOST_OFFLINE, CONNECTING, LIVE }

/**
 * Estado de la sincronía para mostrar en una insignia (AND-18): `label` es lo que se lee de un vistazo y `detail` las
 * medidas. Un desfase de más de 500 ms es lo que el Canal Sync corrige, así que pasa de «buena» a «regular».
 */
data class SyncBadge(val level: SyncLevel, val label: String, val detail: String?) {
    companion object {
        private const val WARN_DRIFT_MS = 500L

        fun of(connected: Boolean, hostOnline: Boolean?, attempt: Int, rttMs: Long?, driftMs: Long?): SyncBadge = when {
            !connected && attempt > 0 -> SyncBadge(SyncLevel.CONNECTING, "Reconectando… intento $attempt", null)
            !connected -> SyncBadge(SyncLevel.CONNECTING, "Conectando con la sala…", null)
            hostOnline == false -> SyncBadge(SyncLevel.HOST_OFFLINE, "Host desconectado", null)
            else -> {
                val warn = driftMs != null && kotlin.math.abs(driftMs) > WARN_DRIFT_MS
                SyncBadge(
                    level = if (warn) SyncLevel.WARN else SyncLevel.GOOD,
                    label = if (warn) "Sincronía regular" else "Sincronía buena",
                    detail = rttMs?.let { "RTT $it ms · desfase ${driftMs ?: 0} ms" },
                )
            }
        }
    }
}
