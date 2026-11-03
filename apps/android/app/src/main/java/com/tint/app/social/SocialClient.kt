package com.tint.app.social

import com.tint.app.sync.ResilientSocket
import com.tint.app.sync.SyncProtocol
import com.tint.app.sync.SyncSocketFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import java.time.Instant
import java.util.UUID

/** La pregunta de trivia en pantalla y lo que va pasando con ella. */
data class TriviaState(
    val question: TriviaQuestion,
    /** Cuándo llegó, en el reloj monótono local. La cuenta regresiva parte de ahí: no se comparan relojes. */
    val receivedAtMs: Long,
    val myOption: Int? = null,
    val ack: TriviaAck? = null,
    val result: TriviaResult? = null,
) {
    /** Duración de la ventana de respuesta, calculada con las dos horas del servidor (no con la hora actual). */
    val windowMs: Long get() = maxOf(0L, question.closesAtMs - question.opensAtMs)

    /** Cuánto queda para responder; 0 si ya cerró (por tiempo o por el resultado). */
    fun remainingMs(nowMs: Long): Long = if (result != null) 0 else maxOf(0L, receivedAtMs + windowMs - nowMs)
}

data class SocialUiState(
    val connected: Boolean = false,
    val messages: List<ChatItem> = emptyList(),
    val reactions: List<Reaction> = emptyList(),
    /** Modo lento de la sala en segundos (0 = apagado). */
    val slowModeS: Int = 0,
    val mutedUserIds: List<String> = emptyList(),
    /** El host me silenció: puedo leer, no escribir. */
    val muted: Boolean = false,
    /** Hasta cuándo (reloj monótono local, ms) no puedo volver a escribir por el modo lento. */
    val cooldownUntilMs: Long? = null,
    /** Último error en palabras simples; `errorSeq` cambia con cada uno para poder reaccionar a repetidos. */
    val error: String? = null,
    val errorSeq: Int = 0,
    val trivia: TriviaState? = null,
    /** Encuesta vigente (o la última cerrada, hasta que la descarte). `myVote` ya resuelto. */
    val poll: PollState? = null,
    /** Puntos recientes del láser del host, con su hora de llegada local. */
    val laser: List<LaserArrival> = emptyList(),
    val revoked: Boolean = false,
    val expired: Boolean = false,
    /** La sala se cerró (cierre 4010): el evento terminó o el host la deshabilitó. */
    val roomClosed: Boolean = false,
    val reconnectAttempt: Int = 0,
)

/**
 * Cliente del chat y las reacciones del Canal Social como participante (espejo de `useSocialSocket.ts`).
 * Social-core es quien decide (modo lento, silencio, límites): el cliente solo pre-valida para mostrar la
 * regla en vez de fallar en silencio. Reconecta como el Canal Sync.
 */
