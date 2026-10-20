// Wire contract, Kotlin side. The source of truth is shared/src/contract.ts (zod): a
// contract change updates that schema, shared/fixtures and this file together.
//
// kotlinx.serialization alone is looser than zod (it accepts `lat: 91`, a quoted number
// like `"lat": "48"`, and reads `altitudeM: null` as "absent"), so every decodeX() function
// parses to a JsonElement, rejects explicit nulls, checks JSON types against the
// serializer's descriptor, decodes, then runs validate() with the zod rules.
package com.runninglivetracker.contract

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PolymorphicKind
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.StructureKind
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * The one Json instance for the wire. Optional fields are omitted on encode (never `null`),
 * unknown keys are ignored (zod strips them), and records carry their type in `kind`.
 */
val ContractJson: Json = Json {
    explicitNulls = false
    ignoreUnknownKeys = true
    classDiscriminator = "kind"
}

/** A payload that does not satisfy the wire contract. */
class ContractException(message: String, cause: Throwable? = null) : IllegalArgumentException(message, cause)

private val UUID_V4 = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)
private val ERROR_CODE = Regex("^[A-Z][A-Z0-9_]*$")

private fun check(condition: Boolean, message: () -> String) {
    if (!condition) throw ContractException(message())
}

/** Number.MAX_SAFE_INTEGER: zod 4's `.int()` rejects anything larger. */
private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

private fun checkEpochMs(value: Long, field: String) =
    check(value in 0..MAX_SAFE_INTEGER) { "$field must be a non-negative safe integer" }

// ---- ingest (phone -> server) ----

@Serializable
sealed interface IngestRecord {
    val seq: Long
    val recordedAt: Long

    fun validate()
}

@Serializable
@SerialName("fix")
data class FixRecord(
    override val seq: Long,
    override val recordedAt: Long,
    val lat: Double,
    val lon: Double,
    val accuracyM: Double,
    val altitudeM: Double? = null,
    val speedMps: Double? = null,
) : IngestRecord {
    fun hasAltitude(): Boolean = altitudeM != null
    fun hasSpeed(): Boolean = speedMps != null

    override fun validate() {
        checkEpochMs(seq, "seq")
        checkEpochMs(recordedAt, "recordedAt")
        check(lat in -90.0..90.0) { "lat must be in [-90, 90]" }
        check(lon in -180.0..180.0) { "lon must be in [-180, 180]" }
        check(accuracyM.isFinite() && accuracyM > 0) { "accuracyM must be a positive number" }
        altitudeM?.let { check(it.isFinite()) { "altitudeM must be a finite number" } }
        speedMps?.let { check(it.isFinite() && it >= 0) { "speedMps must be a non-negative number" } }
    }
}

@Serializable
@SerialName("end")
data class EndRecord(
    override val seq: Long,
    override val recordedAt: Long,
) : IngestRecord {
    override fun validate() {
        checkEpochMs(seq, "seq")
        checkEpochMs(recordedAt, "recordedAt")
    }
}

@Serializable
data class IngestBatch(
    val sessionId: String,
    val sessionStartedAt: Long,
    val records: List<IngestRecord>,
) {
    fun validate() {
        check(UUID_V4.matches(sessionId)) { "sessionId must be a UUIDv4" }
        checkEpochMs(sessionStartedAt, "sessionStartedAt")
        check(records.isNotEmpty()) { "records must not be empty" }
        records.forEach { it.validate() }
        check(records.zipWithNext().all { (a, b) -> b.seq > a.seq }) {
            "records must be in strictly increasing seq order"
        }
    }
}

@Serializable
data class IngestAck(
    val sessionId: String,
    val ackedThroughSeq: Long,
    val serverNow: Long,
) {
    fun validate() {
        check(UUID_V4.matches(sessionId)) { "sessionId must be a UUIDv4" }
        checkEpochMs(ackedThroughSeq, "ackedThroughSeq")
        checkEpochMs(serverNow, "serverNow")
    }
}

// ---- errors ----

@Serializable
data class ErrorDetail(val code: String, val message: String)

@Serializable
data class ErrorBody(val error: ErrorDetail) {
    fun validate() {
        check(ERROR_CODE.matches(error.code)) { "error.code must be SCREAMING_SNAKE" }
    }
}

// ---- health (GET /api/v1/health, server/src/http/build-app.ts) ----

@Serializable
data class HealthResponse(val ok: Boolean, val serverNow: Long, val eventId: String)

// ---- decode / encode ----

