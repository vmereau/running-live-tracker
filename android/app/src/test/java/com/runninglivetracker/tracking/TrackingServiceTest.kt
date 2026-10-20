package com.runninglivetracker.tracking

import android.Manifest
import android.app.Application
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.runninglivetracker.settings.Settings
import com.runninglivetracker.settings.SettingsRepository
import com.runninglivetracker.settings.settingsDataStore
import com.runninglivetracker.testing.awaitUntil
import com.runninglivetracker.testing.settle
import com.runninglivetracker.tracking.db.AppDatabase
import com.runninglivetracker.tracking.db.SessionEntity
import com.runninglivetracker.contract.IngestAck
import com.runninglivetracker.contract.IngestBatch
import com.runninglivetracker.upload.ConnectivitySource
import com.runninglivetracker.upload.IngestClient
import com.runninglivetracker.upload.IngestResult
import com.runninglivetracker.upload.AndroidConnectivitySource
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit

/** Stands in for FusedLocation: records the request and delivers fixes on the given executor, like GMS. */
class FakeLocationSource : LocationSource {
    @Volatile var requests = 0
    @Volatile var removes = 0
    @Volatile private var executor: Executor? = null
    @Volatile private var onLocations: ((List<Location>) -> Unit)? = null
    @Volatile var intervalMs = 0L

    override fun request(intervalMs: Long, executor: Executor, onLocations: (List<Location>) -> Unit) {
        this.intervalMs = intervalMs
        this.executor = executor
        this.onLocations = onLocations
        requests++
    }

    /** Runs inside [remove] before it returns, e.g. to dispatch a callback still in flight. */
    @Volatile var onRemove: (() -> Unit)? = null

    override suspend fun remove() {
        removes++
        onRemove?.invoke()
    }

    /** Dispatches [locations] to the writer without waiting, like GMS does. */
    fun dispatch(vararg locations: Location) {
        val cb = onLocations!!
        executor!!.execute { cb(locations.toList()) }
    }

    /** Dispatches [locations] to the writer and waits until it has processed them. */
    fun deliver(vararg locations: Location) {
        val exec = executor!!
        val cb = onLocations!!
        exec.execute { cb(locations.toList()) }
        val done = CountDownLatch(1)
        exec.execute { done.countDown() }
        assertTrue("writer did not drain", done.await(5, TimeUnit.SECONDS))
    }
}

/** Stands in for the network callback: [fire] simulates connectivity returning. */
class FakeConnectivitySource : ConnectivitySource {
    @Volatile var callback: (() -> Unit)? = null
    @Volatile var unregistered = false

    override fun register(onAvailable: () -> Unit) {
        callback = onAvailable
    }

    override fun unregister() {
        unregistered = true
    }

    fun fire() = callback!!.invoke()
}

/** Stands in for the HTTP client: answers with [respond] (Retry by default, so the outbox stays put). */
class FakeIngestClient : IngestClient() {
    val batches = java.util.Collections.synchronizedList(mutableListOf<IngestBatch>())
    @Volatile var respond: (IngestBatch) -> IngestResult = { IngestResult.Retry("offline") }

