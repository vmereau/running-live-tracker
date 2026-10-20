package com.runninglivetracker.tracking.db

import android.content.Context
import androidx.room.AutoMigration
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

/**
 * v1: sessions + outbox (Story 2.2). v2: `sessions.lastAckedAt` and the `quarantine` table
 * (Story 2.3), an auto-migration that keeps every session and outbox row. No destructive fallback.
 */
@Database(
    entities = [SessionEntity::class, OutboxEntity::class, QuarantineEntity::class],
    version = 2,
    exportSchema = true,
    autoMigrations = [AutoMigration(from = 1, to = 2)],
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun trackingDao(): TrackingDao

    companion object {
        const val NAME = "tracking.db"

        @Volatile
        private var instance: AppDatabase? = null

        /** One instance per process, shared by the service (writer) and the UI (observer). */
        fun get(context: Context): AppDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(context.applicationContext, AppDatabase::class.java, NAME)
                    .build()
                    .also { instance = it }
            }

        /** Test seam: JVM tests install an in-memory database (null resets). */
        @androidx.annotation.VisibleForTesting
        internal fun setInstanceForTest(db: AppDatabase?) {
            synchronized(this) { instance = db }
        }
    }
}
