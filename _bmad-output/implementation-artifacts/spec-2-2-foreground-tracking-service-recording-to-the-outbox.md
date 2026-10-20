---
title: 'Foreground tracking service recording to the outbox'
type: 'feature'
created: '2026-10-20'
status: 'done'
baseline_commit: '3f5416cc11abd8649f6ee7aa6145a9affbd4eabb'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The app can only store settings. A runner cannot press Start, pocket the phone and have every GPS fix recorded with the screen locked, so nothing exists for the 2.3 uploader to send.

**Approach:** Add a setup flow that grants every permission, a single foreground `TrackingService` that owns a persisted session and writes validated fixes and a final `end` record into a Room outbox (seq allocated in one transaction on a single-threaded writer), and a main screen showing tracking state, elapsed time and fix count.

## Boundaries & Constraints

**Always:** Only `TrackingService` writes sessions and outbox rows. Seq starts at 0 and increases by 1 per session, with no gaps or duplicates across Stop and OS restarts. `recordedAt = Location.getTime()`. Fixes without accuracy or with non-finite or out-of-range values are dropped before the insert (reuse `FixRecord.validate()`). Altitude and speed are stored only when `hasAltitude()`/`hasSpeed()`. The session captures `sessionId` (UUIDv4), `sessionStartedAt` (epoch ms) and the runner key at Start. The fix count lives on the session row, because 2.3 will delete outbox rows. Start is enabled only when settings are valid and every permission is granted. The runner key field cannot be saved while a session is active. Never log the runner key.

**Never:** Uploader, network calls from the service, quarantine table, `DRAINING` state, pending/ack counters (2.3/2.4). WorkManager, JobScheduler, kapt, race stats. No server, web or shared contract changes.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Start | Valid settings, all permissions | Session row created, foreground (type `location`) with persistent notification, updates every 5 s high accuracy | N/A |
| Valid fix | lat/lon finite, has accuracy | Outbox row `kind=fix` with next seq; session fix count +1 | N/A |
| Bad fix | No accuracy, NaN lat, lat 91 | Not stored, seq not consumed | Dropped silently |
| Stop | Session active | Updates removed, queued callbacks written, then `end` with next seq; session marked ended; service leaves foreground and stops | A fix arriving after `end` is dropped |
| OS restart | `START_STICKY` with null intent, active session in Room | Same session resumed, next fix gets next seq | No active session → `stopSelf()` |
| App opened, session active, service dead | Active session in Room | Activity sends Resume; tracking continues | N/A |
| Key edit during session | Active session | Key field disabled, message shown | N/A |
| Missing permission | Any of the 4 not granted | Start disabled; setup lists each with its explanation and a Grant button | N/A |
| Stop tapped | Session active | Confirmation dialog; only "Stop" sends the Stop command | Cancel keeps tracking |

**Decisions:**
- Stop is protected by an in-app confirmation dialog. The notification has no Stop action (avoids accidental stops in a pocket).

</frozen-after-approval>

## Code Map

- `android/app/src/main/java/com/runninglivetracker/contract/Contract.kt` -- `FixRecord`/`EndRecord` and `validate()`: reuse to validate a fix before insert. Do not change.
- `.../settings/SettingsRepository.kt`, `SettingsValidation.kt` -- read the settings to gate Start; validation is reused unchanged.
- `.../ui/SettingsScreen.kt` -- add a `keyLocked` parameter that disables the key field and Save of a changed key.
- `.../MainActivity.kt` -- currently shows only `SettingsScreen`; becomes the host of main/setup/settings screens.
- `android/app/build.gradle.kts`, `gradle/libs.versions.toml` -- Room runtime and `ksp(room-compiler)` already wired; add `room-ktx` if needed, `kotlinx-coroutines-play-services` (Task `await`), and test deps.
- `android/app/src/main/AndroidManifest.xml` -- INTERNET only today.

## Tasks & Acceptance

