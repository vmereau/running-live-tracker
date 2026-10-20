package com.runninglivetracker.upload

import android.util.Log
import com.runninglivetracker.contract.EndRecord
import com.runninglivetracker.contract.FixRecord
import com.runninglivetracker.contract.IngestBatch
import com.runninglivetracker.contract.IngestRecord
import com.runninglivetracker.settings.SettingsValidation
import com.runninglivetracker.settings.Validated
import com.runninglivetracker.tracking.db.OutboxEntity
import com.runninglivetracker.tracking.db.TrackingDao
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.ReceiveChannel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Drains the outbox to `POST /api/v1/ingest`: oldest session first, from its lowest remaining
 * seq, at most [batchSize] records of one session per batch, each with that session's captured
 * key. Acked rows are deleted, rejected batches are quarantined, anything else stays for a retry.
 * It never allocates seq and never blocks the writer: it only reads, deletes and quarantines.
 *
 * Blocking DAO and HTTP calls: run it on Dispatchers.IO.
 */
class Uploader(
    private val dao: TrackingDao,
    private val client: IngestClient,
    /** The raw base URL from settings, read at each flush. */
    private val baseUrl: suspend () -> String,
    private val allowCleartext: Boolean,
    private val clock: () -> Long = System::currentTimeMillis,
    private val batchSize: Int = MAX_BATCH_RECORDS,
) {

    /**
     * Sends batch after batch until the outbox is empty (true) or a retryable failure (false).
     * A rejected batch is quarantined and the flush goes on with the next rows.
     */
    suspend fun flush(): Boolean {
        val url = when (val validated = SettingsValidation.validateBaseUrl(baseUrl(), allowCleartext)) {
            is Validated.Ok -> validated.value
            is Validated.Invalid -> {
                Log.w(TAG, "Upload skipped: invalid server URL")
                return false
            }
        }
        while (true) {
            currentCoroutineContext().ensureActive() // blocking calls only: stop here once cancelled
            val session = dao.nextUploadSession() ?: return true
            val rows = dao.pendingBatch(session.sessionId, batchSize)
            if (rows.isEmpty()) continue // deleted meanwhile: pick the next session
            val batch = IngestBatch(session.sessionId, session.sessionStartedAt, rows.map { it.toRecord() })
            when (val result = client.send(url, session.runnerKey, batch)) {
                is IngestResult.Acked -> dao.ackThrough(session.sessionId, result.ack.ackedThroughSeq, clock())
                is IngestResult.Rejected -> {
                    Log.w(
                        TAG,
                        "Batch ${session.sessionId} seq ${rows.first().seq}..${rows.last().seq} rejected: " +
                            "HTTP ${result.status} ${result.code ?: "-"}; quarantined",
                    )
                    dao.quarantine(session.sessionId, rows.map { it.seq }, result.status, result.code, clock())
                }
                is IngestResult.Retry -> {
                    Log.w(TAG, "Upload failed (${result.reason}); will retry")
                    return false
                }
            }
        }
    }

    /**
     * Flushes, then waits [FLUSH_INTERVAL_MS] after a success or [backoffMs] after a failure, or
     * until [trigger] fires (connectivity returned), which flushes at once and resets the backoff.
     * Runs until cancelled.
     */
    suspend fun run(trigger: ReceiveChannel<Unit>): Nothing = uploadLoop(trigger) {
        try {
            flush()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "Upload failed (${e.javaClass.simpleName}); will retry")
            false
        }
    }

    companion object {
        private const val TAG = "Uploader"

        /** Server limit (MAX_BATCH_RECORDS in shared/src/contract.ts). */
        const val MAX_BATCH_RECORDS = 200
        const val FLUSH_INTERVAL_MS = 10_000L
        const val MAX_BACKOFF_MS = 60_000L

        /** 1 s, 2 s, 4 s … capped at 60 s, after [failures] consecutive failures (≥ 1). */
        fun backoffMs(failures: Int): Long {
            if (failures <= 0) return 0
            if (failures > 7) return MAX_BACKOFF_MS
            return minOf(1_000L shl (failures - 1), MAX_BACKOFF_MS)
        }

        /** The scheduling policy of [run], with the flush injected so it can run on virtual time. */
        internal suspend fun uploadLoop(trigger: ReceiveChannel<Unit>, flush: suspend () -> Boolean): Nothing {
            var failures = 0
            while (true) {
                failures = if (flush()) 0 else failures + 1
                val wait = if (failures == 0) FLUSH_INTERVAL_MS else backoffMs(failures)
                val triggered = withTimeoutOrNull(wait) {
                    trigger.receiveCatching().getOrNull() ?: awaitCancellation()
                }
                if (triggered != null) failures = 0
            }
        }

        internal fun OutboxEntity.toRecord(): IngestRecord = when (kind) {
            OutboxEntity.KIND_END -> EndRecord(seq = seq, recordedAt = recordedAt)
            else -> FixRecord(
                seq = seq,
                recordedAt = recordedAt,
                lat = checkNotNull(lat) { "fix without lat" },
                lon = checkNotNull(lon) { "fix without lon" },
                accuracyM = checkNotNull(accuracyM) { "fix without accuracyM" },
                altitudeM = altitudeM,
                speedMps = speedMps,
            )
        }
    }
}
