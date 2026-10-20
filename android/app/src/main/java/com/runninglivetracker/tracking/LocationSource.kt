package com.runninglivetracker.tracking

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.tasks.await
import java.util.concurrent.Executor

/**
 * Where [TrackingService] gets its fixes. Production uses FusedLocation; JVM tests swap in a
 * fake through [TrackingService.locationSourceFactory] so they need no Google Play services.
 */
interface LocationSource {
    /** Starts updates every [intervalMs]; [onLocations] runs on [executor]. May throw SecurityException. */
    fun request(intervalMs: Long, executor: Executor, onLocations: (List<Location>) -> Unit)

    /**
     * Stops updates. Returns once the provider has stopped dispatching: every callback already
     * dispatched is queued on the executor by then.
     */
    suspend fun remove()
}

class FusedLocationSource(context: Context) : LocationSource {
    private val client = LocationServices.getFusedLocationProviderClient(context)
    private var callback: LocationCallback? = null

    // Callers check ACCESS_FINE_LOCATION first and catch SecurityException.
    @SuppressLint("MissingPermission")
    override fun request(intervalMs: Long, executor: Executor, onLocations: (List<Location>) -> Unit) {
        val cb = callback ?: object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) = onLocations(result.locations)
        }.also { callback = it }
        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, intervalMs)
            .setMinUpdateIntervalMillis(intervalMs)
            .build()
        client.requestLocationUpdates(request, executor, cb)
    }

    override suspend fun remove() {
        val cb = callback ?: return
        client.removeLocationUpdates(cb).await()
    }
}
