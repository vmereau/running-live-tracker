package com.runninglivetracker.settings

import org.junit.Assert.assertEquals
import org.junit.Test

class SettingsValidationTest {

    private val validKey = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123-_6" // 43 chars

    @Test
    fun keyIsTrimmedAndAccepted() {
        assertEquals(43, validKey.length)
        assertEquals(Validated.Ok(validKey), SettingsValidation.validateKey("  $validKey \n"))
    }

    @Test
    fun badKeysAreRejected() {
        val invalid = Validated.Invalid("Key must be 43 characters: letters, digits, - or _")
        assertEquals(invalid, SettingsValidation.validateKey(validKey.dropLast(1)))
        assertEquals(invalid, SettingsValidation.validateKey(validKey + "A"))
        assertEquals(invalid, SettingsValidation.validateKey(validKey.dropLast(1) + "+"))
        assertEquals(invalid, SettingsValidation.validateKey(validKey.dropLast(1) + "="))
        assertEquals(invalid, SettingsValidation.validateKey(""))
    }

    @Test
    fun httpsIsAcceptedAndTrailingSlashStripped() {
        assertEquals(
            Validated.Ok("https://pc.tail1234.ts.net"),
            SettingsValidation.validateBaseUrl(" https://pc.tail1234.ts.net/ ", allowCleartext = false),
        )
        assertEquals(
            Validated.Ok("https://pc.tail1234.ts.net"),
            SettingsValidation.validateBaseUrl("https://pc.tail1234.ts.net", allowCleartext = true),
        )
        assertEquals(
            Validated.Ok("https://example.com:8443/tracker"),
            SettingsValidation.validateBaseUrl("https://example.com:8443/tracker//", allowCleartext = false),
        )
    }

    @Test
    fun cleartextIsRejectedInRelease() {
        assertEquals(
            Validated.Invalid("Release builds need an https:// URL"),
            SettingsValidation.validateBaseUrl("http://localhost:8787", allowCleartext = false),
        )
    }

    @Test
    fun cleartextToLocalHostsIsAcceptedInDebug() {
        assertEquals(Validated.Ok("http://10.0.2.2:8787"), SettingsValidation.validateBaseUrl("http://10.0.2.2:8787", true))
        assertEquals(Validated.Ok("http://localhost:8787"), SettingsValidation.validateBaseUrl("http://localhost:8787/", true))
    }

    @Test
    fun cleartextToOtherHostsIsRejectedInDebug() {
        assertEquals(
            Validated.Invalid("http:// is only allowed for localhost and 10.0.2.2"),
            SettingsValidation.validateBaseUrl("http://192.168.1.5:8787", allowCleartext = true),
        )
    }

    @Test
    fun queryFragmentAndNonUrlsAreRejected() {
        assertEquals(
            Validated.Invalid(SettingsValidation.URL_QUERY_OR_FRAGMENT),
            SettingsValidation.validateBaseUrl("https://pc.ts.net/?a=1", false),
        )
        assertEquals(
            Validated.Invalid(SettingsValidation.URL_QUERY_OR_FRAGMENT),
            SettingsValidation.validateBaseUrl("https://pc.ts.net#x", false),
        )
        assertEquals(Validated.Invalid(SettingsValidation.URL_EMPTY), SettingsValidation.validateBaseUrl("  ", false))
        for (bad in listOf("pc.ts.net", "ftp://pc.ts.net", "https://", "https:///path", "not a url")) {
            assertEquals(bad, Validated.Invalid(SettingsValidation.URL_INVALID), SettingsValidation.validateBaseUrl(bad, true))
        }
    }

    @Test
    fun settingsToStringHidesTheKey() {
        assertEquals("Settings(baseUrl=https://x, runnerKey=***)", Settings("https://x", validKey).toString())
    }
}
