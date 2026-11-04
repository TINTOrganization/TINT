package com.tint.app.join

import java.time.Instant
import java.time.format.DateTimeParseException

/** Cuánto le queda a una invitación, en palabras, para la vista previa (AND-14). */
object InviteExpiry {
    private const val MINUTE = 60_000L
    private const val HOUR = 60 * MINUTE
    private const val DAY = 24 * HOUR

    /** `null` si la fecha no se puede leer: la vista previa simplemente no dice nada del vencimiento. */
    fun text(expiresAtIso: String, nowMs: Long): String? {
        val at = try {
            Instant.parse(expiresAtIso).toEpochMilli()
        } catch (_: DateTimeParseException) {
            return null
        }
        val left = at - nowMs
        return when {
            left <= 0 -> "Esta invitación ya venció"
            left >= DAY -> "Vence en ${plural(left / DAY, "día", "días")}"
            left >= HOUR -> "Vence en ${plural(left / HOUR, "hora", "horas")}"
            left >= MINUTE -> "Vence en ${plural(left / MINUTE, "minuto", "minutos")}"
            else -> "Vence en menos de un minuto"
        }
    }

    private fun plural(n: Long, one: String, many: String) = "$n ${if (n == 1L) one else many}"
}
