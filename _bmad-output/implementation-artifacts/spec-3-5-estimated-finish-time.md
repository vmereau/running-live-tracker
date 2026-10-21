---
title: 'Estimated finish time'
type: 'feature'
created: '2026-10-21'
status: 'done'
baseline_commit: '53d558513d56a7a789e0f0e52ea3fc3f5b8666d0'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `RunnerView.etaAt` is always `null`. Spectators can't tell when a runner will reach the finish, so they can't plan where to be.

**Approach:** Add one pure domain ETA function. `toRunnerView` fills `etaAt` from it, so the value is the same live and on replay, and it changes with every `runner` event as pace changes. The web formats it: a local clock time plus the projected finishing time, shown in the selected-runner panel and on the runner's overview row.

## Boundaries & Constraints

**Always:** `etaAt = lastFixAt + remainingM × avgPaceSPerKm / 1000`, defined only in `server/src/domain/eta.ts`, with `ETA_MIN_DISTANCE_M = 1000` as a named constant. It is non-null only when there is a course, status is `active`, `distanceM ≥ 1000` (the view's `distanceM`, which equals `progressM` with a course), and `lastFixAt`, `remainingM` and `avgPaceSPerKm` are all non-null. The pace used is the view's `avgPaceSPerKm`, so the metres skipped by a rejoin jump don't distort it. The web shows the clock time as `HH:mm` in the browser's local time, rounded to the nearest minute ("Finish ≈ 12:41"), and the projected time as `etaAt − runStartedAt` in `h:mm:ss` (same format as elapsed). A runner who reaches the finish while still active gets `etaAt = lastFixAt`.

**Decisions (planning, 2026-10-21):** The panel shows two rows after Complete: "Finish ≈" `12:41` and "Projected time" `3:28:15`. The overview row adds ` · finish ≈ 12:41` to the end of its progress line. For a `stopped` runner, the panel's Elapsed row is renamed "Final time" (the value is already the frozen elapsed), so no ETA row and no duplicate. Both rows and the row suffix are hidden when `etaAt` is `null`.

**Never:** Persist `etaAt`. Compute or adjust the ETA in the web, beyond `etaAt − runStartedAt` and clock formatting. Change the contract, fixtures or Kotlin classes (the field already exists). Blend in the current pace (that is a possible change after Epic 4, inside `domain` only). Let `web` import anything but `shared`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path | course, active, distance 4000 m, remaining 6000 m, avg 300 s/km | `etaAt = lastFixAt + 1 800 000` | N/A |
| No course | any | `etaAt` null; web hides ETA | N/A |
| Too early | course, active, distance 999 m | null | N/A |
| Stopped | course, distance 5000 m | null; panel shows "Final time" in place of "Elapsed" | N/A |
| notStarted | no fix | null; panel says not started | N/A |
| Pace null | course, active, distance ≥ 1000 m, avg null | null | N/A |
| Pace change | same remaining, avg 300 → 330 s/km | ETA moves later by remaining × 30 / 1000 s | N/A |
| At the finish | course, active, remaining 0 | `etaAt = lastFixAt` | N/A |
| Web with ETA | `etaAt` = local 12:41:40, runStartedAt 3:28:15 earlier | panel "Finish ≈ 12:42", "Projected time 3:28:15"; row suffix " · finish ≈ 12:42" | N/A |

</frozen-after-approval>

## Code Map

- `server/src/domain/stats.ts` + `stats.test.ts`: style to copy (named constants, null guards with `!(x >= y)`, thresholds test).
- `server/src/projection/apply-records.ts` `toRunnerView(state, course)`: already computes `remainingM`, `avgPaceSPerKm`, `distanceM`. Compute `etaAt` there from those fields and `state.status`/`state.lastFixAt`. Don't touch `applyRecords` (derived, not stored).
- `server/src/projection/snapshot.ts:37`: `initialRunnerView` default `etaAt: null`. Keep it.
- `server/src/projection/progress-golden.test.ts`: `simulate`/`fold` helpers at 5:00/km on `shared/fixtures/gpx`.
- `server/src/projection/create-projection.test.ts:303`: live=replay loop with `seen` counters.
- `web/src/format.ts`: `formatElapsed`, `progressText`, `runnerRowText` (`RunnerRowText`), `selectedPanelText`. `format.test.ts:133` has the stopped panel test to update.
- `web/src/runner-list.ts`: `createRow` builds the `.runner-progress` span (`remaining`, ` left · `, `percent`). `render` assigns `runnerRowText` output. The panel rows are generic `[label, value]` pairs, so they need no DOM change.

## Tasks & Acceptance

**Execution:**
- [x] `server/src/domain/eta.ts` + `eta.test.ts` -- `ETA_MIN_DISTANCE_M = 1000` and `etaAt({hasCourse, status, distanceM, lastFixAt, remainingM, avgPaceSPerKm}): number | null`. Test the constant, the happy path, each null condition (no course, notStarted, stopped, 999 m vs 1000 m, null lastFixAt/remainingM/pace), remaining 0, and a pace change that moves the ETA.
- [x] `server/src/projection/apply-records.ts` + `apply-records.test.ts` -- `toRunnerView` fills `etaAt` from the view fields it already computed. Test: with a course, null before 1000 m, then set; null after `end`; null without a course.
- [x] `server/src/projection/progress-golden.test.ts` -- on out-and-back at 5:00/km, ETA ≈ `runStartedAt + lengthM × 0.3 s` (within 1 %) from 1 km on; null on the no-course run. Views go through `RunnerView.parse`.
- [x] `server/src/projection/create-projection.test.ts` -- in the course run of the live=replay loop, count `seen.eta` and assert it is > 0.
- [x] `web/src/format.ts` + `format.test.ts` -- `formatClock(epochMs)` (local `HH:mm`, rounded to the nearest minute, so 23:59:40 reads "00:00"); `etaText(view): {clock: string, projected: string} | null` (null when `etaAt` or `runStartedAt` is null, or status isn't active). `RunnerRowText` gains `eta: string | null` ("finish ≈ 12:42"). `selectedPanelText` adds the two rows after Complete and renames Elapsed to "Final time" when stopped. Tests build expected times with local `new Date(y, m, d, h, mi, s)`.
- [x] `web/src/runner-list.ts` -- add an ETA span at the end of the progress line (with its ` · ` separator inside it), hidden when `rowText.eta` is null.

**Acceptance Criteria:**
- Given `pnpm check`, then typecheck, all tests (live=replay included) and depcruise pass.
- Given a course and `pnpm simulate --pace 5:00,6:00` with two keys, when the runners pass 1 km, then each row and the panel show the same "finish ≈" time for the same runner, the 6:00 runner's is later, and each stays close to start + course length × pace (the simulator's pace is constant, so the pace-change case is covered by the unit tests).

## Implementation Notes

- `etaAt` rounds `remainingM × avgPaceSPerKm` to the millisecond: the contract's `epochMs` accepts integers only, so the raw product failed `RunnerView.parse`.
- `eta.ts` imports the `RunnerStatus` type from `shared` (the first `domain` file to do so); depcruise allows it.
- Live check (out-and-back 2270 m, `--pace 5:00,6:00 --time-scale 5`): Alice's ETA = start + 681 s from 1.1 km on, row and panel both "finish ≈ 11:45", projected 0:11:21; Bob's later (11:47). After Stop the panel read "Final time 0:11:21" with no ETA rows, and `etaAt` was null.

## Spec Change Log

## Review Triage Log

| # | Source | Finding | Verdict | Evidence / route |
|---|--------|---------|---------|------------------|
| 1 | edge-case, blind | Fixes stop while active: `etaAt` stays anchored to the old `lastFixAt` and can read as a past clock time | low | Real, but it needs a gap longer than the time left (near the finish), and the row's "last update N min ago" already shows staleness. Hiding past ETAs would also hide a finished-but-not-stopped runner's `etaAt = lastFixAt`; it adds a branch. Rejected. |
| 2 | edge-case, blind | Off course: progress frozen, avg pace rises, ETA drifts later, then jumps back on rejoin | low | That is the formula applied to no measured progress, and the badge flags the state. Nulling the ETA off course adds a branch the epic doesn't ask for. Rejected. |
| 3 | edge-case, blind | `HH:mm` gives no hint when the finish is the next day | low | Race days start in the morning; a cross-midnight finish is out of scope. Rejected. |
| 4 | edge-case, blind | Row ETA hidden while `lengthM` null but `etaAt` set; row and panel disagree | false | `snapshot.ts:14-15` and `etaAt` both come from the same `course`: `lengthM` null ⇔ no course ⇔ `etaAt` null. |
| 5 | blind | The `remainingM ≥ 0` / pace > 0 guard in `etaAt` is untested and missing from the docstring | low | Verified. Patch: docstring + tests. |
| 6 | blind | Live=replay no-course branch doesn't assert `seen.eta === 0` | low | Verified. Patch: one assertion. |
| 7 | blind | No late Start / rejoin ETA test | low | Behaviour is the documented choice (Design Notes); no defect shown. Rejected. |
| 8 | blind | Clock rounded vs projected floored can differ by a minute | low | The page shows no start clock to add them up against; the rounding is the planned choice. Rejected. |
| 9 | blind | ETA span relies on `title`, no aria label | low | Same pattern as every other row span; cosmetic. Rejected. |
| 10 | blind | apply-records ETA test re-derives the formula; no projection-level finish-while-active case | low | The 1 % golden check is independent and `eta.test.ts` covers remaining 0; no defect shown. Rejected. |
| 11 | verification-gap | Row ETA span wiring in `runner-list.ts` untested | low | Pre-verified; no DOM test harness, same gap as the 3.2/3.4 deferred items. Defer. |

## Design Notes

The 1000 m gate uses the view's `distanceM`, as the epic says. After a late Start the jump makes `distanceM` ≥ 1000 at once, while pace has only been measured over ≥ 100 m. That ETA is shaky for the first few hundred metres, but it settles quickly. Gating on the measured distance (`progressM − skippedM`) would be the stricter option if Epic 4 shows a problem.

Rounding the clock to the nearest minute matches the "≈". The projected time is floored like elapsed, so a finished runner's final time and their last projection read the same way.

## Verification

**Commands:**
- `pnpm check` -- expected: typecheck, all tests and depcruise pass

**Manual checks:**
- Point a temporary event.json at `shared/fixtures/gpx/out-and-back.gpx`, run `pnpm dev` and `pnpm simulate`. After 1 km the row and panel show "finish ≈ HH:mm" and a projected time. After Stop, the panel shows "Final time" and no ETA.