    override fun send(baseUrl: String, runnerKey: String, batch: IngestBatch): IngestResult {
        batches += batch
        return respond(batch)
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TrackingServiceTest {

    private val app: Application = ApplicationProvider.getApplicationContext()
    private lateinit var db: AppDatabase
    private val fake = FakeLocationSource()
    private val connectivity = FakeConnectivitySource()
    private val ingest = FakeIngestClient()
    private val key = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_6"
    /** Every service built by [createService], destroyed in [tearDown] so no uploader outlives its test. */
    private val controllers = mutableListOf<ServiceController<TrackingService>>()
    private val uuidV4 = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(app, AppDatabase::class.java).allowMainThreadQueries().build()
        AppDatabase.setInstanceForTest(db)
        TrackingService.locationSourceFactory = { fake }
        TrackingService.connectivitySourceFactory = { connectivity }
        TrackingService.ingestClientFactory = { ingest }
        shadowOf(app).grantPermissions(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.ACCESS_BACKGROUND_LOCATION,
            Manifest.permission.POST_NOTIFICATIONS,
        )
    }

    @After
    fun tearDown() {
        TrackingService.locationSourceFactory = { FusedLocationSource(it) }
        TrackingService.connectivitySourceFactory = { AndroidConnectivitySource(it) }
        TrackingService.ingestClientFactory = { IngestClient() }
        release.countDown()
        controllers.forEach { it.destroy() }
        AppDatabase.setInstanceForTest(null)
        db.close()
    }

    private val dao get() = db.trackingDao()

    private fun location(i: Int, accuracy: Float? = 5f) = Location("test").apply {
        time = 1_760_000_000_000 + i * 5_000L
        latitude = 48.85 + i * 1e-4
        longitude = 2.35
        accuracy?.let { this.accuracy = it }
    }

    private fun command(action: String?) = action?.let { Intent(app, TrackingService::class.java).setAction(it) }

    private fun createService(): TrackingService =
        Robolectric.buildService(TrackingService::class.java).create().also { controllers += it }.get()

    private fun startedSession(): TrackingService {
        runBlocking { SettingsRepository(app.settingsDataStore).save(Settings("https://pc.tail1234.ts.net", key)) }
        val service = createService()
        assertEquals(Service.START_STICKY, service.onStartCommand(command(TrackingService.ACTION_START), 0, 1))
        awaitUntil(message = "location updates requested") { fake.requests == 1 }
        return service
    }

    // Matrix "Start": session row created, foreground type location, persistent notification, 5 s updates.
    @Test
    fun startCreatesSessionAndRunsInForegroundWithLocationType() {
        val service = startedSession()

        val session = dao.activeSession()
        assertNotNull(session)
        assertTrue(session!!.sessionId, uuidV4.matches(session.sessionId))
        assertEquals(key, session.runnerKey)
        assertEquals(0L, session.nextSeq)
        assertTrue(session.sessionStartedAt > 0)

        val shadow = shadowOf(service)
        assertNotNull(shadow.lastForegroundNotification)
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION, service.foregroundServiceType)
        val notification = shadow.lastForegroundNotification
        assertTrue("persistent notification", notification.flags and android.app.Notification.FLAG_ONGOING_EVENT != 0)
        // Decision: no Stop action in the notification.
        assertTrue(notification.actions.isNullOrEmpty())
        assertEquals(5_000L, fake.intervalMs)
        assertFalse(shadow.isStoppedBySelf)
    }

    // Matrix "Valid fix" / "Bad fix": valid fixes get the next seq and bump the count; bad ones consume nothing.
    @Test
    fun validFixesGetNextSeqAndBadFixesAreDropped() {
        startedSession()
        val id = dao.activeSession()!!.sessionId

        fake.deliver(location(0))
        fake.deliver(location(1, accuracy = null)) // no accuracy
        fake.deliver(location(2).apply { latitude = 91.0 })
        fake.deliver(location(3).apply { latitude = Double.NaN })
        fake.deliver(location(4))

        assertEquals(listOf(0L, 1L), dao.outbox(id).map { it.seq })
        assertEquals(listOf(location(0).time, location(4).time), dao.outbox(id).map { it.recordedAt })
        assertEquals(2L, dao.session(id)!!.fixCount)
    }

    // Matrix "Stop": updates removed, queued fixes written, then `end` with the next seq; session ended; service stops.
    @Test
    fun stopWritesEndAfterFixesEndsSessionAndStopsService() {
        val service = startedSession()
        val id = dao.activeSession()!!.sessionId
        fake.deliver(location(0), location(1))
        fake.deliver(location(2))

        service.onStartCommand(command(TrackingService.ACTION_STOP), 0, 2)
        awaitUntil(message = "service stopped itself") { shadowOf(service).isStoppedBySelf }

        assertEquals(1, fake.removes)
        val rows = dao.outbox(id)
        assertEquals(listOf(0L, 1L, 2L, 3L), rows.map { it.seq })
        assertEquals(listOf("fix", "fix", "fix", "end"), rows.map { it.kind })
        val session = dao.session(id)!!
        assertNotNull(session.endedAt)
        assertEquals(3L, session.fixCount)
        assertNull(dao.activeSession())
        assertTrue(shadowOf(service).isStoppedBySelf)
        assertTrue(shadowOf(service).isForegroundStopped)

        // A fix arriving after `end` is dropped.
        fake.deliver(location(3))
        assertEquals(4, dao.outbox(id).size)
        assertEquals(3L, dao.session(id)!!.fixCount)
    }

