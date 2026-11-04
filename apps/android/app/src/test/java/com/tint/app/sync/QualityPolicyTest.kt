package com.tint.app.sync

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class QualityPolicyTest {
    private val source = PlaybackQuality("source", "Original", "https://v/source")
    private val q720 = PlaybackQuality("720p", "720p", "https://v/720")
    private val q360 = PlaybackQuality("360p", "360p", "https://v/360")
    private val all = listOf(source, q720, q360)
    private val wifi = NetworkHints(metered = false, dataSaver = false, widthDp = 1000)

    @Test
    fun `auto elige 360p con datos moviles o ahorro de datos`() {
        assertEquals(q360, QualityPolicy.resolve(QualityPref.AUTO, all, wifi.copy(metered = true)))
        assertEquals(q360, QualityPolicy.resolve(QualityPref.AUTO, all, wifi.copy(dataSaver = true)))
    }

    @Test
    fun `auto elige 720p en pantallas estrechas y en wifi`() {
        assertEquals(q720, QualityPolicy.resolve(QualityPref.AUTO, all, wifi.copy(widthDp = 411)))
        assertEquals(q720, QualityPolicy.resolve(QualityPref.AUTO, all, wifi))
    }

    @Test
    fun `una calidad elegida se respeta aunque haya datos moviles`() {
        assertEquals(source, QualityPolicy.resolve(QualityPref.SOURCE, all, wifi.copy(metered = true)))
        assertEquals(q360, QualityPolicy.resolve(QualityPref.Q360, all, wifi))
    }

    @Test
    fun `si la pedida no existe cae al original`() {
        assertEquals(source, QualityPolicy.resolve(QualityPref.Q720, listOf(source), wifi))
        assertEquals(source, QualityPolicy.resolve(QualityPref.AUTO, listOf(source), wifi.copy(metered = true)))
    }

    @Test
    fun `sin original usa la primera disponible y sin nada no hay calidad`() {
        assertEquals(q360, QualityPolicy.resolve(QualityPref.AUTO, listOf(q360), wifi))
        assertNull(QualityPolicy.resolve(QualityPref.AUTO, emptyList(), wifi))
    }

    @Test
    fun `estima los datos por hora con el tope del transcodificador`() {
        assertEquals("hasta ≈ 0,5 GB por hora", QualityPolicy.dataPerHour("360p"))
        assertEquals("hasta ≈ 1,4 GB por hora", QualityPolicy.dataPerHour("720p"))
        assertEquals("hasta ≈ 3,7 GB por hora", QualityPolicy.dataPerHour("source"))
        assertNull(QualityPolicy.dataPerHour("raro"))
    }

    @Test
    fun `las preferencias se leen de lo guardado y lo desconocido es auto`() {
        assertEquals(QualityPref.Q720, QualityPref.fromWire("720p"))
        assertEquals(QualityPref.AUTO, QualityPref.fromWire("loquesea"))
        assertEquals(QualityPref.AUTO, QualityPref.fromWire(null))
    }
}
