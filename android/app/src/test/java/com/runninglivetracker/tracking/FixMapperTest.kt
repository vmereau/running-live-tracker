package com.runninglivetracker.tracking

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FixMapperTest {

    private fun map(
        time: Long = 1_760_000_000_000,
        lat: Double = 48.8566,
        lon: Double = 2.3522,
        hasAccuracy: Boolean = true,
        accuracy: Float = 5f,
        hasAltitude: Boolean = false,
        altitude: Double = 0.0,
        hasSpeed: Boolean = false,
        speed: Float = 0f,
    ) = FixMapper.map(time, lat, lon, hasAccuracy, accuracy, hasAltitude, altitude, hasSpeed, speed)

    @Test
    fun validFixWithoutOptionalsOmitsThem() {
        assertEquals(ValidFix(1_760_000_000_000, 48.8566, 2.3522, 5.0, null, null), map())
    }

    @Test
    fun altitudeAndSpeedAreKeptOnlyWhenPresent() {
        val fix = map(hasAltitude = true, altitude = 35.5, hasSpeed = true, speed = 3.25f)!!
        assertEquals(35.5, fix.altitudeM!!, 0.0)
        assertEquals(3.25, fix.speedMps!!, 0.0)
        // Values without has*() flags are ignored, even if non-zero.
        val bare = map(hasAltitude = false, altitude = 35.5, hasSpeed = false, speed = 3.25f)!!
        assertNull(bare.altitudeM)
        assertNull(bare.speedMps)
    }

    @Test
    fun recordedAtIsLocationTime() {
        assertEquals(42L, map(time = 42)!!.recordedAt)
    }

    @Test
    fun noAccuracyIsDropped() = assertNull(map(hasAccuracy = false))

    @Test
    fun nonPositiveOrNonFiniteAccuracyIsDropped() {
        assertNull(map(accuracy = 0f))
        assertNull(map(accuracy = Float.NaN))
        assertNull(map(accuracy = Float.POSITIVE_INFINITY))
    }

    @Test
    fun nanCoordinatesAreDropped() {
        assertNull(map(lat = Double.NaN))
        assertNull(map(lon = Double.NaN))
    }

    @Test
    fun outOfRangeCoordinatesAreDropped() {
        assertNull(map(lat = 91.0))
        assertNull(map(lat = -90.5))
        assertNull(map(lon = 180.1))
        assertNull(map(lon = Double.NEGATIVE_INFINITY))
    }

    @Test
    fun badOptionalValuesDropTheFix() {
        assertNull(map(hasAltitude = true, altitude = Double.NaN))
        assertNull(map(hasSpeed = true, speed = -1f))
        assertNull(map(hasSpeed = true, speed = Float.NaN))
    }

    @Test
    fun negativeTimeIsDropped() = assertNull(map(time = -1))
}
