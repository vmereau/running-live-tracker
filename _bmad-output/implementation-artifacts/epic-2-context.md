# Epic 2 Context: Runners track their run from their Android phone

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

A runner installs the sideloaded Android app, enters the server URL and their secret key once, presses Start, locks and pockets the phone and runs. Positions keep flowing with the screen off for a full marathon. They are buffered in a local outbox while there is no signal and sent once the connection returns, and they finish uploading after Stop. This epic replaces the Epic 1 simulator with a real phone, which proves end to end that the server stores a run's positions under the right runner. Losing positions, or tracking dying in the pocket, would break the whole product on race day.

## Stories

- Story 2.1: Android app scaffold, settings and wire contract
- Story 2.2: Foreground tracking service recording to the outbox
- Story 2.3: Uploading positions with acks, retries and offline buffering
- Story 2.4: Finishing uploads after Stop

## Requirements & Constraints

- Android only (no iOS). The app is sideloaded (debug and release APK), not distributed through the Play Store.
- The runner can start and stop tracking. While tracking, a GPS position is recorded every 5–10 s (target 5 s) and sent to the server.
- Tracking must survive at least 5 h with the phone pocketed and the screen locked.
- Positions recorded without signal are kept and sent when the connection returns, so the gap in the track fills in on the web page. Spectators see the last-update age grow during the gap.
- After Stop, every remaining position must still reach the server, even if the app is closed.
- The phone shows no race stats: no distance, pace or ETA. The main screen shows only tracking state, elapsed time since Start, the count of recorded fixes, pending records, the time of the last successful ack and the count of quarantined records.
- Runners, keys, events and the course are managed only on the server. The app only stores `baseUrl` and `runnerKey`.

## Technical Decisions

- **Build:** a single `:app` module with Compose. AGP 9.4.1 uses built-in Kotlin, so declare Kotlin 2.4.21 explicitly and apply `org.jetbrains.kotlin.plugin.compose` 2.4.21. Do not apply `kotlin-android` and do not use kapt. Room runs through KSP 2.3.12. Other pins: Compose BOM 2026.09.00, Room 2.8.5, DataStore Preferences 1.2.1, play-services-location 21.4.0, compileSdk / targetSdk / minSdk 37 / 36 / 29. The Compose BOM needs compileSdk 37. Package name and screen design are your choice.
- **Settings:** `baseUrl` and `runnerKey` live in DataStore. The key is trimmed and must be 43 base64url characters (32 random bytes, no padding). Changing the key is blocked while a session is active. Release builds accept HTTPS only. A debug-only network security config allows cleartext to `localhost` (physical phone via `adb reverse`) and `10.0.2.2` (emulator). The app has no tunnel-specific code. Public access goes through `https://<machine>.<tailnet>.ts.net`.
- **Wire contract:** the source of truth is `shared/src/contract.ts`. Hand-write Kotlin classes for FixRecord `{seq, kind:"fix", recordedAt, lat, lon, accuracyM, altitudeM?, speedMps?}`, EndRecord `{seq, kind:"end", recordedAt}`, IngestBatch `{sessionId, sessionStartedAt, records}`, IngestAck `{sessionId, ackedThroughSeq, serverNow}` and ErrorBody `{error:{code,message}}`. Use kotlinx.serialization with `explicitNulls = false`: optional fields are omitted, never `null`. Map `hasAltitude()` / `hasSpeed()` to absent fields. JVM contract tests round-trip every valid sample in `shared/fixtures/*.json` and reject the invalid ones. A contract change updates the schema, the fixtures and the Kotlin classes together.
- **Conventions:** times are integer epoch ms UTC. `recordedAt` = `Location.getTime()`. Units are SI and field names carry a unit suffix. `sessionId` is a phone-generated UUIDv4. `seq` starts at 0 and increases by 1 per session. Clients branch on HTTP status plus error `code`, never on the message text.
- **One service (`TrackingService`):** it owns the session state and is the only writer of seq numbers and outbox rows. Seq allocation and the Room insert happen in one `@Transaction` on a single-threaded writer. Start and Stop are commands sent to the service. Start creates the session (`sessionId`, `sessionStartedAt`, and the runner key captured at that moment) and calls `startForeground` with type `location` and a persistent notification. Fixes come from `FusedLocationProviderClient` at 5 s, high accuracy. Each fix is validated (has accuracy, finite coordinates; otherwise dropped) and written to the outbox before any network attempt. On Stop the service removes location updates, drains pending callbacks, then writes an `end` record with the next seq. The service returns `START_STICKY` and, after an OS restart, resumes the same session from persisted state with no seq gaps or duplicates. WorkManager and JobScheduler are not used.
- **Draining:** after Stop the service stays in the foreground in a `DRAINING` state, with type `dataSync` and the notification "Uploading N pending". It calls `stopSelf()` only when the outbox is empty. Launching the app with a non-empty outbox and no active session restarts draining. A planning review noted that the service can declare `location|dataSync` and switch type through `ServiceCompat.startForeground`, and that dataSync is capped at 6 h on Android 15+.
- **Permissions:** `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION` ("Allow all the time"), `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` and `FOREGROUND_SERVICE_DATA_SYNC`, plus the battery-optimization exemption. All are granted at setup, before the first `startForeground`.
- **Uploader:** a coroutine owned by the service. It flushes every 10 s and immediately when connectivity returns. It always sends the oldest remaining session first, from its lowest remaining seq. Each batch holds records of exactly one session, in increasing seq order, at most 200, with `Authorization: Bearer <that session's captured key>` to `POST /api/v1/ingest`. On `200` it deletes exactly `WHERE sessionId = ack.sessionId AND seq ≤ ack.ackedThroughSeq`.
- **Errors:** `400 INVALID_BATCH`, `409 SESSION_OWNER_MISMATCH` and `413 BATCH_TOO_LARGE` are final for that batch: move its rows to a local `quarantine` table and continue. Network errors, `5xx`, `401` and `429` leave the outbox untouched and retry with capped exponential backoff (max 60 s). Recording is never blocked by upload failures. The server is idempotent on `(sessionId, seq)`, so resends are safe.
- **Health check:** `GET /api/v1/health` returns `200 {ok, serverNow, eventId}` and needs no auth. The "Test connection" action uses it.
- **Testing:** JVM contract tests against `shared/fixtures`. OkHttp MockWebServer uploader tests cover ack-and-delete, 400 quarantine, 401 retry, offline backlog draining in order, and multi-session ordering. Manual checks: airplane mode for 2 minutes mid-run on a real phone, and later a soak of at least 5 h per runner phone (Epic 4).

## Cross-Story Dependencies

- Depends on Epic 1: the `shared` contract and fixtures, `/api/v1/health`, authenticated `/api/v1/ingest` with its error codes, and the live map page used to verify gap filling. `server/scripts/keygen` issues runner keys, and `config/event.json` must list the runner's `keyHash`.
- 2.1 provides settings, the DataStore keys, network security configs and the Kotlin contract classes that 2.2 to 2.4 build on.
- 2.2 provides the service, session and Room outbox that the 2.3 uploader drains. 2.3 adds the quarantine table and backoff that 2.4 reuses for draining after Stop.
- Epic 4 relies on this epic for the soak test of at least 5 h on each runner's phone and the two-runner test run. Sessions outside the active event window are stored and acked but not shown.
