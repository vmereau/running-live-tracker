---
title: 'Distance, pace and elapsed time'
type: 'feature'
created: '2026-10-20'
status: 'done'
baseline_commit: '82dc043f064a0d7afc5954fa985cf94841c0f40a'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Spectators see where each runner is but not how the race is going. `RunnerView.distanceM` is always 0, and both paces are always `null`.

**Approach:** Add pure stats functions in `server/src/domain` and fold them into the projection, so `distanceM`, `avgPaceSPerKm` and `currentPaceSPerKm` are filled the same way live and on replay. The web shows elapsed time (computed locally), distance and both paces for each runner.

## Boundaries & Constraints

**Always:** Each stat lives in exactly one pure domain function, with thresholds as named constants (`MIN_AVG_PACE_DISTANCE_M = 100`, `CURRENT_PACE_MIN_WINDOW_S = 60`, `CURRENT_PACE_MIN_WINDOW_M = 200`). Only accepted fixes feed stats. `distanceM` (no course) is the sum of haversine segments between consecutive accepted fixes, including across sessions and gaps. Server `elapsedS = (lastFixAt − runStartedAt) / 1000`. `avgPaceSPerKm = elapsedS / (distanceM / 1000)`, which is `null` while `distanceM < 100`. `currentPaceSPerKm` uses the shortest trailing window of accepted fixes that spans at least 60 s and at least 200 m of the same cumulative distance. It is `null` until such a window exists and `null` while `stopped`. Web elapsed = `(runEndedAt ?? store.now()) − runStartedAt`, ticking every second.

**Never:** Persist derived values. Recompute distance or pace in the web (AD-2). Change the contract schema, fixtures or Kotlin classes, or touch course or ETA fields (stories 3.3 to 3.5). Build the selected-runner stats panel (story 3.2).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior |
|----------|--------------|---------------------------|
| No fixes | notStarted | distanceM 0, both paces null; web shows "—" for elapsed and paces, "0.0 km" |
| Short start | < 100 m covered | avgPace null; currentPace null |
| Window not reached | 300 m in 50 s, or 150 m in 90 s | currentPace null |
| Steady run | 5:00 /km for 3 km | avg ≈ current ≈ 300 s/km |
| Stopped | `end` folded | currentPace null; distanceM and avgPace keep final values; web elapsed frozen at runEndedAt − runStartedAt |
| Rejected fix | accuracy > 30 or non-monotonic | no change to distance or pace |
| 2 km gap | fixes resume 2 km away | distance adds the 2 km straight-line segment |
| Late Start | first fix partway along the course | distance and elapsed count from the first accepted fix only |

</frozen-after-approval>

## Code Map

- `server/src/domain/geo.ts` -- reuse `haversineM`, `cumulativeDistancesM`, `pointAtDistance`. Do not change.
- `server/src/domain/gpx.ts` -- `parseGpx` for golden tests (fixtures have no timestamps).
- `server/src/projection/apply-records.ts` -- `RunnerState`, `applyRecords` (the one fold), `toRunnerView`. Add stats state here.
- `server/src/projection/create-projection.test.ts:284` -- the live-equals-replay seeded test must keep passing.
- `server/src/projection/snapshot.ts` -- `initialRunnerView` defaults (distanceM 0, paces null) stay as they are.
- `web/src/format.ts` + `format.test.ts` -- pure formatters. Add the new ones here.
- `web/src/runner-list.ts` -- rows keyed per runner; `renderAges` runs every 1 s via `setInterval`; `store.now()` is server-aligned.
- `.dependency-cruiser.cjs` -- projection may import domain; web only shared. Scripts may not be imported from `server/src`.

## Tasks & Acceptance

**Execution:**
- [x] `server/src/domain/stats.ts` -- add the constants, `segmentDistanceM(a, b)` (wraps `haversineM`), `avgPaceSPerKm(elapsedS, distanceM)`, and `currentPaceSPerKm(samples)`, where samples are `{recordedAt, distanceM}` per accepted fix in order. Return `null` for non-positive elapsed time or distance, so the contract's `positive()` holds. -- one definition per stat.
- [x] `server/src/domain/stats.test.ts` -- unit tests for each function: thresholds exactly at 100 m / 60 s / 200 m, null cases, and the shortest-window choice.
- [x] `server/src/projection/apply-records.ts` -- add `distanceM` and `paceSamples` (readonly, copied on append like `track`) to `RunnerState` and accumulate them on each accepted fix. `toRunnerView` fills `distanceM`, `avgPaceSPerKm` and `currentPaceSPerKm` (null when `stopped`). -- live = replay by construction.
- [x] `server/src/projection/apply-records.test.ts` -- fold cases: rejected fix leaves stats unchanged; stopped nulls the current pace only; S1 end → S2 fix keeps summing distance.
- [x] `server/src/projection/stats-golden.test.ts` -- build records from `shared/fixtures/gpx` with `parseGpx` + `pointAtDistance` at a fixed pace and a fix every 5 s, fold them, and assert: no-course run on `out-and-back.gpx` (distance ≈ GPX length within 1 %, avg and current ≈ planned pace); late Start (first fix at 40 % of `straight.gpx`); and a 2 km gap (no fixes over 2 km of `lap.gpx` looped, distance includes the straight-line jump, paces stay finite and positive). -- golden coverage from the AC.
- [x] `web/src/format.ts` + `format.test.ts` -- add `elapsedMs(view, now)` (null before runStartedAt, never negative), `formatElapsed` (`h:mm:ss`, "—" for null), `formatDistanceKm` (1 decimal + " km") and `formatPace` (`m:ss /km`, rounded to the nearest second with carry, so 299.6 → "5:00 /km"; "—" for null). -- formatting only, no recomputation.
- [x] `web/src/runner-list.ts` -- add a stats line to each row: `elapsed · distance · current pace · avg pace`, labelled like "now 4:58 /km · avg 5:02 /km". Refresh elapsed in the 1 s tick (rename `renderAges` to `renderTicking`) and the rest on render. -- the web shows the stats for every runner.
- [x] `web/src/styles.css` -- style the stats line so it stays readable on a phone.

