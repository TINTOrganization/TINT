package com.tint.app.join

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class JoinControllerTest {
    private class FakeInvites : RoomInvites {
        var result: ClaimResult = ClaimResult.Joined(JoinedRoom("r1", "Peli", "Ana"))
        var gate: CompletableDeferred<Unit>? = null
        val claims = mutableListOf<Pair<String, String>>()

        var preview: InvitePreview = InvitePreview.Ready("Peli", "2026-11-10T12:00:00.000Z")
        var previewGate: CompletableDeferred<Unit>? = null
        val previews = mutableListOf<String>()

        override suspend fun preview(code: String): InvitePreview {
            previews += code
            val answer = preview
            previewGate?.await()
            return answer
        }

        override suspend fun claim(code: String, nick: String): ClaimResult {
            claims += code to nick
            gate?.await()
            return result
        }
    }

    private fun controller(invites: FakeInvites) = JoinController(invites, CoroutineScope(Dispatchers.Unconfined))

    @Test
    fun `empieza sin hacer nada`() {
        assertEquals(JoinState.Idle, controller(FakeInvites()).state.value)
    }

    @Test
    fun `entra a la sala con un codigo valido`() {
        val invites = FakeInvites()
        val c = controller(invites)

        c.submit("https://tint.jaucor.online/invite/wVRbfj_3dEnd", "  Ana ")

        assertEquals(JoinState.Joined(JoinedRoom("r1", "Peli", "Ana")), c.state.value)
        assertEquals(listOf("wVRbfj_3dEnd" to "Ana"), invites.claims)
    }

    @Test
    fun `pasa por uniendose`() = runBlocking {
        val invites = FakeInvites().apply { gate = CompletableDeferred() }
        val c = controller(invites)

        c.submit("abcdef12", "Ana")
        assertEquals(JoinState.Joining, c.state.value)

        invites.gate!!.complete(Unit)
        assertEquals(JoinState.Joined(JoinedRoom("r1", "Peli", "Ana")), c.state.value)
    }

    @Test
    fun `un codigo que no parece valido no llama al servidor`() {
        val invites = FakeInvites()
        val c = controller(invites)

        c.submit("hola mundo", "Ana")

        assertEquals(
            JoinState.Error("Ese link no parece válido. Revisa que incluya /invite/ o el código."),
            c.state.value,
        )
        assertEquals(0, invites.claims.size)
    }

    @Test
    fun `el nick debe tener entre 2 y 24 caracteres`() {
        val invites = FakeInvites()
        val c = controller(invites)

        c.submit("abcdef12", " A ")
        assertEquals(JoinState.Error("El nick debe tener entre 2 y 24 caracteres."), c.state.value)

        c.submit("abcdef12", "x".repeat(25))
        assertEquals(JoinState.Error("El nick debe tener entre 2 y 24 caracteres."), c.state.value)
        assertEquals(0, invites.claims.size)
    }

    @Test
    fun `un codigo rechazado muestra el error y se puede reintentar`() {
        val invites = FakeInvites().apply {
            result = ClaimResult.Failure("Esta invitación fue revocada por el host.")
        }
        val c = controller(invites)

        c.submit("abcdef12", "Ana")
        assertEquals(JoinState.Error("Esta invitación fue revocada por el host."), c.state.value)

        invites.result = ClaimResult.Joined(JoinedRoom("r2", "Otra", "Ana"))
        c.submit("zzzzzz99", "Ana")
        assertEquals(JoinState.Joined(JoinedRoom("r2", "Otra", "Ana")), c.state.value)
    }

    @Test
    fun `ignora un segundo envio mientras se une`() = runBlocking {
        val invites = FakeInvites().apply { gate = CompletableDeferred() }
        val c = controller(invites)

        c.submit("abcdef12", "Ana")
        c.submit("abcdef12", "Ana")
        invites.gate!!.complete(Unit)

        assertEquals(1, invites.claims.size)
    }

    @Test
    fun `salir de la sala vuelve al inicio`() {
        val c = controller(FakeInvites())
        c.submit("abcdef12", "Ana")

        c.leave()

        assertEquals(JoinState.Idle, c.state.value)
    }

    @Test
    fun `la vista previa empieza vacia y no consulta con un texto que no es codigo`() {
        val invites = FakeInvites()
        val c = controller(invites)
        assertEquals(InvitePreview.Idle, c.preview.value)

        c.lookup("hola mundo")

        assertEquals(InvitePreview.Idle, c.preview.value)
        assertEquals(emptyList<String>(), invites.previews)
    }

    @Test
    fun `consulta la invitacion al pegar el link y muestra la sala`() = runBlocking {
        val invites = FakeInvites().apply { previewGate = CompletableDeferred() }
        val c = controller(invites)

        c.lookup("https://tint.jaucor.online/invite/wVRbfj_3dEnd")
        assertEquals(InvitePreview.Loading, c.preview.value)

        invites.previewGate!!.complete(Unit)
        assertEquals(InvitePreview.Ready("Peli", "2026-11-10T12:00:00.000Z"), c.preview.value)
        assertEquals(listOf("wVRbfj_3dEnd"), invites.previews)
    }

    @Test
    fun `no repite la consulta del mismo codigo y borrar el texto limpia la vista previa`() {
        val invites = FakeInvites()
        val c = controller(invites)

        c.lookup("abcdef12")
        c.lookup("  abcdef12 ")
        assertEquals(1, invites.previews.size)

        c.lookup("")
        assertEquals(InvitePreview.Idle, c.preview.value)
    }

    @Test
    fun `una invitacion inutil se muestra como no disponible`() {
        val invites = FakeInvites().apply { preview = InvitePreview.Unavailable("Esta invitación fue revocada por el host.") }
        val c = controller(invites)

        c.lookup("abcdef12")

        assertEquals(InvitePreview.Unavailable("Esta invitación fue revocada por el host."), c.preview.value)
    }

    @Test
    fun `la respuesta de un codigo viejo no pisa al nuevo`() = runBlocking {
        val oldGate = CompletableDeferred<Unit>()
        val invites = FakeInvites().apply { previewGate = oldGate; preview = InvitePreview.Ready("Vieja", "x") }
        val c = controller(invites)
        c.lookup("viejo1234")
        invites.preview = InvitePreview.Ready("Nueva", "y")
        invites.previewGate = null
        c.lookup("nuevo1234")

        oldGate.complete(Unit)

        assertEquals(InvitePreview.Ready("Nueva", "y"), c.preview.value)
    }
}
