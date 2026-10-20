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
 * [ACTION_RESUME]; a null intent is a `START_STICKY` restart and resumes like [ACTION_RESUME].
 *
 * Threading: one single-thread [writer] receives the FusedLocation callbacks and runs every DB
 * write, so seq allocation is serialized. [sessionId] is confined to that thread. On Stop,
 * `removeLocationUpdates` is awaited first; every callback already dispatched is then queued on
 * [writer] ahead of `appendEnd`, and the ended-session check in the DAO drops anything later.
 *
 * Uploading: an [Uploader] coroutine on Dispatchers.IO drains the outbox while the service lives
 * (every 10 s, and at once when [connectivity] reports a network). It never touches [writer] or
 * seq allocation, so recording never waits on the network.
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
        startUploader()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Every command arrives through startForegroundService: go foreground right away. Stop uses
        // dataSync so it can still write `end` if the location permission was revoked.
        val type = if (intent?.action == ACTION_STOP) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        } else {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        }
        if (!enterForeground(type)) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        when (intent?.action) {
            ACTION_START -> start(startId)
            ACTION_STOP -> stop()
            else -> resume(startId) // ACTION_RESUME or a sticky restart (null intent)
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
                Log.i(TAG, "Resume: no active session")
                mainHandler.post { if (!stopping && stopSelfResult(startId)) leaveForeground() }
                return@execute
            }
            sessionId = session.sessionId
            Log.i(TAG, "Resume: session ${session.sessionId} at seq ${session.nextSeq}")
            mainHandler.post { if (!stopping) requestUpdates() }
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
                mainHandler.post {
                    // A Resume during Stop has a newer startId, so stopSelfResult(startId) would
                    // leave the service foreground forever. Only a Start since then keeps it alive.
                    if (stopping) {
                        stopping = false
                        leaveForeground()
                        stopSelf()
                    }
                }
            }
        }
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
        true
    } catch (e: RuntimeException) {
        // SecurityException (permission missing) or ForegroundServiceStartNotAllowedException.
        Log.w(TAG, "startForeground failed", e)
        false
    }

    private fun leaveForeground() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
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
            .setContentTitle(getString(R.string.tracking_notification_title))
            .setContentText(getString(R.string.tracking_notification_text))
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
