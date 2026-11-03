package com.tint.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.tint.app.layout.RoomLayout

/**
 * Coloca los bloques de la sala según el formato (mockups M05 a M08). No sabe nada de video ni de red: recibe cada bloque
 * ya armado. El video es el mismo composable en los cuatro formatos (`movableContentOf` en la pantalla), así que girar
 * el aparato no lo reinicia.
 */
@Composable
fun RoomScaffold(
    layout: RoomLayout,
    topBar: @Composable (overlay: Boolean) -> Unit,
    video: @Composable () -> Unit,
    status: @Composable () -> Unit,
    reactions: @Composable () -> Unit,
    voiceBar: @Composable () -> Unit,
    tabs: @Composable (tabSet: List<RoomTab>) -> Unit,
    chat: @Composable () -> Unit,
    cards: @Composable (horizontal: Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    when (layout) {
        RoomLayout.PHONE_PORTRAIT -> Column(modifier.fillMaxSize()) {
            topBar(false)
            VideoBox(Modifier.fillMaxWidth(), rounded = false, video = video)
            Box(Modifier.padding(horizontal = 14.dp, vertical = 6.dp)) { status() }
            Box(Modifier.padding(horizontal = 10.dp)) { reactions() }
            Box(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) { voiceBar() }
            Box(Modifier.weight(1f).fillMaxWidth()) { tabs(PHONE_TABS) }
        }

        RoomLayout.PHONE_LANDSCAPE -> Row(modifier.fillMaxSize()) {
            Column(Modifier.weight(0.64f).fillMaxHeight()) {
                VideoBox(Modifier.fillMaxWidth(), rounded = false, video = video) { topBar(true) }
                Box(Modifier.padding(horizontal = 14.dp, vertical = 4.dp)) { status() }
                Box(Modifier.padding(horizontal = 12.dp)) { reactions() }
            }
            Box(Modifier.weight(0.36f).fillMaxHeight().background(TintSurface)) { tabs(PHONE_TABS) }
        }

        RoomLayout.TABLET_PORTRAIT -> Column(modifier.fillMaxSize()) {
            topBar(false)
            VideoBox(Modifier.fillMaxWidth().padding(horizontal = 20.dp), rounded = true, video = video)
            Box(Modifier.padding(horizontal = 24.dp, vertical = 8.dp)) { status() }
            Box(Modifier.padding(horizontal = 24.dp)) { reactions() }
            Row(Modifier.weight(1f).fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 10.dp, bottom = 20.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(18.dp)).background(TintSurface)) { chat() }
                Box(Modifier.width(292.dp).fillMaxHeight()) { cards(false) }
            }
        }

        RoomLayout.TABLET_LANDSCAPE -> Column(modifier.fillMaxSize()) {
            topBar(false)
            Row(Modifier.weight(1f).fillMaxWidth().padding(start = 24.dp, end = 24.dp, top = 8.dp, bottom = 20.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Column(Modifier.weight(1.6f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    VideoBox(Modifier.fillMaxWidth(), rounded = true, video = video)
                    status()
                    reactions()
                    Box(Modifier.weight(1f).fillMaxWidth()) { cards(true) }
                }
                Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(18.dp)).background(TintSurface)) { tabs(RAIL_TABS) }
            }
        }
    }
}

private val PHONE_TABS = listOf(RoomTab.CHAT, RoomTab.TRIVIA, RoomTab.POLL, RoomTab.RANKING, RoomTab.VOICE)
private val RAIL_TABS = listOf(RoomTab.CHAT, RoomTab.RANKING, RoomTab.POLL)

/** El recuadro 16:9 del video, con algo encima si hace falta (la cabecera en el móvil horizontal). */
@Composable
private fun VideoBox(modifier: Modifier, rounded: Boolean, video: @Composable () -> Unit, overlay: @Composable () -> Unit = {}) {
    Box(
        modifier.aspectRatio(16f / 9f).then(if (rounded) Modifier.clip(RoundedCornerShape(16.dp)) else Modifier).background(Color.Black),
    ) {
        video()
        overlay()
    }
}
