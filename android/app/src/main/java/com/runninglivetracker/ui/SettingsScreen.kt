package com.runninglivetracker.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.runninglivetracker.R
import com.runninglivetracker.settings.HealthClient
import com.runninglivetracker.settings.Settings
import com.runninglivetracker.settings.SettingsRepository
import com.runninglivetracker.settings.SettingsValidation
import com.runninglivetracker.settings.Validated
import com.runninglivetracker.settings.describe
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun SettingsScreen(
    repository: SettingsRepository,
    healthClient: HealthClient,
    allowCleartext: Boolean,
    /** True while a session is active: the key field is disabled and a changed key cannot be saved. */
    keyLocked: Boolean = false,
    onBack: (() -> Unit)? = null,
) {
    val scope = rememberCoroutineScope()
    var loaded by rememberSaveable { mutableStateOf(false) }
    var baseUrl by rememberSaveable { mutableStateOf("") }
    var runnerKey by rememberSaveable { mutableStateOf("") }
    var savedKey by rememberSaveable { mutableStateOf("") }
    var urlError by rememberSaveable { mutableStateOf<String?>(null) }
    var keyError by rememberSaveable { mutableStateOf<String?>(null) }
    var showKey by rememberSaveable { mutableStateOf(false) }
    var status by rememberSaveable { mutableStateOf<String?>(null) }
    // Not saveable: the call dies with this composition's scope, so a restored `true` would stick.
    var testing by remember { mutableStateOf(false) }
    val savedText = stringResource(R.string.saved)
    val keyLockedText = stringResource(R.string.key_locked)

    // Fill the fields once from DataStore (not again after a rotation, to keep edits).
    LaunchedEffect(Unit) {
        if (!loaded) {
            val saved = repository.settings.first()
            baseUrl = saved.baseUrl
            runnerKey = saved.runnerKey
            savedKey = saved.runnerKey
            loaded = true
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(stringResource(R.string.settings_title), style = MaterialTheme.typography.headlineSmall)

        OutlinedTextField(
            value = baseUrl,
            onValueChange = { baseUrl = it; urlError = null; status = null },
            label = { Text(stringResource(R.string.base_url_label)) },
            placeholder = { Text(stringResource(R.string.base_url_hint)) },
            isError = urlError != null,
            supportingText = urlError?.let { { Text(it) } },
            singleLine = true,
            enabled = loaded,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Uri,
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
            ),
            modifier = Modifier.fillMaxWidth(),
        )

        OutlinedTextField(
            value = runnerKey,
            onValueChange = { runnerKey = it; keyError = null; status = null },
            label = { Text(stringResource(R.string.runner_key_label)) },
            isError = keyError != null,
            supportingText = (keyError ?: keyLockedText.takeIf { keyLocked })?.let { { Text(it) } },
            singleLine = true,
            enabled = loaded && !keyLocked,
            visualTransformation = if (showKey) VisualTransformation.None else PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Password,
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
            ),
            trailingIcon = {
                TextButton(onClick = { showKey = !showKey }) {
                    Text(stringResource(if (showKey) R.string.hide_key else R.string.show_key))
                }
            },
            modifier = Modifier.fillMaxWidth(),
        )

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(
                enabled = loaded,
                onClick = {
                    val url = SettingsValidation.validateBaseUrl(baseUrl, allowCleartext)
                    val key = SettingsValidation.validateKey(runnerKey)
                    urlError = (url as? Validated.Invalid)?.message
                    keyError = (key as? Validated.Invalid)?.message
                    status = null
                    if (keyLocked && key is Validated.Ok && key.value != savedKey) {
                        keyError = keyLockedText
                    } else if (url is Validated.Ok && key is Validated.Ok) {
                        baseUrl = url.value
                        runnerKey = key.value
                        scope.launch {
                            repository.save(Settings(baseUrl = url.value, runnerKey = key.value))
                            savedKey = key.value
                            status = savedText
                        }
                    }
                },
            ) { Text(stringResource(R.string.save)) }

            OutlinedButton(
                enabled = loaded && !testing,
                onClick = {
                    when (val url = SettingsValidation.validateBaseUrl(baseUrl, allowCleartext)) {
                        is Validated.Invalid -> urlError = url.message
                        is Validated.Ok -> {
                            urlError = null
                            testing = true
                            status = null
                            scope.launch {
                                try {
                                    val result = withContext(Dispatchers.IO) { healthClient.check(url.value) }
                                    status = result.describe()
                                } finally {
                                    testing = false
                                }
                            }
                        }
                    }
                },
            ) { Text(stringResource(if (testing) R.string.testing else R.string.test_connection)) }
        }

        status?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }

        onBack?.let { OutlinedButton(onClick = it) { Text(stringResource(R.string.back)) } }
    }
}
