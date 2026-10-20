package com.runninglivetracker.testing

import android.os.Looper
import org.junit.Assert.fail
import org.robolectric.Shadows.shadowOf

/**
 * Runs the (paused) Robolectric main looper until [condition] holds. Work done on real
 * background threads (the service's writer, Dispatchers.IO) posts back to the main looper.
 */
fun awaitUntil(timeoutMs: Long = 5_000, message: String = "condition", condition: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (true) {
        shadowOf(Looper.getMainLooper()).idle()
        if (condition()) return
        if (System.currentTimeMillis() > deadline) fail("Timed out waiting for $message")
        Thread.sleep(10)
    }
}

/** Keeps the main looper running for [ms] (used before asserting that something did NOT happen). */
fun settle(ms: Long = 500) {
    val end = System.currentTimeMillis() + ms
    while (System.currentTimeMillis() < end) {
        shadowOf(Looper.getMainLooper()).idle()
        Thread.sleep(10)
    }
}
