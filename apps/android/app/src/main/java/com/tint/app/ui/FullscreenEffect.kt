package com.tint.app.ui

import android.content.pm.ActivityInfo
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Pantalla completa del video: se gira a horizontal, se esconden las barras del sistema (reaparecen al deslizar desde el
 * borde) y «atrás» sale de la pantalla completa en vez de salir de la sala. Al terminar todo vuelve a como estaba.
 */
@Composable
fun FullscreenEffect(enabled: Boolean, onExit: () -> Unit) {
    val activity = LocalContext.current as ComponentActivity
    val view = LocalView.current
    BackHandler(enabled = enabled, onBack = onExit)
    DisposableEffect(enabled) {
        val controller = WindowCompat.getInsetsController(activity.window, view)
        if (enabled) {
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller.hide(WindowInsetsCompat.Type.systemBars())
        }
        onDispose {
            if (enabled) {
                activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                controller.show(WindowInsetsCompat.Type.systemBars())
            }
        }
    }
}
