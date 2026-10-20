package com.runninglivetracker.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.runninglivetracker.R
import com.runninglivetracker.tracking.db.SessionEntity
import kotlinx.coroutines.delay
import java.util.Locale

/** `H:MM:SS` from a duration in ms (negative clamps to 0). */
fun formatElapsed(ms: Long): String {
    val total = (ms.coerceAtLeast(0)) / 1000
    return String.format(Locale.ROOT, "%d:%02d:%02d", total / 3600, (total / 60) % 60, total % 60)
}

/**
 * Tracking state, elapsed time since Start and recorded fix count, read from Room (not from the
 * service). No race stats by design.
 */
@Composable
fun MainScreen(
    session: SessionEntity?,
    settingsValid: Boolean,
    permissionsGranted: Boolean,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenSetup: () -> Unit,
) {
    var confirmStop by rememberSaveable { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(session?.sessionId) {
        while (session != null) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            stringResource(if (session != null) R.string.state_tracking else R.string.state_stopped),
            style = MaterialTheme.typography.headlineMedium,
        )
        Text(stringResource(R.string.elapsed_label), style = MaterialTheme.typography.labelLarge)
        Text(
            if (session != null) formatElapsed(now - session.sessionStartedAt) else formatElapsed(0),
            style = MaterialTheme.typography.displayMedium,
        )
        Text(stringResource(R.string.fix_count_label), style = MaterialTheme.typography.labelLarge)
        Text((session?.fixCount ?: 0).toString(), style = MaterialTheme.typography.displaySmall)

        if (session == null) {
            Button(
                onClick = onStart,
                enabled = settingsValid && permissionsGranted,
                modifier = Modifier.fillMaxWidth(),
            ) { Text(stringResource(R.string.start)) }
            if (!settingsValid) Text(stringResource(R.string.start_needs_settings))
            if (!permissionsGranted) Text(stringResource(R.string.start_needs_permissions))
        } else {
            Button(
                onClick = { confirmStop = true },
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                modifier = Modifier.fillMaxWidth(),
            ) { Text(stringResource(R.string.stop)) }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(onClick = onOpenSettings) { Text(stringResource(R.string.settings)) }
            OutlinedButton(onClick = onOpenSetup) { Text(stringResource(R.string.permissions)) }
        }
    }

    if (confirmStop && session != null) {
        AlertDialog(
            onDismissRequest = { confirmStop = false },
            title = { Text(stringResource(R.string.stop_confirm_title)) },
            text = { Text(stringResource(R.string.stop_confirm_text)) },
            confirmButton = {
                TextButton(onClick = { confirmStop = false; onStop() }) { Text(stringResource(R.string.stop)) }
            },
            dismissButton = {
                TextButton(onClick = { confirmStop = false }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}
