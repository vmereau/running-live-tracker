---
title: 'Always-on home PC'
type: 'feature'
created: '2026-10-21'
status: 'done'
baseline_commit: '35ba7e64645226b7f25a225ce276590fd8de7347'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nothing brings the server back after a reboot or crash, the logs only go to stdout, and there is no single check that tells whether the home PC is race-ready (AD-14).

**Approach:** Have the server also append its pino JSON logs to `<DATA_DIR>/logs/`. Add a Windows supervisor script, run by a Task Scheduler "at logon" task, that restarts the server whenever it exits. Add `pnpm race-check`, which reports pass/fail for the public health check, the active event and its window, the runners, the course and the power settings. Add a runbook that covers PC setup and the manual checks.

## Boundaries & Constraints

**Always:** Server code stays tunnel-agnostic and binds `127.0.0.1` only. Logs never contain raw keys or request bodies. `server/scripts` imports only `domain`/`shared`, so race-check reads the config JSON itself instead of importing `config/`. Same `DATA_DIR`/`EVENT_CONFIG` env and defaults as `main.ts`. Extend `docs/ops/` instead of starting a new place.

**Never:** No Windows service/NSSM (AD-14 says at logon + auto-logon), no containers. No wire-contract change (`EventInfo` stays as is). Do not automate Windows Update pause or auto-logon. No log rotation or backup scheduling.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Server boots | any `DATA_DIR` | every log line goes to stdout and is appended to `<DATA_DIR>/logs/server-<UTC YYYY-MM-DD of boot>.log` (dir created) | N/A |
| race-check all good | public URL up, health `eventId` = config `eventId`, closesAt in the future, course expected and loaded, sleep/hibernate AC timeouts 0 | one line per check `PASS`/`FAIL`/`SKIP` + detail; exit 0 | N/A |
| URL down / non-200 / bad JSON | `--base-url` unreachable | health `FAIL` with the reason; checks that need the server `FAIL`; power still reported | exit 1, no stack trace |
| Wrong event live | health `eventId` ≠ config `eventId` | event `FAIL` naming both ids | exit 1 |
| Window closed | `closesAt` ≤ now | window `FAIL`; before `opensAt` = `PASS` with "opens in …" | exit 1 if closed |
| Course mismatch | config has `coursePath` but snapshot `hasCourse` false, or the opposite | course `FAIL` | exit 1 |
| Not Windows / powercfg fails | `process.platform !== 'win32'` | power `SKIP` (does not fail the run) | N/A |
| Server exits | crash or config error under the supervisor | restarted after 10 s, exit code + time appended to `logs/supervisor.log` | stderr kept in `logs/stderr-<start>.log` when non-empty |

</frozen-after-approval>

## Code Map

- `server/src/main.ts:62`: `buildApp({ logger: true })`. The comment there names Story 4.2. Pass a pino logger config with a custom `stream` (sync `writeSync` to stdout and to an fd from `openSync(path, 'a')`), so no line is lost on `process.exit`. Close the fd after `store.close()`. Pre-logger `console.error` exits stay as is (the supervisor captures stderr).
- `server/src/main.test.ts:62`: `startMain`/`waitForReady` parse stdout logs. Keep stdout output. The key-secrecy test (~:188) should also assert the log file lacks the secret.
- `server/scripts/backup.ts`: script style to copy: exported pure functions, `if (import.meta.main)` CLI, `DATA_DIR`/repo-root resolution.
- `server/scripts/simulate-runner.ts` / `.test.ts`: `--base-url` arg parsing, `UsageError`, and the stub `node:http` server pattern for tests.
- `shared/src/contract.ts:75`: `HealthResponse` (in `http`) / `Snapshot.event` (`eventId`, `hasCourse`, `lengthM`, `runners`). Validate responses with the shared zod schemas.
- `config/event.example.json`: config shape (`eventId`, `opensAt`, `closesAt`, `coursePath?`, `runners[].runnerId/displayName`).
- `docs/ops/tailscale-funnel.md` (Funnel commands) and `docs/ops/events-and-backups.md` (configs, switching). The runbook links to both.
- `README.md`: Commands table, Public access section, and the `DATA_DIR` row ("Log files arrive in Story 4.2").

