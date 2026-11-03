package com.tint.app.ui

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import com.tint.app.sync.NetworkHints
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tint.app.sync.PlaybackQuality
import com.tint.app.sync.QualityPolicy
import com.tint.app.sync.QualityPref

/**
 * Menú de calidad personal (AND-17): Auto y las versiones que publicó el servidor, con una estimación de datos por
 * hora de cada una y, arriba, cuál se está reproduciendo. Solo cambia este aparato; no se manda a nadie.
 */
@Composable
fun QualityMenu(
    qualities: List<PlaybackQuality>,
    current: PlaybackQuality?,
    auto: PlaybackQuality?,
    pref: QualityPref,
    metered: Boolean,
    onSelect: (QualityPref) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (qualities.size < 2) return
    var open by remember { mutableStateOf(false) }
    val label = if (pref == QualityPref.AUTO) "Auto" else current?.label ?: pref.label
    TextButton(onClick = { open = true }, modifier = modifier.semantics { contentDescription = "Calidad del video: $label" }) {
        Text(label, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
            Text("Calidad actual: ${current?.label ?: "—"}${if (pref == QualityPref.AUTO) " (auto)" else ""}", fontWeight = FontWeight.Bold, fontSize = 14.sp)
            if (metered) Text("Estás con datos móviles", color = TintWarn, fontSize = 12.sp)
        }
        val options = listOf(QualityPref.AUTO) + QualityPref.entries.filter { p -> p != QualityPref.AUTO && qualities.any { it.id == p.wire } }
        options.forEach { option ->
            DropdownMenuItem(
                text = {
                    Column {
                        Text((if (option == pref) "✓ " else "") + option.label, fontWeight = if (option == pref) FontWeight.Bold else FontWeight.Normal)
                        QualityPolicy.dataPerHour(if (option == QualityPref.AUTO) auto?.id.orEmpty() else option.wire)
                            ?.let { Text(it, fontSize = 12.sp, color = TintMuted) }
                    }
                },
                onClick = {
                    open = false
                    onSelect(option)
                },
            )
        }
    }
}

/**
 * Mantiene al día lo que `auto` mira: si la red es de datos móviles o con ahorro de datos y el ancho de la pantalla.
 * Capa fina sobre `ConnectivityManager`; la decisión vive en `QualityPolicy`.
 */
@Composable
fun NetworkHintsEffect(widthDp: Int, onHints: (NetworkHints) -> Unit) {
    val context = LocalContext.current
    val report by rememberUpdatedState(onHints)
    val width by rememberUpdatedState(widthDp)
    DisposableEffect(context) {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        fun read() = NetworkHints(
            metered = cm.isActiveNetworkMetered,
            dataSaver = cm.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED,
            widthDp = width,
        )
        report(read())
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, capabilities: android.net.NetworkCapabilities) = report(read())

            override fun onLost(network: Network) = report(read())
        }
        cm.registerDefaultNetworkCallback(callback)
        onDispose { cm.unregisterNetworkCallback(callback) }
    }
    // Girar la pantalla cambia el ancho sin cambiar la red.
    androidx.compose.runtime.LaunchedEffect(widthDp) {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        onHints(NetworkHints(cm.isActiveNetworkMetered, cm.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED, widthDp))
    }
}
