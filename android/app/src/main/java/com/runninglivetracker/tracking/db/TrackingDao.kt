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
 * allocation (read nextSeq, insert, bump) is one transaction on one thread.
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
}