**Execution:**
- [x] `.../tracking/db/` -- `AppDatabase` (version 1, `exportSchema = true` with KSP `room.schemaLocation` = `android/app/schemas`, committed), `SessionEntity` (sessionId PK, sessionStartedAt, runnerKey, nextSeq, fixCount, endedAt nullable), `OutboxEntity` (PK `(sessionId, seq)`, kind, recordedAt, lat/lon/accuracyM/altitudeM/speedMps nullable), `TrackingDao` with `@Transaction` `appendFix`/`appendEnd` (read nextSeq, insert, bump; drop if session ended) and a `Flow` of the active session -- seq integrity.
- [x] `.../tracking/FixMapper.kt` -- pure function from primitive location values (`hasAccuracy`, `time`, …) to a validated `FixRecord`-shaped value or null -- JVM-testable without `android.location.Location`.
- [x] `.../tracking/TrackingService.kt` -- Start/Stop/Resume commands; one single-thread executor used for location callbacks and all DB writes; Stop = `removeLocationUpdates(...).await()` then `appendEnd` on the same executor; `ServiceCompat.startForeground` type `location`; notification channel and persistent notification; `START_STICKY` -- AC 2–4.
- [x] `.../ui/MainScreen.kt`, `.../ui/SetupScreen.kt`, `MainActivity.kt` -- main screen (state, elapsed ticking each second from `sessionStartedAt`, fix count, Start/Stop, Settings), setup list (fine location, background "Allow all the time" requested after fine, `POST_NOTIFICATIONS` on API 33+, battery exemption via `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`), re-checked on resume; Resume sent on start if a session is active -- matrix rows.
- [x] `AndroidManifest.xml`, `res/values/strings.xml` -- permissions (`ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `FOREGROUND_SERVICE_DATA_SYNC`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`), service `exported=false` with `foregroundServiceType="location|dataSync"` -- AC 1.
- [x] `android/app/src/test/.../tracking/` -- `FixMapperTest` (matrix bad-fix rows, absent optionals), `TrackingDaoTest` on an in-memory Room DB via Robolectric (seq 0..n, end after fixes, drop after end, resume after reopening the DB continues seq, fixCount) -- seq invariants.
- [x] `README.md` -- Android section: setup permissions and manual tracking check.

**Acceptance Criteria:**
- Given the manifest, when it is inspected, then it declares `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` and `FOREGROUND_SERVICE_DATA_SYNC`.
- Given a session with fixes 0..n, when Stop runs, then the outbox holds seq 0..n+1 for that session with the last row `kind=end` and no gaps.
- Given the DB is closed and reopened mid-session, when the next fix is appended, then it gets the next seq after the last stored one.
- Given `./gradlew test assembleDebug assembleRelease`, then it passes.

## Implementation Notes

## Spec Change Log

## Review Triage Log

