---
title: 'Two-runner test run and tuning'
type: 'feature'
created: '2026-10-21'
status: 'done'
baseline_commit: '16ef7d5644a8dceaa10159f3a9a4411f94e3c77d'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 4.4 is proven by a real two-runner test run with a friend watching, and the page's distance, pace and finish time are then compared with each runner's watch. There is no protocol for that run, no record of what the page showed over time (the ETA is live only and never stored), and no place to write the accepted tolerance or the tuning decision.

**Approach:** Add `pnpm run-log`. During the test run it polls `GET /api/v1/snapshot` and appends each runner's figures to a CSV. Once every runner is `stopped`, or on Ctrl-C, it prints a per-runner tolerance summary: final distance, elapsed, average pace, and the ETA error at each 5 km checkpoint against the actual finish. Extend `docs/ops/race-readiness.md` with the test-run protocol, a friend checklist (the SPEC success signal), a page-versus-watch tolerance table and a tuning section.

## Boundaries & Constraints

**Always:** `server/scripts` imports only `domain`/`shared`. Validate the snapshot with the `shared` `Snapshot` zod schema. The tool is tunnel-agnostic (`--base-url` is any http(s) URL; the doc recommends `http://127.0.0.1:8787` on the PC). A failed or invalid poll is logged to stderr and retried at the next interval; it never ends the run. The CSV is written under `<DATA_DIR>/run-logs/`, which is git-ignored. All times are epoch ms in the CSV and UTC ISO in the summary. Tuning, when a later measured tolerance calls for it, changes only the named constants in `server/src/domain`, with golden and live-equals-replay tests still passing.

**Never:** No server, wire-contract, web or Android change. No domain constant change in this story (no measured data yet). The tool never writes to the DB and never sends keys.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Poll | each `--interval` (default 15 s) | one CSV row per configured runner: `serverNow,runnerId,status,distanceM,progressM,remainingM,avgPaceSPerKm,currentPaceSPerKm,etaAt,lastFixAt,runStartedAt,runEndedAt` (empty cell for null); header once per file | N/A |
| Poll fails | network error, non-200, schema mismatch | stderr line with time and reason; next poll as scheduled | never exits |
| All stopped | every runner that started is `stopped` and was seen `active` in this run | summary printed, exit 0 | N/A |
| Ctrl-C | SIGINT | summary from the rows so far, exit 0 | N/A |
| Summary per runner | rows of that runner | finish = first `serverNow` with `progressM ≥ lengthM`, else `runEndedAt`; elapsed = finish − `runStartedAt`; last `distanceM` km; last `avgPaceSPerKm` as m:ss/km; for each 5 km checkpoint, the first row at or past it with an `etaAt`: ETA − finish, signed m:ss | runner never started → `not started` |
| No course | `event.hasCourse` false | ETA columns empty, summary says `no course: no ETA` | N/A |
| Bad args | unknown flag, bad URL, bad duration | one-line message + usage | exit 1 |

**Decisions (human, 2026-10-21):** The test run has not happened yet. This story ships `run-log` and the protocol with no domain constant changes, and the tolerance and tuning results are filled in by the human after the run, as in 4.3. Build the recorder plus the protocol, not the protocol only. Keep the full spec (about 2,300 tokens, over the 1,600 guideline).

</frozen-after-approval>


## Code Map

