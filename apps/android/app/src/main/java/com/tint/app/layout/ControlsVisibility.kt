package com.tint.app.layout

/**
 * Cuándo se ven los controles que van sobre el video en pantalla completa: aparecen al tocar y se ocultan solos tras
 * [hideAfterMs] sin actividad. Mientras se escribe un mensaje se quedan fijos. No usa relojes propios: recibe la hora.
 */
class ControlsVisibility(private val hideAfterMs: Long = 3_000) {
    private var shown = false
    private var held = false
    private var lastActivityMs = 0L

    fun visible(nowMs: Long): Boolean = shown && (held || nowMs - lastActivityMs < hideAfterMs)

    /** Cuánto falta para ocultarlos (0 si ya están ocultos). */
    fun remainingMs(nowMs: Long): Long =
        if (!visible(nowMs)) 0L else if (held) Long.MAX_VALUE else hideAfterMs - (nowMs - lastActivityMs)

    fun show(nowMs: Long) {
        shown = true
        lastActivityMs = nowMs
    }

    /** Un toque sobre el video: oculta si estaban a la vista, muestra si no (y mientras se escribe, nunca oculta). */
    fun tap(nowMs: Long) {
        if (held) {
            activity(nowMs)
        } else if (visible(nowMs)) {
            shown = false
        } else {
            show(nowMs)
        }
    }

    /** Se usó un control: se reinicia la cuenta. */
    fun activity(nowMs: Long) = show(nowMs)

    fun hold(on: Boolean, nowMs: Long) {
        held = on
        if (!on) lastActivityMs = nowMs
    }
}
