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
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** `H:MM:SS` from a duration in ms (negative clamps to 0). */
fun formatElapsed(ms: Long): String {
    val total = (ms.coerceAtLeast(0)) / 1000
    return String.format(Locale.ROOT, "%d:%02d:%02d", total / 3600, (total / 60) % 60, total % 60)
}

private val ACK_TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss", Locale.ROOT)

/** Local `HH:mm:ss` of an epoch-ms time, or null when there is none. */
fun formatAckTime(epochMs: Long?, zone: ZoneId = ZoneId.systemDefault()): String? =
    epochMs?.let { ACK_TIME.format(Instant.ofEpochMilli(it).atZone(zone)) }

/** Upload counters shown on the main screen, all observed from Room. */
data class UploadStatus(val pending: Long = 0, val lastAckedAt: Long? = null, val quarantined: Long = 0)

/**
 * Tracking state, elapsed time since Start, recorded fix count and upload status (pending
 * records, last ack time, quarantined records), read from Room (not from the service). No race
 * stats by design.
 */
@Composable
fun MainScreen(
    session: SessionEntity?,
    upload: UploadStatus,
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

        Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            Counter(stringResource(R.string.pending_label), upload.pending.toString())
            Counter(
                stringResource(R.string.last_ack_label),
                formatAckTime(upload.lastAckedAt) ?: stringResource(R.string.last_ack_none),
            )
            Counter(stringResource(R.string.quarantined_label), upload.quarantined.toString())
        }

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

@Composable
private fun Counter(label: String, value: String) {
    Column {
        Text(label, style = MaterialTheme.typography.labelLarge)
        Text(value, style = MaterialTheme.typography.titleLarge)
    }
}
