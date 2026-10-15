---
review: reconcile
target: ARCHITECTURE-SPINE.md (running-live-tracker, 2026-10-15, status draft)
against: _bmad-output/specs/spec-running-live-tracker/SPEC.md (+ .memlog.md)
date: 2026-10-15
verdict: PASS WITH FIXES
---

# Reconcile review: spec vs architecture spine

## Verdict

**PASS WITH FIXES.** Every capability (CAP-1 to CAP-7), every constraint, every non-goal and both assumptions has a home in the spine. No spec item was dropped outright, and no non-goal was violated. The problems are under-coverage: a few rules, read literally, would make a spec success criterion fail in plausible race-day conditions (a stuck progress projection, a misleading "last update" indicator, an elapsed time that keeps running after the finish). The operational constraint "the home PC must stay up for the whole race" is also pushed entirely to a deferred runbook. Fixing the four findings marked High/Medium below would clear the spine.

## Coverage matrix

| Spec item | Spine coverage | Status |
| --- | --- | --- |
| Why: where / how fast / how much remains | AD-6, AD-7, AD-8 | Covered |
| CAP-1 start/stop, server holds positions | AD-3, AD-4, AD-10 | Covered |
| CAP-2 all active runners, live, pick a runner | AD-6, web store convention | Covered (see F-8) |
| CAP-3 elapsed, distance, current + avg pace, close to watch | AD-2, AD-7, AD-8 | **Under-covered** (F-3, F-6) |
| CAP-4 one shared GPX, km done/total, remaining, % | AD-7, `/api/v1/course`, config `coursePath` | **Under-covered** (F-1) |
| CAP-5 ETA, changes with pace | AD-8 | Covered, weakly (F-7) |
| CAP-6 key-only ingest, key identifies runner | AD-5 | Covered (see F-9) |
| CAP-7 offline buffer + last-update age, gap fills in | AD-3, AD-10, AD-2, AD-6 | **Under-covered** (F-2) |
| C: Android only | Stack, seed | Covered |
| C: home PC + tunnel, public HTTPS, no port forwarding | AD-11, deployment seed | Covered |
| C: home PC, power, internet must stay up all race | Deferred (runbook, Windows services) | **Under-covered** (F-4) |
| C: one shared link, no viewer login | AD-5 (read endpoints unauthenticated) | Covered (see F-10) |
| C: runners, runs, keys, GPX set up on server only | Config convention, keygen CLI | Covered (see F-11) |
| C: position every 5-10 s | AD-10 (5 s fix, 10 s flush) | Covered (see F-12) |
| C: full marathon, pocket, screen locked | AD-10 | Under-covered (F-5) |
| NG: iOS, history/replay, social, viewer accounts/self sign-up | Not built; replay deferred | Respected |
| Success signal: 2 runners, friend on phone, start to finish | AD-6 reconnect semantics; test-run event config | Covered (see F-8) |
| A: runners and keys registered server-side | Config + keygen | Covered |
| A: positions stored so replay can come later | AD-1 | Covered |

## Findings

### F-1 (High) Forward-only window can freeze course progress for the rest of the race. Affects CAP-4, CAP-5, CAP-3.

AD-7 projects each fix only within `[lastProgressM − 50 m, lastProgressM + 1000 m]`, and when a course is set, "distance covered" **is** `progressM`. There is no recovery rule. If accepted fixes stop for more than about 1 km of course, every later fix falls outside the window, stays `offCourse: true`, and progress, distance, remaining, percent and ETA freeze until the finish. Realistic causes:
- the service is killed and restarted late (AD-10 limits the damage but cannot rule it out);
- a stretch of fixes worse than 30 m accuracy (tunnels, tall buildings) that AD-7 skips;
- the runner presses Start a few km into the race (AD-4 assumes Start at the line, but that is only an assumption).

This breaks CAP-4's success criterion ("progress figures match their position on the course") and the success signal.

**Fix:** add a re-acquire rule to AD-7. After N consecutive off-window fixes, or after a time gap, search the whole remainder of the course (≥ `lastProgressM`), limited by a plausible speed (e.g. ≤ gap × 7 m/s), and accept the nearest match within 100 m. Name the constants in `server/src/domain` and add a unit test for the "late Start" and "15-minute gap" cases.

