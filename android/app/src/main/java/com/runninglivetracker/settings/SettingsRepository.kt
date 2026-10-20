package com.runninglivetracker.settings

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/** The only two things the app stores. Empty strings mean "not set yet". */
data class Settings(val baseUrl: String, val runnerKey: String) {
    // Never print the runner key (logs, crash reports).
    override fun toString(): String = "Settings(baseUrl=$baseUrl, runnerKey=${if (runnerKey.isEmpty()) "" else "***"})"
}

val Context.settingsDataStore: DataStore<Preferences> by preferencesDataStore(name = "settings")

/** Settings persisted in DataStore Preferences. Callers save values already validated by [SettingsValidation]. */
class SettingsRepository(private val dataStore: DataStore<Preferences>) {

    val settings: Flow<Settings> = dataStore.data.map {
        Settings(baseUrl = it[BASE_URL] ?: "", runnerKey = it[RUNNER_KEY] ?: "")
    }

    suspend fun save(settings: Settings) {
        dataStore.edit {
            it[BASE_URL] = settings.baseUrl
            it[RUNNER_KEY] = settings.runnerKey
        }
    }

    companion object {
        val BASE_URL = stringPreferencesKey("baseUrl")
        val RUNNER_KEY = stringPreferencesKey("runnerKey")
    }
}
