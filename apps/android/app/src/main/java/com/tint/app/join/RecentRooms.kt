package com.tint.app.join

import com.tint.app.net.ApiJson
import com.tint.app.store.KeyValueStore
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

/** Una sala a la que ya entré: con el código se puede volver (AND-15). */
@Serializable
data class RecentRoom(val code: String, val title: String, val kind: RoomKind, val lastJoinedMs: Long)

/**
 * Las últimas salas a las que entró este aparato, solo en el aparato (sin PII ni servidor). Si una invitación ya
 * no sirve, la vista previa de la pantalla de entrada lo dice al tocarla.
 */
class RecentRooms(private val store: KeyValueStore) {
    fun list(): List<RecentRoom> {
        val raw = store.get(KEY) ?: return emptyList()
        return try {
            ApiJson.decodeFromString(ListSerializer(RecentRoom.serializer()), raw)
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun remember(room: JoinedRoom, nowMs: Long) {
        val code = room.inviteCode ?: return
        val entry = RecentRoom(code, room.title?.takeIf { it.isNotBlank() } ?: "Sala", room.kind, nowMs)
        save((listOf(entry) + list().filterNot { it.code == code }).take(MAX))
    }

    fun forget(code: String) = save(list().filterNot { it.code == code })

    private fun save(rooms: List<RecentRoom>) =
        store.put(KEY, ApiJson.encodeToString(ListSerializer(RecentRoom.serializer()), rooms))

    private companion object {
        const val KEY = "recent_rooms"
        const val MAX = 5
    }
}
