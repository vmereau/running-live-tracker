package com.runninglivetracker.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.runninglivetracker.R

/** The four things tracking needs. Below API 33 notifications need no runtime permission. */
data class PermissionState(
    val location: Boolean,
    val background: Boolean,
    val notifications: Boolean,
    val battery: Boolean,
) {
    val allGranted: Boolean get() = location && background && notifications && battery
}

private fun Context.granted(permission: String) =
    ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

fun Context.permissionState(): PermissionState = PermissionState(
    location = granted(Manifest.permission.ACCESS_FINE_LOCATION),
    background = granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION),
    notifications = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || granted(Manifest.permission.POST_NOTIFICATIONS),
    battery = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName),
)

/**
 * Lists each permission with its explanation and a Grant button. [onChanged] re-reads the state;
 * the host also re-reads it on every resume (settings pages return through onResume).
 */
@Composable
fun SetupScreen(permissions: PermissionState, onChanged: () -> Unit, onBack: () -> Unit) {
    val context = LocalContext.current
    // After a denial Android may stop showing the dialog: the next tap opens the app settings.
    var denied by rememberSaveable { mutableStateOf(setOf<String>()) }

    fun openAppSettings() {
        context.startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)),
        )
    }

    val locationLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
        if (result[Manifest.permission.ACCESS_FINE_LOCATION] != true) denied = denied + "location"
        onChanged()
    }
    val backgroundLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (!ok) denied = denied + "background"
        onChanged()
    }
    val notificationsLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (!ok) denied = denied + "notifications"
        onChanged()
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(stringResource(R.string.setup_title), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.setup_intro))

        PermissionItem(
            title = stringResource(R.string.perm_location_title),
            text = stringResource(R.string.perm_location_text),
            granted = permissions.location,
            enabled = true,
            showSettings = "location" in denied,
            onGrant = {
                if ("location" in denied) {
                    openAppSettings()
                } else {
                    locationLauncher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                }
            },
        )
        PermissionItem(
            title = stringResource(R.string.perm_background_title),
            text = stringResource(R.string.perm_background_text),
            granted = permissions.background,
            // Android only grants background location once foreground location is granted.
            enabled = permissions.location,
            showSettings = "background" in denied,
            onGrant = {
                if ("background" in denied) openAppSettings() else backgroundLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            },
        )
        PermissionItem(
            title = stringResource(R.string.perm_notifications_title),
            text = stringResource(R.string.perm_notifications_text),
            granted = permissions.notifications,
            enabled = true,
            showSettings = "notifications" in denied,
            onGrant = {
                if ("notifications" in denied || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                    openAppSettings()
                } else {
                    notificationsLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                }
            },
        )
        PermissionItem(
            title = stringResource(R.string.perm_battery_title),
            text = stringResource(R.string.perm_battery_text),
            granted = permissions.battery,
            enabled = true,
            showSettings = false,
            onGrant = { requestBatteryExemption(context) },
        )

        OutlinedButton(onClick = onBack) { Text(stringResource(R.string.back)) }
    }
}

// A sideloaded tracker that must survive hours in a pocket is the documented use case for this intent.
@SuppressLint("BatteryLife")
private fun requestBatteryExemption(context: Context) {
    context.startActivity(
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}")),
    )
}

@Composable
private fun PermissionItem(
    title: String,
    text: String,
    granted: Boolean,
    enabled: Boolean,
    showSettings: Boolean,
    onGrant: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(text, style = MaterialTheme.typography.bodyMedium)
            if (granted) {
                Text(stringResource(R.string.granted), color = MaterialTheme.colorScheme.primary)
            } else {
                Button(onClick = onGrant, enabled = enabled) {
                    Text(stringResource(if (showSettings) R.string.open_app_settings else R.string.grant))
                }
            }
        }
    }
}
