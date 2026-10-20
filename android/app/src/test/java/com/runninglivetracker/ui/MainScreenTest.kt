package com.runninglivetracker.ui

import android.content.Context
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import com.runninglivetracker.R
import com.runninglivetracker.tracking.db.SessionEntity
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainScreenTest {

    @get:Rule
    val compose = createComposeRule()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private fun s(id: Int) = context.getString(id)

    private var starts = 0
    private var stops = 0

    private val session = SessionEntity(
        sessionId = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b",
        sessionStartedAt = System.currentTimeMillis() - 65_000,
        runnerKey = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_6",
        fixCount = 12,
    )

    private fun show(
        session: SessionEntity?,
        settingsValid: Boolean,
        permissionsGranted: Boolean,
        upload: UploadStatus = UploadStatus(),
    ) {
        compose.setContent {
            MainScreen(
                session = session,
                upload = upload,
                settingsValid = settingsValid,
                permissionsGranted = permissionsGranted,
                onStart = { starts++ },
                onStop = { stops++ },
                onOpenSettings = {},
                onOpenSetup = {},
            )
        }
    }

    private fun startButton() = compose.onNode(hasText(s(R.string.start)) and hasClickAction())

    // Matrix "Missing permission": Start disabled, reason shown.
    @Test
    fun startIsDisabledWhenAPermissionIsMissing() {
        show(session = null, settingsValid = true, permissionsGranted = false)
        startButton().assertIsNotEnabled()
        compose.onNodeWithText(s(R.string.start_needs_permissions)).assertIsDisplayed()
        compose.onNodeWithText(s(R.string.start_needs_settings)).assertDoesNotExist()
    }

    @Test
    fun startIsDisabledWhenSettingsAreInvalid() {
        show(session = null, settingsValid = false, permissionsGranted = true)
        startButton().assertIsNotEnabled()
        compose.onNodeWithText(s(R.string.start_needs_settings)).assertIsDisplayed()
        compose.onNodeWithText(s(R.string.start_needs_permissions)).assertDoesNotExist()
    }

    @Test
    fun startIsEnabledWhenSettingsAndPermissionsAreOk() {
        show(session = null, settingsValid = true, permissionsGranted = true)
        startButton().assertIsEnabled().performClick()
        assertEquals(1, starts)
        compose.onNodeWithText(s(R.string.state_stopped)).assertIsDisplayed()
    }

    @Test
    fun activeSessionShowsStateElapsedAndFixCount() {
        show(session = session, settingsValid = true, permissionsGranted = true)
        compose.onNodeWithText(s(R.string.state_tracking)).assertIsDisplayed()
        compose.onNodeWithText("12").assertIsDisplayed()
        compose.onNodeWithText("0:01:05", substring = true).assertExists()
        startButton().assertDoesNotExist()
    }

    // Matrix "Stop tapped": confirmation dialog; only "Stop" sends the command, Cancel keeps tracking.
    @Test
    fun stopAsksForConfirmationAndOnlyConfirmCallsOnStop() {
        show(session = session, settingsValid = true, permissionsGranted = true)

        compose.onNode(hasText(s(R.string.stop)) and hasClickAction()).performClick()
        compose.onNodeWithText(s(R.string.stop_confirm_title)).assertIsDisplayed()
        assertEquals(0, stops)

        compose.onNodeWithText(s(R.string.cancel)).performClick()
        compose.onNodeWithText(s(R.string.stop_confirm_title)).assertDoesNotExist()
        assertEquals(0, stops)

        compose.onNode(hasText(s(R.string.stop)) and hasClickAction()).performClick()
        compose.onNode(hasText(s(R.string.stop)) and hasAnyAncestor(isDialog())).performClick()
        compose.onNodeWithText(s(R.string.stop_confirm_title)).assertDoesNotExist()
        assertEquals(1, stops)
    }

    // Main-screen contents: pending records, last ack time (local HH:mm:ss) and quarantined count.
    @Test
    fun uploadCountersAreShown() {
        val ackedAt = LocalDateTime.of(2026, 10, 20, 9, 5, 7).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
        show(session = session, settingsValid = true, permissionsGranted = true, upload = UploadStatus(37, ackedAt, 4))
        compose.onNodeWithText(s(R.string.pending_label)).assertIsDisplayed()
        compose.onNodeWithText("37").assertIsDisplayed()
        compose.onNodeWithText(s(R.string.last_ack_label)).assertIsDisplayed()
        compose.onNodeWithText("09:05:07").assertIsDisplayed()
        compose.onNodeWithText(s(R.string.quarantined_label)).assertIsDisplayed()
        compose.onNodeWithText("4").assertIsDisplayed()
    }

    @Test
    fun noAckYetShowsADash() {
        show(session = null, settingsValid = true, permissionsGranted = true)
        compose.onNodeWithText(s(R.string.last_ack_none)).assertIsDisplayed()
    }

    @Test
    fun ackTimeIsLocalHoursMinutesSeconds() {
        val utc = ZoneOffset.UTC
        assertEquals("00:00:01", formatAckTime(1_000, utc))
        assertEquals("08:53:20", formatAckTime(1_760_000_000_000, utc))
        assertEquals(null, formatAckTime(null, utc))
    }
}
