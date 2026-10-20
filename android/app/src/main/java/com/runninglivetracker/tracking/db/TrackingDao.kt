package com.runninglivetracker.tracking.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import com.runninglivetracker.tracking.ValidFix
import kotlinx.coroutines.flow.Flow

/**
 * Blocking DAO: TrackingService calls the write methods from its single-threaded writer, so seq
 * allocation (read nextSeq, insert, bump) is one transaction on one thread. The uploader only
 * reads, deletes and quarantines outbox rows (never allocates seq), from its own thread; Room
 * serializes those transactions with the writer's.
 */
@Dao
abstract class TrackingDao {

    @Query("SELECT * FROM sessions WHERE endedAt IS NULL ORDER BY sessionStartedAt DESC LIMIT 1")
    abstract fun activeSession(): SessionEntity?

    @Query("SELECT * FROM sessions WHERE endedAt IS NULL ORDER BY sessionStartedAt DESC LIMIT 1")
    abstract fun observeActiveSession(): Flow<SessionEntity?>

    @Query("SELECT * FROM sessions WHERE sessionId = :sessionId")
    abstract fun session(sessionId: String): SessionEntity?

    @Query("SELECT * FROM outbox WHERE sessionId = :sessionId ORDER BY seq")
    abstract fun outbox(sessionId: String): List<OutboxEntity>

    @Insert(onConflict = OnConflictStrategy.ABORT)
    abstract fun insertSession(session: SessionEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    protected abstract fun insertOutbox(row: OutboxEntity)

    @Query("UPDATE sessions SET nextSeq = nextSeq + 1, fixCount = fixCount + :fixDelta WHERE sessionId = :sessionId")
    protected abstract fun bumpSeq(sessionId: String, fixDelta: Long)

    @Query("UPDATE sessions SET endedAt = :endedAt WHERE sessionId = :sessionId")
    protected abstract fun markEnded(sessionId: String, endedAt: Long)

    /** Writes [fix] with the session's next seq. Returns that seq, or null (dropped) if the session is unknown or ended. */
    @Transaction
    open fun appendFix(sessionId: String, fix: ValidFix): Long? {
        val session = session(sessionId)?.takeIf { it.endedAt == null } ?: return null
        val seq = session.nextSeq
        insertOutbox(
            OutboxEntity(
                sessionId = sessionId,
                seq = seq,
                kind = OutboxEntity.KIND_FIX,
                recordedAt = fix.recordedAt,
                lat = fix.lat,
                lon = fix.lon,
                accuracyM = fix.accuracyM,
                altitudeM = fix.altitudeM,
                speedMps = fix.speedMps,
            ),
        )
        bumpSeq(sessionId, fixDelta = 1)
        return seq
    }

    /** Writes the `end` record with the next seq and marks the session ended. Returns that seq, or null if already ended/unknown. */
    @Transaction
    open fun appendEnd(sessionId: String, recordedAt: Long, endedAt: Long = recordedAt): Long? {
        val session = session(sessionId)?.takeIf { it.endedAt == null } ?: return null
        val seq = session.nextSeq
        insertOutbox(OutboxEntity(sessionId = sessionId, seq = seq, kind = OutboxEntity.KIND_END, recordedAt = recordedAt))
        bumpSeq(sessionId, fixDelta = 0)
        markEnded(sessionId, endedAt)
        return seq
    }

    // ---- upload (Uploader) ----

    /** The session to upload next: the oldest (by sessionStartedAt) that still has outbox rows. */
    @Query(
        "SELECT * FROM sessions WHERE sessionId IN (SELECT DISTINCT sessionId FROM outbox) " +
            "ORDER BY sessionStartedAt, sessionId LIMIT 1",
    )
    abstract fun nextUploadSession(): SessionEntity?

    /** Up to [limit] outbox rows of [sessionId], from its lowest remaining seq, in increasing seq order. */
    @Query("SELECT * FROM outbox WHERE sessionId = :sessionId ORDER BY seq LIMIT :limit")
    abstract fun pendingBatch(sessionId: String, limit: Int): List<OutboxEntity>

    @Query("DELETE FROM outbox WHERE sessionId = :sessionId AND seq <= :seq")
    protected abstract fun deleteThrough(sessionId: String, seq: Long)

    @Query("UPDATE sessions SET lastAckedAt = :ackedAt WHERE sessionId = :sessionId")
    protected abstract fun setLastAckedAt(sessionId: String, ackedAt: Long)

    /** A 200 ack: deletes exactly `sessionId = [sessionId] AND seq <= [seq]` and records the ack time. */
    @Transaction
    open fun ackThrough(sessionId: String, seq: Long, ackedAt: Long) {
        deleteThrough(sessionId, seq)
        setLastAckedAt(sessionId, ackedAt)
    }

    @Query(
        "INSERT OR REPLACE INTO quarantine " +
            "(sessionId, seq, kind, recordedAt, lat, lon, accuracyM, altitudeM, speedMps, httpStatus, errorCode, quarantinedAt) " +
            "SELECT sessionId, seq, kind, recordedAt, lat, lon, accuracyM, altitudeM, speedMps, :status, :code, :at " +
            "FROM outbox WHERE sessionId = :sessionId AND seq IN (:seqs)",
    )
    protected abstract fun copyToQuarantine(sessionId: String, seqs: List<Long>, status: Int, code: String?, at: Long)

    @Query("DELETE FROM outbox WHERE sessionId = :sessionId AND seq IN (:seqs)")
    protected abstract fun deleteOutbox(sessionId: String, seqs: List<Long>)

    /** A final rejection (400 / 409 / 413): moves the batch's rows from the outbox to `quarantine`. */
    @Transaction
    open fun quarantine(sessionId: String, seqs: List<Long>, status: Int, code: String?, at: Long) {
        if (seqs.isEmpty()) return
        copyToQuarantine(sessionId, seqs, status, code, at)
        deleteOutbox(sessionId, seqs)
    }

    @Query("SELECT * FROM quarantine ORDER BY sessionId, seq")
    abstract fun quarantined(): List<QuarantineEntity>

    @Query("SELECT COUNT(*) FROM outbox")
    abstract fun observePendingCount(): Flow<Long>

    /** Blocking: outbox rows not yet acked (any session). Decides between draining and stopping. */
    @Query("SELECT COUNT(*) FROM outbox")
    abstract fun pendingCount(): Long

    @Query("SELECT COUNT(*) FROM quarantine")
    abstract fun observeQuarantineCount(): Flow<Long>

    /** The most recent ack over every session, or null if nothing was ever acked. */
    @Query("SELECT MAX(lastAckedAt) FROM sessions")
    abstract fun observeLastAckedAt(): Flow<Long?>
}
