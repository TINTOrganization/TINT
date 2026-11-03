package com.tint.app.layout

/**
 * Cómo se organiza la sala según el tamaño de la ventana (los cuatro formatos de los mockups M05 a M08). Se decide por
 * el tamaño que Android da a la app, no por el modelo del aparato, así que también acierta en pantalla dividida.
 */
enum class RoomLayout(
    /** Chat, trivia, encuesta, ranking y voz comparten un panel con pestañas (si no, el chat está siempre a la vista). */
    val tabbed: Boolean,
    /** El panel social va a la derecha del video (si no, debajo). */
    val sidePanel: Boolean,
    /** La cabecera se dibuja sobre el video para no gastar altura. */
    val overlayTopBar: Boolean,
) {
    PHONE_PORTRAIT(tabbed = true, sidePanel = false, overlayTopBar = false),
    PHONE_LANDSCAPE(tabbed = true, sidePanel = true, overlayTopBar = true),
    TABLET_PORTRAIT(tabbed = false, sidePanel = false, overlayTopBar = false),
    TABLET_LANDSCAPE(tabbed = false, sidePanel = true, overlayTopBar = false),
    ;

    companion object {
        private const val MEDIUM_WIDTH_DP = 600
        private const val EXPANDED_WIDTH_DP = 840
        private const val COMPACT_HEIGHT_DP = 480

        fun of(widthDp: Int, heightDp: Int): RoomLayout = when {
            widthDp > heightDp ->
                if (widthDp >= EXPANDED_WIDTH_DP && heightDp >= COMPACT_HEIGHT_DP) TABLET_LANDSCAPE else PHONE_LANDSCAPE
            widthDp >= MEDIUM_WIDTH_DP -> TABLET_PORTRAIT
            else -> PHONE_PORTRAIT
        }
    }
}
