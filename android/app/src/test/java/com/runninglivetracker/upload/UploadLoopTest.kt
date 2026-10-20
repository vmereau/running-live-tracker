package com.runninglivetracker.upload

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/** The [Uploader.run] schedule on virtual time: flush outcomes are scripted, times are recorded. */
@OptIn(ExperimentalCoroutinesApi::class)
class UploadLoopTest {

    private val trigger = Channel<Unit>(Channel.CONFLATED)
    private val flushTimes = mutableListOf<Long>()

    /** Starts the loop; [outcome] decides each flush's result from its index. */
    private fun TestScope.startLoop(outcome: (Int) -> Boolean) = backgroundScope.launch {
        Uploader.uploadLoop(trigger) {
            flushTimes += currentTime
            outcome(flushTimes.size - 1)
        }
    }

    @Test
    fun successfulFlushesRunEveryTenSeconds() = runTest {
        startLoop { true }
        runCurrent()
        advanceTimeBy(30_001)
        assertEquals(listOf(0L, 10_000L, 20_000L, 30_000L), flushTimes)
    }

    @Test
    fun failuresBackOffExponentiallyUpToSixtySecondsAndASuccessResets() {
        runTest {
            // 8 failures, then success, then a failure again.
            startLoop { it == 8 || it >= 10 }
            runCurrent()
            advanceTimeBy(200_000)
            // Waits: 1, 2, 4, 8, 16, 32, 60, 60 (s) after failures; 10 after the success; 1 after the next failure.
            val expected = mutableListOf(0L)
            for (wait in listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 32_000L, 60_000L, 60_000L, 10_000L, 1_000L)) {
                expected += expected.last() + wait
            }
            assertEquals(expected, flushTimes.take(expected.size))
        }
    }

    // Matrix "Offline": connectivity returning flushes at once and resets the backoff.
    @Test
    fun triggerFlushesImmediatelyAndResetsTheBackoff() = runTest {
        startLoop { it >= 6 } // offline for the first six flushes
        runCurrent()
        advanceTimeBy(31_500) // flushes at 0, 1, 3, 7, 15, 31 s; next would be at 63 s
        assertEquals(listOf(0L, 1_000L, 3_000L, 7_000L, 15_000L, 31_000L), flushTimes)

        trigger.trySend(Unit)
        runCurrent()
        assertEquals(31_500L, flushTimes.last()) // at once, not at 63 s
        advanceTimeBy(10_001)
        assertEquals(41_500L, flushTimes.last()) // success: back to the 10 s cadence
    }

    @Test
    fun triggerAfterFailureResetsTheBackoffEvenIfTheFlushFailsAgain() = runTest {
        startLoop { false }
        runCurrent()
        advanceTimeBy(7_500) // 0, 1, 3, 7 s
        trigger.trySend(Unit)
        runCurrent()
        assertEquals(7_500L, flushTimes.last())
        advanceTimeBy(1_001) // backoff restarted at 1 s
        assertEquals(8_500L, flushTimes.last())
    }
}
