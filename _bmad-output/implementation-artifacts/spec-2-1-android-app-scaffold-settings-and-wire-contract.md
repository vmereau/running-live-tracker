---
title: 'Android app scaffold, settings and wire contract'
type: 'feature'
created: '2026-10-16'
status: 'done'
baseline_commit: 'a438a57500695415f12b7af4b135b3b6309b5514'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** There is no phone app yet. Runners need an installable Android app where they enter the server base URL and their secret key once, plus Kotlin wire classes that match `shared/src/contract.ts`, before tracking (2.2) and uploading (2.3) can be built.

**Approach:** Add an `android/` Gradle project (single `:app` module, Compose, the pinned Stack versions). It has one settings screen backed by DataStore with a "Test connection" health check, and hand-written kotlinx.serialization contract classes with a validation layer, checked by JVM tests against `shared/fixtures`.

## Boundaries & Constraints

**Always:** Pins: AGP 9.4.1 (built-in Kotlin), KGP + compose plugin 2.4.21 declared explicitly, KSP 2.3.12, Compose BOM 2026.09.00, Room 2.8.5, DataStore Preferences 1.2.1, play-services-location 21.4.0, compileSdk/targetSdk/minSdk 37/36/29, Gradle wrapper 9.6.0+ (whatever AGP 9.4.1 supports), JDK 17 toolchain. Pin the other libraries (kotlinx-serialization, OkHttp, activity/lifecycle) to current stable releases. Optional ingest fields are omitted on encode, never `null`. The key is trimmed and must match `^[A-Za-z0-9_-]{43}$`. Base URL: `https://` with a host is always accepted; `http://` only in debug builds and only for host `localhost` or `10.0.2.2`. Trailing `/` is stripped, and query or fragment is rejected. Release builds pin cleartext off in the network security config; the debug source set overrides it for `localhost` and `10.0.2.2`.

**Never:** kotlin-android plugin, kapt, WorkManager, JobScheduler, tunnel-specific code, race stats on the phone, logging the runner key. No tracking service, outbox entities or uploader (2.2/2.3). No "key locked while a session is active" rule yet (no sessions exist until 2.2). No server, web or shared contract changes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Save valid settings | `https://pc.tail1234.ts.net/` + valid key with spaces around it | Stored as `https://pc.tail1234.ts.net` and the trimmed key; restored after app restart | N/A |
| Bad key | 42 chars, or contains `+`/`=` | Not saved | Inline message "Key must be 43 characters: letters, digits, - or _" |
| Cleartext in release | `http://localhost:8787` (release) | Not saved | "Release builds need an https:// URL" |
| Cleartext in debug | `http://10.0.2.2:8787` (debug) | Saved | N/A |
| Cleartext other host, debug | `http://192.168.1.5:8787` | Not saved | "http:// is only allowed for localhost and 10.0.2.2" |
| Test connection OK | Server returns `200 {ok,serverNow,eventId}` | "Connected — event `<eventId>`" | N/A |
| Test connection fails | Non-2xx with ErrorBody, non-JSON body, or network error | Shows HTTP status + `code`, or the exception message | Never crashes; button usable again |

**Decisions:**
- Release signing: a git-ignored `android/keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`) signs `release` when present; otherwise `release` falls back to the debug signing config so it is always installable.
- Local verification: install the Android SDK (cmdline-tools, platform 37, build-tools, platform-tools) under `D:\Android\Sdk`, with the Gradle user home on `D:` too (the C: disk has no room). Nothing goes on C:. `android/local.properties` (git-ignored) points at the SDK. The CI android job is also added.

</frozen-after-approval>

## Code Map

- `shared/src/contract.ts` -- source of truth for FixRecord, EndRecord, IngestBatch (UUIDv4, ≥1 record, strictly increasing seq), IngestAck, ErrorBody (code `^[A-Z][A-Z0-9_]*$`). Unknown keys are stripped, not rejected. Do not edit.
- `shared/src/contract.test.ts` -- fixture naming rule `<schema>.<case>.json`, where the prefix picks the schema. The Kotlin test mirrors it for the 5 ingest-side prefixes and skips read-side ones (event-info, snapshot, runner-view, track-*, runner-event).
- `shared/fixtures/valid|invalid/*.json` -- test inputs. Notes: `ingest-batch.mixed` has `accuracyM: 5` (integer), and `fix-record.optional-null` has `altitudeM: null` (must be rejected).
- `server/src/http/build-app.ts` -- `/api/v1/health` returns `{ok, serverNow, eventId}`.
- `.gitignore`, `.gitattributes`, `.github/workflows/ci.yml`, `README.md` -- repo files to extend.