## Tasks & Acceptance

**Execution:**
- [x] `server/src/main.ts`: tee the logs to stdout + `<DATA_DIR>/logs/server-<date>.log` as in the matrix. Log `logPath` in "server ready".
- [x] `server/src/main.test.ts`: assert that the log file exists after boot, holds the "server ready" JSON line and, in the ingest e2e, does not contain the key.
- [x] `server/scripts/race-check.ts`: export `parseRaceCheckArgs` (`--base-url` required, `https`/`http`; optional `--config`, defaulting to `EVENT_CONFIG` / `<repo>/config/event.json`), `parsePowercfgAcIndex(output)` (the second-to-last `0x…` value, which is the AC index; locale-independent) and `raceCheck(deps)`, which returns `{ name, status, detail }[]` with injected `fetch`, `now`, `readConfig` and `queryPower`. Checks: health, event, window (ISO times and a relative "opens in"/"closes in"), runners (config ids vs snapshot ids, listing display names), course (with `lengthM` km), sleep (`SUB_SLEEP STANDBYIDLE`), hibernate (`SUB_SLEEP HIBERNATEIDLE`). The CLI prints aligned lines and a summary, then exits 0 or 1.
- [x] `server/scripts/race-check.test.ts`: cover every matrix row except the supervisor, using a stub HTTP server and fake power output (a sample English `powercfg /query` block plus one with French labels), plus arg errors.
- [x] `ops/windows/start-server.ps1`: params `-EventConfig` (required), `-DataDir`, `-Port`. Resolves the repo root from `$PSScriptRoot` and loops: `Start-Process node server/src/main.ts -NoNewWindow -Wait -PassThru` with stdout to `logs/stdout.log` and stderr to `logs/stderr-<yyyyMMdd-HHmmss>.log` (deleted if empty). Appends to `supervisor.log` and sleeps 10 s.
- [x] `package.json`: `"race-check": "node server/scripts/race-check.ts"`.
- [x] `docs/ops/race-readiness.md`: the runbook. One-time setup: `powercfg /change standby-timeout-ac 0` and `hibernate-timeout-ac 0` (or `powercfg /hibernate off`); build web; register the logon task (a `Register-ScheduledTask` snippet: at logon of the current user, `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File …\start-server.ps1 -EventConfig …`, no execution time limit); Tailscale service Automatic + "Run unattended" + `tailscale funnel --bg 8787` (persists across reboots); auto-logon (Sysinternals Autologon). A reboot test. `pnpm race-check --base-url https://<host>.ts.net` and a note that, from the PC itself, it goes over the tailnet, so also open `/api/v1/health` on a phone with mobile data. Where the logs are. A manual checklist: Windows Update paused for race week, auto-logon on, power plugged in/router up, race config active, backup taken.
- [x] `README.md`: Commands row for `pnpm race-check`, a link to the runbook from Public access, and an update to the `DATA_DIR` row (logs).

**Acceptance Criteria:**
- Given `pnpm check`, then typecheck, all tests and depcruise pass.
- Given the server is started by `start-server.ps1` and its node process is killed, when 10 s pass, then health answers again and `supervisor.log` records the exit.

## Review Triage Log

