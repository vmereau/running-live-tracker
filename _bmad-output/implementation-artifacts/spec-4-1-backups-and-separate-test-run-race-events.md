---
title: 'Backups and separate test-run / race events'
type: 'feature'
created: '2026-10-21'
status: 'done'
baseline_commit: 'ccf95e465bfb5481b2bac4470b2864974fc70def'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** There is no safe way to back up the live WAL fix log, and nothing proves or documents that a test run and the race can share one DB without test-run positions showing up in the race.

**Approach:** Add `pnpm backup` (`server/scripts/backup.ts`), which writes a timestamped `db.backup()` copy to `<DATA_DIR>/backups/`. Event scoping already exists (`readRunRecords` filters on the event window), so add end-to-end tests: one that boots against a backup and gets the snapshot from backup time, and one that switches configs on a shared DB. Then document both configs, keygen, switching, backup and restore in an ops note.

## Boundaries & Constraints

**Always:** Back up only through better-sqlite3 `db.backup()` on a connection to `<DATA_DIR>/tracker.db` (the same `DATA_DIR` env/default as `main.ts`). `server/scripts` imports only `domain`/`shared` (depcruise). Real configs stay git-ignored; only `*.example.json` is committed. Switching events = a different config + restart.

**Never:** Copy `tracker.db`/`-wal`/`-shm` with the filesystem. Create the DB when it is missing. Change the store schema, the ingest window behaviour (out-of-window sessions are still stored and acked) or the projection. Add backup scheduling or retention (4.2 territory).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Backup while live | server running, `DATA_DIR` has `tracker.db` | `backups/tracker-<UTC ISO, ':' and '.' → '-'>.db` is created (dir made if missing); the path is printed; exit 0 | N/A |
| No DB | `DATA_DIR` without `tracker.db` | nothing is created | stderr names the path, exit 1 |
| Restore | backup copied to `tracker.db` of an empty data dir | boot snapshot = live snapshot at backup time, not later | N/A |
| Test-run session in race | session started in the test-run window, race config booted | stored, but alice is `notStarted` with an empty track | N/A |

</frozen-after-approval>

## Code Map

- `server/scripts/keygen.ts`: script style to copy (header comment, exported pure function, `if (import.meta.main)` CLI, usage on stderr, exit 1).
- `server/src/main.ts:22-38`: `DATA_DIR` default `<repo>/data` and the `tracker.db` name. Mirror them; the script cannot import main.
- `server/src/store/open-store.ts`: WAL schema. Do not modify it.
- `server/src/main.test.ts`: `startMain`/`freePort`/`waitForReady`/`openLive` helpers. The test at :364 ("same snapshot after a restart") is the pattern for both new e2e tests. `ingest-batch.mixed.json`'s session starts at 1_760_000_000_000.
- `server/src/projection/create-projection.test.ts:156` and `open-store.test.ts:121`: window filtering is already unit-tested. Do not duplicate it.
- `.gitignore`: only `config/event.json` is ignored today.
- `README.md`: Commands table and `DATA_DIR` row. `docs/ops/tailscale-funnel.md` is the existing ops note.

## Tasks & Acceptance

**Execution:**
- [x] `server/scripts/backup.ts`: export `async backupDatabase(dataDir, now = new Date()): Promise<string>`. It opens `tracker.db` with `fileMustExist`, runs `mkdirSync(backups, {recursive})` and `await db.backup(dest)`, closes the DB in `finally` and returns `dest`. The CLI resolves `DATA_DIR` like main, prints the path and exits 1 with the message on failure.
- [x] `server/scripts/backup.test.ts`: on a temp DB (created with better-sqlite3 in WAL mode with a row): a fixed `now` gives the expected file name; the copy holds the row; it creates the `backups` dir; a missing DB rejects and creates no file; the CLI with `DATA_DIR` env prints the path (spawnSync).
- [x] `server/src/main.test.ts`, backup e2e: boot, POST the mixed batch, take a snapshot, run the backup CLI (spawnSync, same `DATA_DIR`) while live, then POST a second session's batch. Copy the backup into a fresh data dir as `tracker.db` and boot it. Its snapshot (`serverNow` zeroed) equals the backup-time one and lacks the second session.
- [x] `server/src/main.test.ts`, events e2e: one data dir, a test-run config and a race config (different `eventId`, disjoint windows, same alice key). Boot test-run and POST session A (in its window) → shown. Restart on race: alice `notStarted`, empty track; health `eventId` is the race's. POST session B → shown; A still absent. Restart on test-run: A shown, B absent. Both sessions are in the DB.
- [x] `package.json`: add `"backup": "node server/scripts/backup.ts"`.
- [x] `.gitignore`: replace `config/event.json` with `config/*.json` + `!config/*.example.json`.
- [x] `docs/ops/events-and-backups.md`: a short note covering `config/event.test-run.json` and `config/event.race.json` made from the example (distinct `eventId`, windows in epoch ms, keygen per runner, same keys allowed), switching via `EVENT_CONFIG` + restart, `pnpm backup`, and restore (stop the server, delete `tracker.db-wal`/`-shm`, copy the backup to `tracker.db`, start).
- [x] `README.md`: add a `pnpm backup` Commands row, a link to the ops note from the setup/config section, and the backups folder in the `DATA_DIR` row.

