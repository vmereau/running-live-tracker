package com.runninglivetracker.settings

import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class HealthClientTest {

    private val server = MockWebServer()
    private val client = HealthClient()

    @Before
    fun setUp() = server.start()

    @After
    fun tearDown() = server.close()

    private fun baseUrl() = server.url("/").toString().trimEnd('/')

    @Test
    fun okReplyIsConnected() {
        server.enqueue(
            MockResponse.Builder()
                .code(200)
                .body("""{"ok":true,"serverNow":1760000000000,"eventId":"paris-2026"}""")
                .build(),
        )
        val result = client.check(baseUrl())
        assertEquals(HealthResult.Connected("paris-2026", 1760000000000), result)
        assertEquals("Connected — event paris-2026", result.describe())
        assertEquals("/api/v1/health", server.takeRequest().url.encodedPath)
    }

    @Test
    fun errorBodyGivesStatusAndCode() {
        server.enqueue(
            MockResponse.Builder()
                .code(503)
                .body("""{"error":{"code":"NOT_READY","message":"booting"}}""")
                .build(),
        )
        val result = client.check(baseUrl())
        assertEquals(HealthResult.HttpError(503, "NOT_READY"), result)
        assertEquals("HTTP 503 — NOT_READY", result.describe())
    }

    @Test
    fun nonJsonErrorGivesStatusOnly() {
        server.enqueue(MockResponse.Builder().code(502).body("<html>Bad gateway</html>").build())
        assertEquals(HealthResult.HttpError(502, null), client.check(baseUrl()))
    }

    @Test
    fun nonJsonOkIsAFailure() {
        server.enqueue(MockResponse.Builder().code(200).body("hello").build())
        assertTrue(client.check(baseUrl()) is HealthResult.Failure)
    }

    @Test
    fun okFalseOrWrongShapeIsAFailure() {
        server.enqueue(
            MockResponse.Builder().code(200).body("""{"ok":false,"serverNow":1,"eventId":"e"}""").build(),
        )
        server.enqueue(MockResponse.Builder().code(200).body("""{"ok":true,"serverNow":"1"}""").build())
        assertEquals(HealthResult.Failure("Server reported ok=false"), client.check(baseUrl()))
        assertTrue(client.check(baseUrl()) is HealthResult.Failure)
    }

    @Test
    fun networkErrorIsAFailureNotACrash() {
        val url = baseUrl()
        server.close()
        val result = client.check(url)
        assertTrue(result.toString(), result is HealthResult.Failure)
        assertTrue((result as HealthResult.Failure).message.isNotBlank())
    }
}
