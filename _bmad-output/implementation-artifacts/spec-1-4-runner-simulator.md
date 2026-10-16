---
title: 'Story 1.4: Runner simulator'
type: 'feature'
created: '2026-10-16'
status: 'done'
baseline_commit: '6bf364f43aa5151c153d194ca3bb6bc89b1ab352'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The live pipeline can only be exercised by going for a run. There is no way to feed realistic, continuous positions (including offline gaps and backlog uploads) through the real ingest API, and no GPX parser for this or for Epic 3's course.

**Approach:** Add a pure `parseGpx` (plus `haversineM` and point-at-distance interpolation) to `domain`, three GPX fixtures in `shared/fixtures/gpx/`, and `server/scripts/simulate-runner.ts`: each key becomes one simulated runner that walks the GPX at a given pace, records a fix every 5 s into an in-memory outbox, and uploads it per AD-3 (oldest first, ≤ 200, ack-delete, capped backoff), holding fixes during configured offline gaps and finishing with an `end` record.

## Boundaries & Constraints

**Always:**
- `server/scripts` imports only `domain` and `shared` (`.dependency-cruiser.cjs` unchanged). `domain` stays pure: no I/O, no new npm dependency (GPX is parsed by a small hand-written scanner).
- `parseGpx(xml)`: points of all `trkseg`s of the first `trk` in file order; if that has no points, the first `rte`'s `rtept`s; `[]` when neither exists. Accepts single/double-quoted attributes in any order, self-closing points, optional `<ele>` (→ `altitudeM`). Throws on a non-numeric or out-of-range `lat`/`lon`.
- Simulator behaves as AD-3 says the phone will: new UUIDv4 `sessionId` and `sessionStartedAt` per runner; `seq` from 0, +1 per record; batches of one session, oldest first, ≤ 200; on ack delete `seq ≤ ackedThroughSeq`; network error / 5xx / 401 / 429 → retry with exponential backoff capped at 60 s; 400 / 409 / 413 → drop that batch, log it, carry on.
- Fixes: `kind: 'fix'`, `accuracyM` 5, `speedMps` = runner speed, `altitudeM` when the GPX has `<ele>`, coordinates interpolated along the polyline. Each runner ends with one `end` record, then exits once its outbox is empty. Process exit code 0 when every record was acked, 1 otherwise.
- Clock, sleep and fetch are injectable so tests run in milliseconds. Logs never print a key.

**Never:**
- No projection, SSE or web changes (Story 1.5/1.6). No contract changes. No course loading in `config` (Story 3.3).
- No duplicate / out-of-order resend injection modes (not in the story ACs).

