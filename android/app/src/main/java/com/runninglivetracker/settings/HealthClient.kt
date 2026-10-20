package com.runninglivetracker.settings

import com.runninglivetracker.contract.ContractException
import com.runninglivetracker.contract.decodeErrorBody
import com.runninglivetracker.contract.decodeHealthResponse
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit

sealed interface HealthResult {
    data class Connected(val eventId: String, val serverNow: Long) : HealthResult

    /** Non-2xx reply. [code] is the ErrorBody code when the body is one, else null. */
    data class HttpError(val status: Int, val code: String?) : HealthResult

    /** Network error, bad URL, or a 2xx reply that is not a health response. */
    data class Failure(val message: String) : HealthResult
}

fun HealthResult.describe(): String = when (this) {
    is HealthResult.Connected -> "Connected — event $eventId"
    is HealthResult.HttpError -> if (code != null) "HTTP $status — $code" else "HTTP $status"
    is HealthResult.Failure -> message
}

/** `GET <baseUrl>/api/v1/health` (no auth). Blocking: call it off the main thread. */
class HealthClient(
    private val client: OkHttpClient = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).build(),
) {
    fun check(baseUrl: String): HealthResult {
        val url = "${baseUrl.trimEnd('/')}/api/v1/health".toHttpUrlOrNull()
            ?: return HealthResult.Failure("Invalid server URL")
        val request = Request.Builder().url(url).get().build()
        return try {
            client.newCall(request).execute().use { response ->
                val body = response.body.string()
                if (response.isSuccessful) {
                    try {
                        val health = decodeHealthResponse(body)
                        if (health.ok) {
                            HealthResult.Connected(health.eventId, health.serverNow)
                        } else {
                            HealthResult.Failure("Server reported ok=false")
                        }
                    } catch (_: ContractException) {
                        HealthResult.Failure("HTTP ${response.code}: not a health response")
                    }
                } else {
                    val code = try {
                        decodeErrorBody(body).error.code
                    } catch (_: ContractException) {
                        null
                    }
                    HealthResult.HttpError(response.code, code)
                }
            }
        } catch (e: IOException) {
            HealthResult.Failure(e.message ?: e.javaClass.simpleName)
        } catch (e: RuntimeException) {
            HealthResult.Failure(e.message ?: e.javaClass.simpleName)
        }
    }
}
