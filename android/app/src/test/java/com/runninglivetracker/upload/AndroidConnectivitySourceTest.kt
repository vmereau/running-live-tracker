package com.runninglivetracker.upload

import android.app.Application
import android.net.ConnectivityManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowNetwork

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AndroidConnectivitySourceTest {

    private val app: Application = ApplicationProvider.getApplicationContext()
    private val manager = app.getSystemService(ConnectivityManager::class.java)
    private val callbacks get() = shadowOf(manager).networkCallbacks

    @Test
    fun registerAddsACallbackThatForwardsOnAvailableAndUnregisterRemovesIt() {
        val source = AndroidConnectivitySource(app)
        val before = callbacks.size
        var calls = 0

        source.register { calls++ }
        assertEquals(before + 1, callbacks.size)

        callbacks.forEach { it.onAvailable(ShadowNetwork.newInstance(1)) }
        assertEquals(1, calls)

        source.unregister()
        assertEquals(before, callbacks.size)
    }

    @Test
    fun registeringTwiceKeepsOneCallback() {
        val source = AndroidConnectivitySource(app)
        val before = callbacks.size
        source.register {}
        source.register {}
        assertEquals(before + 1, callbacks.size)
        source.unregister()
        source.unregister() // no-op
        assertTrue(callbacks.size == before)
    }
}
