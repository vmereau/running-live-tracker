package com.runninglivetracker.contract

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Mirrors shared/src/contract.test.ts: fixtures are named `<schema>.<case>.json` (or
 * `<schema>.json`) and the prefix picks the schema. Only the ingest side is used by the phone.
 */
class ContractFixturesTest {

    private val fixturesDir = File(
        requireNotNull(System.getProperty("fixturesDir")) { "fixturesDir system property not set" },
    )

    /** Decode then re-encode through the app's own code path. */
    private val ingestSide: Map<String, (String) -> String> = mapOf(
        "fix-record" to { text -> encodeIngestRecord(decodeFixRecord(text)) },
        "end-record" to { text -> encodeIngestRecord(decodeEndRecord(text)) },
        "ingest-batch" to { text -> encodeIngestBatch(decodeIngestBatch(text)) },
        "ingest-ack" to { text -> encodeIngestAck(decodeIngestAck(text)) },
        "error-body" to { text -> encodeErrorBody(decodeErrorBody(text)) },
    )

    /** Server -> web payloads; the phone never reads them. */
    private val readSide = setOf("event-info", "track-point", "runner-view", "snapshot", "runner-event", "track-event")

    private fun fixtures(kind: String): List<Pair<File, String>> {
        val files = File(fixturesDir, kind).listFiles { f -> f.name.endsWith(".json") }
            ?: error("no fixtures folder at ${File(fixturesDir, kind)}")
        return files.sortedBy { it.name }.mapNotNull { file ->
            val prefix = file.name.substringBefore('.')
            when {
                prefix in ingestSide -> file to prefix
                prefix in readSide -> null
                else -> error("fixture $kind/${file.name}: no schema named \"$prefix\"")
            }
        }
    }

    @Test
    fun everyIngestSchemaHasAValidFixture() {
        val covered = fixtures("valid").map { it.second }.toSet()
        assertEquals(ingestSide.keys, covered)
    }

    @Test
    fun validFixturesRoundTripUnchanged() {
        val failures = mutableListOf<String>()
        for ((file, prefix) in fixtures("valid")) {
            val text = file.readText()
            try {
                val encoded = ingestSide.getValue(prefix)(text)
                val expected = Json.parseToJsonElement(text)
                val actual = Json.parseToJsonElement(encoded)
                if (!sameJson(expected, actual)) failures += "valid/${file.name}: re-encoded as $encoded"
            } catch (e: Exception) {
                failures += "valid/${file.name}: ${e.message}"
            }
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun invalidFixturesAreRejected() {
        val accepted = fixtures("invalid").filter { (file, prefix) ->
            runCatching { ingestSide.getValue(prefix)(file.readText()) }.isSuccess
        }
        assertTrue("accepted: ${accepted.map { it.first.name }}", accepted.isEmpty())
        assertTrue(fixtures("invalid").isNotEmpty())
    }

    @Test
    fun absentOptionalFieldsStayAbsent() {
        val encoded = encodeIngestRecord(FixRecord(seq = 0, recordedAt = 1, lat = 0.0, lon = 0.0, accuracyM = 1.0))
        assertEquals("""{"kind":"fix","seq":0,"recordedAt":1,"lat":0.0,"lon":0.0,"accuracyM":1.0}""", encoded)
        assertFalse(encoded.contains("null"))
    }

    @Test
    fun unknownKeysAreIgnored() {
        val fix = decodeFixRecord("""{"seq":0,"kind":"fix","recordedAt":1,"lat":0,"lon":0,"accuracyM":1,"bearingDeg":90}""")
        assertEquals(1.0, fix.accuracyM, 0.0)
        assertFalse(fix.hasAltitude())
        assertFalse(fix.hasSpeed())
    }

    @Test
    fun wrongKindOrTypesAreRejected() {
        assertThrows(ContractException::class.java) { decodeFixRecord("""{"seq":1,"kind":"end","recordedAt":1}""") }
        assertThrows(ContractException::class.java) { decodeEndRecord("""{"seq":1,"recordedAt":1}""") }
        assertThrows(ContractException::class.java) { decodeEndRecord("""{"seq":1.5,"kind":"end","recordedAt":1}""") }
        assertThrows(ContractException::class.java) { decodeEndRecord("""{"seq":-1,"kind":"end","recordedAt":1}""") }
        assertThrows(ContractException::class.java) {
            decodeFixRecord("""{"seq":0,"kind":"fix","recordedAt":1,"lat":"48","lon":0,"accuracyM":1}""")
        }
        assertThrows(ContractException::class.java) {
            decodeFixRecord("""{"seq":0,"kind":"fix","recordedAt":1,"lat":0,"lon":0,"accuracyM":1,"speedMps":-0.5}""")
        }
        assertThrows(ContractException::class.java) {
            decodeIngestBatch(
                """{"sessionId":"3f1c2b9e-8a4d-4c6e-9b2a-1d5e7f0a3c48","sessionStartedAt":0,""" +
                    """"records":[{"seq":"0","kind":"end","recordedAt":1}]}""",
            )
        }
        assertThrows(ContractException::class.java) {
            decodeIngestAck("""{"sessionId":42,"ackedThroughSeq":0,"serverNow":1}""")
        }
        assertThrows(ContractException::class.java) { decodeIngestAck("not json") }
        // Well-typed but outside the zod rules: these reach IngestAck.validate().
        assertThrows(ContractException::class.java) {
            decodeIngestAck("""{"sessionId":"3f1c2b9e-8a4d-1c6e-9b2a-1d5e7f0a3c48","ackedThroughSeq":0,"serverNow":1}""")
        }
        assertThrows(ContractException::class.java) {
            decodeIngestAck("""{"sessionId":"3f1c2b9e-8a4d-4c6e-9b2a-1d5e7f0a3c48","ackedThroughSeq":-1,"serverNow":1}""")
        }
        // zod 4 .int() only accepts safe integers.
        assertThrows(ContractException::class.java) {
            decodeEndRecord("""{"seq":9007199254740992,"kind":"end","recordedAt":1}""")
        }
    }

    @Test
    fun batchSizeIsNotCappedByTheSchema() {
        val records = (0L..200L).map { EndRecord(seq = it, recordedAt = it) }
        val batch = IngestBatch("3f1c2b9e-8a4d-4c6e-9b2a-1d5e7f0a3c48", 0, records)
        assertEquals(batch, decodeIngestBatch(encodeIngestBatch(batch)))
    }

    /** JSON equality with numbers compared by value (Kotlin writes `5` as `5.0`). */
    private fun sameJson(a: JsonElement, b: JsonElement): Boolean = when {
        a is JsonObject && b is JsonObject -> a.keys == b.keys && a.keys.all { sameJson(a.getValue(it), b.getValue(it)) }
        a is JsonArray && b is JsonArray -> a.size == b.size && a.indices.all { sameJson(a[it], b[it]) }
        a is JsonNull || b is JsonNull -> a == b
        a is JsonPrimitive && b is JsonPrimitive -> when {
            a.isString || b.isString -> a.isString == b.isString && a.content == b.content
            a.doubleOrNull != null && b.doubleOrNull != null -> a.doubleOrNull == b.doubleOrNull
            else -> a.content == b.content
        }
        else -> false
    }
}
