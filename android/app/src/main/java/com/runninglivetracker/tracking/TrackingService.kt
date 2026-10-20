package com.runninglivetracker.tracking

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.annotation.VisibleForTesting
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.runninglivetracker.BuildConfig
import com.runninglivetracker.MainActivity
import com.runninglivetracker.R
import com.runninglivetracker.settings.SettingsRepository
import com.runninglivetracker.settings.SettingsValidation
import com.runninglivetracker.settings.Validated
import com.runninglivetracker.settings.settingsDataStore
import com.runninglivetracker.tracking.db.AppDatabase
import com.runninglivetracker.tracking.db.SessionEntity
import com.runninglivetracker.tracking.db.TrackingDao
import com.runninglivetracker.upload.AndroidConnectivitySource
import com.runninglivetracker.upload.ConnectivitySource
import com.runninglivetracker.upload.IngestClient
import com.runninglivetracker.upload.Uploader
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The only writer of sessions and outbox rows. Commands: [ACTION_START], [ACTION_STOP],
 * [ACTION_RESUME], [ACTION_DRAIN]; a null intent is a `START_STICKY` restart and resumes like
 * [ACTION_RESUME].
 *
 * Threading: one single-thread [writer] receives the FusedLocation callbacks and runs every DB
 * write, so seq allocation is serialized. [sessionId] is confined to that thread. On Stop,
 * `removeLocationUpdates` is awaited first; every callback already dispatched is then queued on
 * [writer] ahead of `appendEnd`, and the ended-session check in the DAO drops anything later.
 *
 * Uploading: an [Uploader] coroutine on Dispatchers.IO drains the outbox while the service lives
 * (every 10 s, and at once when [connectivity] reports a network). It never touches [writer] or
 * seq allocation, so recording never waits on the network.
 *
 * Draining: with no active session and a non-empty outbox (after Stop, on a sticky restart, or on
 * [ACTION_DRAIN] from the app), the service stays foreground as `dataSync` with "Uploading N
 * pending" and stops itself once the outbox is empty. Draining is derived from Room, never
 * persisted. A Start cancels it; the OS `dataSync` timeout ([onTimeout]) ends it with rows kept.
 */
class TrackingService : Service() {