### F-2 (Medium) "Last update" age is tied to accepted fixes, not received updates. Affects CAP-7.

CAP-7 says the UI shows "how long ago each runner last **sent** an update". AD-2 computes age as `now − lastFixAt`. AD-7 says fixes worse than 30 m accuracy "are skipped by all projections", so read literally, `lastFixAt` stops advancing in poor-GPS areas even while the phone is delivering. Spectators would see a runner going stale who is actually connected. `lastFixAt` is also a phone `recordedAt`, so after a backlog flush it shows the age of the newest fix, not the time of the last contact. That is acceptable, but it should be stated.

**Fix:** in `RunnerView`, define a `lastReceivedAt` (server `receivedAt` of the latest batch carrying any record) or a `lastRecordedAt` over *all* stored fixes, separate from the accepted-fix timestamps. Have AD-2's age ticker use that field, and state in AD-7 that the accuracy filter does not apply to it.

### F-3 (Medium) Elapsed time keeps running after the runner stops. Affects CAP-3.

AD-2 says the web computes elapsed time as `now − runStartedAt`, with no case for `status: stopped`. After the finish, a spectator sees elapsed time climbing away from what the runner's watch shows. That contradicts CAP-3 ("values stay close to what each runner's own watch reports"). Server-side `elapsedS` (used in avg pace, AD-8) is also never defined: it could be up to the last fix or up to now.

**Fix:** define `runEndedAt` (the `recordedAt` of the `end` record of the latest session) in `RunnerView`. Elapsed is `(runEndedAt ?? now) − runStartedAt`, and server `elapsedS = lastAcceptedFixAt − runStartedAt`. State both in AD-2 and AD-8.

### F-4 (Medium) The "home PC must stay up" constraint has no architectural guard. Affects the operational constraint and the success signal.

The spec treats home-PC uptime as a hard constraint. The spine puts all of it under Deferred (runbook "after the test run", Windows services optional). But the test run itself is the success signal, so it already needs these measures. Windows-specific failures are not mentioned at all: sleep or hibernate, scheduled Windows Update reboots, the tunnel daemon not autostarting, the laptop lid. AD-1's crash recovery helps only if someone restarts the processes.

**Fix:** add a short operational rule (AD-12 or a deployment-seed bullet) that is required **before the test run**:
- the power plan never sleeps;
- Windows Update active hours or a pause covering race day;
- server and tunnel autostart (service or scheduled task);
- a `/api/v1/health` check, or reuse of `/snapshot`, used for a pre-race smoke test.

Keep the UPS and the fuller checklist deferred.

### F-5 (Low-Medium) Screen-locked marathon endurance is designed for but never verified or budgeted. Affects the full-marathon / pocket / screen-locked constraint.

AD-10 covers the mechanism: foreground service, battery-optimisation exemption, persisted session. Two quiet parts of the constraint are missing:
- **Battery budget.** High-accuracy GPS every 5 s plus a radio wake every 10 s for 4-6 h, with no target such as "≥ 30 % battery left after 5 h".
- **OEM background killers** (Samsung, Xiaomi and others) that ignore the standard exemption.

Nothing ties the test run to proving the constraint.

**Fix:** add an acceptance check to AD-10 or to the Deferred spike list: a 5-hour pocketed, screen-locked soak on each runner's actual phone, measuring battery drain and fix gaps. Note that per-OEM "never sleeping apps" settings belong in the runbook.

### F-6 (Low) The "close to watch" tolerance is undefined, and course distance differs from watch distance by design. Affects CAP-3.

With a course set, distance is course-projected `progressM`. Runners' watches usually read 1-3 % long against a measured course, so the two numbers will drift apart by design. That is fine and arguably better, but the spec's quiet tolerance requirement is not stated anywhere, so the test run has no pass/fail line. `runStartedAt` = first *accepted* fix can also lag the watch start by the time to a GPS lock.

