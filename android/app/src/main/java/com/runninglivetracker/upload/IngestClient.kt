package com.runninglivetracker.upload

import com.runninglivetracker.contract.ContractException
import com.runninglivetracker.contract.IngestAck
import com.runninglivetracker.contract.IngestBatch
import com.runninglivetracker.contract.decodeErrorBody
import com.runninglivetracker.contract.decodeIngestAck
import com.runninglivetracker.contract.encodeIngestBatch
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** What the uploader does with one batch. Never carries the runner key. */
sealed interface IngestResult {
    /** `200` with a valid ack for this batch: delete through [IngestAck.ackedThroughSeq]. */
    data class Acked(val ack: IngestAck) : IngestResult

    /** `400` / `409` / `413`: final for this batch (quarantine it). [code] is the ErrorBody code, if any. */
    data class Rejected(val status: Int, val code: String?) : IngestResult

    /** Anything else (network error, 5xx, 401, 429, other status, bad 200): keep the rows and retry later. */
    data class Retry(val reason: String) : IngestResult
}

/**
 * `POST <baseUrl>/api/v1/ingest` with `Authorization: Bearer <runnerKey>`. Blocking: call it off
 * the main thread. Clients branch on status (plus error code), never on the message text.
 * Open so JVM tests can stand in for the network.
 */
open class IngestClient(
    private val client: OkHttpClient = OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).build(),
) {
    open fun send(baseUrl: String, runnerKey: String, batch: IngestBatch): IngestResult {
        val url = "${baseUrl.trimEnd('/')}/api/v1/ingest".toHttpUrlOrNull()
            ?: return IngestResult.Retry("Invalid server URL")
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $runnerKey")
            .post(encodeIngestBatch(batch).toRequestBody(JSON))
            .build()
        return try {
            client.newCall(request).execute().use { response ->
                val body = response.body.string()
                when (val status = response.code) {
                    200 -> ackFor(batch, body)
                    in REJECTED -> IngestResult.Rejected(status, errorCode(body))
                    else -> {
                        val code = errorCode(body)
                        IngestResult.Retry(if (code != null) "HTTP $status $code" else "HTTP $status")
                    }
                }
            }
        } catch (e: IOException) {
            IngestResult.Retry(e.javaClass.simpleName)
        } catch (e: RuntimeException) {
            IngestResult.Retry(e.javaClass.simpleName)
        }
    }

    /**
     * A 200 counts only if it is an IngestAck for this batch's session whose ackedThroughSeq lies
     * within the batch: an ack past the batch would delete rows never sent, and one before it
     * would delete nothing and resend the same batch forever.
     */
    private fun ackFor(batch: IngestBatch, body: String): IngestResult {
        val ack = try {
            decodeIngestAck(body)
        } catch (_: ContractException) {
            return IngestResult.Retry("HTTP 200: not an ack")
        }
        if (ack.sessionId != batch.sessionId) return IngestResult.Retry("HTTP 200: ack for another session")
        val first = batch.records.first().seq
        val last = batch.records.last().seq
        if (ack.ackedThroughSeq !in first..last) return IngestResult.Retry("HTTP 200: ackedThroughSeq outside the batch")
        return IngestResult.Acked(ack)
    }

    private fun errorCode(body: String): String? = try {
        decodeErrorBody(body).error.code
    } catch (_: ContractException) {
        null
    }

    private companion object {
        val JSON = "application/json".toMediaType()

        /** INVALID_BATCH, SESSION_OWNER_MISMATCH, BATCH_TOO_LARGE. */
        val REJECTED = setOf(400, 409, 413)
    }
}
