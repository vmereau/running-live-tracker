package com.runninglivetracker.settings

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okio.Path.Companion.toOkioPath
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SettingsRepositoryTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private val key = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_6"

    /** A fresh DataStore over the same file stands in for the app being killed and reopened. */
    private fun <T> withRepository(block: suspend (SettingsRepository) -> T): T {
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        val file = tmp.root.resolve("settings.preferences_pb")
        val dataStore = PreferenceDataStoreFactory.createWithPath(scope = scope) { file.toOkioPath() }
        return try {
            runBlocking { block(SettingsRepository(dataStore)) }
        } finally {
            // Wait for the scope to finish so the next DataStore on this file is not "still active".
            runBlocking { scope.coroutineContext[Job]!!.cancelAndJoin() }
        }
    }

    @Test
    fun unsetSettingsAreEmpty() {
        assertEquals(Settings("", ""), withRepository { it.settings.first() })
    }

    @Test
    fun savedSettingsSurviveARestart() {
        withRepository { it.save(Settings("https://pc.tail1234.ts.net", key)) }
        assertEquals(Settings("https://pc.tail1234.ts.net", key), withRepository { it.settings.first() })
    }
}
