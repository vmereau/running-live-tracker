package com.runninglivetracker.settings

import java.net.URI
import java.net.URISyntaxException

/** Result of validating one settings field: the normalized value, or a message to show inline. */
sealed interface Validated<out T> {
    data class Ok<T>(val value: T) : Validated<T>
    data class Invalid(val message: String) : Validated<Nothing>
}

/** Pure validation of the two settings fields (no Android dependency, unit-tested on the JVM). */
object SettingsValidation {
    const val KEY_INVALID = "Key must be 43 characters: letters, digits, - or _"
    const val URL_EMPTY = "Enter the server URL"
    const val URL_INVALID = "Enter a URL like https://machine.tailnet.ts.net"
    const val URL_QUERY_OR_FRAGMENT = "The URL must not contain ? or #"
    const val URL_RELEASE_NEEDS_HTTPS = "Release builds need an https:// URL"
    const val URL_CLEARTEXT_HOST = "http:// is only allowed for localhost and 10.0.2.2"

    /** 32 random bytes as unpadded base64url (see server keygen). */
    private val KEY = Regex("^[A-Za-z0-9_-]{43}$")

    /** Hosts the debug network security config allows over cleartext. */
    val CLEARTEXT_HOSTS = setOf("localhost", "10.0.2.2")

    fun validateKey(raw: String): Validated<String> {
        val key = raw.trim()
        return if (KEY.matches(key)) Validated.Ok(key) else Validated.Invalid(KEY_INVALID)
    }

    /**
     * `https://<host>` is always accepted. `http://` only when [allowCleartext] (debug builds)
     * and only for [CLEARTEXT_HOSTS]. Trailing slashes are stripped; a query or fragment is rejected.
     */
    fun validateBaseUrl(raw: String, allowCleartext: Boolean): Validated<String> {
        val text = raw.trim()
        if (text.isEmpty()) return Validated.Invalid(URL_EMPTY)
        val uri = try {
            URI(text)
        } catch (_: URISyntaxException) {
            return Validated.Invalid(URL_INVALID)
        }
        val scheme = uri.scheme?.lowercase()
        val host = uri.host
        if ((scheme != "https" && scheme != "http") || host.isNullOrEmpty()) {
            return Validated.Invalid(URL_INVALID)
        }
        if (uri.rawQuery != null || uri.rawFragment != null) return Validated.Invalid(URL_QUERY_OR_FRAGMENT)
        if (scheme == "http") {
            if (!allowCleartext) return Validated.Invalid(URL_RELEASE_NEEDS_HTTPS)
            if (host.lowercase() !in CLEARTEXT_HOSTS) return Validated.Invalid(URL_CLEARTEXT_HOST)
        }
        return Validated.Ok(text.trimEnd('/'))
    }
}
