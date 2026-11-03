package com.tint.app.voice

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceProtocolTest {
    private val peer = """{"peer_id":"p1","user_id":"u1","nick":"Ana","role":"host","muted":true,"host_muted":false}"""

    private fun state(extra: String = "") = """{"type":"voice_state","room_id":"r1","self":$peer,
        "peers":[{"peer_id":"p2","user_id":"u2","nick":"Beto","role":"participant","muted":false,"host_muted":true}],
        "ice_servers":[{"urls":"stun:s:3478"},{"urls":["turn:t:3478?transport=udp"],"username":"u","credential":"c"}],
        "max_members":8$extra}"""

    // ---- Servidor → cliente ----

    @Test
    fun `voice_state trae quien soy, los demas, los servidores ICE y el cupo`() {
        val msg = VoiceProtocol.parse(state()) as VoiceMessage.VoiceState

        assertEquals("r1", msg.roomId)
        assertEquals(VoicePeer("p1", "u1", "Ana", "host", muted = true, hostMuted = false), msg.self)
        assertEquals(VoicePeer("p2", "u2", "Beto", "participant", muted = false, hostMuted = true), msg.peers.single())
        assertEquals(listOf("stun:s:3478"), msg.iceServers[0].urls)
        assertEquals("u", msg.iceServers[1].username)
        assertEquals("c", msg.iceServers[1].credential)
        assertEquals(8, msg.maxMembers)
    }

    @Test
    fun `los campos opcionales de un par tienen valores por defecto`() {
        val raw = """{"type":"peer_joined","peer":{"peer_id":"p9","user_id":"u9"}}"""

        val peer = (VoiceProtocol.parse(raw) as VoiceMessage.PeerJoined).peer

        assertEquals(VoicePeer("p9", "u9", "", "participant", muted = false, hostMuted = false), peer)
    }

    @Test
    fun `un voice_state sin self valido se descarta y los pares o servidores malos se omiten`() {
        assertNull(VoiceProtocol.parse("""{"type":"voice_state","room_id":"r","self":{"peer_id":""},"peers":[]}"""))
        val raw = """{"type":"voice_state","room_id":"r1","self":$peer,"peers":[1,{"peer_id":"x"}],
            "ice_servers":[{"urls":5},{"urls":[]},{"urls":"stun:ok"}]}"""

        val msg = VoiceProtocol.parse(raw) as VoiceMessage.VoiceState

        assertTrue(msg.peers.isEmpty())
        assertEquals(listOf("stun:ok"), msg.iceServers.single().urls)
        assertEquals(0, msg.maxMembers)
    }

    @Test
    fun `peer_left y peer_muted`() {
        assertEquals(VoiceMessage.PeerLeft("p2"), VoiceProtocol.parse("""{"type":"peer_left","peer_id":"p2"}"""))
        assertEquals(
            VoiceMessage.PeerMuted("p2", "u2", muted = true, hostMuted = true),
            VoiceProtocol.parse("""{"type":"peer_muted","peer_id":"p2","user_id":"u2","muted":true,"host_muted":true}"""),
        )
        assertNull(VoiceProtocol.parse("""{"type":"peer_left"}"""))
        assertNull(VoiceProtocol.parse("""{"type":"peer_muted","peer_id":"p2","muted":"si","host_muted":true}"""))
    }

    @Test
    fun `una oferta o respuesta llega como description`() {
        val raw = """{"type":"signal","from":"p2","data":{"description":{"type":"offer","sdp":"v=0 oferta"}}}"""

        val msg = VoiceProtocol.parse(raw) as VoiceMessage.Signal

        assertEquals("p2", msg.from)
        assertEquals(SignalData.Description("offer", "v=0 oferta"), msg.data)
    }

    @Test
    fun `un candidato ICE llega con su identificacion y el null marca el fin`() {
        val cand = """{"type":"signal","from":"p2","data":{"candidate":{"candidate":"candidate:1 1 UDP 1 1.2.3.4 5 typ host","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":"uf"}}}"""
        val end = """{"type":"signal","from":"p2","data":{"candidate":null}}"""

        assertEquals(
            SignalData.Candidate(IceCandidateInit("candidate:1 1 UDP 1 1.2.3.4 5 typ host", "0", 0, "uf")),
            (VoiceProtocol.parse(cand) as VoiceMessage.Signal).data,
        )
        assertEquals(SignalData.Candidate(null), (VoiceProtocol.parse(end) as VoiceMessage.Signal).data)
    }

    @Test
    fun `una senal que no se entiende se descarta`() {
        assertNull(VoiceProtocol.parse("""{"type":"signal","data":{"description":{"type":"offer","sdp":"x"}}}"""))
        assertNull(VoiceProtocol.parse("""{"type":"signal","from":"p2","data":{}}"""))
        assertNull(VoiceProtocol.parse("""{"type":"signal","from":"p2","data":{"description":{"type":"offer"}}}"""))
        assertNull(VoiceProtocol.parse("""{"type":"signal","from":"p2","data":{"candidate":{"sdpMid":"0"}}}"""))
        assertNull(VoiceProtocol.parse("""{"type":"signal","from":"p2","data":"x"}"""))
    }

    @Test
    fun `errores y mensajes desconocidos`() {
        assertEquals(VoiceMessage.Error("HOST_MUTED"), VoiceProtocol.parse("""{"type":"error","code":"HOST_MUTED","event_id_ref":"e"}"""))
        assertNull(VoiceProtocol.parse("""{"type":"error"}"""))
        assertNull(VoiceProtocol.parse("""{"type":"otra"}"""))
        assertNull(VoiceProtocol.parse("no es json"))
        assertNull(VoiceProtocol.parse("[1]"))
    }

    // ---- Cliente → servidor ----

    private fun obj(json: String) = Json.parseToJsonElement(json).jsonObject

    @Test
    fun `toda orden lleva tipo, event_id y la hora del emisor`() {
        val o = obj(VoiceProtocol.selfMute(true, "id-1", 1_793_719_500_000L))

        assertEquals("self_mute", o["type"]!!.jsonPrimitive.content)
        assertEquals("id-1", o["event_id"]!!.jsonPrimitive.content)
        assertEquals("1793719500000", o["occurred_at"]!!.jsonPrimitive.content)
        assertEquals("true", o["muted"]!!.jsonPrimitive.content)
        assertEquals("leave", obj(VoiceProtocol.leave("id-2", 1L))["type"]!!.jsonPrimitive.content)
    }

    @Test
    fun `una descripcion se manda como la manda la web`() {
        val o = obj(VoiceProtocol.signal("p2", SignalData.Description("answer", "v=0 respuesta"), "id", 1L))

        assertEquals("signal", o["type"]!!.jsonPrimitive.content)
        assertEquals("p2", o["to"]!!.jsonPrimitive.content)
        val description = o["data"]!!.jsonObject["description"]!!.jsonObject
        assertEquals("answer", description["type"]!!.jsonPrimitive.content)
        assertEquals("v=0 respuesta", description["sdp"]!!.jsonPrimitive.content)
    }

    @Test
    fun `un candidato se manda con sdpMid y sdpMLineIndex y el fin como null`() {
        val cand = obj(VoiceProtocol.signal("p2", SignalData.Candidate(IceCandidateInit("candidate:1", "0", 0, null)), "id", 1L))
        val c = cand["data"]!!.jsonObject["candidate"]!!.jsonObject
        assertEquals("candidate:1", c["candidate"]!!.jsonPrimitive.content)
        assertEquals("0", c["sdpMid"]!!.jsonPrimitive.content)
        assertEquals("0", c["sdpMLineIndex"]!!.jsonPrimitive.content)
        assertFalse(c.containsKey("usernameFragment"))

        val end = obj(VoiceProtocol.signal("p2", SignalData.Candidate(null), "id", 1L))
        assertEquals(JsonNull, end["data"]!!.jsonObject["candidate"])
    }

    // ---- Mensajes para la persona ----

    @Test
    fun `los errores de la voz se explican en palabras simples`() {
        assertEquals("El host te silenció. Podrás hablar cuando te lo permita.", VoiceProtocol.errorMessage("HOST_MUTED"))
        assertTrue(VoiceProtocol.errorMessage("VOICE_FULL").contains("llena"))
        assertTrue(VoiceProtocol.errorMessage("NOT_ON_STAGE").contains("escenario"))
        assertEquals("Algo salió mal con la voz. Inténtalo de nuevo.", VoiceProtocol.errorMessage("RARO"))
    }

    @Test
    fun `los cierres sin reintento tienen aviso y los demas reconectan`() {
        assertEquals("Ya no tienes acceso a esta sala.", VoiceProtocol.closeNotice(4001))
        assertEquals("Tu invitación caducó. Pide al host un link nuevo.", VoiceProtocol.closeNotice(4003))
        assertEquals(VoiceProtocol.errorMessage("VOICE_FULL"), VoiceProtocol.closeNotice(4008))
        assertEquals(VoiceProtocol.errorMessage("NOT_ON_STAGE"), VoiceProtocol.closeNotice(4009))
        assertEquals("El evento terminó.", VoiceProtocol.closeNotice(4010))
        assertNull(VoiceProtocol.closeNotice(1006))
        assertNull(VoiceProtocol.closeNotice(1000))
    }

    @Test
    fun `los cierres terminales propios de la voz`() {
        assertEquals(setOf(4008, 4009), VoiceProtocol.EXTRA_TERMINAL_CODES)
    }
}
