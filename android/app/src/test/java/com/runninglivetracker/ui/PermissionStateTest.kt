package com.runninglivetracker.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PermissionStateTest {

    private val all = PermissionState(location = true, background = true, notifications = true, battery = true)

    @Test
    fun allGrantedOnlyWhenEveryPermissionIsGranted() {
        assertTrue(all.allGranted)
        assertFalse(all.copy(location = false).allGranted)
        assertFalse(all.copy(background = false).allGranted)
        assertFalse(all.copy(notifications = false).allGranted)
        assertFalse(all.copy(battery = false).allGranted)
    }
}
