---
title: 'Public dry run and phone soak test'
type: 'feature'
created: '2026-10-21'
status: 'done'
baseline_commit: '23a9fa83c2c611b08ee2b0bd8c96cb7654aedf4c'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Story 4.3 is proven by two manual tests (a public-URL `simulate` dry run with a phone watching, and a ≥ 5 h pocketed soak on each runner's phone), but there is no written protocol, no place to record results, and no way to show from the server side that a session's track is continuous, ended, and has no lost records.

**Approach:** Add `pnpm session-report`, a read-only report of the stored sessions of an event (fix count, duration, distance, `end` received, missing seqs, gaps between fixes over a threshold, upload delay). Extend `docs/ops/race-readiness.md` with the dry-run and soak protocols and result tables that the human fills in.

## Boundaries & Constraints

**Always:** `server/scripts` imports only `domain`/`shared` (read the config JSON and SQLite directly, like `race-check.ts`/`backup.ts`). The report never writes to the DB. Same `DATA_DIR`/`EVENT_CONFIG` env and defaults as `main.ts`. All times epoch ms, printed as UTC ISO. Extend existing `docs/ops/` notes.

**Never:** No server, wire-contract, Android or web change. No HTTP calls from the report. No automation of the phone tests. The dry run never runs against the race config's window (its sessions would land in the race).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Complete session | seqs 0..n contiguous, last is `end` | block: runner display name, sessionId, start, first→last fix, duration, fixes, km, `end` at, max gap, gaps > threshold listed (from, to, length), max upload delay; verdict `COMPLETE` | N/A |
| Lost records | a seq range missing | verdict `INCOMPLETE`, missing ranges listed (`12..15`) | exit 1 |
| No `end` | still running or Stop not uploaded | verdict `INCOMPLETE (no end)` | exit 1 |
| Signal gap | two consecutive fixes > `--gap` apart (default 30 s) | listed as a gap; does not change the verdict | N/A |
| Scope | default | sessions whose `sessionStartedAt ∈ [opensAt, closesAt]` of `--config`, ordered by start; `--session <id>` reports that one session regardless of window | unknown id → message, exit 1 |
| Nothing to report | no session in window | `no sessions in <eventId> window (<from> – <to>)` | exit 1 |
| DB missing / bad args / bad config | | one-line message + usage for arg errors, no stack trace | exit 1 |
| Runner not in config | session's runnerId absent | shows the raw runnerId | N/A |

</frozen-after-approval>

## Code Map

- `server/scripts/race-check.ts:24-80`: arg parsing style (`parseArgs`, `UsageError`, `--` stripping, `EVENT_CONFIG` default) and the zod `RaceConfig` subset to copy (only `eventId`, `opensAt`, `closesAt`, `runners[].runnerId/displayName`).
- `server/scripts/backup.ts`: `DATA_DIR` resolution, opening `tracker.db` with `fileMustExist`, `import.meta.main` CLI.
- `server/scripts/backup.test.ts:11`: `liveDataDir()` pattern (temp dir, WAL DB, connection kept open). Tests should create the real schema by calling nothing from `store/` (forbidden): copy the two `CREATE TABLE` statements from `server/src/store/open-store.ts:9-29` into the test helper.
- `server/src/store/open-store.ts:9-29`: `sessions` / `records` schema. Records hold `seq`, `kind` (`fix`|`end`), `recordedAt`, `receivedAt`, `lat`/`lon`/`accuracyM` (NULL for `end`).
- `server/src/domain/geo.ts`: `cumulativeDistancesM(points)` for the km figure.
- `server/scripts/simulate-runner.ts:14`: `FIX_INTERVAL_MS = 5_000`, reused in the doc's explanation of the 30 s default.
- `docs/ops/race-readiness.md`: race-week checklist (line ~200 "Public-URL `pnpm simulate` dry run") to link to the new sections; `docs/ops/events-and-backups.md#two-configs` for making configs.
- `README.md:60-72`: Commands table; `package.json` scripts.
- Android `MainScreen.kt:105`: the app's *Pending* counter is what proves "outbox empty after Stop" on the phone.

## Tasks & Acceptance

**Execution:**
- [x] `server/scripts/session-report.ts` -- export `parseSessionReportArgs(argv, env, repoRoot)` (`--config`, `--session`, `--gap` duration `30s`/`5m`, default 30 s), pure `summarizeSession(session, records, gapMs)` returning the matrix fields + `complete: boolean`, `formatSessionReport(...)`, and a CLI that opens `<DATA_DIR>/tracker.db` read-only and exits 0 only when every reported session is complete -- server-side proof for the soak and dry run.
- [x] `server/scripts/session-report.test.ts` -- cover every matrix row with in-memory record lists for `summarizeSession` and a temp WAL DB for the CLI (one test with a writer connection still open, as when the server runs).
- [x] `package.json` -- `"session-report": "node server/scripts/session-report.ts"`.
- [x] `docs/ops/race-readiness.md` -- add **Public dry run**: make `config/event.dry-run.json` from the race config (same runners, keys and `coursePath`, own `eventId`, window covering the dry run and disjoint from the race), run the task with it, `pnpm -s simulate --base-url https://<host>.ts.net --gpx <race gpx> --key …(every runner) --time-scale 10 --stagger 1m --gap 10m+5m`, phone on mobile data watching `/`: what to tick (markers, tracks, stats, progress, ETA, runner switch, gap fills in), `pnpm session-report --config config/event.dry-run.json` all `COMPLETE`, switch back to the race config, then a results table (date, Tailscale version, phone/browser/carrier, pass/fail, notes) with "repeat the day before" row. Add **Phone soak test** (per runner, test-run config): battery optimization off for the app plus vendor settings to check (Samsung "Never sleeping apps", Xiaomi autostart + "No restrictions", Huawei app launch manual, OnePlus/Oppo battery), charged phone, Start, pocket with screen locked ≥ 5 h, Stop, *Pending* reaches 0, `session-report` `COMPLETE` with gaps only where there was no signal, and a results table (runner, phone/Android, date, duration, battery start→end %, gaps and their cause, vendor settings needed, pass/fail). Link both from the checklist.
- [x] `README.md` -- Commands row for `pnpm session-report`.

**Acceptance Criteria:**
- Given `pnpm check`, then typecheck, all tests and depcruise pass.
- Given the server is running and a `pnpm simulate` run with `--gap` finished, when `pnpm session-report` runs on its config, then each simulated session is `COMPLETE` and the gap appears in its gap list.

## Implementation Notes

- Deviation: an offline period (`simulate --gap`, or a phone in a mobile-data dead zone) keeps recording fixes every 5 s and uploads the backlog later, so it leaves no gap in `recordedAt`. The AC "the gap appears in its gap list" therefore needs a second list: `upload gaps` (consecutive records by seq received more than `--gap` apart, by `receivedAt`). The matrix's `track gaps` (by `recordedAt`) are unchanged, and neither list affects the verdict. Under `--time-scale N` the offline gap shows as an upload gap of duration/N, so the dry-run doc uses `--gap 10s`.
- The report reuses `UsageError`/`readConfigFile` from `race-check.ts` and `parseDurationMs` from `simulate-runner.ts`. It opens the DB with `readonly: true`, which the tests show works while a writer connection is open.
- Local manual check (implementer): a temp server and a 20× two-runner simulate with `--gap 2m+5m` → both sessions `COMPLETE`, exit 0. With `--gap 10s`, each showed one upload gap of 0:00:15 and no track gaps.
- The vendor battery menu paths come from general knowledge and were not checked on devices. The doc says the menus vary between versions.

## Spec Change Log

## Review Triage Log

| # | Source | Finding | Verdict | Evidence / route |
|---|--------|---------|---------|------------------|
| 1 | blind, edge-case | Upload gaps walk seq order, not receive order | low | A FIFO outbox keeps the two orders equal, but the docs say "by server time". Sorting is a one-line correction. Patch. |
| 2 | blind | The offline-period test fixture receives seqs 8–10 before 4–7 | low | Neither the phone nor `simulate` can produce that order, and the expected value depended on #1. Patch: a realistic fixture. |
| 3 | blind | No gap shown before the first fix (GPS cold start) | low | `started` and the first fix time are both printed, so the span is visible. Rejected. |
| 4 | blind | Exit 1 means both "incomplete" and "could not run" | low | Separating them adds surface. The message tells the two apart. Rejected. |
| 5 | blind | stdout/stderr picked by a text prefix | low | Developer-only, and the fix adds a field. Rejected. |
| 6 | blind | Sessions and records are not read in one snapshot | low | The report runs after Stop or after the simulation, and the fix adds a wrapper. Rejected. |
| 7 | blind | `--session` gives no warning outside the window | low | Unlikely: the soak uses the window listing by default. Adds a branch. Rejected. |
| 8 | blind | `USAGE` `--gap` text omits upload gaps | low | A direct text correction. Patch. |
| 9 | blind | Split sessions (Start pressed twice) are not covered | low | `TrackingService` resumes the active session after a kill, so it is unlikely. Doc additions. Rejected. |
| 10 | blind | Soak has no battery pass criterion | false | The intent says battery use is *noted*, with no threshold. |
| 11 | blind | Simulated-time caveat incomplete (negative upload delay, fixes span) | low | The doc already says those figures mean nothing under `--time-scale`. Rejected. |
| 12 | blind | The test copies the store schema | low | Scripts (tests included) may not import `store/`, and the spec asked for the copy. Rejected. |
| 13 | blind, edge-case | CLI tests leave temp dirs | low | Happens on every run, and `rmSync` is a direct fix. Patch. |
| 14 | blind, verification-gap | Inclusive window bounds untested | low | A query changed to exclusive bounds would pass every test. Patch: a boundary test. |
| 15 | blind, edge-case | A fix row with NULL lat/lon is silently skipped | false | The ingest `FixRecord` schema requires lat/lon, so the store never holds such a row. |
| 16 | blind, edge-case | Two `end` records or fixes after `end` still give COMPLETE | low | The phone and the simulator end with `end` as the last seq. Adds a branch. Rejected. |
| 17 | edge-case | The 30 s dry-run gap sits right at the 30 s default threshold | false | The runbook tells the reader to run with `--gap 10s` for the dry run. |
| 18 | edge-case | `Math.max(...delays)` RangeError on huge sessions | false | 6 h at 5 s is about 4,300 records, far below the argument limit. |
| 19 | edge-case | `opensAt >= closesAt` gives a misleading "no sessions" message | low | The server refuses that config at boot, so the setup is already broken. Rejected. |
| 20 | edge-case | `--session` fails on a missing or invalid config | low | Unlikely, and the config is needed for names anyway. Rejected. |

## Design Notes

"Continuous track" is judged by the human: the report lists every gap with its UTC times so the runner can match each one to a place without signal. Lost data is judged by the machine: a missing seq or a missing `end` is `INCOMPLETE`. The dry run uses its own event config because a session belongs to an event only by its start time; started now under the race config, it would be hidden.

## Verification

**Commands:**
- `pnpm check` -- expected: everything passes.

**Manual checks:**
- Local: server with the example config, a 20× `simulate` with a gap, then `pnpm session-report` shows `COMPLETE` and the gap.
- Human (after merge, recorded in the ops note): the public dry run, its day-before repeat, and one soak per runner phone.