| # | Source | Finding | Verdict | Route | Evidence |
|---|--------|---------|---------|-------|----------|
| 1 | blind, edge (x3) | `stopping` never resets and Stop finishes with `stopSelfResult(stopId)`; a Resume during Stop leaves the service foreground forever | low | patch | Resume's post skips both `requestUpdates` and stop under `!stopping`; a newer startId makes `stopSelfResult` false. Direct fix: after `end`, if still stopping, reset, leave foreground, `stopSelf()`. |
| 2 | blind | Stop enters foreground with type `location`; with location revoked it throws, `end` is never written, session stays active and key locked forever; stopping before `startForeground` can crash | medium | patch | `onStartCommand` calls `enterForeground()` (type location) for every action, including STOP. Fix: STOP goes foreground with type `dataSync` (already declared). |
| 3 | blind, edge (x3) | Resume only sent when `savedInstanceState == null`: reopening from recents after process death restores a bundle, so tracking never resumes; granting permissions later never resumes either | medium | patch | Process death is exactly the row's scenario and Android restores the saved state. Fix: run the check on every ON_RESUME. |
| 4 | blind, edge | Resume gated on `allGranted` (battery, notifications) though only location is needed: UI shows Tracking while nothing records | low | patch | Revoking battery exemption mid-session blocks resume. Direct fix: gate on `permissions.location`. Start gating stays `allGranted`. |
| 5 | vgap | No test that Stop writes `end` after a callback still in flight during `remove()` | low | patch | Pre-verified. Fake `remove()` dispatches one location to the executor before returning. |
| 6 | vgap | No test for Stop as the first command to a fresh service | low | patch | Pre-verified. The `?: dao.activeSession()` fallback is untested. |
| 7 | vgap | `allGranted` / `permissionState()` and the resume gate untested | low | patch | Pre-verified. Add `allGranted` per-field test and MainActivity "location missing → no Resume". |
| 8 | vgap | MainActivity wiring of `keyLocked` and `settingsValid` untested | low | reject | Pre-verified; two one-line expressions, needs activity-level Compose test infra; composables are tested. |
| 9 | vgap | Save-time key-lock guard untested | low | reject | Pre-verified; backstop behind a disabled field, reachable only in an edge case. |
| 10 | vgap | Start with invalid settings untested; foreground-failure and permission-missing paths untested | low | patch | Pre-verified. Patch the invalid-settings case only; the other two are defensive logging paths (rejected). |
| 11 | blind, edge | Battery / app-settings `startActivity` without `ActivityNotFoundException` handling | low | reject | Stock and major OEM builds handle both intents; the two runner phones are known; fix adds fallback branches. |
| 12 | blind, edge | Device location off or request Task failure: Start succeeds, no fixes | low | reject | Fix count staying 0 is visible on the main screen; fix adds a settings check and a new setup item. |
| 13 | blind | Cached/out-of-order fixes accepted | low | reject | Default `maxUpdateAge` = interval (5 s); server orders by seq; harmless. |
| 14 | blind | `baseUrl` editable mid-session | false | reject | Architecture H15 captures only the key; a different server rejects with 409 → quarantine (2.3). Intended. |
| 15 | blind | `dataSync` declared ahead of 2.4 | false | reject | Story AC requires the manifest to declare `FOREGROUND_SERVICE_DATA_SYNC`; also used by row 2 now. |
| 16 | blind | Float→Double widening (`5.1f` → `5.0999999…`) | low | reject | Cosmetic; within contract. |
| 17 | blind | Robolectric tests only on SDK 34 | low | reject | Allowed by Design Notes; SDK 35+ needs a Java 21 test JVM. |
| 18 | blind | Threading KDoc wrong; orphan active sessions never cleaned | false | reject | `onDestroy` resets `updatesRequested`; Start reuses the active session, so two `endedAt IS NULL` rows cannot be created. |
| 19 | edge | Service destroyed while Stop is suspended in `remove()` → `RejectedExecutionException`, no `end` | false | reject | No path calls `stopSelf` while `stopping` is true before `end` (resume guarded, Start reuses session); system kill takes the process. |
| 20 | edge | Room write exception crashes the writer thread | low | reject | Seq PK conflict impossible inside the transaction; disk-full is rare; fix adds catch branches. |
| 21 | edge | Start refused with a newer command id leaves the notification | low | reject | Needs invalid settings, which the UI blocks before Start. |
| 22 | edge | Location revoked on API 29–33: foreground succeeds, nothing recorded | low | reject | User revoking location mid-race is unlikely; fix adds a stop branch and UI state. |
| 23 | edge | `startForegroundService` after the activity goes background before the IO query returns | low | reject | Millisecond window; fix adds a catch. |

## Design Notes

Ordering on Stop comes from the shared single-thread executor: FusedLocation delivers callbacks on it, so once `removeLocationUpdates` completes, every already-dispatched callback is queued ahead of `appendEnd`. The ended-session check inside the transaction is the second guard. The UI observes Room, not the service, so it needs no binding and survives process death. Room tests: if Robolectric does not support SDK 36, pin `@Config(sdk = [<highest supported>])`.

## Verification

**Commands:**
- `cd android && ./gradlew test assembleDebug assembleRelease` -- expected: BUILD SUCCESSFUL.

**Manual checks (if no CLI):**
- On a real phone: grant setup, Start, lock for 5 min, unlock: fix count ~60, elapsed correct. Stop, then `adb shell run-as com.runninglivetracker` + sqlite shows seq contiguous ending in `end`. `adb shell am kill` while locked: tracking resumes with the next seq.
