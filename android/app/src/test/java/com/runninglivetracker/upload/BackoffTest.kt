package com.runninglivetracker.upload

import org.junit.Assert.assertEquals
import org.junit.Test

class BackoffTest {

    @Test
    fun doublesFromOneSecondAndCapsAtSixtySeconds() {
        assertEquals(
            listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 32_000L, 60_000L, 60_000L),
            (1..8).map { Uploader.backoffMs(it) },
        )
    }

    @Test
    fun largeFailureCountsStayCapped() {
        assertEquals(60_000L, Uploader.backoffMs(31))
        assertEquals(60_000L, Uploader.backoffMs(64))
        assertEquals(60_000L, Uploader.backoffMs(Int.MAX_VALUE))
    }

    @Test
    fun noFailureNoWait() {
        assertEquals(0L, Uploader.backoffMs(0))
    }
}
