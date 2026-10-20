package com.runninglivetracker

import android.Manifest
import android.app.Application
import android.os.Bundle
import android.os.PowerManager
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.runninglivetracker.testing.awaitUntil
import com.runninglivetracker.testing.settle
import com.runninglivetracker.tracking.TrackingService
import com.runninglivetracker.tracking.db.AppDatabase
import com.runninglivetracker.tracking.db.SessionEntity
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

// Matrix "App opened, session active, service dead": the activity sends Resume.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainActivityTest {

    private val app: Application = ApplicationProvider.getApplicationContext()
    private lateinit var db: AppDatabase
    private val key = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_6"

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(app, AppDatabase::class.java).allowMainThreadQueries().build()
        AppDatabase.setInstanceForTest(db)
    }

    @After
    fun tearDown() {
        AppDatabase.setInstanceForTest(null)
        db.close()
    }

    private fun grantEverything() {
        shadowOf(app).grantPermissions(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.ACCESS_BACKGROUND_LOCATION,
            Manifest.permission.POST_NOTIFICATIONS,
        )
        shadowOf(app.getSystemService(PowerManager::class.java)).setIgnoringBatteryOptimizations(app.packageName, true)
    }

    private fun grantLocationOnly() = shadowOf(app).grantPermissions(
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.ACCESS_COARSE_LOCATION,
    )

    private fun assertResumeSent() {
        awaitUntil(message = "a started service") { shadowOf(app).peekNextStartedService() != null }
        val intent = shadowOf(app).nextStartedService
        assertEquals(TrackingService::class.java.name, intent.component?.className)
        assertEquals(TrackingService.ACTION_RESUME, intent.action)
    }

    private fun activeSession() = db.trackingDao().insertSession(
        SessionEntity(sessionId = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b", sessionStartedAt = 900, runnerKey = key),
    )

    @Test
    fun openingTheAppWithAnActiveSessionSendsResume() {
        grantEverything()
        activeSession()
        Robolectric.buildActivity(MainActivity::class.java).setup()

        awaitUntil(message = "a started service") { shadowOf(app).peekNextStartedService() != null }
        val intent = shadowOf(app).nextStartedService
        assertEquals(TrackingService::class.java.name, intent.component?.className)
        assertEquals(TrackingService.ACTION_RESUME, intent.action)
    }

    @Test
    fun openingTheAppWithoutASessionSendsNothing() {
        grantEverything()
        Robolectric.buildActivity(MainActivity::class.java).setup()
        settle()
        assertNull(shadowOf(app).peekNextStartedService())
    }

    // Reopened from recents after process death: the saved bundle is restored, Resume is still sent.
    @Test
    fun recreatedActivityWithSavedStateStillSendsResume() {
        grantEverything()
        activeSession()
        Robolectric.buildActivity(MainActivity::class.java).setup(Bundle())
        assertResumeSent()
    }

    @Test
    fun locationPermissionMissingSendsNoResume() {
        shadowOf(app).grantPermissions(
            Manifest.permission.ACCESS_BACKGROUND_LOCATION,
            Manifest.permission.POST_NOTIFICATIONS,
        )
        shadowOf(app.getSystemService(PowerManager::class.java)).setIgnoringBatteryOptimizations(app.packageName, true)
        activeSession()
        Robolectric.buildActivity(MainActivity::class.java).setup()
        settle()
        assertNull(shadowOf(app).peekNextStartedService())
    }

    // Only location is needed to keep recording; the other permissions gate Start, not Resume.
    @Test
    fun locationGrantedWithoutBatteryExemptionStillSendsResume() {
        grantLocationOnly()
        activeSession()
        Robolectric.buildActivity(MainActivity::class.java).setup()
        assertResumeSent()
    }
}