| # | Source | Finding | Verdict | Evidence / route |
|---|--------|---------|---------|------------------|
| 1 | blind, edge-case, verification-gap | A log-file write error (`ENOSPC`, `EIO`) throws out of every pino call | medium | `logStream.write` guards only the stdout write. A full disk on race day would fail requests or crash the server in a loop. Patch: catch it and keep serving. |
| 2 | blind, edge-case | `writeAll` busy-loops on a repeated stdout `EAGAIN` | low | Under the supervisor stdout is a file, and in tests the parent drains the pipe. Unlikely, and the fix adds a guard. Rejected. |
| 3 | edge-case | `store.close()` throwing in shutdown skips `closeSync` | low | Pre-existing shutdown shape. The process exits either way. Rejected. |
| 4 | blind, edge-case | A failing `Add-Content` in `Write-SupervisorLog` ends the supervisor, and the task has no restart-on-failure | medium | Under `$ErrorActionPreference='Stop'` the call inside `catch` and at startup is fatal, so the safety net would disappear. Patch: best-effort log writes, plus task restart settings in the runbook. |
| 5 | blind, edge-case | A boot-failure loop makes a stderr file every 10 s with no backoff | low | About 200 B per file, and race-check shows the failure. A backoff adds branches. Rejected. |
| 6 | blind | Stopping the task can leave node running, and the snippet hard-codes 8787 | low | Documented with a workaround. 8787 is the default port. Rejected. |
| 7 | blind | race-check does not probe `/` or the SSE stream | low | The checks listed in the intent are covered. The runbook's reboot test opens the map on a phone. Rejected. |
| 8 | blind | The window check uses the local clock, not `serverNow` | low | race-check runs on the server PC, so it is the same clock. Rejected. |
| 9 | blind | No disk-space or backup-age check | low | Not part of the intent's checks. Backup is on the manual checklist. Rejected. |
| 10 | blind | Logs are written twice (`stdout.log` + `server-*.log`) | low | `stdout.log` is overwritten at each run, so the disk cost is negligible. Rejected. |
| 11 | blind, edge-case | `RaceConfig` does not refine `opensAt < closesAt` | low | The server refuses that config at boot, so the event/health check fails anyway. Rejected. |
| 12 | blind | No tests for the ps1, a failed log open, or `EAGAIN` | low | The ps1 is covered by #23. The others are unlikely paths with guard-only fixes. Rejected. |
| 13 | blind | The CLI "all good" test's exit-code assertion is conditional | low | Exit 1 on FAIL is pinned by the unreachable-URL CLI test. Rejected. |
| 14 | blind | The checklist has no race-morning race-check | low | Switching events is manual and easy to forget. A one-line doc fix. Patch. |
| 15 | edge-case | An orphaned node holding `stdout.log` makes Start-Process fail | low | The same orphan already causes EADDRINUSE, and the runbook covers stopping it. Rejected. |
| 16 | edge-case | Removing an empty stderr file can fail on a lock | low | node has exited by then, so there is no lock. Rejected. |
| 17 | edge-case | stderr file stamp is local time while `supervisor.log` is UTC | low | Mismatched times when reading the logs. A direct one-token correction. Patch. |
| 18 | edge-case | `--base-url https://h?` (bare `?`) passes validation | low | Unlikely input, and the guard is extra code. Rejected. |
| 19 | edge-case | Duplicate runnerIds collapse in the Sets | false | The server's config schema rejects duplicate runnerIds at boot, and the snapshot comes from that config. |
| 20 | edge-case, verification-gap | The runbook's `powercfg /hibernate off` alternative is not what race-check reads (HIBERNATEIDLE) | low | Following it gives SKIP/FAIL instead of PASS. Patch: drop the alternative from the runbook. |
| 21 | edge-case | powercfg failing on Windows should FAIL, not SKIP | false | The frozen matrix says powercfg failure = SKIP. The fix would edit the spec. |
| 22 | verification-gap | Append across restarts is not tested | low | Changing `'a'` to `'w'` would pass all tests. Patch: assert two "server ready" lines in the restart test. |
| 23 | verification-gap | The supervisor kill/restart AC has no recorded verification | low | The implementer verified it manually, but nothing records it for the race PC. Patch: add a kill-and-restart step to the runbook's reboot test. |

## Design Notes

The supervisor loop sits outside node, so it covers crashes and also a config error that is fixed while the loop keeps retrying. Task Scheduler only starts it at logon. The race-check event check compares the config file with the live server, because the public `EventInfo` has no window. A matching `eventId` makes the config's window the active one.

## Verification

**Commands:**
- `pnpm check`: expected: everything passes.

**Manual checks:**
- On the PC: register the task, reboot, and without touching anything `pnpm race-check --base-url https://<host>.ts.net` is all PASS. The phone (mobile data) gets 200 from `/api/v1/health`.