private fun parseStrict(text: String): JsonElement {
    val element = try {
        ContractJson.parseToJsonElement(text)
    } catch (e: SerializationException) {
        throw ContractException("not JSON: ${e.message}", e)
    }
    rejectNulls(element, "$")
    return element
}

private fun rejectNulls(element: JsonElement, path: String) {
    when (element) {
        is JsonNull -> throw ContractException("$path must not be null")
        is JsonObject -> element.forEach { (key, value) -> rejectNulls(value, "$path.$key") }
        is JsonArray -> element.forEachIndexed { i, value -> rejectNulls(value, "$path[$i]") }
        is JsonPrimitive -> Unit
    }
}

/**
 * zod does not coerce: a string where a number is expected (or the reverse) is invalid.
 * Shapes that do not match the descriptor (missing object, wrong kind) are left to the decoder.
 */
@OptIn(ExperimentalSerializationApi::class)
private fun checkTypes(descriptor: SerialDescriptor, element: JsonElement, path: String) {
    when (descriptor.kind) {
        PrimitiveKind.STRING -> check(element is JsonPrimitive && element.isString) { "$path must be a string" }
        PrimitiveKind.BOOLEAN -> check(element is JsonPrimitive && !element.isString && element.booleanOrNull != null) {
            "$path must be a boolean"
        }
        is PrimitiveKind -> check(element is JsonPrimitive && !element.isString) { "$path must be a number" }
        StructureKind.CLASS, StructureKind.OBJECT -> if (element is JsonObject) {
            for (i in 0 until descriptor.elementsCount) {
                val name = descriptor.getElementName(i)
                val value = element[name] ?: continue
                checkTypes(descriptor.getElementDescriptor(i), value, "$path.$name")
            }
        }
        StructureKind.LIST -> if (element is JsonArray) {
            element.forEachIndexed { i, value -> checkTypes(descriptor.getElementDescriptor(0), value, "$path[$i]") }
        }
        PolymorphicKind.SEALED -> if (element is JsonObject) {
            val kind = (element[ContractJson.configuration.classDiscriminator] as? JsonPrimitive)
                ?.takeIf { it.isString }?.content ?: return
            val subclasses = descriptor.getElementDescriptor(1)
            val index = subclasses.getElementIndex(kind)
            if (index >= 0) checkTypes(subclasses.getElementDescriptor(index), element, path)
        }
        else -> Unit
    }
}

private fun <T> decodeWith(serializer: KSerializer<T>, element: JsonElement): T = try {
    checkTypes(serializer.descriptor, element, "$")
    ContractJson.decodeFromJsonElement(serializer, element)
} catch (e: SerializationException) {
    throw ContractException(e.message ?: "invalid payload", e)
} catch (e: IllegalArgumentException) {
    if (e is ContractException) throw e
    throw ContractException(e.message ?: "invalid payload", e)
}

/** Decodes one `fix` or `end` record. */
fun decodeIngestRecord(text: String): IngestRecord =
    decodeWith(IngestRecord.serializer(), parseStrict(text)).also { it.validate() }

fun decodeFixRecord(text: String): FixRecord =
    decodeIngestRecord(text) as? FixRecord ?: throw ContractException("kind must be \"fix\"")

fun decodeEndRecord(text: String): EndRecord =
    decodeIngestRecord(text) as? EndRecord ?: throw ContractException("kind must be \"end\"")

fun decodeIngestBatch(text: String): IngestBatch =
    decodeWith(IngestBatch.serializer(), parseStrict(text)).also { it.validate() }

fun decodeIngestAck(text: String): IngestAck =
    decodeWith(IngestAck.serializer(), parseStrict(text)).also { it.validate() }

fun decodeErrorBody(text: String): ErrorBody =
    decodeWith(ErrorBody.serializer(), parseStrict(text)).also { it.validate() }

fun decodeHealthResponse(text: String): HealthResponse =
    decodeWith(HealthResponse.serializer(), parseStrict(text))

/** Always goes through [IngestRecord.serializer] so `kind` is written. */
fun encodeIngestRecord(record: IngestRecord): String =
    ContractJson.encodeToString(IngestRecord.serializer(), record)

fun encodeIngestBatch(batch: IngestBatch): String =
    ContractJson.encodeToString(IngestBatch.serializer(), batch)

fun encodeIngestAck(ack: IngestAck): String =
    ContractJson.encodeToString(IngestAck.serializer(), ack)

fun encodeErrorBody(body: ErrorBody): String =
    ContractJson.encodeToString(ErrorBody.serializer(), body)