    // Matrix "OS restart": START_STICKY with a null intent resumes the active session at the next seq.
    @Test
    fun nullIntentResumesActiveSessionAtNextSeq() {
        val id = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b"
        dao.insertSession(SessionEntity(sessionId = id, sessionStartedAt = 900, runnerKey = key))
        repeat(3) { dao.appendFix(id, ValidFix(1_000L + it, 48.0, 2.0, 4.0)) }

        val service = createService()
        assertEquals(Service.START_STICKY, service.onStartCommand(null, 0, 1))
        awaitUntil(message = "location updates requested") { fake.requests == 1 }
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION, service.foregroundServiceType)

        fake.deliver(location(0))
        assertEquals(listOf(0L, 1L, 2L, 3L), dao.outbox(id).map { it.seq })
        assertEquals(4L, dao.session(id)!!.fixCount)
        assertEquals(id, dao.activeSession()!!.sessionId)
        assertFalse(shadowOf(service).isStoppedBySelf)
    }

    // Matrix "OS restart", no active session: stopSelf().
    @Test
    fun nullIntentWithoutActiveSessionStopsItself() {
        val service = createService()
        service.onStartCommand(null, 0, 1)
        awaitUntil(message = "service stopped itself") { shadowOf(service).isStoppedBySelf }
        settle(100)
        assertEquals(0, fake.requests)
        assertNull(dao.activeSession())
    }

    // Matrix "App opened, session active, service dead": the Resume command continues the same session.
    @Test
    fun resumeCommandContinuesActiveSession() {
        val id = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b"
        dao.insertSession(SessionEntity(sessionId = id, sessionStartedAt = 900, runnerKey = key))
        dao.appendFix(id, ValidFix(1_000L, 48.0, 2.0, 4.0))

        val service = createService()
        service.onStartCommand(command(TrackingService.ACTION_RESUME), 0, 1)
        awaitUntil(message = "location updates requested") { fake.requests == 1 }
        fake.deliver(location(0))
        assertEquals(listOf(0L, 1L), dao.outbox(id).map { it.seq })
    }

    private fun assertStoppedAndOutOfForeground(service: TrackingService) {
        awaitUntil(message = "service stopped itself") { shadowOf(service).isStoppedBySelf }
        assertTrue(shadowOf(service).isForegroundStopped)
    }

    // A Resume arriving during Stop (newer startId) must not keep the service foreground.
    @Test
    fun resumeDuringStopStillStopsTheService() {
        val service = startedSession()
        val id = dao.activeSession()!!.sessionId
        service.onStartCommand(command(TrackingService.ACTION_STOP), 0, 2)
        service.onStartCommand(command(TrackingService.ACTION_RESUME), 0, 3)
        assertStoppedAndOutOfForeground(service)
        assertNotNull(dao.session(id)!!.endedAt)
        assertEquals("end", dao.outbox(id).last().kind)
    }

    // Stop goes foreground as dataSync, so it writes `end` even with location revoked.
    @Test
    fun stopWithLocationPermissionRevokedStillWritesEnd() {
        val id = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b"
        dao.insertSession(SessionEntity(sessionId = id, sessionStartedAt = 900, runnerKey = key))
        dao.appendFix(id, ValidFix(1_000L, 48.0, 2.0, 4.0))
        shadowOf(app).denyPermissions(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.ACCESS_BACKGROUND_LOCATION,
        )

        val service = createService()
        service.onStartCommand(command(TrackingService.ACTION_STOP), 0, 1)
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC, service.foregroundServiceType)
        assertStoppedAndOutOfForeground(service)
        assertEquals(listOf("fix", "end"), dao.outbox(id).map { it.kind })
        assertNull(dao.activeSession())
    }

    // Design note: once remove() returns, a callback already dispatched is queued ahead of `end`.
    @Test
    fun stopWritesFixStillInFlightBeforeEnd() {
        val service = startedSession()
        val id = dao.activeSession()!!.sessionId
        fake.deliver(location(0))
        fake.onRemove = { fake.dispatch(location(1)) }

        service.onStartCommand(command(TrackingService.ACTION_STOP), 0, 2)
        assertStoppedAndOutOfForeground(service)

        val rows = dao.outbox(id)
        assertEquals(listOf(0L, 1L, 2L), rows.map { it.seq })
        assertEquals(listOf("fix", "fix", "end"), rows.map { it.kind })
        assertEquals(2L, dao.session(id)!!.fixCount)
    }

    // Stop as the first command to a fresh service (process was dead) ends the persisted session.
    @Test
    fun stopAsFirstCommandEndsPersistedSession() {
        val id = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b"
        dao.insertSession(SessionEntity(sessionId = id, sessionStartedAt = 900, runnerKey = key))

        val service = createService()
        service.onStartCommand(command(TrackingService.ACTION_STOP), 0, 1)
        assertStoppedAndOutOfForeground(service)
        assertEquals(listOf(com.runninglivetracker.tracking.db.OutboxEntity.KIND_END), dao.outbox(id).map { it.kind })
        assertEquals(0L, dao.outbox(id).single().seq)
        assertNull(dao.activeSession())
    }

    @Test
    fun startWithInvalidSettingsCreatesNoSessionAndStops() {
        runBlocking { SettingsRepository(app.settingsDataStore).save(Settings("", "not-a-key")) }
        val service = createService()
        service.onStartCommand(command(TrackingService.ACTION_START), 0, 1)
        awaitUntil(message = "service stopped itself") { shadowOf(service).isStoppedBySelf }
        settle(100)
        assertNull(dao.activeSession())
        assertEquals(0, fake.requests)
    }

    // ---- uploader (Story 2.3) ----

    private val release = CountDownLatch(1)

    private fun ackAll(): (IngestBatch) -> IngestResult =
        { IngestResult.Acked(IngestAck(it.sessionId, it.records.last().seq, 1_760_000_000_000)) }

    // The service owns the uploader: recorded fixes are sent and acked rows leave the outbox.
    @Test
    fun uploaderDrainsTheOutboxWhileTracking() {
        ingest.respond = ackAll()
        startedSession()
        val id = dao.activeSession()!!.sessionId
        fake.deliver(location(0), location(1))
        connectivity.fire() // flush now instead of waiting for the 10 s tick
        awaitUntil(message = "outbox drained") { dao.outbox(id).isEmpty() && ingest.batches.isNotEmpty() }
        assertEquals(key, dao.session(id)!!.runnerKey)
        assertNotNull(dao.session(id)!!.lastAckedAt)
        assertEquals(listOf(0L, 1L), ingest.batches.flatMap { b -> b.records.map { it.seq } }.distinct())
        assertEquals(2L, dao.session(id)!!.fixCount)
    }

    // Acceptance: a fix written while uploads fail (here: hang) gets the next seq without waiting on HTTP.
    @Test
    fun recordingNeverWaitsOnAStuckUpload() {
        val inFlight = CountDownLatch(1)
        ingest.respond = {
            inFlight.countDown()
            release.await(30, TimeUnit.SECONDS)
            IngestResult.Retry("timeout")
        }
        startedSession()
        val id = dao.activeSession()!!.sessionId
        fake.deliver(location(0))
        connectivity.fire()
        assertTrue("upload started", inFlight.await(5, TimeUnit.SECONDS))

        fake.deliver(location(1))
        fake.deliver(location(2))
        assertEquals(listOf(0L, 1L, 2L), dao.outbox(id).map { it.seq })
        assertEquals(3L, dao.session(id)!!.nextSeq)
        release.countDown()
    }

    // The loop survives an unexpected exception from a flush (caught in Uploader.run) and drains later.
    @Test
    fun uploaderSurvivesAnExceptionAndDrainsAfterwards() {
        val ack = ackAll()
        ingest.respond = { if (ingest.batches.size == 1) throw RuntimeException("boom") else ack(it) }
        startedSession()
        val id = dao.activeSession()!!.sessionId
        fake.deliver(location(0), location(1))
        connectivity.fire()
        awaitUntil(message = "outbox drained after the exception") { dao.outbox(id).isEmpty() }
        assertTrue(ingest.batches.size >= 2)
        assertNotNull(dao.session(id)!!.lastAckedAt)
    }

    @Test
    fun connectivityCallbackIsUnregisteredOnDestroy() {
        val controller = Robolectric.buildService(TrackingService::class.java).create()
        assertNotNull(connectivity.callback)
        assertFalse(connectivity.unregistered)
        controller.destroy()
        assertTrue(connectivity.unregistered)
    }
}