- `server/scripts/race-check.ts:15-55,93,109,136`: arg parsing (`parseArgs`, `UsageError`, `--` stripping, `--base-url` validation and trailing-slash trim), `readConfigFile`, `formatDuration`, `fetch` with `AbortSignal.timeout`, and the injectable `deps` (`fetch`, `now`) for tests. Reuse these by import.
- `server/scripts/simulate-runner.ts:54,69`: `parseDurationMs` for `--interval`, `formatPace` for m:ss/km.
- `server/scripts/session-report.ts`: `DATA_DIR` default resolution, the `import.meta.main` CLI and the `main(argv, env)` → exit code shape to copy.
- `shared/src/contract.ts:100-125`: `RunnerView`, `Snapshot` (has `event.lengthM`, `event.hasCourse`, `runners`). The snapshot also carries the full tracks: poll the PC locally, not through Funnel.
- `server/src/projection/apply-records.ts:158-183`: how the page values are built: `distanceM` = `progressM` with a course; average pace uses progress minus skipped metres; `etaAt` is null unless `active` and past `ETA_MIN_DISTANCE_M`. Do not change.
- Tunable constants (doc's tuning section lists them with their files): `domain/progress.ts:9-19` (`BACK_WINDOW_M`, `MIN_FORWARD_WINDOW_M`, `WINDOW_GROWTH_MPS`, `ON_COURSE_M`, `REJOIN_FIXES`, `EXPECTED_SPEED_MPS`), `domain/stats.ts:8-12` (`MIN_AVG_PACE_DISTANCE_M`, `CURRENT_PACE_MIN_WINDOW_S/M`), `domain/eta.ts:7` (`ETA_MIN_DISTANCE_M`, ETA basis = average pace). Also `MAX_ACCURACY_M` in `projection/apply-records.ts:15` (not domain: the doc says it is out of scope for tuning).
- `docs/ops/race-readiness.md:192-332`: the `session-report`, *Public dry run* and *Phone soak test* sections to follow in style; the *Race-week checklist* at line ~333 gets a test-run item.
- `README.md` Commands table; `package.json` scripts.

## Tasks & Acceptance

**Execution:**
- [x] `server/scripts/run-log.ts` -- export `parseRunLogArgs(argv, env, repoRoot)` (`--base-url` required, `--interval` default `15s`, `--out` default `<DATA_DIR>/run-logs/<eventId>-<UTC stamp>.csv`), pure `snapshotRows(snapshot)` → CSV lines, pure `summarizeRun(rows, lengthM)` and `formatRunSummary`, and a `runLog(deps)` loop with injectable `fetch`/`now`/`sleep`/`appendLine`/`signal` -- records what the page showed.
- [x] `server/scripts/run-log.test.ts` -- every matrix row: rows from a fixture snapshot, poll failure keeps the loop going, stop on all stopped, abort via signal, the summary on a synthetic run (checkpoint ETA errors, finish by `progressM ≥ lengthM` and by `runEndedAt`, not started, no course), arg errors.
- [x] `package.json` -- `"run-log": "node server/scripts/run-log.ts"`; `README.md` Commands row.
- [x] `docs/ops/race-readiness.md` -- add **Two-runner test run**: test-run config (window covering it, the race course, both runners), `race-check` PASS, both phones set up as in the soak, `pnpm run-log --base-url http://127.0.0.1:8787` started before the start, both runners Start at the same time and record on their watch/app, the friend on mobile data with a **success-signal checklist** (switch runners start to finish; live position, pace, stats, km done / total km and ETA for each runner), Stop, *Pending* 0, `session-report` COMPLETE, `run-log` summary. Then a **tolerance table** per runner (page vs watch: distance, elapsed, average pace, finish time, and the ETA error at each checkpoint) with an *accepted tolerance* row, and a **Tuning** section listing each constant, its file, what it affects and when to change it, with the rule: domain constants only, update the golden tests, `pnpm check` green, replay a backup to confirm. Add the test-run item to the race-week checklist.

**Acceptance Criteria:**
- Given `pnpm check`, then typecheck, all tests and depcruise pass.
- Given a local server with a course and a two-runner `pnpm simulate` running, when `pnpm run-log --base-url http://127.0.0.1:8787 --interval 2s` runs until both runners stop, then the CSV holds rows for both runners and the summary prints finish, distance, pace and checkpoint ETA errors for each.

## Implementation Notes

- Deviation: the matrix's "finish = first `serverNow` with `progressM ≥ lengthM`" is implemented as the `lastFixAt` of that row. `runStartedAt`, `runEndedAt` and `etaAt` are all on the fix (recorded-time) clock, so elapsed and the ETA error stay on one clock. `serverNow` would add the upload delay and the poll offset (up to `--interval`), and it is on a different clock under `simulate --time-scale`. Checkpoint rows are timed by their `lastFixAt` for the same reason.
- "Every runner that started in this run" = runners seen `active` by this `run-log`. A runner already `stopped` before the first poll (an earlier session in the window) does not block the auto-stop, and one that never starts is ignored. If a runner's phone never starts, `run-log` ends when the other runner stops.
- Implemented inline (no subagent). `--base-url` validation was moved out of `parseRaceCheckArgs` into an exported `parseBaseUrl` in `race-check.ts`, with unchanged behavior (race-check tests pass). `run-log` reuses `formatSpan` (session-report), `formatPace`/`parseDurationMs` (simulate-runner) and the shared `Snapshot` schema. If nothing was ever received it exits 1 with `no snapshot received`. That case is outside the matrix.
- Local check (implementer): a temp server on port 8799 with `out-and-back.gpx` (2.27 km) and a 30× two-runner `simulate` (5:00 and 5:30/km, 30 s stagger) with `run-log --interval 2s` → 28 rows. It stopped by itself once both runners were stopped. Summary: finish by course length, 5:00 and 5:30 average pace, and each ETA equal to its runner's finish (as expected at a constant simulated pace). There were no 5 km checkpoints on that course, so the summary line now says so.

## Spec Change Log

## Review Triage Log

| # | Source | Finding | Verdict | Evidence / route |
|---|--------|---------|---------|------------------|
| 1 | verification-gap | `main` wiring (mkdir, abortable sleep, exit code) has no test | low | No test removes `mkdirSync`, so a regression could ship. Patch: a spawned CLI test against a stub server with a temp `DATA_DIR`. |
| 2 | verification-gap | Elapsed for a Stop finish is never asserted | low | The fixture separates the last fix (58 min) from the Stop (59 min), but no test checks it. Patch: one assertion. |
| 3 | blind, edge-case | Ends early if one runner stops before the other ever starts | low | Both runners start together in the protocol, and the fix adds an option or a wait rule. Rejected. |
| 4 | blind | ETA error measured against a Stop that may not be the finish | medium | Course matching rarely reaches the exact end, so the Stop fallback is common. Patch: the summary says how many km were left, and the doc says to use the watch finish instead. |
| 5 | blind | The Stop delay biases every ETA error negative | medium | Same root cause as #4 (a Stop finish is not flagged). Patch: the summary says so, and the doc gives the correction. |
| 6 | blind | Finish and checkpoints quantized to the poll interval | low | Up to 15 s late, not documented. Patch: one doc line. Deriving from the tracks would add complexity. |
| 7 | blind | CSV lacks `offCourse`, position, `lastReceivedAt` | low | The columns are fixed in the frozen matrix, and the raw fixes stay in the DB for offline analysis. Rejected (would need an intent change). |
| 8 | blind, edge-case ×2 | An existing `--out` file gets a second header | low | The matrix says "header once per file", and the code checked once per process. Patch: a `hasContent` dep skips the header. |
| 9 | blind | Tuning step 4 writes its CSV into the real `data\run-logs` | low | `DATA_DIR` came from the operator's environment. Patch: the doc says to pass `--out`. |
| 10 | blind | Tuning step 4 Ctrl-C not explained | low | Patch: the doc explains it (all runners already stopped). |
| 11 | blind | Poll period drifts by the request time | low | Milliseconds on localhost, and the fix adds scheduling. Rejected. |
| 12 | blind, edge-case | A session restart mixes two sessions in one summary | false | `runStartedAt` is set only when `notStarted` (`apply-records.ts:123`), so all of a runner's rows share one start, as on the page. |
| 13 | blind | Untested: `statusLine`, quote with `"`, `parseBaseUrl` direct, `signedSpan(0)`, no-snapshot exit 1 | low | Quote test added (direct). `parseBaseUrl` is covered via both parsers; the rest are cosmetic or need SIGINT on Windows. Rest rejected. |
| 14 | blind | UTC finish vs local watch time | low | Easy to misread by whole hours. Patch: doc line. |
| 15 | blind | Exit 0 when nothing was measured | low | The matrix says Ctrl-C → summary, exit 0. Rejected. |
| 16 | edge-case ×2 | A runner stopped before this run gets a full summary block as if from this run | low | `started` was `status !== 'notStarted'`. Patch: started = seen `active` in the rows, consistent with the loop's stop rule; doc line. |
| 17 | edge-case | A write failure (disk, file locked) crashes the recorder | medium | Opening the CSV in Excel on Windows locks it mid-run, and the ETA history would be lost. Patch: catch, log, keep polling; rows stay in memory for the summary. |
| 18 | edge-case | `--interval` over 2^31 ms spins | low | Nobody passes `1000h`. Rejected. |
| 19 | edge-case | eventId change mid-recording mixes events | low | The protocol never switches configs during the run. Rejected. |
| 20 | edge-case | `lengthM` 0 with a course | false | The course is loaded from a GPX with at least 2 distinct points, so its length is positive (`load-course.ts`). |
| 21 | edge-case | An outage spanning checkpoints attributes a late row to an earlier km | low | The polls are on localhost. The row's time is printed, and the fix adds a field. Rejected. |
| 22 | edge-case | The `formatSpan` import pulls in better-sqlite3 | low | The tool runs on the PC where the server and its native module run. Rejected. |
| 23 | edge-case | "signed m:ss" vs printed `+h:mm:ss` | low | A superset, and the doc matches the output. Rejected. |

## Design Notes

The ETA is never persisted: it is derived live from the fold, so only sampling the snapshot during the run can measure how good it was. Scripts may not import `projection`, so replaying the log offline would mean copying `applyRecords`, which is drift-prone. Polling the real endpoint measures exactly what the friend saw. `run-log` runs on the PC (localhost): each snapshot carries every track (~4,300 points per runner by the end), which is cheap locally but wasteful through the tunnel.

Under `pnpm simulate --time-scale N`, fixes carry simulated time, so `serverNow` and `etaAt` are on different clocks there. The local AC check is about rows and summary shape, not ETA accuracy.

## Verification

**Commands:**
- `pnpm check` -- expected: everything passes.

**Manual checks:**
- Local: the AC above, run once by the implementer (`--time-scale 1` with a short GPX if the ETA figures need to make sense).
- Human (after merge, recorded in the ops note): the two-runner test run, the tolerance table, and any tuning it calls for.
