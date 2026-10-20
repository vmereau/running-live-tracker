---
title: 'Uploading positions with acks, retries and offline buffering'
type: 'feature'
created: '2026-10-20'
status: 'done'
baseline_commit: 'd23639b203e58115517205e75852766f5e38285e'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `TrackingService` records fixes into the Room outbox, but nothing sends them, so spectators see nothing and the outbox only grows.

**Approach:** Add an uploader coroutine owned by `TrackingService` that drains the outbox oldest session first in batches of up to 200 records to `POST /api/v1/ingest`. It deletes acked rows, moves rejected batches to a new `quarantine` table and retries transient failures with capped backoff. It flushes every 10 s and right away when connectivity returns. The main screen also shows pending records, the last ack time and the quarantined count.

## Boundaries & Constraints

**Always:** Each batch holds one session's rows in increasing seq order from its lowest remaining seq (≤ 200), with `Authorization: Bearer <that session's captured runnerKey>`. The base URL is read from settings at each flush. On `200` the uploader deletes exactly `sessionId = ack.sessionId AND seq ≤ ack.ackedThroughSeq`. Recording (the writer executor and seq allocation) never waits on the network. Outbox rows are never lost: anything not acked or quarantined stays. The Room upgrade from v1 to v2 keeps existing sessions and outbox rows. Never log the runner key or the Authorization header.

**Never:** The `DRAINING` state, the "Uploading N pending" notification, keeping the service alive after Stop, or restarting draining on app launch (all 2.4). No WorkManager or JobScheduler. No destructive migration fallback. No changes to the server, web or shared contract.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Ack | 250 pending rows in session A | Batch seq 0..199 sent, then 200..249 in the same flush; all deleted; `lastAckedAt` set | N/A |
| Two sessions | Ended session A (older) and active B both have rows | Every A batch is sent before any B batch, each with its own key | N/A |
| 400 / 409 / 413 | Server rejects the batch | The batch's rows move to `quarantine` with status and code; flush continues with the next rows | Final for that batch |
| Network error, 5xx, 401, 429, other status | Any | Outbox untouched; flush stops; retry after 1 s, 2 s, 4 s … capped at 60 s; a success resets the backoff | Logged (status/code only) |
| Bad 200 | Body not an `IngestAck`, or `ack.sessionId` differs from the batch | Treated as a retryable failure, nothing deleted | Logged |
| Offline | No network for 2 min while tracking | Fixes keep their seq and accumulate; when the network returns, a flush starts at once and sends the backlog in order | N/A |
| Invalid settings URL | baseUrl fails validation | No request sent; counts as a retryable failure | N/A |

</frozen-after-approval>

## Code Map

- `android/app/src/main/java/com/runninglivetracker/tracking/TrackingService.kt` -- owns the uploader. Launch the loop in `onCreate` on `scope` with `Dispatchers.IO`; `onDestroy` already cancels `scope`. Do not touch the writer, the seq logic or the Stop ordering. Add a `connectivitySourceFactory` test seam next to `locationSourceFactory`.
- `.../tracking/db/TrackingDao.kt`, `Entities.kt`, `AppDatabase.kt` -- add queries/entities here. `AppDatabase.get` builds without migrations today.
- `android/app/schemas/...AppDatabase/1.json` -- the v1 schema, needed for `@AutoMigration(from = 1, to = 2)`. Commit the generated `2.json`.
- `.../contract/Contract.kt` -- reuse `FixRecord`, `EndRecord`, `IngestBatch`, `encodeIngestBatch`, `decodeIngestAck`, `decodeErrorBody`, `ContractException`. Do not change.
- `.../settings/HealthClient.kt` -- the OkHttp client pattern (blocking, `callTimeout`, `IOException`/`RuntimeException` → failure) to mirror in the ingest client.
- `.../settings/SettingsRepository.kt`, `SettingsValidation.validateBaseUrl(url, BuildConfig.DEBUG)` -- the URL source and its check.
- `.../ui/MainScreen.kt`, `MainActivity.kt` -- add the three counters, observed from Room flows.
- Server reference: `server/src/ingest/ingest.ts` acks `ackedThroughSeq = last.seq` of the batch. Codes: `INVALID_BATCH` 400, `BATCH_TOO_LARGE` 413, `SESSION_OWNER_MISMATCH` 409, `UNAUTHORIZED` 401.
- Tests: `TrackingDaoTest.kt` (Robolectric `@Config(sdk = [34])`, in-memory Room), `HealthClientTest.kt` (`mockwebserver3`), `TrackingServiceTest.kt` (`FakeLocationSource`).

## Tasks & Acceptance

**Execution:**
- [x] `.../tracking/db/` -- `QuarantineEntity` (outbox columns plus `httpStatus`, `errorCode` nullable, `quarantinedAt`; PK `(sessionId, seq)`), and a nullable `lastAckedAt` on `SessionEntity`. Bump `AppDatabase` to version 2 with `autoMigrations = [AutoMigration(1, 2)]`. DAO: `nextUploadSession()` (oldest `sessionStartedAt` with outbox rows), `pendingBatch(sessionId, limit)`, `@Transaction ackThrough(sessionId, seq, ackedAt)` (delete + set `lastAckedAt`), `@Transaction quarantine(sessionId, seqs, status, code, at)` (insert-select + delete), and flows `observePendingCount()`, `observeQuarantineCount()`, `observeLastAckedAt()` (MAX over sessions) -- storage for upload state.
- [x] `.../upload/IngestClient.kt` -- `send(baseUrl, runnerKey, batch): IngestResult` with `Acked(ack)` / `Rejected(status, code)` (400/409/413 only) / `Retry(reason)` (everything else, including an undecodable 200) -- maps HTTP to the three outcomes.
- [x] `.../upload/Uploader.kt` -- `suspend fun flush(): Boolean` loops batch by batch until the outbox is empty (true) or a retryable failure (false). Outbox rows map to `FixRecord`/`EndRecord`. A pure `backoffMs(failures)` = min(1000·2^(n-1), 60000). `run(trigger)` loop: flush, then wait for `10 s` on success or the backoff on failure, or until `trigger` fires (connectivity returned; resets the backoff) -- the policy, kept off the service for testing.
- [x] `.../upload/ConnectivitySource.kt` -- interface plus a `ConnectivityManager.registerDefaultNetworkCallback` implementation that signals `onAvailable`. Add `ACCESS_NETWORK_STATE` to `AndroidManifest.xml` -- immediate flush on reconnect.
- [x] `TrackingService.kt` -- start `Uploader.run` in `onCreate`, unregister connectivity in `onDestroy`. Add the test seams.
- [x] `MainScreen.kt`, `MainActivity.kt`, `strings.xml` -- "Pending", "Last ack" (local `HH:mm:ss`, or "—"), "Quarantined" -- epic main-screen contents.
- [x] `gradle/libs.versions.toml`, `app/build.gradle.kts` -- `kotlinx-coroutines-test` (test only) -- virtual-time loop tests.
- [x] `android/app/src/test/.../upload/` -- `UploaderTest` (Robolectric in-memory Room + MockWebServer): ack-and-delete with a 250-row backlog sent in order, 400 quarantine then continue, 409/413 quarantine, 401/500/429/network failures retried with the outbox untouched, bad 200, multi-session ordering with per-session Bearer, invalid URL. `BackoffTest`. A `run` loop test under `runTest`: the 10 s cadence, backoff growth, and a trigger flushing immediately. `MigrationTest`: build a v1 DB file from `1.json`'s create SQL with one session and outbox row, open `AppDatabase` v2, check the rows survive and `quarantine` is empty -- matrix coverage.
- [x] `README.md` -- Android section: uploader behavior and the airplane-mode manual check.

**Acceptance Criteria:**
- Given a fix written while uploads fail, when it is recorded, then it gets the next seq without waiting on any HTTP call (writer and uploader are independent).
- Given a v1 database with outbox rows, when the v2 app opens it, then no row is lost.
- Given the main screen, when rows are pending, acked or quarantined, then the three counters update from Room.
- Given `cd android && ./gradlew test assembleDebug assembleRelease`, then it passes.

## Implementation Notes

## Spec Change Log

## Review Triage Log

| # | Source | Finding | Verdict | Route | Evidence |
|---|--------|---------|---------|-------|----------|
| 1 | blind, edge | Poison outbox row (`checkNotNull` in `toRecord`, encode or header exceptions) stalls the outbox forever | low | reject | Unreachable: `appendFix` only writes `ValidFix` (non-null lat/lon/accuracyM), kinds are only fix/end, and the key is validated as base64url before the session is created. The fix adds a local-quarantine branch. |
| 2 | blind, edge | 401 (or a persistent retry) on the oldest session blocks every newer session, including the live one | medium | defer | Real, but strict oldest-first plus "401 = retry" is the frozen intent and the epic AC. It needs a revoked key with rows stranded in an older session. Policy change (skip or cap) belongs with 2.4 draining. |
| 3 | edge, blind | `flush()` loop has no suspension point, so it keeps uploading after `onDestroy` cancels the scope | low | patch | Verified: no suspend call inside `while (true)`. Fix: `ensureActive()` per iteration. |
| 4 | blind | Blocking OkHttp call not cancelled by coroutine cancellation (up to 30 s) | low | reject | Benign: an in-flight batch finishing after destroy only acks or deletes correctly, and resends are idempotent. The fix adds call-cancel plumbing. |
| 5 | blind, edge | `onDestroy` throws `UninitializedPropertyAccessException` if `onCreate` failed before `connectivity` was set | false | reject | If `onCreate` throws, the process crashes and `onDestroy` is never invoked. |
| 6 | blind, edge | Uploader coroutines leak across `TrackingServiceTest` tests | low | patch | Verified: helper-created services are not destroyed. Direct fix in tearDown. |
| 7 | blind | 413 quarantines good records instead of splitting the batch | low | reject | Batches are capped at 200 records (≈30 kB), far under Fastify's 1 MB default body limit, so 413 is unreachable in practice. The frozen intent mandates quarantine. |
| 8 | blind | 400 quarantines the whole batch for one bad record, including `end` | low | reject | The frozen intent mandates batch quarantine. Records are pre-validated on the phone, so a 400 means a contract mismatch, where bisection would not help. |
| 9 | blind | `Retry-After` ignored on 429/503 | low | reject | The server does not send it, and the backoff is already capped. |
| 10 | blind | Response body read with no size limit | low | reject | Captive-portal pages are small. Unlikely and cosmetic. |
| 11 | blind | "Last ack" shows only `HH:mm:ss`, misleading across days | low | reject | The format is specified. Meaningful only when the app is reopened on another day. |
| 12 | blind | Quarantine table has no viewer, clear or prune | low | reject | Out of scope (no harm beyond a count). A handful of rows per race. |
| 13 | blind | Orphan outbox rows counted as pending but never uploaded | false | reject | Sessions are never deleted, and outbox rows are only inserted inside a transaction that reads the session row. |
| 14 | blind | `MigrationTest` hand-built instead of `MigrationTestHelper`; string `contains` checks | low | reject | Opening v2 runs Room's schema validation against the generated schema. Adequate. |
| 15 | blind | Spec and sprint-status statuses disagree; empty notes sections | false | reject | The workflow syncs sprint status at step 5. The empty sections are left for later steps. |
| 16 | blind | Design Notes cite the server as the ack-range guarantee | low | reject | The fix edits this build's spec. |
| 17 | blind | Import ordering in `TrackingServiceTest` | low | reject | No ktlint or spotless in the build. |
| 18 | blind, vgap | `AndroidConnectivitySource` untested | low | patch | Pre-verified. A Robolectric shadow test is cheap. |
| 19 | blind, vgap | MainActivity wiring of the counters untested | low | patch | Pre-verified. Swapping `pending`/`quarantined` compiles and passes. |
| 20 | blind | No test that the key or Authorization header is never logged | low | reject | Log lines were inspected: only status, code, session and seq ranges. Needs log-capture infrastructure. |
| 21 | vgap | Lower bound of the ack range check never exercised | low | patch | Pre-verified. |
| 22 | vgap | Exception-to-retry wrapper in `Uploader.run` untested | low | patch | Pre-verified. Losing it would stop uploads for the rest of the session. |
| 23 | vgap | `observeLastAckedAt` MAX tested with one session only | low | patch | Pre-verified. A small test. |

## Design Notes

Deleting outbox rows while the writer inserts is safe: inserts always use seq > every pending seq, and Room serializes transactions. The uploader never allocates seq. `ackThrough` deletes by `seq ≤ x`, so an ack covering rows outside the batch is impossible (server acks the batch's last seq). Backoff mirrors the simulator (1 s doubling, 60 s cap) for consistent behavior.

## Verification

**Commands:**
- `cd android && ./gradlew test assembleDebug assembleRelease` -- expected: BUILD SUCCESSFUL.

**Manual checks (if no CLI):**
- Real phone against the server: Start, airplane mode on for 2 min, then off. Pending grows then drops to 0 within seconds. On the web page the last-update age grows during the gap, then the gap fills in. The positions are stored under the right runner.
