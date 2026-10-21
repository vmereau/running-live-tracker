# Epic 4 Context: Race-day readiness

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Make the system trustworthy for marathon day. The home Windows PC has to stay up and publicly reachable for the whole race and come back on its own after a reboot. The append-only fix log has to be backed up safely. Test-run data must never show up in the race. The full pipeline (phones → Tailscale Funnel → server → spectator browsers) has to be proven end-to-end: a public-URL dry run, a ≥ 5 h pocketed soak on each runner's own phone, and a real two-runner test run with a friend watching. This epic adds no new functional requirements. It verifies tracking endurance, tunnel-only exposure, operational availability and the success signal. It also gives the only planned chance to measure accuracy and tune the stats constants.

## Stories

- Story 4.1: Backups and separate test-run / race events
- Story 4.2: Always-on home PC
- Story 4.3: Public dry run and phone soak test
- Story 4.4: Two-runner test run and tuning

## Requirements & Constraints

- **Tracking endurance:** each runner's phone must track for ≥ 5 h with the phone pocketed and the screen locked. The server must end up with a continuous track, with gaps only where there was no signal, and the outbox must be empty after Stop. Note battery use and any vendor-specific battery settings each phone needs.
- **Exposure:** the server is reachable only over public HTTPS through Tailscale Funnel (port 443, `https://<machine>.<tailnet>.ts.net`). No router port forwarding, no raw public IP, no Cloudflare Quick Tunnels.
- **Availability:** the home PC, power and internet must stay available for the whole race. After a reboot everything must come back with no manual step.
- **Success signal:** during a two-runner test run, a friend on a phone browser can switch between runners from start to finish and see live position, pace, stats, km done out of total km and an estimated finish time for each runner.
- **Accuracy tolerance:** compare the page's distance, pace and finish time with each runner's own watch/app data, and record the differences as the accepted tolerance.
- **No data loss:** backups must be consistent copies of the live WAL database.
- Live only: no history or replay UI is added. Positions stay stored.

## Technical Decisions

- **Backups:** `server/scripts/backup` writes a timestamped copy to `data/backups/` using better-sqlite3 `db.backup()`. Never file-copy a WAL database. A test must show that booting against a backup copy gives the same snapshot the live server had at backup time. This relies on state being fully rebuilt by replaying the log through `applyRecords`. Derived values are never persisted.
- **Event scoping:** the test run and the race are separate `config/event.json` configs. Each has its own `eventId`, `opensAt`/`closesAt` (epoch ms) and runners, and both share one SQLite DB. The projection includes only sessions whose `sessionStartedAt ∈ [opensAt, closesAt]`. Sessions outside the window are stored and acked but never shown. Config is read-only at runtime, so switching events means a restart. Only `*.example.json` is committed. `event.json`, `config/courses/` and `data/` are git-ignored.
- **Keys:** generate them with the existing keygen script (32 random bytes, base64url, 43 chars, plus the hex SHA-256 `keyHash` pasted into config). The config validates hash format and uniqueness of `runnerId`/`keyHash`.
- **Race-readiness checklist** (all must hold): Windows sleep and hibernate are disabled. Windows Update is paused for race week. Auto-logon is enabled. Server and Tailscale autostart at logon. `GET /api/v1/health` → `200 {ok, serverNow, eventId}` on the public URL. A public-URL `simulate-runner` dry run with a phone browser watching passes the day before. Backups use `db.backup()`.
- **race-check script:** reports pass/fail for the public health check, the active `eventId` and window, the configured runners, whether the course is loaded, and the power settings it can query. Checks it cannot automate (Windows Update paused, auto-logon) go in a runbook checklist.
- **Server process:** one Node process plus the Tailscale daemon, with no containers. Fastify binds `127.0.0.1` only. Port and data dir come from env vars. Pino JSON logs go to `data/logs` and never contain raw keys or request bodies. Code must stay tunnel-agnostic (no Tailscale-specific headers or hostnames).
- **Scripts dependency rule:** `server/scripts` may import only `domain` and `shared`. This is enforced by dependency-cruiser.
- **Tuning:** any change to matching window, off-course distance, pace window or ETA basis happens only in the named constants in `server/src/domain`. Golden tests are updated and must still pass, and so must the live-equals-replay test. The pace-window sizes and ETA-on-average-pace are documented assumptions to revisit after the test run.
- Error bodies are `{error:{code,message}}` with stable codes. All times are epoch ms UTC.

## Cross-Story Dependencies

- Builds on Epics 1–3: `simulate-runner` (with offline gaps, works against the public URL), keygen, ingest/projection/SSE, the Android `TrackingService` and outbox, and the course/stats/ETA display. Existing Funnel setup notes live in `docs/ops/`; extend those ops notes rather than starting new ones.
- 4.1 (separate test-run/race configs, backups) should land before 4.3/4.4, so soak and test-run sessions go in test-run events and never appear in the race.
- 4.2 (autostart, race-check, health on the public URL) is the foundation for the public dry run in 4.3. Repeat the dry run the day before the race.
- 4.4's measured tolerance may lead to domain constant tuning, which must keep every earlier golden and replay test passing.
