---
title: 'Course progress'
type: 'feature'
created: '2026-10-21'
status: 'done'
baseline_commit: '2c377a9fc06faac96858e0ff9fc11eb716595385'
route: 'dispatch'
review_loop_iteration: 1
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The server loads the course (3.3), but `progressM`, `remainingM`, `progressFraction` and `offCourse` always keep their defaults. Spectators can't see how far into the race a runner is.

**Approach:** Add a pure domain matcher that moves a runner's progress along the course, one accepted fix at a time, inside the forward window. The projection fold threads it through, so it runs the same way live and on replay. With a course, `distanceM` and the pace samples use `progressM`. The web formats the figures in the overview row and the selected-runner panel.

## Boundaries & Constraints

**Always:** All thresholds are named constants in `server/src/domain/progress.ts`: back window 50 m, minimum forward window 1000 m, 8 m/s window growth, on-course 100 m, 6 rejoin fixes, and an expected speed of 3 m/s. Only accepted fixes feed the matcher. The first accepted fix starts progress at 0, with `lastMatchAt` set to its `recordedAt`. The window is `[max(0, p − 50), min(lengthM, p + max(1000, 8 × (recordedAt − lastMatchAt)/1000))]`. A match sets `progressM = max(progressM, matchM)`, sets `lastMatchAt`, clears `offCourse` and resets the rejoin count. A fix with no in-window match keeps `progressM`, sets `offCourse: true`, and increments the rejoin count when it is within 100 m of `[p, lengthM]` (otherwise the count resets to 0). On the 6th such fix, progress jumps to that fix's match in `[p, lengthM]`. With a course, `distanceM = progressM`. **Decision (2026-10-21):** distance that progress skips in a rejoin jump (late Start included) counts in km done/remaining/% but not in pace: `CourseProgress.skippedM` sums `jumpTarget − p` per jump, `avgPaceSPerKm = elapsedS / ((progressM − skippedM)/1000)`, and pace samples carry `progressM − skippedM`, so neither pace spikes after a jump. `remainingM = lengthM − progressM` and `progressFraction = progressM / lengthM`. Progress carries across sessions. A stopped runner keeps their last progress. The web takes `lengthM` from `snapshot.event` and computes nothing but formatting.

**Never:** Compute the ETA (3.5). Change the contract, fixtures or Kotlin classes (the fields already exist). Persist progress. Recompute progress in the web. Let `web` import anything but `shared`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| No course | any fixes | `progressM`, `remainingM`, `progressFraction` null; `offCourse` false; `distanceM` raw haversine (unchanged) | N/A |
| Course, notStarted | no accepted fix | progress fields null, `offCourse` false; web hides progress | N/A |
| Out-and-back, outbound | fix also within 100 m of the return leg | stays on the outbound pass (closest to expected position) | N/A |
| Lap course, start | first fixes near start = finish | progress ≈ distance run, never ≈ `lengthM` | N/A |
| Late Start at 40 % | first fixes > 1000 m ahead | 5 fixes `offCourse: true`, progress 0; the 6th jumps to ≈ its course position; paces stay ≈ the true pace (skipped metres excluded) | N/A |
| 2 km gap | next fix 2050 m further after 615 s | window has grown, so it matches the pass nearest the expected position | N/A |
| Detour | 100 m+ from course | `offCourse: true`, progress unchanged; cleared on the next in-window match | N/A |
| Web, course | `progressM` non-null | row: `"X.X / Y.Y km"` in place of distance, then `"Z.Z km left · N %"`; panel rows Distance `"X.X / Y.Y km"`, Remaining, Complete; "off course" badge while `offCourse` | N/A |
| Web, no course | `progressM` null | no progress text, no badge, nothing shown as 0 | N/A |

</frozen-after-approval>

## Code Map

- `server/src/domain/course.ts` (`Course {points, cumulativeM, lengthM}`), `geo.ts` (`haversineM`, `LatLon`): reuse them.
- `server/src/projection/apply-records.ts`: `RunnerState`, `initialRunnerState`, `applyRecords(state, records)`, `toRunnerView(state)`. The pace samples get `next.distanceM` today.
- `server/src/projection/create-projection.ts`: already receives `course`. Pass it into `applyRecords` and `toRunnerView` on the boot, refold and fast paths.
- `server/src/projection/create-projection.test.ts:303`: the live=replay loop with `seen` counters. `fix()` uses `lat 48 + seq/1000`, `lon 2 + recordedAt/1e7`.
- `server/src/projection/stats-golden.test.ts`: the `simulate`/`course`/`fold` helpers to copy (5 s fixes at 5:00/km).
- `web/src/format.ts` (`runnerStatsText`, `selectedPanelText`, `formatDistanceKm`) and `format.test.ts`: the pure text layer.
- `web/src/runner-list.ts`: the `Row` stats spans and `renderStats` (rows rebuilt on each tick). `styles.css` holds the classes.

