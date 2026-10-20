package com.runninglivetracker.upload

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log

/**
 * Tells the uploader when a network becomes available, so a flush starts at once instead of
 * waiting for the next tick. JVM tests swap in a fake through
 * [com.runninglivetracker.tracking.TrackingService.connectivitySourceFactory].
 */
interface ConnectivitySource {
    /** [onAvailable] may run on any thread, and also right after registering if a network is up. */
    fun register(onAvailable: () -> Unit)

    fun unregister()
}

class AndroidConnectivitySource(context: Context) : ConnectivitySource {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private var callback: ConnectivityManager.NetworkCallback? = null

    override fun register(onAvailable: () -> Unit) {
        if (callback != null) return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = onAvailable()
        }
        try {
            manager.registerDefaultNetworkCallback(cb)
            callback = cb
        } catch (e: RuntimeException) {
            // SecurityException without ACCESS_NETWORK_STATE, or too many callbacks: the 10 s tick still runs.
            Log.w(TAG, "registerDefaultNetworkCallback failed", e)
        }
    }

    override fun unregister() {
        val cb = callback ?: return
        callback = null
        try {
            manager.unregisterNetworkCallback(cb)
        } catch (e: RuntimeException) {
            Log.w(TAG, "unregisterNetworkCallback failed", e)
        }
    }

    private companion object {
        const val TAG = "ConnectivitySource"
    }
}
