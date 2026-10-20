package com.runninglivetracker.ui

import android.content.Context
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.test.core.app.ApplicationProvider
import com.runninglivetracker.R
import com.runninglivetracker.settings.HealthClient
import com.runninglivetracker.settings.Settings
import com.runninglivetracker.settings.SettingsRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import okio.Path.Companion.toOkioPath
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Matrix "Key edit during session": key field disabled, message shown.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SettingsScreenTest {

    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val tmp = TemporaryFolder()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private lateinit var repository: SettingsRepository

    @Before
    fun setUp() {
        val file = tmp.root.resolve("settings.preferences_pb")
        repository = SettingsRepository(PreferenceDataStoreFactory.createWithPath(scope = scope) { file.toOkioPath() })
        runBlocking { repository.save(Settings("https://pc.tail1234.ts.net", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_6")) }
    }

    @After
    fun tearDown() = runBlocking { scope.coroutineContext[Job]!!.cancelAndJoin() }

    private fun show(keyLocked: Boolean) {
        compose.setContent { SettingsScreen(repository, HealthClient(), allowCleartext = false, keyLocked = keyLocked) }
        // Loaded once the URL field is enabled.
        compose.waitUntil(5_000) {
            compose.onAllNodes(hasSetTextAction() and hasText(context.getString(R.string.base_url_label)) and isEnabled())
                .fetchSemanticsNodes().isNotEmpty()
        }
    }

    // A disabled text field drops its SetText action, so match on the label alone.
    private fun keyField() = compose.onNode(hasText(context.getString(R.string.runner_key_label)))

    @Test
    fun keyFieldIsDisabledWithMessageWhileASessionIsActive() {
        show(keyLocked = true)
        keyField().assertIsNotEnabled()
        compose.onNodeWithText(context.getString(R.string.key_locked)).assertExists()
    }

    @Test
    fun keyFieldIsEditableWithoutASession() {
        show(keyLocked = false)
        compose.onNode(hasSetTextAction() and hasText(context.getString(R.string.runner_key_label))).assertIsEnabled()
        compose.onNodeWithText(context.getString(R.string.key_locked)).assertDoesNotExist()
    }
}
