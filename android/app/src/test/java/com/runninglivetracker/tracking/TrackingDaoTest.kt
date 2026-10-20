package com.runninglivetracker.tracking

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.runninglivetracker.tracking.db.AppDatabase
import com.runninglivetracker.tracking.db.OutboxEntity
import com.runninglivetracker.tracking.db.SessionEntity
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// SDK 35+ under Robolectric needs a Java 21 test JVM; the build's toolchain is 17.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TrackingDaoTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val opened = mutableListOf<AppDatabase>()
    private val sessionId = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b"
    private val key = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_6"

    private fun inMemory(): AppDatabase =
        Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).allowMainThreadQueries().build().also { opened += it }

    private fun onDisk(): AppDatabase =
        Room.databaseBuilder(context, AppDatabase::class.java, "test-tracking.db").allowMainThreadQueries().build().also { opened += it }

    @After
    fun close() {
        opened.forEach { it.close() }
        context.deleteDatabase("test-tracking.db")
    }

    private fun fix(i: Int) = ValidFix(recordedAt = 1_000L + i, lat = 48.0 + i * 1e-4, lon = 2.0, accuracyM = 4.0)

    private fun AppDatabase.newSession() =
        trackingDao().insertSession(SessionEntity(sessionId = sessionId, sessionStartedAt = 900, runnerKey = key))

    @Test
    fun fixesGetContiguousSeqFromZeroAndCount() {
        val db = inMemory()
        db.newSession()
        val dao = db.trackingDao()
        val seqs = (0 until 5).map { dao.appendFix(sessionId, fix(it)) }
        assertEquals(listOf(0L, 1L, 2L, 3L, 4L), seqs)
        assertEquals(5L, dao.session(sessionId)!!.fixCount)
        assertEquals(5L, dao.session(sessionId)!!.nextSeq)
        assertEquals(listOf(0L, 1L, 2L, 3L, 4L), dao.outbox(sessionId).map { it.seq })
    }

    @Test
    fun endFollowsFixesWithNoGapAndEndsTheSession() {
        val db = inMemory()
        db.newSession()
        val dao = db.trackingDao()
        repeat(3) { dao.appendFix(sessionId, fix(it)) }
        assertEquals(3L, dao.appendEnd(sessionId, recordedAt = 5_000))

        val rows = dao.outbox(sessionId)
        assertEquals(listOf(0L, 1L, 2L, 3L), rows.map { it.seq })
        assertEquals(listOf("fix", "fix", "fix", "end"), rows.map { it.kind })
        assertEquals(OutboxEntity(sessionId, 3, OutboxEntity.KIND_END, 5_000), rows.last())
        val session = dao.session(sessionId)!!
        assertEquals(5_000L, session.endedAt)
        assertEquals(3L, session.fixCount)
        assertNull(dao.activeSession())
    }

    @Test
    fun fixAndEndAfterEndAreDropped() {
        val db = inMemory()
        db.newSession()
        val dao = db.trackingDao()
        dao.appendFix(sessionId, fix(0))
        dao.appendEnd(sessionId, recordedAt = 5_000)
        assertNull(dao.appendFix(sessionId, fix(1)))
        assertNull(dao.appendEnd(sessionId, recordedAt = 6_000))
        assertEquals(listOf(0L, 1L), dao.outbox(sessionId).map { it.seq })
        assertEquals(1L, dao.session(sessionId)!!.fixCount)
    }

    @Test
    fun unknownSessionIsDropped() {
        val dao = inMemory().trackingDao()
        assertNull(dao.appendFix(sessionId, fix(0)))
        assertNull(dao.appendEnd(sessionId, recordedAt = 1))
    }

    @Test
    fun optionalFieldsAreStoredOnlyWhenPresent() {
        val db = inMemory()
        db.newSession()
        val dao = db.trackingDao()
        dao.appendFix(sessionId, fix(0))
        dao.appendFix(sessionId, fix(1).copy(altitudeM = 35.0, speedMps = 3.0))
        val (bare, full) = dao.outbox(sessionId)
        assertNull(bare.altitudeM)
        assertNull(bare.speedMps)
        assertEquals(35.0, full.altitudeM!!, 0.0)
        assertEquals(3.0, full.speedMps!!, 0.0)
    }

    @Test
    fun reopeningTheDatabaseMidSessionContinuesTheSeq() {
        val first = onDisk()
        first.newSession()
        repeat(3) { first.trackingDao().appendFix(sessionId, fix(it)) }
        first.close()

        val second = onDisk()
        val dao = second.trackingDao()
        val active = dao.activeSession()
        assertNotNull(active)
        assertEquals(sessionId, active!!.sessionId)
        assertEquals(3L, dao.appendFix(sessionId, fix(3)))
        assertEquals(4L, dao.appendEnd(sessionId, recordedAt = 9_000))
        assertEquals(listOf(0L, 1L, 2L, 3L, 4L), dao.outbox(sessionId).map { it.seq })
        assertEquals(4L, dao.session(sessionId)!!.fixCount)
    }

    @Test
    fun activeSessionFlowReflectsStartAndEnd() = runBlocking {
        val db = inMemory()
        val dao = db.trackingDao()
        assertNull(dao.observeActiveSession().first())
        db.newSession()
        dao.appendFix(sessionId, fix(0))
        assertEquals(1L, dao.observeActiveSession().first()!!.fixCount)
        dao.appendEnd(sessionId, recordedAt = 2_000)
        assertNull(dao.observeActiveSession().first())
    }

    @Test
    fun sessionToStringHidesTheKey() {
        val text = SessionEntity(sessionId, 900, key).toString()
        assertFalse(text, text.contains(key))
    }
}