**Fix:** state the tolerance in AD-7/AD-8 (e.g. distance within 3 %, elapsed within 30 s, avg pace within 10 s/km at the finish) and say that course distance is intentionally the course figure, not the GPS figure.

### F-7 (Low) The ETA reacts slowly to pace changes. Affects CAP-5.

CAP-5's success criterion is "changes when their pace changes". AD-8 bases the ETA on *average* pace, so late in the race a sharp slow-down barely moves it. The literal criterion holds, but the spirit is weak. It is already marked `[ASSUMPTION]`. The memlog says `now + …` while the spine says `lastFixAt + …`. The spine's version is better, but the memlog drift should be noted.

**Fix:** keep it, but name the alternative (a blend of average pace and current pace) as an option to tune after the test run, and add a test that the ETA moves when the trailing pace changes.

### F-8 (Low) "Active runners" and the phone-sized viewer are implicit. Affects CAP-2 and the success signal.

CAP-2 shows "all *active* runners". The snapshot carries every configured runner with `notStarted | active | stopped`, and nothing says how the map treats the other two states. The success signal has the friend watching **on their phone** from start to finish. AD-6's reconnect-to-fresh-snapshot handles a backgrounded mobile tab well, but mobile layout is listed only as "web visual design" in Deferred.

**Fix:** add one line to the CAP-2 row of the map: markers for `active` and `stopped` runners, list-only for `notStarted`. Make the web UI mobile-first (a phone-width layout is a requirement, not only styling).

### F-9 (Low) The ingest idempotency key does not include the runner. Affects CAP-6.

AD-3 makes `(sessionId, seq)` unique, while the spine memlog decision said `(runner_id, session_id, seq)`. A phone holding a valid key could send a `sessionId` that collides with another runner's session. Insert-or-ignore would then silently drop the other runner's records, or attribute them wrongly. That conflicts with "recorded for the right runner".

**Fix:** make the unique key `(runnerId, sessionId, seq)`, with `runnerId` coming from the key (AD-5), or reject a `sessionId` already owned by a different runner with `409`.

### F-10 (Low) The shared link is effectively public. Affects the shared-link constraint (quiet privacy expectation).

The spec's "one shared link, no login" implies a link given to friends. AD-11's Tailscale Funnel hostname (`machine.tailnet.ts.net`) shows up in public certificate-transparency logs, so it is discoverable. With unauthenticated read endpoints, runners' live locations are visible to anyone who finds it. Link secrecy is deferred, which is acceptable for a personal project.

**Fix:** keep it deferred, but state the exposure in Deferred so the choice is deliberate, or adopt the cheap unguessable path-token now. It costs little and touches only the HTTP layer.

### F-11 (Info) "Runs are set up on the server" is reinterpreted.

The spec lists *runs* among the server-configured entities. The spine derives the run (runner × active event, AD-4) and configures only the event. This is consistent with the spec's intent, and nothing is managed from the app or web. Suggest one sentence in AD-4: "a run is configured implicitly by listing the runner in the event."

### F-12 (Info) The 5-10 s cadence is met as sampling plus batching.

The spec says the phone "sends a position every 5-10 s". AD-10 samples every 5 s and flushes every 10 s, so delivery latency is up to about 10 s plus network time. That is within the spec's intent. Note it in AD-10 so nobody "fixes" it to one POST per fix.

### F-13 (Info) The spec has a leftover per-runner GPX wording.

The SPEC's CAP-5 and success signal still say "for a runner with a GPX", left over from the superseded per-runner-course decision. CAP-4 and the memlog fix one course per event, and the spine follows that correctly. Suggest updating the SPEC wording to "when the event has a course". No spine change is needed.

## Out-of-scope observation (spine-internal)

- The deployment seed lists "phone on LAN" for dev, but AD-11 binds `127.0.0.1` only, so a physical phone on the LAN cannot reach a dev server. Allow `HOST` from env in dev (default `127.0.0.1`), or use `adb reverse`.

## Non-goal check

No spine element introduces iOS, history or replay UI, social features, viewer accounts or self sign-up. Keeping positions after the race (AD-1, SQLite backup) matches the spec's assumption and is not a replay feature.
