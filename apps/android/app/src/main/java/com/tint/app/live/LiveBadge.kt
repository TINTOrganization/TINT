package com.tint.app.live

import com.tint.app.sync.SyncBadge
import com.tint.app.sync.SyncLevel

/** El estado de la transmisión como la misma insignia que usa la sincronía de las películas (mockups M13 y M14). */
object LiveBadge {
    fun of(state: LiveUiState): SyncBadge = when (state.status) {
        LiveStatus.IDLE, LiveStatus.CONNECTING -> SyncBadge(SyncLevel.CONNECTING, "Conectando con la transmisión…", null)
        LiveStatus.WAITING -> SyncBadge(SyncLevel.CONNECTING, "El host todavía no transmite", null)
        LiveStatus.LIVE -> SyncBadge(
            SyncLevel.LIVE,
            "En vivo",
            state.viewerCount?.let { "$it ${if (it == 1) "espectador" else "espectadores"}" },
        )
        LiveStatus.RECONNECTING -> SyncBadge(SyncLevel.WARN, "Reconectando con la transmisión…", state.error)
        LiveStatus.ENDED -> SyncBadge(SyncLevel.HOST_OFFLINE, "El evento terminó", null)
        LiveStatus.ERROR -> SyncBadge(SyncLevel.HOST_OFFLINE, "No se pudo ver la transmisión", state.error)
    }
}
