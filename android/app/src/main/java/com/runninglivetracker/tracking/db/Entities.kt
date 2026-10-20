package com.runninglivetracker.tracking.db

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * One tracking session, written only by TrackingService. [nextSeq] is the seq the next outbox
 * row gets. [fixCount] lives here (not COUNT(*) on the outbox) because the uploader deletes
 * acked outbox rows. [endedAt] is null while the session is active. [lastAckedAt] is the phone time
 * of the last successful upload ack for this session (null until the first one).
 */
@Entity(tableName = "sessions")
data class SessionEntity(
    @PrimaryKey val sessionId: String,
    val sessionStartedAt: Long,
    val runnerKey: String,
    val nextSeq: Long = 0,
    val fixCount: Long = 0,
    val endedAt: Long? = null,
    val lastAckedAt: Long? = null,
) {
    // Never print the runner key (logs, crash reports).
    override fun toString(): String =
        "SessionEntity(sessionId=$sessionId, sessionStartedAt=$sessionStartedAt, runnerKey=***, " +
            "nextSeq=$nextSeq, fixCount=$fixCount, endedAt=$endedAt, lastAckedAt=$lastAckedAt)"
}

/** One wire record waiting for upload: a `fix` (with position fields) or the final `end`. */
@Entity(tableName = "outbox", primaryKeys = ["sessionId", "seq"])
data class OutboxEntity(
    val sessionId: String,
    val seq: Long,
    val kind: String,
    val recordedAt: Long,
    val lat: Double? = null,
    val lon: Double? = null,
    val accuracyM: Double? = null,
    val altitudeM: Double? = null,
    val speedMps: Double? = null,
) {
    companion object {
        const val KIND_FIX = "fix"
        const val KIND_END = "end"
    }
}

/**
 * An outbox row the server rejected for good (400 / 409 / 413): kept locally, never resent.
 * [errorCode] is the ErrorBody code, or null when the reply had none.
 */
@Entity(tableName = "quarantine", primaryKeys = ["sessionId", "seq"])
data class QuarantineEntity(
    val sessionId: String,
    val seq: Long,
    val kind: String,
    val recordedAt: Long,
    val lat: Double? = null,
    val lon: Double? = null,
    val accuracyM: Double? = null,
    val altitudeM: Double? = null,
    val speedMps: Double? = null,
    val httpStatus: Int,
    val errorCode: String? = null,
    val quarantinedAt: Long,
)
