package com.tint.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import com.tint.app.auth.AuthRepository
import com.tint.app.auth.CredentialManagerGoogleSource
import com.tint.app.auth.LoginController
import com.tint.app.auth.LoginState
import com.tint.app.join.InviteCode
import com.tint.app.join.JoinController
import com.tint.app.join.JoinState
import com.tint.app.ui.HomeScreen
import com.tint.app.ui.JoinScreen
import com.tint.app.ui.LoginScreen
import com.tint.app.join.RoomKind
import com.tint.app.ui.LiveRoomScreen
import com.tint.app.ui.RoomScreen
import com.tint.app.ui.TintAccent
import com.tint.app.ui.TintBackground

class MainActivity : ComponentActivity() {
    /** Código de un link de invitación que abrió la app; prellena el formulario de unirse. */
    private var pendingCode by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingCode = InviteCode.fromDeepLink(intent?.dataString)
        val container = AppContainer(applicationContext)
        val auth = AuthRepository(
            api = container.api,
            tokens = container.tokens,
            google = CredentialManagerGoogleSource(this, getString(R.string.default_web_client_id)),
            firebase = container.firebase,
        )
        val login = LoginController(auth, lifecycleScope)
        val join = JoinController(container.invites, lifecycleScope)
        container.onHostSessionExpired = login::onSessionExpired

        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = TintAccent, onPrimary = TintBackground, background = TintBackground)) {
                val loginState by login.state.collectAsState()
                val joinState by join.state.collectAsState()
                val invitePreview by join.preview.collectAsState()
                var showJoin by remember { mutableStateOf(false) }
                var recents by remember { mutableStateOf(container.recentRooms.list()) }
                (joinState as? JoinState.Joined)?.let { joined ->
                    LaunchedEffect(joined.room.inviteCode) {
                        container.recentRooms.remember(joined.room, System.currentTimeMillis())
                        recents = container.recentRooms.list()
                    }
                }
                when {
                    joinState is JoinState.Joined -> {
                        val room = (joinState as JoinState.Joined).room
                        // Una sala `live` abre al espectador de la transmisión; `watch`, el reproductor sincronizado.
                        if (room.kind == RoomKind.LIVE) {
                            LiveRoomScreen(room = room, container = container, onLeave = join::leave)
                        } else {
                            RoomScreen(room = room, container = container, onLeave = join::leave)
                        }
                    }
                    showJoin || pendingCode != null -> JoinScreen(
                        state = joinState,
                        preview = invitePreview,
                        onLookup = join::lookup,
                        recents = recents,
                        onForget = { code ->
                            container.recentRooms.forget(code)
                            recents = container.recentRooms.list()
                        },
                        initialCode = pendingCode,
                        onSubmit = join::submit,
                        onBack = {
                            showJoin = false
                            pendingCode = null
                            join.leave()
                        },
                    )
                    loginState == LoginState.SignedIn -> HomeScreen(onJoin = { showJoin = true }, onSignOut = login::signOut)
                    else -> LoginScreen(state = loginState, onSignIn = login::signIn, onJoin = { showJoin = true })
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        InviteCode.fromDeepLink(intent.dataString)?.let { pendingCode = it }
    }
}
