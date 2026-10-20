package com.runninglivetracker.ui

import android.content.Context
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import com.runninglivetracker.R
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Matrix "Missing permission": setup lists each permission with its explanation and a Grant button.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SetupScreenTest {

    @get:Rule
    val compose = createComposeRule()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private fun s(id: Int) = context.getString(id)

    private val explanations = listOf(
        R.string.perm_location_title to R.string.perm_location_text,
        R.string.perm_background_title to R.string.perm_background_text,
        R.string.perm_notifications_title to R.string.perm_notifications_text,
        R.string.perm_battery_title to R.string.perm_battery_text,
    )

    private fun show(state: PermissionState) =
        compose.setContent { SetupScreen(permissions = state, onChanged = {}, onBack = {}) }

    @Test
    fun everyMissingPermissionHasItsExplanationAndAGrantButton() {
        show(PermissionState(location = false, background = false, notifications = false, battery = false))
        for ((title, text) in explanations) {
            compose.onNodeWithText(s(title)).performScrollTo().assertIsDisplayed()
            compose.onNodeWithText(s(text)).performScrollTo().assertIsDisplayed()
        }
        compose.onAllNodes(hasText(s(R.string.grant)) and hasClickAction()).assertCountEquals(4)
        // Background location is requested only after precise location.
        compose.onAllNodes(hasText(s(R.string.grant)) and hasClickAction() and isEnabled()).assertCountEquals(3)
    }

    @Test
    fun grantedPermissionsShowGrantedInsteadOfAButton() {
        show(PermissionState(location = true, background = false, notifications = true, battery = true))
        compose.onAllNodes(hasText(s(R.string.granted))).assertCountEquals(3)
        compose.onAllNodes(hasText(s(R.string.grant)) and hasClickAction() and isEnabled()).assertCountEquals(1)
    }
}