## Tasks & Acceptance

**Execution:**
- [x] `server/src/domain/progress.ts` + `progress.test.ts` -- `type CourseProgress = {progressM, skippedM, lastMatchAt, offCourse, rejoinCount, rejoinM}`, `startProgress(recordedAt)`, `advanceProgress(course, state, fix: LatLon & {recordedAt})`, and `matchOnCourse(course, fix, fromM, toM, expectedM): number | null`. Unit-test each matrix row on small synthetic courses, plus window clipping, progress never decreasing, `skippedM` on a jump, scattered rejoin matches not jumping, and a new session after a long pause on an out-and-back staying on the outbound leg. The segment walk starts by binary search on `cumulativeM` and stops past `toM`.
- [x] `server/src/projection/apply-records.ts` + test -- `RunnerState.progress: CourseProgress | null`. `applyRecords(state, records, course: Course | null = null)` and `toRunnerView(state, course = null)` fill the four fields. The optional param keeps existing call sites working. The first accepted fix of a new session (its sessionId differs from the previous accepted fix's) sets `lastMatchAt` to its `recordedAt` before matching. Test pace after a late-Start jump.
- [x] `server/src/projection/create-projection.ts` -- pass `course` through.
- [x] `server/src/projection/create-projection.test.ts` -- run the live=replay loop with and without a course built around the `fix()` coordinate pattern. With a course, assert `seen.progress > 0` and `seen.offCourse > 0`.
- [x] `server/src/projection/progress-golden.test.ts` -- on the `shared/fixtures/gpx` courses: out-and-back (progress ≈ 40 % at 40 %, ≈ `lengthM` at the end, within 1 %), lap (≈ 100 m at 100 m, ≈ `lengthM` at the end), late Start on straight (70 %, since 40 % is inside the 1000 m window; paces ≈ planned pace after the jump), a 2 km gap on out-and-back `[100, 2150]` (final ≈ `lengthM`), and no course (nulls). Every view goes through `RunnerView.parse`.
- [x] `web/src/format.ts` + `format.test.ts` -- `progressText(view, lengthM)` returns `{done: "X.X / Y.Y km", remaining: "Z.Z km", percent: "N %"} | null` (null when `lengthM` or any progress field is null; done is floored to 0.1 km and percent floored, so they never contradict). `runnerRowText(view, lengthM, now)` returns the row's `{distance, distanceTitle, progress: ProgressText | null, offCourse}` (badge only with progress). `selectedPanelText` takes `lengthM` and returns `offCourse` gated the same way. Test both with and without a course, on and off course, and with progress null.
- [x] `web/src/runner-list.ts`, `styles.css` -- add a row progress line and an "off course" badge, plus the panel rows and badge; the module only assigns `runnerRowText`/`selectedPanelText` output.

**Acceptance Criteria:**
- Given `pnpm check`, then typecheck, all tests (the live=replay test included) and depcruise pass.
- Given a course and `pnpm simulate`, when the page is open, then each running runner shows the progress figures rising, and the selected panel matches its row.

## Implementation Notes

- Iteration 0 (reverted for loopback): `straight.gpx` is 1606 m, so its 40 % point lies inside the 1000 m minimum window; the exact 40 % jump case belongs on a synthetic 5 km course, and the golden late Start uses 70 % of straight.
- Iteration 0 live check (out-and-back + 2 simulated runners) showed progress reaching 2270 m / 100 % with matching row and panel figures.
- Iteration 1: `CourseProgress` also holds `rejoinAt` (the time of the previous counted rejoin fix), which the rejoin-consistency `dt` needs. `RunnerState.lastFixSessionId` detects a new session.
- Iteration 1: after a late Start, average pace stays somewhat high (≈ 18 % on straight at 70 %, < 5 % over 3 km on a 5 km course), because the time of the 5 off-course fixes counts while their distance falls into `skippedM`. Current pace stays within 2 %. The golden test asserts the exact expected value.
- Iteration 1: done is floored and remaining rounded, so they can differ from the total by 0.1 km.

## Spec Change Log

- **Loop 1 (2026-10-21).** Triggers: triage #1 (pace absurd after a jump; an intent gap the human resolved), #2 (scattered rejoin matches jump), #3 (a long pause overshoots onto the return leg); patch-level #4, #5, #6 carried in. Amended: the frozen pace decision; the `CourseProgress` fields; Design Notes on the session restart and rejoin consistency; tasks for the binary-search segment walk, the floored done figure, the `runnerRowText` helper and new tests. Known-bad states avoided: ≈ 25 s/km average pace after a late Start; a permanent forward jump from scattered fixes; a permanent overshoot after Stop/resume on an out-and-back. **KEEP:** the pass-based `matchOnCourse` (clip, local equirectangular projection, closest point per pass, nearest-expected wins); the optional `course` params on `applyRecords`/`toRunnerView`; the live=replay loop run with and without a course plus the `seen.progress`/`seen.offCourse` checks; the progress golden tests on out-and-back, lap, gap `[100, 2150]` and no course; the `.off-course` badge styling and `[hidden]` rules; the "X.X / Y.Y km" row distance with the "Z.Z km left · N %" line.

## Review Triage Log

| # | Source | Finding | Verdict | Evidence / route |
|---|--------|---------|---------|------------------|
| 1 | edge-case, blind, verification-gap | After a late Start or rejoin jump, avg pace = elapsed / progressM and the samples jump: ≈ 25 s/km | medium | Verified in `toRunnerView`/`applyRecords`; the frozen text required it. intent_gap → the human chose "exclude skipped distance". |
| 2 | edge-case, blind | Any 6 off-window fixes near any part of the course ahead trigger a permanent jump | medium | Verified: no consistency check between the 6 matches. bad_spec → rejoin consistency. |
| 3 | blind | A long pause inflates `expectedM`; on an out-and-back the return leg wins and progress overshoots for good | medium | Verified: `lastMatchAt` carried across sessions. bad_spec → session restart. |
| 4 | blind | `matchOnCourse` walks every segment per fix (twice on a miss) | low | Verified. Patch-level, carried into the re-derivation. |
| 5 | edge-case | "10.0 / 10.0 km · 0.0 km left" next to "99 %" | low | Verified: done rounded, percent floored. Carried (floor done). |
| 6 | verification-gap | Row hide/show/badge logic in `runner-list.ts` untested | low | Pre-verified. Carried (`runnerRowText` helper + tests). |
| 7 | blind, verification-gap | Panel badge not gated like the row; a stopped runner keeps the badge | low | The server sets `offCourse` only with progress; keeping the last state when stopped is accurate. Rejected (gating folded into #6). |
| 8 | edge-case | Lap course: an off-window fix near start/finish jumps to ≈ lengthM | false | Within 100 m of the finish means within 100 m of the start, which is in-window `[0, 1000]`. |
| 9 | edge-case, blind | Fix 50–100 m behind progress flagged off course | low | Needs a sharp bend plus GPS lag; the fix adds a branch. Rejected. |
| 10 | edge-case | Antimeridian breaks the projection | low | No race in scope crosses ±180°. Rejected. |
| 11 | edge-case | Golden 40 % late Start doesn't exercise the jump | false | The matrix says "> 1000 m ahead"; covered synthetically and at 70 %. |
| 12 | blind | Off course not shown on the map; hard-coded badge colours | low | Cosmetic, beyond the story; no theme tokens exist. Rejected. |
| 13 | blind | Missing tests (zero-length clip, duplicate points, past-finish, hand-copied constants) | low | No defect shown; `buildCourse` guarantees ≥ 2 points and length > 0. Rejected. |
| 14 | edge-case, blind | A late Start inside the first 1000 m window matches in-window, so `skippedM` stays 0 and pace counts metres never run | medium | Verified: `startProgress` then `advanceProgress` matches 800 m in `[0, 1000]`, no skip recorded; the frozen decision includes late Start. Patch: the first fix's progress goes to `skippedM`. |
| 15 | edge-case | Rejoin count/anchor carry over a new session; one fix after resuming can complete a stale rejoin | low | Verified: only `lastMatchAt` was reset on session change. Patch: reset the rejoin fields too (direct). |
| 16 | blind | `toRunnerView` repeats the pace-distance rule instead of `paceDistanceM` | low | Verified duplicated rule (diverges only for course + null progress). Patch (direct). |
| 17 | edge-case | Finish match `s0 + t·(s1 − s0)` can land below `lengthM`, giving 99 % at the finish | low | Floating error at t = 1 is real. Patch: exact endpoints at t = 0/1. |
| 18 | edge-case | `Math.floor(fraction × 100)` reads 0.57 as 56 % | low | Verified float error. Patch: epsilon. |
| 19 | edge-case, blind | Done floored but total and remaining rounded: "2.2 / 2.3 km · 0.0 km left · 100 %" at the 2270 m finish | medium | Verified with the shared fixture; every finisher would see it. Patch: done shows the total at the finish, remaining is ceiled. |
| 20 | verification-gap | `runner-list.ts` DOM wiring (hidden flags, `lengthM` passed) untested | low | Pre-verified; the decisions live in tested `format.ts` helpers, and the repo has no DOM test harness. Defer. |
| 21 | edge-case, blind | Near an out-and-back turnaround both legs merge into one pass, so GPS noise can put progress past the turn | low | Overshoot is bounded by twice the distance to the turn (< 200 m) and heals once the runner gets there; splitting passes adds logic. Rejected. |
| 22 | edge-case | Late Start on an out-and-back return leg first locks onto the outbound mirror | low | It recovers once the mirror drops behind the window (about 150 m); rare. Rejected. |
| 23 | blind | With sparse fixes (60 s), the growing window can take a late Start > 1 km as a normal match before 6 rejoin fixes | low | The app sends fixes every few seconds; with #14 the first fix is skipped anyway. Rejected. |
| 24 | blind | An in-session stop with off-course fixes (aid tent > 100 m away) inflates `expectedM` and can overshoot onto an out-and-back return leg | low | Real but needs a long stop > 100 m off the course on an out-and-back; progress freezes ahead and heals when the runner catches up. Using raw distance instead breaks the 2 km gap case (the straight jump is ≈ 50 m). Rejected. |
| 25 | blind | An app crash mid-run (new session) resets the clock, so gaps > ≈ 5 min go through a rejoin | low | Rare; any extra skipped metres only make pace read slightly slow. Rejected. |
| 26 | blind | No noisy-GPS golden tests; the lap golden checks fewer fixes | low | No defect shown. Rejected. |
| 27 | blind | Test helpers and earth-radius constants are duplicated across test files | low | Test-only duplication, no defect. Rejected. |
| 28 | blind | The rejoin search rescans `[p, toM]` | low | It is equivalent to the frozen rule "within 100 m of `[p, lengthM]`" and only costs one segment walk per miss. Rejected. |

## Design Notes

Matching works in passes. In-window segments, clipped to the window, are projected onto a local equirectangular plane around the fix. Consecutive segments within 100 m form a *pass*, and the pass's closest point is its candidate. Among the candidates, the one nearest `expectedM = p + 3 m/s × dt` wins. This keeps an outbound runner off the return leg (dt is small), and still picks the right leg or lap after a gap (dt is large). Taking the closest point alone, or the earliest pass, fails both on the out-and-back after a gap and on GPS noise between parallel legs. A wrong pick cannot be undone (progress never decreases), so `dt` must reflect movement: a new session (Stop then resume) restarts `lastMatchAt`, which stops a long pause from throwing an out-and-back runner onto the return leg. A GPS gap within one session keeps the growing window, which is what the 2 km gap needs.

Rejoin consistency: `rejoinM` holds the previous counted fix's ahead match. A counted fix whose ahead match is behind `rejoinM − 50 m` or beyond `rejoinM + 100 m + 8 m/s × dt` (dt since that fix) restarts the count at 1 with itself as the anchor. So six scattered fixes near unrelated parts of the course never jump; six fixes moving along one stretch do.

## Verification

**Commands:**
- `pnpm check` -- expected: typecheck, all tests and depcruise pass

**Manual checks:**
- Point a temporary event.json at `shared/fixtures/gpx/out-and-back.gpx`, run `pnpm dev`, then `pnpm simulate` along it. Watch the km done, km left and % rise. Selecting a runner shows the same figures.