**Acceptance Criteria:**
- Given `pnpm check`, then typecheck, all tests and depcruise pass.
- Given `git status` after creating `config/event.race.json`, then it is not listed, and `config/event.example.json` stays tracked.

## Review Triage Log

| # | Source | Finding | Verdict | Evidence / route |
|---|--------|---------|---------|------------------|
| 1 | blind | Restore deletes `-wal`/`-shm` and overwrites `tracker.db` without keeping the current DB | medium | Verified in the ops note. After a crash the WAL holds committed writes, and any post-backup fixes are lost. Patch: move the current files aside. |
| 2 | blind | No integrity verification of the backup | low | `db.backup()` gives a consistent copy, and the e2e test boots one. An integrity step adds tooling. Rejected. |
| 3 | blind, edge-case | A failed `db.backup()` leaves a partial file that looks restorable | medium | Nothing removes `dest` on rejection. Restoring it on race day would lose data. Patch: rm `dest` on failure. |
| 4 | blind | The backup opens the live DB read-write | false | The script only reads. The server holds its own connection, so closing does not delete the WAL, and checkpointing is harmless. No bad outcome. |
| 5 | blind | No retention, timing or off-machine copy guidance | low | Scheduling and retention are excluded (4.2), and the files are tiny. Rejected. |
| 6 | blind | Online backup under concurrent writes is untested | low | Ingest writes every few seconds to a DB of a few MB. A restart costs milliseconds. Rejected. |
| 7 | blind | Early start before `opensAt` is hidden, with no recovery in the docs | low | Real and race-relevant. The fix is one doc line. Patch. |
| 8 | blind | Why a leftover WAL can exist is unexplained | low | Same root cause as #1. Patched with it. |
| 9 | blind | The restore test never covers the leftover-WAL hazard | low | The documented step avoids it. A test would need a crash simulation. Rejected. |
| 10 | blind | Test temp dirs are not cleaned up | low | Same as every existing `main.test.ts` test (pre-existing pattern). Rejected. |
| 11 | blind | Nested `config/**/event.json` is not ignored, and `.gitignore` has no comment | low | Nested configs are not a documented layout. Rejected. |
| 12 | blind | Switching docs don't say how to stop the server or that phones retry | low | Ctrl+C is standard, and phone retry/outbox is Story 2.3 behaviour. Rejected. |
| 13 | edge-case | Same-millisecond backups overwrite each other | low | Needs two manual runs in 1 ms. Rejected. |
| 14 | edge-case | A non-SQLite or 0-byte `tracker.db` gives an unwrapped error or an empty backup | low | The server creates the file, so this is not reachable in normal ops. Rejected. |
| 15 | edge-case | `withServer` hangs if the child exits during boot | low | Test-only. It still fails at the timeout. The guard adds a branch. Rejected. |
| 16 | verification-gap | No gaps found | — | — |

## Design Notes

Restoring needs the stale `-wal`/`-shm` removed. A leftover WAL from the old DB would be replayed onto the restored file. The `db.backup()` copy is self-contained (WAL already folded in), so a lone `tracker.db` is enough.

The ops note goes in a new file next to `tailscale-funnel.md`, because it covers a different procedure. It links back to the Funnel note instead of repeating it.

## Verification

**Commands:**
- `pnpm check`: expected: typecheck, tests and depcruise pass

**Manual checks:**
- `pnpm dev` with a temp config, then `pnpm backup`: a file appears in `data/backups/`, and the server keeps serving.