**Acceptance Criteria:**
- Given seeded random batch orders, when the live projection is compared with a fresh replay, then the snapshots, now including non-trivial `distanceM` and paces, are deep-equal and pass `Snapshot.parse`.
- Given the map page with an active runner, when a second passes, then the elapsed time advances by one second. Given a stopped runner, it stays frozen.
- Given any snapshot, when it is rendered, then no web code computes distance or pace from track points.

## Design Notes

Choosing the current-pace window: walk back from the last sample to the latest index `i` where `last.recordedAt − s[i].recordedAt ≥ 60 000` and `last.distanceM − s[i].distanceM ≥ 200`. Then pace = `Δt_s / (Δd_m / 1000)`. Both differences only grow as `i` decreases, so the walk stops at the first match. The fold may drop samples older than the current window start, because later windows never start earlier.

## Verification

**Commands:**
- `pnpm check` -- expected: typecheck, all tests (incl. live-equals-replay) and depcruise pass

**Manual checks:**
- Run the server with `simulate-runner` at a known pace and open the map. Distance grows, paces settle near the simulated pace, and elapsed ticks.

## Implementation Notes

- `stats.ts` also exports `currentPaceWindowStart(samples)` (the window-start walk), used by `currentPaceSPerKm` and by the fold to prune `paceSamples` at the end of each `applyRecords` call; pruning depends only on the sample sequence, so chunked folds equal whole folds.
- The live-equals-replay seeded test now steps fixes by 5 s (was 1 s) so the 60 s window fills, and asserts that some snapshots carry non-null distance, avg and current pace.
- Panel widened from 240 px to 280 px (still capped at `100vw − 80px`); the stats line wraps between items, never inside a value.

## Spec Change Log

## Review Triage Log

| # | Source | Finding | Verdict | Evidence / route |
|---|--------|---------|---------|------------------|
| 1 | verification-gap | `runner-list.ts` view→stats-line wiring untested (pace slots could be swapped, elapsed tick dropped) | medium | Pre-verified: no web test touches `runner-list.ts`. Patch: pure `runnerStatsText` in `format.ts` + test. |
| 2 | blind, edge | Current pace right after an S1 end → S2 resume reaches back over the pause | low | Real: `paceSamples` spans sessions, so for ≤ ~60 s / 200 m after a resume the pace includes the pause. A resume mid-race is rare, and the fix adds a branch. Rejected. |
| 3 | blind, edge | Current-pace window has no max age; `paceSamples` grows during a standstill | low | Growth is bounded by standstill/run length (≤ one sample per fix, like `track`). A standstill-inclusive pace is the specified window. Rejected. |
| 4 | blind, edge | GPS jitter on a stationary or noisy phone inflates `distanceM` | maybe-false | Magnitude unknown: fused fixes while running may be smooth. Settled by the Epic 4 watch-tolerance measurement. Deferred (medium, unverified). |
| 5 | blind, edge | Avg pace uses `lastFixAt − runStartedAt`; web elapsed uses `(runEndedAt ?? now)` | low | As decided in the epic context (server `elapsedS`). The gap is seconds of upload lag and is not noticeable. Rejected. |
| 6 | blind | Web elapsed subtracts phone `recordedAt` from server-aligned now | low | The frozen intent prescribes this (server clock offset). Phone clocks are network-synced. Rejected. |
| 7 | blind | Seeded test's −500 ms step back rarely hits the non-monotonic rejection after the 5 s step | false | One −500 ms step already gives `recordedAt` < the previous fix's time = `lastFixAt`, so it is rejected on every occurrence. |
| 8 | blind | Avg pace includes the break between sessions | false | The frozen matrix and Always rules say distance counts "across sessions and gaps", and elapsed runs from `runStartedAt`. |
| 9 | blind | Formatter edge cases (NaN, Infinity, negative, ≥ 60 min/km) untested | low | The contract guarantees non-negative or positive values. `formatPace(3600)` → "60:00 /km" is correct. Rejected. |
| 10 | blind | Stats line: elapsed and distance labelled by `title` only; tick untested | low | Values are self-describing ("0:12:34", "2.3 km"). The tick test is covered by #1. Rejected. |
| 11 | blind | No test for a notStarted `toRunnerView`; `create-projection` may not clone the new fields | false | `apply-records.test.ts` "initial state projects to the notStarted contract defaults" covers it. `create-projection` never clones state (immutable fold). |
| 12 | edge | Current pace stays at its last value when fixes stop without `end` | low | The pure projection has no clock. The row's "last update N ago" shows staleness. Rejected. |
| 13 | edge | Very large paces shown verbatim (e.g. "20:00 /km") | low | That is the true pace over the window. Rejected. |
