package com.tint.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tint.app.social.SocialClient
import com.tint.app.social.SocialUiState
import com.tint.app.voice.VoiceClient

/** Pestañas con su contenido: lo que cambia entre el panel del móvil y el carril de la tableta es solo qué pestañas hay. */
@Composable
fun RoomPanels(
    tabs: List<RoomTab>,
    selected: RoomTab,
    onSelect: (RoomTab) -> Unit,
    social: SocialClient,
    state: SocialUiState,
    selfUserId: String?,
    nowMs: () -> Long,
    voice: VoiceClient,
    modifier: Modifier = Modifier,
) {
    val triviaOpen = state.trivia?.let { it.result == null } == true
    val pollOpen = state.poll?.let { !it.closed } == true
    val badges = buildSet {
        if (triviaOpen) add(RoomTab.TRIVIA)
        if (pollOpen) add(RoomTab.POLL)
    }
    // Si la pestaña elegida no existe en este formato (por ejemplo al girar), se cae al chat.
    val current = if (selected in tabs) selected else RoomTab.CHAT
    Column(modifier.fillMaxSize()) {
        RoomTabRow(current, onSelect, tabs, badges)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            RoomTabContent(current, social, state, selfUserId, nowMs, voice)
        }
    }
}

@Composable
private fun RoomTabContent(tab: RoomTab, social: SocialClient, state: SocialUiState, selfUserId: String?, nowMs: () -> Long, voice: VoiceClient) {
    when (tab) {
        RoomTab.CHAT -> ChatPanel(
            state = state,
            selfUserId = selfUserId,
            nowMs = nowMs,
            onSend = social::send,
            modifier = Modifier.fillMaxSize().padding(12.dp),
        )
        RoomTab.TRIVIA -> Scrollable {
            val trivia = state.trivia
            if (trivia == null) {
                EmptyHint("Cuando el host lance una pregunta de trivia aparecerá aquí.")
            } else {
                TriviaCard(trivia, nowMs = nowMs, onAnswer = { social.answerTrivia(it) }, onDismiss = social::dismissTrivia)
            }
        }
        RoomTab.POLL -> Scrollable {
            val poll = state.poll
            if (poll == null) {
                EmptyHint("No hay ninguna encuesta abierta.")
            } else {
                PollCard(poll, wallNowMs = System::currentTimeMillis, onVote = { social.votePoll(it) }, onDismiss = social::dismissPoll)
            }
        }
        RoomTab.RANKING -> Scrollable { LeaderboardCard(state.leaderboard, state.myRank, state.myTotal, selfUserId) }
        RoomTab.VOICE -> Scrollable { VoicePanel(voice) }
    }
}

@Composable
private fun Scrollable(content: @Composable () -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) { content() }
}

/** Las tarjetas que la tableta deja siempre a la vista: voz, la pregunta o encuesta en curso y el ranking (M07 y M08). */
@Composable
fun SideCards(
    horizontal: Boolean,
    social: SocialClient,
    state: SocialUiState,
    selfUserId: String?,
    nowMs: () -> Long,
    voice: VoiceClient,
    modifier: Modifier = Modifier,
) {
    val trivia: @Composable () -> Unit = {
        state.trivia?.let { TriviaCard(it, nowMs = nowMs, onAnswer = { a -> social.answerTrivia(a) }, onDismiss = social::dismissTrivia) }
    }
    val poll: @Composable () -> Unit = {
        state.poll?.let { PollCard(it, wallNowMs = System::currentTimeMillis, onVote = { v -> social.votePoll(v) }, onDismiss = social::dismissPoll) }
    }
    val ranking: @Composable () -> Unit = { LeaderboardCard(state.leaderboard, state.myRank, state.myTotal, selfUserId) }

    if (horizontal) {
        Row(modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.weight(1f)) { VoicePanel(voice) }
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                if (state.trivia != null) trivia() else if (state.poll != null) poll() else ranking()
            }
        }
    } else {
        Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            VoicePanel(voice)
            trivia()
            poll()
            ranking()
        }
    }
}
