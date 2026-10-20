package com.runninglivetracker

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import com.runninglivetracker.settings.HealthClient
import com.runninglivetracker.settings.Settings
import com.runninglivetracker.settings.SettingsRepository
import com.runninglivetracker.settings.SettingsValidation
import com.runninglivetracker.settings.Validated
import com.runninglivetracker.settings.settingsDataStore
import com.runninglivetracker.tracking.TrackingService
import com.runninglivetracker.tracking.db.AppDatabase
import com.runninglivetracker.ui.MainScreen
import com.runninglivetracker.ui.SettingsScreen
import com.runninglivetracker.ui.SetupScreen
import com.runninglivetracker.ui.permissionState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private enum class Screen { Main, Setup, Settings }

class MainActivity : ComponentActivity() {

    /**
     * On every resume (fresh launch, reopened from recents after process death, back from a
     * permission page): a session is active but the service may have died, so ask it to resume.
     * Only location is needed to record; Start still requires every permission. Resume is
     * idempotent in the service.
     */
    override fun onResume() {
        super.onResume()
        val dao = AppDatabase.get(this).trackingDao()
        lifecycleScope.launch {
            val active = withContext(Dispatchers.IO) { dao.activeSession() }
            if (active != null && permissionState().location) {
                TrackingService.send(this@MainActivity, TrackingService.ACTION_RESUME)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val repository = SettingsRepository(applicationContext.settingsDataStore)
        val healthClient = HealthClient()
        val dao = AppDatabase.get(this).trackingDao()
        // Cleartext (http://localhost, http://10.0.2.2) is a debug-only convenience.
        val allowCleartext = BuildConfig.DEBUG
        val activeSession = dao.observeActiveSession()


        setContent {
            MaterialTheme {
                Surface {
                    val session by activeSession.collectAsStateWithLifecycle(initialValue = null)
                    val settings by repository.settings.collectAsStateWithLifecycle(initialValue = Settings("", ""))
                    var permissions by remember { mutableStateOf(permissionState()) }
                    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { permissions = permissionState() }
                    var screen by rememberSaveable { mutableStateOf(Screen.Main) }
                    BackHandler(enabled = screen != Screen.Main) { screen = Screen.Main }

                    val settingsValid = SettingsValidation.validateKey(settings.runnerKey) is Validated.Ok &&
                        SettingsValidation.validateBaseUrl(settings.baseUrl, allowCleartext) is Validated.Ok

                    when (screen) {
                        Screen.Main -> MainScreen(
                            session = session,
                            settingsValid = settingsValid,
                            permissionsGranted = permissions.allGranted,
                            onStart = { TrackingService.send(this, TrackingService.ACTION_START) },
                            onStop = { TrackingService.send(this, TrackingService.ACTION_STOP) },
                            onOpenSettings = { screen = Screen.Settings },
                            onOpenSetup = { screen = Screen.Setup },
                        )
                        Screen.Setup -> SetupScreen(
                            permissions = permissions,
                            onChanged = { permissions = permissionState() },
                            onBack = { screen = Screen.Main },
                        )
                        Screen.Settings -> SettingsScreen(
                            repository,
                            healthClient,
                            allowCleartext = allowCleartext,
                            keyLocked = session != null,
                            onBack = { screen = Screen.Main },
                        )
                    }
                }
            }
        }
    }
}
