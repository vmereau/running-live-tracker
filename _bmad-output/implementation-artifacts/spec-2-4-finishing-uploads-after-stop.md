---
title: 'Finishing uploads after Stop'
type: 'feature'
created: '2026-10-20'
status: 'done'
baseline_commit: '9e0668d88a11d0729130f8069c6221f485b1d241'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** On Stop, `TrackingService` writes `end` and stops itself right away. That kills the uploader, so the last positions (and `end`) stay on the phone until the next Start.

**Approach:** After Stop, if the outbox is not empty, the service stays in the foreground in a `DRAINING` state (type `dataSync`, notification "Uploading N pending" updated from Room). It calls `stopSelf()` once the outbox is empty. When the app opens with no active session and a non-empty outbox, it sends a new `ACTION_DRAIN`, and a sticky restart with no active session drains too. The main screen headline shows "Uploading" while records are pending and no session is active.

## Boundaries & Constraints

**Always:** DRAINING is entered only when no session is active and the outbox has rows. It leaves on an empty outbox (stopSelf and remove the notification), on a Start (back to tracking, type `location`), or on the OS `dataSync` timeout (`onTimeout`: leave the foreground and stopSelf, keep the rows, and the next app launch drains again). The uploader keeps its 2.3 policy: oldest session first, same retries and quarantine, and an immediate flush when DRAINING starts. A `DRAIN` that arrives while tracking changes nothing and keeps the `location` type. Recording, seq allocation and the Stop ordering (remove updates, then `end`) are unchanged. Never log the runner key.

**Never:** WorkManager or JobScheduler. No change to the Room schema, the server, the web or the shared contract. No race stats on screen. No Stop action in the notification.

**Decision (persistent retry while draining):** keep strict oldest-session-first. A session stuck on a retry (e.g. 401) keeps DRAINING until the outbox is empty or the OS timeout. No skip policy or "auth failing" indicator in this story. The 2.3 deferred item stays open.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Stop, rows pending | `end` written, outbox has N > 0 rows | Stays foreground, type `dataSync`, notification "Uploading N pending". N drops as acks arrive. At 0 the notification is removed and the service stops itself | N/A |
| Stop, outbox empty | `end` written and acked or nothing pending | Stops at once, as today | N/A |
| Offline while draining | Uploads keep failing | Stays DRAINING and retries with backoff | OS timeout → stop, rows kept |
| App launch | No active session, outbox has rows, service dead | `ACTION_DRAIN` sent; service drains as above | N/A |
| App launch, nothing to do | No active session, outbox empty | No command sent | N/A |
| Sticky restart | Null intent, no active session, rows pending | Drains instead of stopping | N/A |
| Start during DRAINING | User presses Start | New session tracked with type `location`; the old session's rows still go first; no stopSelf when the old rows hit 0 | N/A |
| DRAIN while tracking | Active session, `ACTION_DRAIN` | No state or type change | N/A |
| dataSync timeout | `onTimeout(startId, fgsType)` | Leave foreground and stopSelf within seconds; outbox untouched | Logged |

</frozen-after-approval>

## Code Map

