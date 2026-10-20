package com.runninglivetracker.upload

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.runninglivetracker.contract.EndRecord
import com.runninglivetracker.contract.FixRecord
import com.runninglivetracker.contract.IngestAck
import com.runninglivetracker.contract.decodeIngestBatch
import com.runninglivetracker.contract.encodeIngestAck
import com.runninglivetracker.tracking.ValidFix
import com.runninglivetracker.tracking.db.AppDatabase
import com.runninglivetracker.tracking.db.SessionEntity
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class UploaderTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private lateinit var db: AppDatabase
    private val server = MockWebServer()
    private val dao get() = db.trackingDao()

    private val sessionA = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b"
    private val sessionB = "9f0c2a3e-7d4b-4c1a-8e2f-5a6b7c8d9e0f"
    private val keyA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_6"
    private val keyB = "ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrqp9876_-"
    private val now = 1_760_000_123_000L

    /** Reachable only through `localhost`: the debug cleartext rule allows it. */
    private var baseUrl = ""

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).allowMainThreadQueries().build()
        server.start()
        baseUrl = "http://localhost:${server.port}"
    }

    @After
    fun tearDown() {
        server.close()
        db.close()
    }

    private fun uploader(url: () -> String = { baseUrl }) =
        Uploader(dao, IngestClient(), baseUrl = { url() }, allowCleartext = true, clock = { now })

    private fun flush() = runBlocking { uploader().flush() }

    private fun session(id: String, key: String, startedAt: Long, fixes: Int, end: Boolean = false) {
        dao.insertSession(SessionEntity(sessionId = id, sessionStartedAt = startedAt, runnerKey = key))
        repeat(fixes) {
            dao.appendFix(id, ValidFix(recordedAt = startedAt + it * 5_000L, lat = 48.85 + it * 1e-5, lon = 2.35, accuracyM = 4.0))
        }
        if (end) dao.appendEnd(id, recordedAt = startedAt + fixes * 5_000L)
    }

    /** Acks every batch like the server: ackedThroughSeq = the batch's last seq. */
    private fun ackEverything() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = ackFor(request)
        }
    }

    private fun ackFor(request: RecordedRequest): MockResponse {
        val batch = decodeIngestBatch(request.body!!.utf8())
        val ack = IngestAck(batch.sessionId, batch.records.last().seq, now)
        return MockResponse.Builder().code(200).body(encodeIngestAck(ack)).build()
    }

    private fun error(status: Int, code: String) = MockResponse.Builder()
        .code(status)
        .body("""{"error":{"code":"$code","message":"nope"}}""")
        .build()

    private fun takeBatch() = server.takeRequest().let { it to decodeIngestBatch(it.body!!.utf8()) }

    private fun pending(id: String) = dao.outbox(id).map { it.seq }

    // Matrix "Ack": 250 rows go as 0..199 then 200..249 in one flush; all deleted; lastAckedAt set.
    @Test
    fun backlogIsSentInOrderedBatchesAndDeletedOnAck() {
        session(sessionA, keyA, startedAt = 1_000, fixes = 249, end = true)
        ackEverything()

        assertTrue(flush())

        val (first, batch1) = takeBatch()
        val (_, batch2) = takeBatch()
        assertEquals(2, server.requestCount)
        assertEquals("POST", first.method)
        assertEquals("/api/v1/ingest", first.url.encodedPath)
        assertEquals("Bearer $keyA", first.headers["Authorization"])
        assertTrue(first.headers["Content-Type"]!!.startsWith("application/json"))
        assertEquals(sessionA, batch1.sessionId)
        assertEquals(1_000L, batch1.sessionStartedAt)
        assertEquals((0L..199L).toList(), batch1.records.map { it.seq })
        assertEquals((200L..249L).toList(), batch2.records.map { it.seq })
        assertTrue(batch1.records.all { it is FixRecord })
        assertTrue(batch2.records.last() is EndRecord)

        assertEquals(emptyList<Long>(), pending(sessionA))
        assertEquals(now, dao.session(sessionA)!!.lastAckedAt)
        runBlocking {
            assertEquals(0L, dao.observePendingCount().first())
            assertEquals(now, dao.observeLastAckedAt().first())
        }
    }

    @Test
    fun emptyOutboxSendsNothing() {
        assertTrue(flush())
        assertEquals(0, server.requestCount)
    }

    // Optional fields are omitted on the wire, never null.
    @Test
    fun fixFieldsMapToTheWireRecord() {
        dao.insertSession(SessionEntity(sessionId = sessionA, sessionStartedAt = 1_000, runnerKey = keyA))
        dao.appendFix(sessionA, ValidFix(2_000, 48.5, 2.25, 3.5, altitudeM = 35.0, speedMps = 3.2))
        dao.appendFix(sessionA, ValidFix(7_000, 48.6, 2.26, 4.5))
        ackEverything()
        assertTrue(flush())
        val request = server.takeRequest()
        val text = request.body!!.utf8()
        assertFalse(text, text.contains("null"))
        val records = decodeIngestBatch(text).records
        assertEquals(FixRecord(0, 2_000, 48.5, 2.25, 3.5, 35.0, 3.2), records[0])
        assertEquals(FixRecord(1, 7_000, 48.6, 2.26, 4.5), records[1])
    }

    // Matrix "400": the batch is quarantined with status and code, then the flush continues.
    @Test
    fun rejectedBatchIsQuarantinedAndTheFlushContinues() {
        session(sessionA, keyA, startedAt = 1_000, fixes = 250)
        server.enqueue(error(400, "INVALID_BATCH"))
        server.enqueue(MockResponse.Builder().code(200).body(encodeIngestAck(IngestAck(sessionA, 249, now))).build())

        assertTrue(flush())

        assertEquals(2, server.requestCount)
        assertEquals((0L..199L).toList(), takeBatch().second.records.map { it.seq })
        assertEquals((200L..249L).toList(), takeBatch().second.records.map { it.seq })
        assertEquals(emptyList<Long>(), pending(sessionA))
        val quarantined = dao.quarantined()
        assertEquals((0L..199L).toList(), quarantined.map { it.seq })
        assertTrue(quarantined.all { it.httpStatus == 400 && it.errorCode == "INVALID_BATCH" && it.quarantinedAt == now })
        assertEquals(48.85, quarantined.first().lat!!, 0.0)
        runBlocking { assertEquals(200L, dao.observeQuarantineCount().first()) }
    }

    // Matrix "409 / 413": final for the batch, no code needed to quarantine.
    @Test
    fun conflictAndTooLargeAreQuarantined() {
        session(sessionA, keyA, startedAt = 1_000, fixes = 2)
        session(sessionB, keyB, startedAt = 2_000, fixes = 3)
        server.enqueue(error(409, "SESSION_OWNER_MISMATCH"))
        server.enqueue(MockResponse.Builder().code(413).body("too big").build())

        assertTrue(flush())

        assertEquals(emptyList<Long>(), pending(sessionA))
        assertEquals(emptyList<Long>(), pending(sessionB))
        val bySession = dao.quarantined().groupBy { it.sessionId }
        assertEquals(listOf(0L, 1L), bySession[sessionA]!!.map { it.seq })
        assertTrue(bySession[sessionA]!!.all { it.httpStatus == 409 && it.errorCode == "SESSION_OWNER_MISMATCH" })
        assertEquals(listOf(0L, 1L, 2L), bySession[sessionB]!!.map { it.seq })
        assertTrue(bySession[sessionB]!!.all { it.httpStatus == 413 && it.errorCode == null })
        assertNull(dao.session(sessionA)!!.lastAckedAt)
    }

    // Matrix "Network error, 5xx, 401, 429, other status": outbox untouched, flush stops.
    @Test
    fun transientFailuresLeaveTheOutboxUntouchedAndStopTheFlush() {
        session(sessionA, keyA, startedAt = 1_000, fixes = 3)
        session(sessionB, keyB, startedAt = 2_000, fixes = 3)
        val failures = listOf(
            error(401, "UNAUTHORIZED"),
            error(500, "INTERNAL"),
            MockResponse.Builder().code(502).body("<html>bad gateway</html>").build(),
            error(429, "RATE_LIMITED"),
            MockResponse.Builder().code(404).build(),
            MockResponse.Builder().code(204).build(),
        )
        for (response in failures) {
            server.enqueue(response)
            assertFalse(response.toString(), flush())
            assertEquals(listOf(0L, 1L, 2L), pending(sessionA))
            assertEquals(listOf(0L, 1L, 2L), pending(sessionB))
        }
        // One request per flush: the flush stops at the first failure (session B never tried).
        assertEquals(failures.size, server.requestCount)
        repeat(failures.size) { assertEquals(sessionA, takeBatch().second.sessionId) }
        assertTrue(dao.quarantined().isEmpty())
        assertNull(dao.session(sessionA)!!.lastAckedAt)
    }

    @Test
    fun networkErrorIsRetryable() {
        session(sessionA, keyA, startedAt = 1_000, fixes = 3)
        server.close()
        assertFalse(flush())
        assertEquals(listOf(0L, 1L, 2L), pending(sessionA))
    }

    // Matrix "Bad 200": not an ack, an ack for another session, or an ack outside the batch.
    @Test
    fun badAckIsRetryableAndDeletesNothing() {
        session(sessionA, keyA, startedAt = 1_000, fixes = 3)
        val bad = listOf(
            "hello",
            """{"ok":true}""",
            encodeIngestAck(IngestAck(sessionB, 2, now)),
            encodeIngestAck(IngestAck(sessionA, 3, now)),
        )
        for (body in bad) {
            server.enqueue(MockResponse.Builder().code(200).body(body).build())
            assertFalse(body, flush())
            assertEquals(listOf(0L, 1L, 2L), pending(sessionA))
        }
        assertNull(dao.session(sessionA)!!.lastAckedAt)
    }

    // An ack for part of the batch deletes exactly seq <= ackedThroughSeq; the rest is resent.
    @Test
    fun partialAckDeletesOnlyThroughTheAckedSeq() {
        session(sessionA, keyA, startedAt = 1_000, fixes = 4)
        server.enqueue(MockResponse.Builder().code(200).body(encodeIngestAck(IngestAck(sessionA, 1, now))).build())
        server.enqueue(error(503, "UNAVAILABLE"))
        assertFalse(flush())
        assertEquals(listOf(2L, 3L), pending(sessionA))
        takeBatch()
        assertEquals(listOf(2L, 3L), takeBatch().second.records.map { it.seq })
    }

    // An ack below the batch (here 0 for batch 2..3) is not an ack for it: nothing deleted, retry.
    @Test
    fun ackBelowTheBatchIsRetryable() {
        session(sessionA, keyA, startedAt = 1_000, fixes = 4)
        server.enqueue(MockResponse.Builder().code(200).body(encodeIngestAck(IngestAck(sessionA, 1, now))).build())
        server.enqueue(MockResponse.Builder().code(200).body(encodeIngestAck(IngestAck(sessionA, 0, now))).build())
        assertFalse(flush())
        assertEquals(listOf(2L, 3L), pending(sessionA))
        assertEquals(2, server.requestCount)
    }

    // Last ack is the MAX over sessions, not the last one written.
    @Test
    fun lastAckedAtIsTheLatestOverAllSessions() {
        session(sessionA, keyA, startedAt = 1_000, fixes = 1)
        session(sessionB, keyB, startedAt = 2_000, fixes = 1)
        ackEverything()
        val times = ArrayDeque(listOf(9_000L, 5_000L)) // A (sent first) acked later than B
        val uploader = Uploader(dao, IngestClient(), { baseUrl }, allowCleartext = true, clock = { times.removeFirst() })
        assertTrue(runBlocking { uploader.flush() })
        assertEquals(9_000L, dao.session(sessionA)!!.lastAckedAt)
        assertEquals(5_000L, dao.session(sessionB)!!.lastAckedAt)
        runBlocking { assertEquals(9_000L, dao.observeLastAckedAt().first()) }
    }

    // Matrix "Two sessions": every batch of the older session goes before any of the newer one, each with its own key.
    @Test
    fun olderSessionIsDrainedFirstWithItsOwnKey() {
        // B is inserted first but started later: order is by sessionStartedAt.
        session(sessionB, keyB, startedAt = 5_000, fixes = 3)
        session(sessionA, keyA, startedAt = 1_000, fixes = 201, end = true)
        ackEverything()

        assertTrue(flush())

        val sent = List(server.requestCount) { takeBatch() }
        assertEquals(listOf(sessionA, sessionA, sessionB), sent.map { it.second.sessionId })
        assertEquals(listOf("Bearer $keyA", "Bearer $keyA", "Bearer $keyB"), sent.map { it.first.headers["Authorization"] })
        assertEquals((0L..199L).toList(), sent[0].second.records.map { it.seq })
        assertEquals(listOf(200L, 201L), sent[1].second.records.map { it.seq })
        assertEquals(listOf(0L, 1L, 2L), sent[2].second.records.map { it.seq })
        assertEquals(5_000L, sent[2].second.sessionStartedAt)
        assertEquals(emptyList<Long>(), pending(sessionA))
        assertEquals(emptyList<Long>(), pending(sessionB))
    }

    // Matrix "Offline": fixes recorded while uploads fail keep their seq; the backlog then drains in order.
    @Test
    fun offlineBacklogDrainsInOrderWhenTheNetworkReturns() {
        dao.insertSession(SessionEntity(sessionId = sessionA, sessionStartedAt = 1_000, runnerKey = keyA))
        val down = MockResponse.Builder().code(503).build()
        repeat(24) { i ->
            dao.appendFix(sessionA, ValidFix(1_000L + i * 5_000L, 48.85, 2.35, 4.0))
            server.enqueue(down)
            assertFalse(flush())
        }
        assertEquals((0L..23L).toList(), pending(sessionA))
        repeat(24) { takeBatch() }

        ackEverything()
        assertTrue(flush())
        assertEquals((0L..23L).toList(), takeBatch().second.records.map { it.seq })
        assertEquals(emptyList<Long>(), pending(sessionA))
        assertEquals(24L, dao.session(sessionA)!!.nextSeq)
    }

    // Matrix "Invalid settings URL": no request, retryable.
    @Test
    fun invalidBaseUrlSendsNothingAndIsRetryable() {
        session(sessionA, keyA, startedAt = 1_000, fixes = 2)
        ackEverything()
        for (url in listOf("", "not a url", "ftp://localhost", "http://example.com")) {
            assertFalse(url, runBlocking { uploader { url }.flush() })
        }
        assertFalse(runBlocking { Uploader(dao, IngestClient(), { baseUrl }, allowCleartext = false).flush() })
        assertEquals(0, server.requestCount)
        assertEquals(listOf(0L, 1L), pending(sessionA))
    }

    // The base URL is read at each flush.
    @Test
    fun baseUrlIsReadAtEachFlush() {
        session(sessionA, keyA, startedAt = 1_000, fixes = 1)
        ackEverything()
        var url = ""
        val uploader = Uploader(dao, IngestClient(), baseUrl = { url }, allowCleartext = true, clock = { now })
        assertFalse(runBlocking { uploader.flush() })
        url = "$baseUrl/"
        assertTrue(runBlocking { uploader.flush() })
        assertEquals(1, server.requestCount)
    }
}
