package com.runninglivetracker.tracking

import com.runninglivetracker.contract.ContractException
import com.runninglivetracker.contract.FixRecord

/** A location fix that satisfies the wire contract, waiting for its seq (allocated at insert). */
data class ValidFix(
    val recordedAt: Long,
    val lat: Double,
    val lon: Double,
    val accuracyM: Double,
    val altitudeM: Double? = null,
    val speedMps: Double? = null,
)

/**
 * Maps the primitive values of an `android.location.Location` to a [ValidFix], or null when the
 * fix must be dropped (no accuracy, non-finite or out-of-range values). Pure, so it is
 * JVM-testable; validation is [FixRecord.validate], the same rules the server applies.
 */
object FixMapper {
    fun map(
        time: Long,
        latitude: Double,
        longitude: Double,
        hasAccuracy: Boolean,
        accuracyM: Float,
        hasAltitude: Boolean,
        altitudeM: Double,
        hasSpeed: Boolean,
        speedMps: Float,
    ): ValidFix? {
        if (!hasAccuracy) return null
        val fix = ValidFix(
            recordedAt = time,
            lat = latitude,
            lon = longitude,
            accuracyM = accuracyM.toDouble(),
            altitudeM = if (hasAltitude) altitudeM else null,
            speedMps = if (hasSpeed) speedMps.toDouble() else null,
        )
        return try {
            // seq is allocated later in the insert transaction; 0 is a valid placeholder.
            FixRecord(0, fix.recordedAt, fix.lat, fix.lon, fix.accuracyM, fix.altitudeM, fix.speedMps).validate()
            fix
        } catch (_: ContractException) {
            null
        }
    }
}