class SocialClient(
    private val roomId: String,
    token: () -> String?,
    urlFor: (roomId: String, token: String) -> String,
    sockets: SyncSocketFactory,
    scope: CoroutineScope,
    private val nowMs: () -> Long,
    private val selfUserId: () -> String?,
    sleep: suspend (Long) -> Unit = { delay(it) },
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val wallClock: () -> String = { Instant.now().toString() },
    /** Hora de pared en ms, solo para la cuenta atrás de las encuestas (el cierre lo decide el servidor). */
    private val wallNowMs: () -> Long = { System.currentTimeMillis() },
) {
    private val lock = Any()
    private val _state = MutableStateFlow(SocialUiState())
    val state: StateFlow<SocialUiState> = _state

    /** `event_id` ya vistos: traga ecos y reenvíos del servidor. */
    private val seen = LinkedHashSet<String>()
    private var lastReactionAtMs: Long? = null

    /** Encuestas que el usuario descartó: el servidor reenvía la vigente al reconectar y no debe reaparecer. */
    private val dismissedPolls = LinkedHashSet<String>()

    private val connection = ResilientSocket(
        token = token,
        urlFor = { urlFor(roomId, it) },
        sockets = sockets,
        scope = scope,
        sleep = sleep,
        listener = object : ResilientSocket.Listener {
            override fun onOpen() {
                _state.update { it.copy(connected = true) }
            }

            override fun onMessage(text: String) {
                SocialProtocol.parse(text)?.let(::handle)
            }

            override fun onClosed(code: Int, reconnectAttempt: Int?) {
                _state.update {
                    it.copy(
                        connected = false,
                        revoked = it.revoked || code == SyncProtocol.CLOSE_REVOKED,
                        expired = it.expired || code == SyncProtocol.CLOSE_EXPIRED,
                        roomClosed = it.roomClosed || code == SyncProtocol.CLOSE_ROOM_CLOSED,
                        reconnectAttempt = reconnectAttempt ?: it.reconnectAttempt,
                    )
                }
            }
        },
    )

    fun start() = connection.start()

    fun stop() {
        connection.stop()
        _state.update { it.copy(connected = false) }
    }

    /** Envía un mensaje. Devuelve false (y explica por qué) si no se puede: vacío, largo, silenciado, modo lento. */
    fun send(text: String, spoiler: Boolean = false): Boolean {
        val trimmed = text.trim()
        if (trimmed.isEmpty() || trimmed.length > SocialProtocol.CHAT_MAX_LENGTH) return false
        val current = _state.value
        if (current.muted) {
            fail("MUTED")
            return false
        }
        val until = current.cooldownUntilMs
        if (until != null && nowMs() < until) {
            fail("SLOW_MODE")
            return false
        }
        if (!connection.send(SocialProtocol.chatSend(roomId, trimmed, spoiler, newId(), wallClock()))) return false
        _state.update {
            it.copy(
                error = null,
                cooldownUntilMs = if (it.slowModeS > 0) nowMs() + it.slowModeS * 1000L else null,
            )
        }
        return true
    }

    /** Envía una reacción (máximo 5 por segundo, como el servidor). `positionMs` es la del vídeo. */
    fun sendReaction(emoji: String, positionMs: Long): Boolean {
        if (!SocialProtocol.isReaction(emoji)) return false
        val now = nowMs()
        val last = synchronized(lock) { lastReactionAtMs }
        if (last != null && now - last < MIN_REACTION_GAP_MS) return false
        if (!connection.send(SocialProtocol.reactionSend(roomId, emoji, positionMs, newId(), wallClock()))) return false
        synchronized(lock) { lastReactionAtMs = now }
        return true
    }

    /**
     * Responde la pregunta abierta con el índice de la opción. Una sola vez, y solo dentro de la ventana
     * (medida con el reloj local); social-core vuelve a comprobarlo con el suyo.
     */
    fun answerTrivia(option: Int): Boolean {
        val trivia = _state.value.trivia ?: return false
        if (trivia.myOption != null || trivia.result != null) return false
        if (option !in trivia.question.options.indices) return false
        if (trivia.remainingMs(nowMs()) <= 0) {
            fail("TRIVIA_CLOSED")
            return false
        }
        if (!connection.send(SocialProtocol.triviaAnswer(roomId, trivia.question.triviaId, option, newId()))) return false
        _state.update { it.copy(error = null, trivia = it.trivia?.copy(myOption = option)) }
        return true
    }

    fun dismissTrivia() {
        _state.update { it.copy(trivia = null) }
    }

    /**
     * Vota (o cambia el voto) por el índice de la opción. El voto es del servidor: aquí se marca al instante y
     * el `poll_state` con `my_vote` lo confirma o lo corrige. No se manda si ya cerró.
     */
    fun votePoll(option: Int): Boolean {
        val poll = _state.value.poll ?: return false
        if (option !in poll.options.indices) return false
        if (poll.closed || poll.remainingMs(wallNowMs()) <= 0) {
            fail("POLL_CLOSED")
            return false
        }
        if (!connection.send(SocialProtocol.pollVote(roomId, poll.pollId, option, newId()))) return false
        _state.update { it.copy(error = null, poll = it.poll?.takeIf { p -> p.pollId == poll.pollId }?.copy(myVote = option) ?: it.poll) }
        return true
    }

    fun dismissPoll() {
        val id = _state.value.poll?.pollId
        if (id != null) synchronized(lock) {
            dismissedPolls.add(id)
            if (dismissedPolls.size > DISMISSED_CAP) dismissedPolls.remove(dismissedPolls.first())
        }
        _state.update { it.copy(poll = null) }
    }

    /** Tira los puntos del láser que ya no se ven; se llama de vez en cuando mientras hay trazo en pantalla. */
    fun pruneLaser() {
        val now = nowMs()
        _state.update { cur ->
            val kept = cur.laser.filter { LaserTrail.isVisible(it, now) }
            if (kept.size == cur.laser.size) cur else cur.copy(laser = kept)
        }
    }

    private fun handle(msg: SocialMessage) {
        when (msg) {
            is SocialMessage.History -> {
                connection.resetBackoff()
                msg.items.forEach { remember(it.eventId) }
                _state.update { it.copy(messages = msg.items.takeLast(SocialProtocol.HISTORY_LIMIT), reconnectAttempt = 0) }
            }
            is SocialMessage.Chat -> if (!remember(msg.item.eventId)) {
                _state.update { it.copy(messages = (it.messages + msg.item).takeLast(SocialProtocol.HISTORY_LIMIT)) }
            }
            is SocialMessage.Settings -> {
                connection.resetBackoff()
                val me = selfUserId()
                _state.update {
                    it.copy(
                        slowModeS = msg.slowModeS,
                        mutedUserIds = msg.mutedUserIds,
                        muted = me != null && me in msg.mutedUserIds,
                    )
                }
            }
            is SocialMessage.ReactionMsg -> if (!remember(msg.reaction.eventId)) {
                _state.update { it.copy(reactions = (it.reactions + msg.reaction).takeLast(REACTION_LIMIT)) }
            }
            is SocialMessage.TriviaQuestionMsg -> _state.update {
                // La misma pregunta reenviada al reconectar no reinicia mi respuesta ni la cuenta regresiva.
                if (it.trivia?.question?.triviaId == msg.question.triviaId) it
                else it.copy(trivia = TriviaState(msg.question, nowMs()))
            }
            is SocialMessage.TriviaAckMsg -> _state.update {
                val t = it.trivia
                if (t == null || t.question.triviaId != msg.ack.triviaId) it
                else it.copy(trivia = t.copy(ack = msg.ack, myOption = msg.ack.option))
            }
            is SocialMessage.TriviaResultMsg -> _state.update {
                val t = it.trivia
                if (t == null || t.question.triviaId != msg.result.triviaId) it
                else it.copy(trivia = t.copy(result = msg.result))
            }
            is SocialMessage.PollStateMsg -> {
                val dismissed = synchronized(lock) { msg.poll.pollId in dismissedPolls }
                if (!dismissed) _state.update {
                    // Los broadcasts no traen `my_vote`: se conserva el último que conocí de esa misma encuesta.
                    val kept = it.poll?.takeIf { p -> p.pollId == msg.poll.pollId }?.myVote
                    it.copy(poll = msg.poll.copy(myVote = msg.poll.myVote ?: kept))
                }
            }
            is SocialMessage.LaserMsg -> if (!remember(msg.point.eventId)) {
                val arrival = LaserArrival(msg.point, nowMs())
                _state.update { it.copy(laser = (it.laser + arrival).takeLast(LASER_LIMIT)) }
            }
            is SocialMessage.Error -> {
                if (msg.code == "SLOW_MODE" && msg.retryAfterMs != null) {
                    _state.update { it.copy(cooldownUntilMs = nowMs() + msg.retryAfterMs) }
                }
                fail(msg.code)
            }
        }
    }

    private fun fail(code: String) {
        _state.update { it.copy(error = SocialProtocol.errorMessage(code), errorSeq = it.errorSeq + 1) }
    }

    /** true si el `event_id` ya se había visto. */
    private fun remember(id: String): Boolean = synchronized(lock) {
        if (!seen.add(id)) return true
        if (seen.size > SEEN_CAP) seen.remove(seen.first())
        false
    }

    private companion object {
        const val REACTION_LIMIT = 20
        const val LASER_LIMIT = 120
        const val DISMISSED_CAP = 50
        const val MIN_REACTION_GAP_MS = 200L
        const val SEEN_CAP = 2000
    }
}
