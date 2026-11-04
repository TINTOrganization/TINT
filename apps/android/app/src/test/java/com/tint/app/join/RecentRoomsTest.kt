package com.tint.app.join

import com.tint.app.store.MemoryStore
import org.junit.Assert.assertEquals
import org.junit.Test

class RecentRoomsTest {
    private val store = MemoryStore()
    private fun recents() = RecentRooms(store)

    @Test
    fun `empieza vacia`() {
        assertEquals(emptyList<RecentRoom>(), recents().list())
    }

    @Test
    fun `recuerda la sala a la que entre, la mas reciente primero`() {
        val r = recents()
        r.remember(JoinedRoom("r1", "Peli", "Ana", RoomKind.WATCH, "codigo001"), nowMs = 100)
        r.remember(JoinedRoom("r2", "Directo", "Ana", RoomKind.LIVE, "codigo002"), nowMs = 200)

        assertEquals(
            listOf(RecentRoom("codigo002", "Directo", RoomKind.LIVE, 200), RecentRoom("codigo001", "Peli", RoomKind.WATCH, 100)),
            r.list(),
        )
    }

    @Test
    fun `volver a entrar con el mismo codigo no duplica, la sube`() {
        val r = recents()
        r.remember(JoinedRoom("r1", "Peli", "Ana", RoomKind.WATCH, "codigo001"), 100)
        r.remember(JoinedRoom("r2", "Otra", "Ana", RoomKind.WATCH, "codigo002"), 200)
        r.remember(JoinedRoom("r1", "Peli", "Ana", RoomKind.WATCH, "codigo001"), 300)

        assertEquals(listOf("codigo001", "codigo002"), r.list().map { it.code })
        assertEquals(300L, r.list().first().lastJoinedMs)
    }

    @Test
    fun `guarda solo las cinco ultimas`() {
        val r = recents()
        (1..7).forEach { r.remember(JoinedRoom("r$it", "S$it", "Ana", RoomKind.WATCH, "codigo00$it"), it.toLong()) }

        assertEquals(listOf("codigo007", "codigo006", "codigo005", "codigo004", "codigo003"), r.list().map { it.code })
    }

    @Test
    fun `sin codigo no hay forma de volver, asi que no se guarda`() {
        val r = recents()
        r.remember(JoinedRoom("r1", "Peli", "Ana", RoomKind.WATCH, null), 1)
        assertEquals(emptyList<RecentRoom>(), r.list())
    }

    @Test
    fun `sin titulo usa un nombre generico`() {
        val r = recents()
        r.remember(JoinedRoom("r1", null, "Ana", RoomKind.WATCH, "codigo001"), 1)
        assertEquals("Sala", r.list().single().title)
    }

    @Test
    fun `olvidar quita una sala y persiste entre instancias`() {
        recents().apply {
            remember(JoinedRoom("r1", "Peli", "Ana", RoomKind.WATCH, "codigo001"), 1)
            remember(JoinedRoom("r2", "Otra", "Ana", RoomKind.WATCH, "codigo002"), 2)
        }
        recents().forget("codigo002")

        assertEquals(listOf("codigo001"), recents().list().map { it.code })
    }

    @Test
    fun `un guardado dañado se ignora`() {
        store.put("recent_rooms", "esto no es json")
        assertEquals(emptyList<RecentRoom>(), recents().list())
    }
}
