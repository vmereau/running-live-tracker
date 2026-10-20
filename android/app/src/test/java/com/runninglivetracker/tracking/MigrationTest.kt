package com.runninglivetracker.tracking

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.runninglivetracker.tracking.db.AppDatabase
import com.runninglivetracker.tracking.db.OutboxEntity
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

/** A v1 database (Story 2.2) opened by the v2 app keeps every session and outbox row. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MigrationTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val name = "migration-test.db"
    private val sessionId = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b"
    private val key = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_6"
    private var room: AppDatabase? = null

    @After
    fun tearDown() {
        room?.close()
        context.deleteDatabase(name)
    }

    private fun schema(version: Int): File {
        val dir = System.getProperty("roomSchemasDir") ?: "schemas"
        return File(dir, "com.runninglivetracker.tracking.db.AppDatabase/$version.json")
    }

    /** Creates the database exactly as Room v1 did, from the committed `1.json`. */
    private fun createV1() {
        val json = Json.parseToJsonElement(schema(1).readText()).jsonObject["database"]!!.jsonObject
        assertEquals(1, json["version"]!!.jsonPrimitive.content.toInt())
        val file = context.getDatabasePath(name).also { it.parentFile!!.mkdirs() }
        SQLiteDatabase.openOrCreateDatabase(file, null).use { db ->
            for (entity in json["entities"]!!.jsonArray) {
                val table = entity.jsonObject["tableName"]!!.jsonPrimitive.content
                db.execSQL(entity.jsonObject["createSql"]!!.jsonPrimitive.content.replace("\${TABLE_NAME}", table))
            }
            for (query in json["setupQueries"]!!.jsonArray) db.execSQL(query.jsonPrimitive.content)
            db.version = 1
            db.execSQL(
                "INSERT INTO sessions (sessionId, sessionStartedAt, runnerKey, nextSeq, fixCount, endedAt) VALUES (?, ?, ?, ?, ?, ?)",
                arrayOf<Any?>(sessionId, 900L, key, 2L, 1L, 5_000L),
            )
            db.execSQL(
                "INSERT INTO outbox (sessionId, seq, kind, recordedAt, lat, lon, accuracyM, altitudeM, speedMps) " +
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                arrayOf<Any?>(sessionId, 0L, "fix", 1_000L, 48.85, 2.35, 4.0, null, 3.0),
            )
            db.execSQL(
                "INSERT INTO outbox (sessionId, seq, kind, recordedAt) VALUES (?, ?, ?, ?)",
                arrayOf<Any?>(sessionId, 1L, "end", 5_000L),
            )
        }
    }

    @Test
    fun v1RowsSurviveTheUpgradeToV2() {
        createV1()

        val db = Room.databaseBuilder(context, AppDatabase::class.java, name).allowMainThreadQueries().build()
        room = db
        val dao = db.trackingDao()

        val session = dao.session(sessionId)!!
        assertEquals(900L, session.sessionStartedAt)
        assertEquals(key, session.runnerKey)
        assertEquals(2L, session.nextSeq)
        assertEquals(1L, session.fixCount)
        assertEquals(5_000L, session.endedAt)
        assertNull(session.lastAckedAt)

        val rows = dao.outbox(sessionId)
        assertEquals(
            listOf(
                OutboxEntity(sessionId, 0, "fix", 1_000, lat = 48.85, lon = 2.35, accuracyM = 4.0, speedMps = 3.0),
                OutboxEntity(sessionId, 1, "end", 5_000),
            ),
            rows,
        )
        assertTrue(dao.quarantined().isEmpty())
        assertEquals(sessionId, dao.nextUploadSession()!!.sessionId)
        runBlocking {
            assertEquals(2L, dao.observePendingCount().first())
            assertEquals(0L, dao.observeQuarantineCount().first())
            assertNull(dao.observeLastAckedAt().first())
        }
        assertEquals(2, db.openHelper.readableDatabase.version)
    }

    @Test
    fun committedV2SchemaHasTheQuarantineTable() {
        val text = schema(2).readText()
        assertTrue(text.contains("\"tableName\": \"quarantine\""))
        assertTrue(text.contains("`lastAckedAt` INTEGER"))
    }
}