- `android/app/src/main/java/com/runninglivetracker/tracking/TrackingService.kt` -- the only file with real logic changes. `stop()` currently calls `leaveForeground(); stopSelf()` after `appendEnd`: branch there on the pending count. `resume()` with no active session currently stops: drain if rows are pending. `onStartCommand` picks the foreground type per action: `DRAIN` → `dataSync` unless `updatesRequested`. `start()` must cancel draining. `buildNotification()` should take the text. `uploadTrigger.trySend(Unit)` forces an immediate flush. Keep draining state on the main thread, like `stopping`. Add `onTimeout(startId, fgsType)` (API 35).
- `.../tracking/db/TrackingDao.kt` -- reuse `observePendingCount()` (Flow) for the notification and the stop condition. Add a blocking `pendingCount()` query if needed on the writer. No entity or schema change.
- `.../upload/Uploader.kt` -- unchanged (strict oldest-first kept).
- `.../MainActivity.kt` -- `onResume` sends `ACTION_RESUME` when a session is active. Add: otherwise, if `pendingCount() > 0`, send `ACTION_DRAIN` (no location permission needed).
- `.../ui/MainScreen.kt`, `res/values/strings.xml` -- headline: `state_uploading` when `session == null && upload.pending > 0`. Strings for "Uploading" and the notification "Uploading %d pending".
- `AndroidManifest.xml` -- already declares `location|dataSync` and `FOREGROUND_SERVICE_DATA_SYNC`. Remove the "(Story 2.4)" comment only if it is wrong.
- Tests: `TrackingServiceTest.kt` (fakes `FakeLocationSource`, `FakeConnectivitySource`, `FakeIngestClient` with `respond`; `awaitUntil`/`settle`; `shadowOf(service).isStoppedBySelf`, `isForegroundStopped`, `lastForegroundNotification`, `service.foregroundServiceType`). Existing Stop tests assume an immediate stopSelf: make `ingest.respond` ack in them, or assert draining instead. `MainActivityTest.kt` (`assertResumeSent` pattern via the shadow's next started service). `MainScreenTest.kt`.

## Tasks & Acceptance

**Execution:**
- [x] `.../tracking/TrackingService.kt` -- add `ACTION_DRAIN`, the DRAINING state, the pending-count observer job (updates the notification via `NotificationManager.notify`, stops at 0), the Stop/Resume branches, Start cancelling the drain, and `onTimeout` -- the core of the story.
- [x] `.../tracking/db/TrackingDao.kt` -- `pendingCount(): Long` blocking query -- used by the writer and by the activity.
- [x] `.../MainActivity.kt` -- send `ACTION_DRAIN` on resume when there is no active session and rows are pending -- restart draining on app launch.
- [x] `.../ui/MainScreen.kt`, `strings.xml` -- "Uploading" headline and the notification strings -- draining is visible on screen.
- [x] `android/app/src/test/.../tracking/TrackingServiceTest.kt` -- matrix rows: Stop with pending rows (type dataSync, notification text "Uploading N pending", updates as acks arrive, stops at 0), Stop with an empty outbox, sticky restart draining, DRAIN while tracking unchanged, Start during DRAINING, `onTimeout` stops with rows kept. Update the existing Stop tests.
- [x] `.../MainActivityTest.kt`, `.../ui/MainScreenTest.kt` -- DRAIN sent or not on launch; the "Uploading" headline.
- [x] `README.md` -- Android section: draining after Stop and the manual check.

**Acceptance Criteria:**
- Given Stop with records pending, when the `end` record is written, then the service stays foreground as `dataSync` with "Uploading N pending", the notification updates as acks arrive, and `stopSelf()` is called only once the outbox is empty.
- Given the app launched with a non-empty outbox and no active session, when it starts, then the service runs in DRAINING.
- Given the main screen while draining or idle, then pending, last ack and quarantined are shown.
- Given `cd android && ./gradlew test assembleDebug assembleRelease`, then it passes.

## Implementation Notes

## Spec Change Log

## Review Triage Log

| # | Source | Finding | Verdict | Route | Evidence |
|---|--------|---------|---------|-------|----------|
| 1 | vgap | Drain on a fresh service that finds an active session: switch back to `location` untested | low | patch | Pre-verified: no test reaches the `foregroundType != LOCATION` branch in `resume()`. Add a test. |
| 2 | vgap | `startDraining` fallback when `enterForeground(dataSync)` fails is untested | low | reject | Needs a new seam in `enterForeground` to fake the throw; the fallback is three plain lines. |
| 3 | vgap, blind, edge | Sticky restart with location revoked goes foreground as `location`, fails and stops instead of draining | low | reject | Real but rare: needs the process killed while draining and location revoked after Stop. The next app launch sends Drain (dataSync) and recovers. The fix needs a Room read or permission branch before `startForeground`. |
| 4 | blind, edge | Start while draining cancels the drain before Start is known to succeed | low | reject | Start is only sent by the button, which is disabled unless settings are valid and every permission is granted. The next app resume sends Drain. |
| 5 | blind, impl | Draining notification first shows "Tracking your run" until the first count emits | low | patch | Verified: `startDraining` calls `enterForeground` before `showDrainingText`. Both callers know `pending`: set the text first. |
| 6 | vgap, blind, edge | `resume()` ignores a failed `enterForeground(LOCATION)` | low | reject | Reachable only when a Drain races a Start and location is revoked: `MainActivity` sends Drain only with no active session. |
| 7 | blind, edge (x3) | Draining never ends on API < 35 when uploads are stuck (401, invalid or cleared URL) | medium | defer | Real: `onTimeout` exists only on API 35+ and minSdk is 29. The frozen decision keeps strict draining "until the outbox is empty or the OS timeout"; a cap or skip policy is a new decision. Extends the 2.3 deferred item. |
| 8 | blind | README says the next launch drains again after a timeout, but the dataSync quota may still be spent | low | patch | Verified: within the 24 h window `startForeground(dataSync)` throws and `startDraining` stops. Fix the README wording. |
| 9 | blind | "Uploading" headline is shown even when no service is running | low | reject | The frozen intent derives the headline from Room ("records pending and no session active"). |
| 10 | blind | `onTimeout` override has no `super` and no `@RequiresApi` | low | reject | compileSdk 37; the base method is a no-op and is only called on API 35+. The build and lint pass. |
| 11 | blind | Notification text should be a plurals resource | low | reject | The text is the epic's "Uploading N pending"; the app is not localized. |
| 12 | blind | Timeout test does not prove uploads stop | low | reject | In production `stopSelf` leads to `onDestroy`, which cancels the uploader (covered by existing tests). Robolectric does not destroy on `stopSelf`. |
| 13 | blind | Missing tests: repeated Drain while draining, Drain with location revoked | low | patch | Cheap tests of claims in the spec (idempotent Drain, no location permission needed). The other listed gaps are covered (`openingTheAppWithoutASessionSendsNothing`) or rejected above. |
| 14 | blind | `MainActivity.onResume` reads the session and the count outside a transaction | low | reject | Any interleaving yields a command the service re-checks from Room. |
| 15 | edge | A posted `startDraining` can run after the service was destroyed | low | reject | Needs `onDestroy` while a Stop or Resume is in flight on the writer; no such path in normal use. |
| 16 | edge | Each app open during draining resets the uploader backoff | low | reject | Only on user-initiated opens; resends are idempotent. |

## Design Notes

Draining is derived, not persisted: "no active session and outbox not empty". The service, the sticky restart and the activity all decide from Room, so no schema change and no state that can drift. The stop condition reads the Flow on the main thread and checks that the state is still DRAINING, which avoids a race with a Start. `ServiceCompat.startForeground` can switch type from `location` to `dataSync` on the running service, because the manifest declares both. On Android 15+, `dataSync` is capped at 6 h per 24 h. `onTimeout` must stop the service within seconds or the app crashes.

## Verification

**Commands:**
- `cd android && ./gradlew test assembleDebug assembleRelease` -- expected: BUILD SUCCESSFUL. Export `GRADLE_USER_HOME=D:\Android\gradle-home` and `JAVA_HOME=C:\Program Files\Java\jdk-17.0.3.1` in the same command (C: is nearly full; the default JAVA_HOME is broken).

**Manual checks (if no CLI):**
- Real phone: Start, airplane mode on, record about 1 min, press Stop. The notification shows "Uploading N pending". Swipe the app away. Turn airplane mode off. N drops to 0, the notification disappears, and the web track fills in to the end.