**Decisions:**
- CLI: `pnpm simulate --base-url <url> --gpx <file> --key <k> [--key <k2> …] [--pace 5:00[,5:30…]] [--time-scale N] [--stagger 30s] [--gap [i:]<at>+<duration> …]`. Durations accept `s`/`m`/`h` suffixes.
- Speed = runner pace (min/km, default 5:00). A comma list gives one pace per runner in key order; a shorter list repeats its last value. `recordedAt` follows simulated run time from `sessionStartedAt` (wall clock at start), so pace looks realistic; wall-clock waits are divided by `--time-scale` (default 1).
- `--stagger` (default 0): runner *i* (0-based) starts *i* × stagger of simulated time later; its `sessionStartedAt` is taken when it actually starts.
- `--gap at+duration` (simulated time since that runner's start) applies to every runner; prefixed `i:` it applies to runner *i* only. Repeatable.
- Spec size (~1,900 tokens) accepted as-is.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Multi-segment track | `trk` with 2 `trkseg`, plus a second `trk` | points of both segments of the first `trk`, in order | N/A |
| Route only | no `trk`, one `rte` | its `rtept`s | N/A |
| Nothing usable | no `trk`/`rte` points | `[]` | caller decides |
| Bad coordinate | `lat="abc"` or `lat="91"` | — | throws `Error` naming the point |
| Normal run | GPX 1 km, pace 5:00/km | ~61 fixes 5 s apart then `end`, all acked, one session per runner in DB | N/A |
| Offline gap | gap 60 s at 120 s | fixes keep being recorded; nothing posted during the gap; backlog posted oldest first in ≤ 200 chunks when it ends | N/A |
| Gap past finish | gap extends beyond last point | gap ends at finish; backlog + `end` uploaded | N/A |
| Server down / 5xx | first posts fail | retried with backoff 1 s, 2 s, 4 s … max 60 s; no record lost or duplicated | N/A |
| Rejected batch | 400 / 409 / 413 | batch dropped and logged; following records still sent | exit code 1 |

</frozen-after-approval>

## Code Map

- `server/src/domain/` -- has only `hash-key.ts` (+ test). Add `gpx.ts` (`parseGpx`, `GpxPoint = {lat, lon, altitudeM?}`) and `geo.ts` (`haversineM`, `pointAtDistance(points, cumulativeM, d)`) with tests; Story 3.3 will reuse both.
- `server/scripts/keygen.ts` / `keygen.test.ts` -- pattern to follow: pure exported functions + `if (import.meta.main)` CLI, usage error → exit 1, CLI test via `spawnSync(process.execPath, [scriptPath, ...])`.
- `shared/src/contract.ts` -- reuse `IngestBatch`, `IngestAck`, `FixRecord`, `EndRecord`, `MAX_BATCH_RECORDS`; import via `@running-live-tracker/shared`. Validate acks with `IngestAck.safeParse`.
- `shared/src/contract.test.ts` -- scans only `fixtures/valid` and `fixtures/invalid` (`<schema>.<case>.json`); GPX files go in `shared/fixtures/gpx/` so they are not picked up.
- `server/src/main.test.ts` -- `startMain`, `freePort`, `waitForReady`, temp `DATA_DIR`, `generateKey`; it may import anything, so the end-to-end simulator test lives here (needs a config whose `keyHash` matches a generated key; write a temp config file).
- `server/package.json` -- test glob already covers `scripts/**/*.test.ts`. Root `package.json` -- add `simulate` script.
- `README.md` -- Commands table + a "Simulating runners" section.

## Tasks & Acceptance

**Execution:**
- [x] `shared/fixtures/gpx/straight.gpx`, `out-and-back.gpx`, `lap.gpx` -- small real-looking tracks (~1–2 km, a few dozen points; out-and-back returns along the same street; lap ends near its start; one uses two `trkseg`s and `<ele>`) -- story AC + later golden tests
- [x] `server/src/domain/geo.ts` + test -- `haversineM` (known-distance vector), cumulative distances, `pointAtDistance` (clamps to ends, interpolates linearly within a segment) -- movement along the GPX
- [x] `server/src/domain/gpx.ts` + test -- `parseGpx` per the rules above; tests cover every GPX matrix row and the three fixtures -- story AC 1
- [x] `server/scripts/simulate-runner.ts` + test -- arg parsing, fix generation, gap handling, outbox/batching/ack/backoff loop, CLI; tests use injected clock/sleep and a `node:http` stub server for ack, 5xx-then-ok, 400-drop, >200 backlog chunking -- story AC 2
- [x] `server/src/main.test.ts` -- boot the server with a temp config holding a generated key, run the simulator CLI (fast time scale) with a gap, assert exit 0, one session, contiguous seqs 0..n with `end` last in `tracker.db` -- end-to-end
- [x] `package.json`, `README.md` -- `pnpm simulate …` script and usage docs (incl. a public Funnel URL example) -- discoverability

**Acceptance Criteria:**
- Given `pnpm check`, then typecheck, all tests and dependency-cruiser pass with `.dependency-cruiser.cjs` unchanged.
- Given a running server and a configured key, when `pnpm simulate` runs a fixture GPX with an offline gap, then it exits 0 and the DB holds every record exactly once under that runner.
- Given an `https://` base URL (the Funnel URL), when the simulator runs, then it posts to `<base>/api/v1/ingest` with no code difference from `http://127.0.0.1` (manual check by Valentin).

## Implementation Notes

- `out-and-back.gpx` is ~2.27 km (49 points), slightly over the "~1–2 km" guide; `straight.gpx` 31 points ~1.6 km; `lap.gpx` 37 points ~1.46 km, two `trkseg`s with `<ele>`.
- `geo.ts` also exports `cumulativeDistancesM` and `EARTH_RADIUS_M`; `pointAtDistance` interpolates altitude when both ends have one.
- `parseGpx` strips XML comments first; a non-numeric `<ele>` is skipped, not rejected.
- Unlisted statuses: any other 4xx (e.g. 404 from a wrong base URL) is dropped like 400/409/413 (exit 1); a malformed or mismatched ack is retried. A wrong key (401) retries forever every 60 s until Ctrl-C, as AD-3 says for the phone.
- Retry delays are real seconds, not scaled by `--time-scale`. Each request times out after 30 s. A bare duration means seconds. An extra fix is recorded exactly at the finish when it is off the 5 s grid.
- `pnpm` echoes the command line (key included) before running a script; README recommends `pnpm -s simulate` when output is shared.
- Verified: `pnpm check` exits 0 (server 143, shared 34, web 2 tests; depcruise clean). Manual run against a real server: exit 0, 84 records once, gap backlog as one 13-record batch, key absent from logs.

## Spec Change Log

## Review Triage Log

Pass 1 (blind = B, edge-case = E, verification-gap = V):

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | V, B: 200 with malformed / wrong-session ack and partial ack untested | medium | pre-verified: stub and real server always ack the full batch; removing the guard or the trim passes every test | patch |
| 2 | V: CLI exit 1 on dropped records (and empty GPX) untested | medium | pre-verified: `main` returning 0 unconditionally passes every test | patch |
| 3 | B, E: e2e test spawns the simulator with no timeout or kill on failure | low | a hung simulator hangs the whole suite (node:test has no default timeout); a test timeout + `sim.kill()` in `finally` is a direct correction | patch |
| 4 | B: README two-runner example has stray runs of spaces | low | confirmed at README line 118; direct correction | patch |
| 5 | B: stagger missing from `recordedAt` when time scale > 1 | low | on the live (wall-clock) map runners are exactly one stagger of run time apart; only the cross-runner `recordedAt` origin differs, as the frozen decision ("`sessionStartedAt` taken when it actually starts") specifies | reject |
| 6 | B: `recordedAt` runs ahead of server time when time scale > 1 | false | the accepted frozen decision; raised and accepted at the checkpoint | reject |
| 7 | B, E: persistent 401 / 5xx / network error retries forever | low | mandated by the frozen block (AD-3 behavior); every retry is logged with the status, so a wrong key is visible at once | reject |
| 8 | B, E: other 4xx (404, 403) drop every batch | low | each drop is logged with its status and the run exits 1; a fatal-abort mode adds behavior for an operator error that is already visible | reject |
| 9 | B: 413 should split and resend | false | AD-3 and the frozen block make 413 final for the batch | reject |
| 10 | B: dropped `end` record not called out | low | the drop log line names the seq range; cosmetic | reject |
| 11 | E: ack beyond the posted batch deletes unposted records | false | AD-3: the phone deletes `seq ≤ ackedThroughSeq` and nothing else; the simulator follows that rule exactly | reject |
| 12 | V: 200 HTML page retried forever | low | same visible retry logging as #7; only for a misconfigured URL | reject |
| 13 | B: assertions inside the stub's request handler | low | a failing assert surfaces as an uncaught exception that fails the run; no named harm in practice | reject |
| 14 | B: e2e gap-batch assertion timing-dependent | false | gap and fixes both run on the wall clock; a slower machine only enlarges the held backlog | reject |
| 15 | B: e2e leaks temp dirs, does not await server exit | low | same pattern as existing `main.test.ts` boots (accepted in 1.3 triage) | reject |
| 16 | B, E: `pointAtDistance` wrong across the antimeridian | low | linear interpolation is fine for city courses; no run crosses lon ±180 | reject |
| 17 | B: GPX namespace prefixes / CDATA / entities unsupported | low | mainstream exporters write the default namespace with plain decimal attributes; needs a real XML parser | reject |
| 18 | B: empty first `trk` falls back to `rte`, not the next `trk` | false | exactly the frozen rule ("first `trk`… falling back to the first `rte`") | reject |
| 19 | B: missing closing tag read to end of file | low | truncated GPX still yields its points or throws on a bad one; no named harm | reject |
| 20 | E: hex coordinates (`0x10`) accepted by `Number()` | low | no GPX exporter writes hex; the extra regex guard is not worth it | reject |
| 21 | E: sleep > 2^31 ms overflows `setTimeout`; huge duration → Infinity | low | needs a stagger/gap of > 24 days or a 300-digit number | reject |
| 22 | E: `--base-url` with query/hash | low | operator error with no realistic trigger | reject |
| 23 | B, E: duplicate `--key` accepted | low | two sessions for one runner is a valid stress case; unlikely by accident | reject |
| 24 | B: Ctrl+C prints no summary | low | the per-batch log already shows what was acked | reject |
| 25 | B: constant `accuracyM` and speed, no jitter | false | the frozen block specifies `accuracyM` 5 and `speedMps` = runner speed | reject |
| 26 | B: diff omits spec and sprint-status | false | the spec is the claims file, given to the edge-case layer by design | reject |
| 27 | B: README does not say a gap at the finish is cut short | false | the README `--gap` row says "uploaded when the gap ends (or at the finish)" | reject |
| 28 | E: out-and-back fixture ~2.27 km, test bound widened | low | recorded in Implementation Notes; within the "~" of the guide | reject |

## Verification

**Commands:**
- `pnpm check` -- expected: exit 0
- Temp config with a `pnpm keygen alice` hash, `EVENT_CONFIG=<it> DATA_DIR=<tmp> pnpm dev`, then `pnpm simulate --base-url http://127.0.0.1:8787 --gpx shared/fixtures/gpx/out-and-back.gpx --key <key> …` -- expected: exit 0, one session in `<tmp>/tracker.db`, gap backlog visible in server logs as one larger batch

**Manual checks (if no CLI):**
- Same command against the public Funnel URL (Valentin, before Story 4.3).
