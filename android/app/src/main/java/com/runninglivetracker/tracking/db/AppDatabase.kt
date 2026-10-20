package com.runninglivetracker.tracking.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(entities = [SessionEntity::class, OutboxEntity::class], version = 1, exportSchema = true)
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
