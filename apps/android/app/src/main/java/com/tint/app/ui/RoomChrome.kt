package com.tint.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tint.app.social.FloatingReactions
import com.tint.app.social.RankEntry
import com.tint.app.social.ReactionArrival
import com.tint.app.social.SocialProtocol
import com.tint.app.sync.SyncBadge
import com.tint.app.sync.SyncLevel
import kotlinx.coroutines.delay

/** Cabecera de la sala: volver, título y el botón de invitar amigos. Sobre el video (`overlay`) lleva fondo degradado. */
@Composable
fun RoomTopBar(
    title: String,
    subtitle: String?,
    onBack: () -> Unit,
    onInvite: (() -> Unit)?,
    overlay: Boolean,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier.fillMaxWidth().height(56.dp)
            .then(if (overlay) Modifier.background(Brush.verticalGradient(listOf(Color(0x99000000), Color.Transparent))) else Modifier)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack, Modifier.size(48.dp)) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Volver", tint = if (overlay) Color.White else TintText)
        }
        Column(Modifier.weight(1f)) {
            Text(title, color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.Bold, maxLines = 1)
            if (subtitle != null && !overlay) Text(subtitle, color = TintMuted, fontSize = 12.sp, maxLines = 1)
        }
        if (onInvite != null) {
            IconButton(onClick = onInvite, Modifier.size(48.dp)) {
                Icon(Icons.Filled.Share, contentDescription = "Invitar amigos", tint = if (overlay) Color.White else TintAccentSoft)
            }
        }
    }
}

/** Insignia de sincronía: un punto de color, la etiqueta y las medidas (AND-18). */
@Composable
fun SyncChip(badge: SyncBadge, modifier: Modifier = Modifier) {
    val dot = when (badge.level) {
        SyncLevel.GOOD -> TintGood
        SyncLevel.WARN -> TintWarn
        SyncLevel.HOST_OFFLINE -> TintDanger
        SyncLevel.CONNECTING -> TintMuted
        SyncLevel.LIVE -> TintDanger
    }
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(dot))
        Text(badge.label, color = TintText, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
        badge.detail?.let { Text(it, color = TintMuted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false)) }
    }
}

/** Los seis botones de reacción, redondos y de tamaño táctil. */
@Composable
fun ReactionRow(onReact: (String) -> Unit, modifier: Modifier = Modifier, size: Dp = 46.dp) {
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        SocialProtocol.REACTION_EMOJIS.forEach { emoji ->
            Box(
                Modifier.size(size).clip(CircleShape).background(TintSurface).border(1.dp, TintHairline, CircleShape)
                    .clickable { onReact(emoji) }
                    .semantics { contentDescription = "Reaccionar con $emoji" },
                contentAlignment = Alignment.Center,
            ) { Text(emoji, fontSize = 22.sp) }
        }
    }
}

/** Las reacciones que suben flotando sobre el video durante dos segundos (AND-16). No intercepta toques. */
@Composable
fun FloatingReactionsLayer(arrivals: List<ReactionArrival>, nowMs: () -> Long, onPrune: () -> Unit, modifier: Modifier = Modifier) {
    var now by remember { mutableLongStateOf(nowMs()) }
    val active = arrivals.isNotEmpty()
    LaunchedEffect(active) {
        var frames = 0
        while (active) {
            now = nowMs()
            delay(33)
            if (++frames % 30 == 0) onPrune()
        }
    }
    if (!active) return
    BoxWithConstraints(modifier) {
        FloatingReactions.frame(arrivals, now).forEach { item ->
            Text(
                item.emoji,
                fontSize = 28.sp,
                modifier = Modifier
                    .offset {
                        IntOffset(
                            x = (constraints.maxWidth * (0.55f + 0.4f * item.lane)).toInt(),
                            y = (constraints.maxHeight * (0.85f - 0.7f * item.progress)).toInt(),
                        )
                    }
                    .alpha(item.alpha),
            )
        }
    }
}

/** Ranking acumulado de la sala (AND-19), con mi fila resaltada. */
@Composable
fun LeaderboardCard(entries: List<RankEntry>, myRank: Int?, myTotal: Int?, selfUserId: String?, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().background(TintSurface, RoundedCornerShape(16.dp)).padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("RANKING DE LA SALA", color = TintAccentSoft, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.4.sp)
        if (entries.isEmpty()) {
            Text("Nadie ha puntuado todavía.", color = TintMuted, fontSize = 13.sp)
        } else {
            entries.forEachIndexed { index, e ->
                val mine = selfUserId != null && e.userId == selfUserId
                RankRow("${index + 1}. ${if (mine) "Tú" else e.nick}", e.score, mine)
            }
            // Si no estoy entre las primeras filas, mi lugar va aparte.
            if (myRank != null && myTotal != null && entries.none { selfUserId != null && it.userId == selfUserId }) {
                RankRow("$myRank. Tú", myTotal, true)
            }
        }
    }
}

@Composable
private fun RankRow(label: String, score: Int, mine: Boolean) {
    Row(
        Modifier.fillMaxWidth()
            .then(if (mine) Modifier.background(TintAccent.copy(alpha = 0.18f), RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 4.dp) else Modifier),
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, color = if (mine) Color.White else TintText, fontSize = 14.sp)
        Text("%,d".format(score).replace(',', ' '), color = if (mine) Color.White else TintText, fontSize = 14.sp, fontWeight = FontWeight.Bold)
    }
}

enum class RoomTab(val label: String) {
    CHAT("Chat"),
    TRIVIA("Trivia"),
    POLL("Encuesta"),
    RANKING("Ranking"),
    VOICE("Voz"),
}

/** Pestañas de la sala: la activa lleva una raya naranja y las que tienen algo nuevo, un punto. */
@Composable
fun RoomTabRow(selected: RoomTab, onSelect: (RoomTab) -> Unit, tabs: List<RoomTab>, badges: Set<RoomTab>, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().height(46.dp).horizontalScroll(rememberScrollState())) {
        tabs.forEach { tab ->
            val active = tab == selected
            Box(
                Modifier.fillMaxHeight().clickable { onSelect(tab) }
                    // La raya se pinta con el tamaño real de la pestaña: dentro de una fila desplazable no hay ancho máximo.
                    .drawBehind { if (active) drawRect(TintAccent, Offset(0f, size.height - 3.dp.toPx()), Size(size.width, 3.dp.toPx())) }
                    .padding(horizontal = 16.dp),
                contentAlignment = Alignment.Center,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(tab.label, color = if (active) TintAccentSoft else TintMuted, fontSize = 14.sp, fontWeight = if (active) FontWeight.Bold else FontWeight.SemiBold)
                    if (tab in badges) Box(Modifier.size(8.dp).clip(CircleShape).background(TintAccent))
                }
            }
        }
    }
}

/** Texto de apoyo cuando una pestaña todavía no tiene nada que mostrar. */
@Composable
fun EmptyHint(text: String, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(text, color = TintMuted, fontSize = 14.sp, lineHeight = 20.sp)
    }
}