## Tasks & Acceptance

**Execution:**
- [x] `android/settings.gradle.kts`, `android/build.gradle.kts`, `android/gradle.properties`, `android/gradle/libs.versions.toml`, `android/gradlew*`, `android/gradle/wrapper/*` -- Gradle project with a version catalog and plugins declared `apply false` (AGP, KGP 2.4.21, compose, serialization, KSP) -- reproducible pinned build.
- [x] `android/app/build.gradle.kts` -- `:app` module: namespace and applicationId `com.runninglivetracker`, Compose on, `buildConfig = true`, minify off, release signing per Decisions, Room runtime + `ksp(room-compiler)`, unit tests get `systemProperty("fixturesDir", <repo>/shared/fixtures)` -- AC 1.
- [x] `android/app/src/main/AndroidManifest.xml`, `res/xml/network_security_config.xml`, `src/debug/res/xml/network_security_config.xml`, `res/values/strings.xml`, launcher icon -- INTERNET permission only (2.2 adds the rest), cleartext rules -- AC 2.
- [x] `android/app/src/main/java/com/runninglivetracker/contract/Contract.kt` -- `@Serializable` classes (sealed `IngestRecord` with `kind` discriminator), a shared `Json` (`explicitNulls=false`, `ignoreUnknownKeys=true`, `classDiscriminator="kind"`), and `decodeX(text)` functions that reject explicit JSON nulls and enforce the zod rules -- AC 3.
- [x] `android/app/src/main/java/com/runninglivetracker/settings/` -- pure `SettingsValidation` (key, base URL with an `allowCleartext` flag taken from `BuildConfig.DEBUG`), a `SettingsRepository` over DataStore, and a `HealthClient` (OkHttp) that returns a sealed result -- matrix rows.
- [x] `android/app/src/main/java/com/runninglivetracker/MainActivity.kt` + `ui/SettingsScreen.kt` -- fields, inline errors, Save, Test connection (network off the main thread) -- matrix rows.
- [x] `android/app/src/test/.../ContractFixturesTest.kt`, `SettingsValidationTest.kt`, `HealthClientTest.kt` (MockWebServer) -- tests for AC 3 and the matrix.
- [x] `.gitignore` (`android/.gradle`, `build/`, `local.properties`, `keystore.properties`, `*.jks`), `.gitattributes` (`gradlew` LF, `*.bat` CRLF, `*.jar` binary), `.github/workflows/ci.yml` (android job: JDK 17, `./gradlew test assembleDebug assembleRelease`), `README.md` (Android section), header comment in `shared/src/contract.ts` pointing at `Contract.kt` (comment only) -- keep the repo coherent.

**Acceptance Criteria:**
- Given the `android/` project, when `./gradlew test assembleDebug assembleRelease` runs, then the tests pass and both APKs are produced with the pinned versions and SDK levels.
- Given every valid ingest-side fixture, when it is decoded and re-encoded, then the output equals the input as JSON with numbers compared by value, and absent optional fields stay absent.
- Given every invalid ingest-side fixture, when it is decoded, then decoding fails.
- Given saved settings, when the app is killed and reopened, then both fields show the saved values.

## Design Notes

kotlinx.serialization alone accepts `lat: 91` and maps `altitudeM: null` to "absent". So `decodeFixRecord` and the other decode functions parse to `JsonElement`, fail on any `JsonNull`, decode, then call `validate()` (ranges, `accuracyM > 0` and finite, `speedMps ≥ 0`, UUIDv4 regex `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` case-insensitive, records non-empty and strictly increasing). Records are always encoded through `IngestRecord.serializer()` so `kind` is written. A Kotlin Double writes `5` as `5.0`, so the round-trip check compares numbers by value.

## Verification

**Commands:**
- `cd android && ./gradlew test assembleDebug assembleRelease` -- expected: BUILD SUCCESSFUL, APKs in `app/build/outputs/apk/{debug,release}/`.
- `pnpm check` -- expected: still green (no TS changes besides a comment).

**Manual checks (if no CLI):**
- Install the debug APK on the emulator, set `http://10.0.2.2:8787` with `pnpm dev` running, press Test connection, and see the `eventId`.

## Review Triage Log

