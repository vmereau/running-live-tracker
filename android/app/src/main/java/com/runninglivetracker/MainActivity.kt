package com.runninglivetracker

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import com.runninglivetracker.settings.HealthClient
import com.runninglivetracker.settings.SettingsRepository
import com.runninglivetracker.settings.settingsDataStore
import com.runninglivetracker.ui.SettingsScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val repository = SettingsRepository(applicationContext.settingsDataStore)
        val healthClient = HealthClient()
        setContent {
            MaterialTheme {
                Surface {
                    // Cleartext (http://localhost, http://10.0.2.2) is a debug-only convenience.
                    SettingsScreen(repository, healthClient, allowCleartext = BuildConfig.DEBUG)
                }
            }
        }
    }
}
