package com.tint.app.join

import java.net.URLEncoder

/** El link que se comparte para invitar a la sala (AND-22), con el mismo formato que abre la propia app. */
object InviteLink {
    fun build(host: String, code: String): String {
        val safeCode = URLEncoder.encode(code.trim(), "UTF-8").replace("+", "%20")
        val cleanHost = host.trim().removePrefix("https://").removePrefix("http://").trimEnd('/')
        return if (cleanHost.isEmpty()) "tint://invite/$safeCode" else "https://$cleanHost/invite/$safeCode"
    }

    fun shareText(title: String?, link: String): String =
        if (title.isNullOrBlank()) "Te invito a ver algo juntos en TINT: $link" else "Te invito a «$title» en TINT: $link"
}