    private val writer: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "tracking-writer") }
    private val mainHandler = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private lateinit var dao: TrackingDao
    private lateinit var locations: LocationSource
    private lateinit var connectivity: ConnectivitySource

    /** Fired when a network becomes available; conflated, so a burst means one extra flush. */
    private val uploadTrigger = Channel<Unit>(Channel.CONFLATED)

    /** Active session being recorded. Accessed only on [writer]. */
    private var sessionId: String? = null

    /** Accessed only on the main thread. */
    private var updatesRequested = false
    private var stopping = false
    private var draining = false
    private var drainJob: Job? = null
    private var foregroundType = 0
    private var notificationTitle = 0
    private var notificationText = ""

    /** Delivered on [writer] (see [requestUpdates]). */
    private fun onLocations(batch: List<Location>) {
        val id = sessionId ?: return
        for (location in batch) record(id, location)
    }

    override fun onCreate() {
        super.onCreate()
        dao = AppDatabase.get(this).trackingDao()
        locations = locationSourceFactory(this)
        createChannel()
        showTrackingText()
        startUploader()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        if (action == ACTION_START) cancelDraining()
        // Every command arrives through startForegroundService: go foreground right away. Stop uses
        // dataSync so it can still write `end` if the location permission was revoked. Drain (or
        // any non-Start command while draining) uses dataSync too, unless location updates run.
        val dataSync = action == ACTION_STOP ||
            (action != ACTION_START && !updatesRequested && (action == ACTION_DRAIN || draining))
        val type = if (dataSync) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        } else {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        }
        if (!enterForeground(type)) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        when (action) {
            ACTION_START -> start(startId)
            ACTION_STOP -> stop()
            else -> resume(startId) // ACTION_RESUME, ACTION_DRAIN or a sticky restart (null intent)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        if (updatesRequested) {
            // Fire and forget: the scope is cancelled right after.
            val source = locations
            CoroutineScope(Dispatchers.Main).launch { runCatching { source.remove() } }
        }
        updatesRequested = false
        draining = false
        connectivity.unregister()
        scope.cancel() // stops the uploader
        uploadTrigger.close()
        writer.shutdown() // queued writes still run
        super.onDestroy()
    }

    // ---- commands ----

    private fun start(startId: Int) {
        stopping = false
        writer.execute {
            val existing = dao.activeSession()
            val session = existing ?: createSession()
            if (session == null) {
                Log.w(TAG, "Start refused: settings are not valid")
                mainHandler.post { stopSelf(startId) }
                return@execute
            }
            sessionId = session.sessionId
            Log.i(TAG, if (existing != null) "Start: resuming ${session.sessionId}" else "Start: new session ${session.sessionId}")
            mainHandler.post { requestUpdates() }
        }
    }

    private fun resume(startId: Int) {
        writer.execute {
            val session = dao.activeSession()
            if (session == null) {
                val pending = dao.pendingCount()
                Log.i(TAG, "Resume: no active session, $pending pending")
                mainHandler.post {
                    when {
                        stopping -> Unit // Stop decides between draining and stopping
                        draining -> uploadTrigger.trySend(Unit)
                        pending > 0 -> startDraining(pending)
                        stopSelfResult(startId) -> leaveForeground()
                    }
                }
                return@execute
            }
            sessionId = session.sessionId
            Log.i(TAG, "Resume: session ${session.sessionId} at seq ${session.nextSeq}")
            mainHandler.post {
                if (stopping) return@post
                // A Drain on a fresh service went foreground as dataSync: tracking needs location.
                if (foregroundType != ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION) {
                    enterForeground(ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
                }
                requestUpdates()
            }
        }
    }

    private fun stop() {
        stopping = true
        scope.launch {
            try {
                locations.remove()
            } catch (e: Exception) {
                Log.w(TAG, "removeLocationUpdates failed", e)
            }
            updatesRequested = false
            // Queued behind every callback FusedLocation already dispatched to the writer.
            writer.execute {
                val id = sessionId ?: dao.activeSession()?.sessionId
                if (id != null) {
                    val now = System.currentTimeMillis()
                    val seq = dao.appendEnd(id, recordedAt = now, endedAt = now)
                    Log.i(TAG, "Stop: session $id ended at seq $seq")
                }
                sessionId = null
                val pending = dao.pendingCount()
                mainHandler.post {
                    // A Resume during Stop has a newer startId, so stopSelfResult(startId) would
                    // leave the service foreground forever. Only a Start since then keeps it alive.
                    if (stopping) {
                        stopping = false
                        if (pending > 0) {
                            startDraining(pending)
                        } else {
                            leaveForeground()
                            stopSelf()
                        }
                    }
                }
            }
        }
    }

    // ---- draining (main thread) ----

    /** No active session and rows pending: stay foreground as dataSync until the outbox is empty. */
    private fun startDraining(pending: Long) {
        if (draining) {
            uploadTrigger.trySend(Unit)
            return
        }
        draining = true
        Log.i(TAG, "Draining: uploading pending records")
        setDrainingText(pending) // before going foreground: never show the tracking text after Stop
        if (!enterForeground(ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)) {
            draining = false
            leaveForeground()
            stopSelf()
            return
        }
        uploadTrigger.trySend(Unit) // flush now, not at the next tick
        drainJob = scope.launch {
            dao.observePendingCount().collect { pending ->
                // Re-checked on the main thread: a Start since then has cancelled the drain.
                if (!draining) return@collect
                if (pending == 0L) {
                    Log.i(TAG, "Draining: outbox empty, stopping")
                    finishDraining()
                } else {
                    showDrainingText(pending)
                }
            }
        }
    }

    private fun finishDraining() {
        cancelDraining()
        leaveForeground()
        stopSelf()
    }

    private fun cancelDraining() {
        if (!draining && drainJob == null) return
        draining = false
        drainJob?.cancel()
        drainJob = null
        showTrackingText()
    }

    /**
     * Android 15+ caps dataSync (6 h per 24 h). Must stop within seconds: leave the foreground and
     * stop, keeping the outbox; the next app launch drains again. Only called from API 35, so no
     * super call (the base method does nothing and is missing on older platforms).
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w(TAG, "Foreground service timeout (type $fgsType): stopping, pending rows kept")
        cancelDraining()
        leaveForeground()
        stopSelf()
    }

    // ---- helpers ----

    private fun startUploader() {
        val settings = SettingsRepository(applicationContext.settingsDataStore)
        val uploader = Uploader(
            dao = dao,
            client = ingestClientFactory(),
            baseUrl = { settings.settings.first().baseUrl },
            allowCleartext = BuildConfig.DEBUG,
        )
        scope.launch(Dispatchers.IO) { uploader.run(uploadTrigger) }
        connectivity = connectivitySourceFactory(this)
        connectivity.register { uploadTrigger.trySend(Unit) }
    }

    /** Runs on [writer]. Reads the settings at this moment and persists a new session, or null if they are invalid. */
    private fun createSession(): SessionEntity? {
        val settings = runBlocking { SettingsRepository(applicationContext.settingsDataStore).settings.first() }
        val key = SettingsValidation.validateKey(settings.runnerKey) as? Validated.Ok ?: return null
        if (SettingsValidation.validateBaseUrl(settings.baseUrl, BuildConfig.DEBUG) !is Validated.Ok) return null
        val session = SessionEntity(
            sessionId = UUID.randomUUID().toString(),
            sessionStartedAt = System.currentTimeMillis(),
            runnerKey = key.value,
        )
        dao.insertSession(session)
        return session
    }

    /** Runs on [writer]. */
    private fun record(id: String, location: Location) {
        val fix = FixMapper.map(
            time = location.time,
            latitude = location.latitude,
            longitude = location.longitude,
            hasAccuracy = location.hasAccuracy(),
            accuracyM = location.accuracy,
            hasAltitude = location.hasAltitude(),
            altitudeM = location.altitude,
            hasSpeed = location.hasSpeed(),
            speedMps = location.speed,
        ) ?: return
        dao.appendFix(id, fix)
    }

    /** Main thread. */
    private fun requestUpdates() {
        if (updatesRequested || stopping) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            Log.w(TAG, "Location permission missing: not recording")
            return
        }
        try {
            locations.request(INTERVAL_MS, writer, ::onLocations)
            updatesRequested = true
        } catch (e: SecurityException) {
            Log.w(TAG, "requestLocationUpdates refused", e)
        }
    }

    private fun enterForeground(type: Int): Boolean = try {
        ServiceCompat.startForeground(this, NOTIFICATION_ID, buildNotification(), type)
        foregroundType = type
        true
    } catch (e: RuntimeException) {
        // SecurityException (permission missing) or ForegroundServiceStartNotAllowedException.
        Log.w(TAG, "startForeground failed", e)
        false
    }

    private fun leaveForeground() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        foregroundType = 0
    }

    private fun showTrackingText() {
        notificationTitle = R.string.tracking_notification_title
        notificationText = getString(R.string.tracking_notification_text)
    }

    private fun setDrainingText(pending: Long) {
        notificationTitle = R.string.draining_notification_title
        notificationText = getString(R.string.draining_notification_text, pending)
    }

    /** "Uploading N pending": updates the foreground notification in place (same id, no re-alert). */
    private fun showDrainingText(pending: Long) {
        setDrainingText(pending)
        if (foregroundType != 0) {
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
        }
    }

    private fun createChannel() {
        val channel = NotificationChannel(CHANNEL_ID, getString(R.string.tracking_channel_name), NotificationManager.IMPORTANCE_LOW)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    /** Persistent, no Stop action (a pocket must not stop the run): Stop lives behind a confirmation in the app. */
    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(notificationTitle))
            .setContentText(notificationText)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        private const val TAG = "TrackingService"
        const val ACTION_START = "com.runninglivetracker.action.START"
        const val ACTION_STOP = "com.runninglivetracker.action.STOP"
        const val ACTION_RESUME = "com.runninglivetracker.action.RESUME"

        /** Finish uploading the outbox when no session is active (sent by the app on launch). */
        const val ACTION_DRAIN = "com.runninglivetracker.action.DRAIN"
        private const val CHANNEL_ID = "tracking"
        private const val NOTIFICATION_ID = 1
        private const val INTERVAL_MS = 5_000L

        /** Test seam: JVM tests replace FusedLocation with a fake. */
        @VisibleForTesting
        internal var locationSourceFactory: (Context) -> LocationSource = { FusedLocationSource(it) }

        /** Test seam: JVM tests replace the network callback with a fake. */
        @VisibleForTesting
        internal var connectivitySourceFactory: (Context) -> ConnectivitySource = { AndroidConnectivitySource(it) }

        /** Test seam: JVM tests replace the HTTP client (no real network). */
        @VisibleForTesting
        internal var ingestClientFactory: () -> IngestClient = { IngestClient() }

        fun send(context: Context, action: String) {
            ContextCompat.startForegroundService(context, Intent(context, TrackingService::class.java).setAction(action))
        }
    }
}