| # | Source | Finding | Verdict | Route | Evidence |
|---|--------|---------|---------|-------|----------|
| 1 | blind, edge | `testing` in `rememberSaveable` stays `true` after rotation mid-test, button stuck | medium | patch | Saved state captures `true`; the old scope's `finally` writes the discarded state. Fixed: plain `remember`. |
| 2 | blind, edge | DataStore read/write exceptions (corruption, disk full) uncaught | low | reject | Real but rare in everyday use (DataStore writes atomically via temp-file rename); fix adds a corruption handler and catch branches. |
| 3 | blind | `allowBackup=false` does not block Android 12+ device-to-device transfer of the key | low | reject | True for targetSdk 31+, but the key only moves to the runner's own new phone; fix adds a new rules file. |
| 4 | blind | Runner key held in the saved-instance-state Bundle | low | reject | Bundle is app/system-private; spec only forbids logging. Fix needs reload logic that loses unsaved edits. |
| 5 | blind, edge | URL with userinfo (`https://u:p@host`) accepted | low | reject | Real, but nobody types credentials into this field; spec says "https:// with a host is always accepted"; fix adds a guard. |
| 6 | blind, edge | README says `https://<host>` while a port/path prefix is accepted | low | patch | Validator test keeps `/tracker`; README reworded to allow port and path prefix. |
| 7 | blind | Spec `in-review` vs sprint-status `in-progress` | false | reject | Step 5 syncs sprint-status to `review` when the spec is closed. |
| 8 | blind | CI `sdkmanager --licenses ... \|\| true` hides failures, no explicit SDK install | low | reject | ubuntu-latest ships cmdline-tools and AGP downloads platform/build-tools; only error clarity is affected; dropping `\|\| true` can break under pipefail. |
| 9 | blind, edge | Incomplete `keystore.properties` fails with an unclear error | low | reject | Developer-only, rare; fix adds per-key guards. |
| 10 | blind | Root `.gitignore` `build/` and `local.properties` unanchored | low | patch | They would ignore any `build/` in the pnpm workspace. Anchored to `android/**/build/` and `android/local.properties`. |
| 11 | blind, vgap | `IngestAck.validate()` never reached by a failing input; no invalid ack/end fixtures | low | patch | Existing ack cases fail in `checkTypes`/`parseStrict`. Added Kotlin cases: v1 UUID and `ackedThroughSeq: -1` (end `seq:-1` was already covered). No shared fixture change (intent forbids). |
| 12 | blind, edge (x2) | Long fields accept values above 2^53 that zod 4 `.int()` rejects | low | patch | zod 4.6.7 `.int()` is safe-integer only; spec says decode enforces the zod rules. `checkEpochMs` now bounds to `MAX_SAFE_INTEGER`, plus a test. Stricter-than-zod `1.0` is harmless (server never emits it). |
| 13 | blind | HealthClientTest lacks `ok:false` / wrong-shape 2xx; check does not test the key | low | patch | Added a test for both. "Does not test the key" is by design: the spec defines Test connection as the unauthenticated health check. |
| 14 | blind | Light theme only, no dark mode | low | reject | Cosmetic, outside the intent; fix adds theming code. |
| 15 | edge | Deeply nested JSON could cause an uncaught StackOverflowError | low | reject | Needs a hostile server on the runner's own URL; fix rewrites the walker. |
| 16 | edge | Huge health body read into memory, possible OOM | low | reject | Health/proxy pages are small; fix adds size limits. |
| 17 | edge | Empty `eventId` / negative `serverNow` shows "Connected — event " | low | reject | The in-repo server always sends a non-empty id; fix adds checks. |
| 18 | edge | `SettingsRepositoryTest` cancels the scope without joining, so the next DataStore may see the file "still active" | low | patch | Active-file release runs on scope completion, which `cancel()` does not wait for. Now `cancelAndJoin()`. |
| 19 | edge | Round-trip compare through `doubleOrNull` hides large-int precision | low | reject | No fixture has integers near 2^53, so nothing is hidden today; fix adds branching. |
| 20 | vgap | Kotlin `HealthResponse` not tied to the server's health payload | low | defer | Pre-verified gap. A shared health fixture needs shared changes, which the intent forbids in this story. |
| 21 | vgap | SettingsScreen save gating and `allowCleartext = BuildConfig.DEBUG` have no automated test | low | reject | Pre-verified gap. Needs Compose/instrumented test infra the project lacks; the manual emulator check covers the flow; one-line wiring. |
