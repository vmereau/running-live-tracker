---
reviews: ARCHITECTURE-SPINE.md (running-live-tracker, draft 2026-10-15)
against: _bmad-output/specs/spec-running-live-tracker/SPEC.md
lens: good-spine rubric (divergence points, enforceable rules, safe deferrals, current tech, capability coverage, operational envelope) + technical correctness
date: 2026-10-15
---

# Spine Review — running-live-tracker

## Verdict

**Approve with required changes.** This is a strong spine. The paradigm (an append-only log, projections computed only on the server, a phone outbox) suits the problem. Most ADs name a real divergence and give a Rule that can be checked. All seven capabilities map to architecture. Five issues should be fixed before epics and stories are cut, because each one either lets independently built units diverge or breaks a spec success criterion on race day:

1. AD-3 and AD-10 contradict each other on uploading after Stop, and AD-10 leaves out the Android permission and restart facts that decide whether tracking survives (High).
2. A single invalid record can block a phone's outbox for the rest of the race. The `null` vs omitted handling between Kotlin and zod makes this likely (High).
3. AD-7's forward window can leave `progressM` stuck for good after a long gap of accepted fixes (High).
4. There is no testing strategy, so each agent will choose its own (Medium).
5. The dependency graph contradicts AD-9, and nothing enforces it. Dev networking contradicts AD-11 (Medium).

The other findings are Medium or Low and are listed below.

---

## 1. Rubric scorecard

| Criterion | Result | Notes |
| --- | --- | --- |
| Fixes the real divergence points for the level below | Mostly | Strong on wire contract, identity, ack semantics, derived-value ownership, and SSE semantics. Missed: event scoping of the log (F-7), elapsed time after Stop (F-8), the meaning of "distance" inside the pace window (F-9), null/optional encoding (F-2), test tooling (F-4), and post-Stop upload ownership (F-1). |
| Every AD Rule is enforceable and actually prevents its divergence | Mostly | AD-3 and AD-10 conflict (F-1). AD-7's window does not prevent the failure it exists to prevent (F-3). The dependency rule has no enforcement mechanism and is internally inconsistent (F-5). |
| Nothing under Deferred can let two units diverge | Mostly | The "SSE through tunnel" spike leaves open whether the web client ships the polling path now or later (F-12). Viewer link secrecy is said to need no contract change, but it does touch the web client's URL handling. That is minor and acceptable. |
| Named tech plausibly current | Plausible, unverified | Several versions sit at the edge of what can be confirmed for Oct 2026 (F-13). Pin them only after `pnpm add` and a Gradle sync. |
| Covers all spec capabilities | Yes | CAP-1 to CAP-7 are all mapped. CAP-3 "close to the watch" is weakened by the progress-as-distance choice (F-9, note). |
| Operational envelope decided, deferred, or open | Partial | Deployment and environments: decided, with a defect (F-5b). Infra/provider: decided as an assumption. Operations: deferred explicitly, but the backup procedure is wrong for WAL (F-10). Host-PC sleep and update reboots are not mentioned (F-11). **Testing strategy: absent (F-4).** Security: covered for ingest, thin on the public read side (F-14). |

---

## 2. Findings

### F-1 — High — AD-3 "retry after Stop" contradicts AD-10's single-service uploader; Android FGS facts that decide survival are missing

**Problem.**
- AD-3 requires the phone to "keep retrying ... for as long as the outbox is not empty, even after Stop."
- AD-10 says the uploader "is a coroutine owned by that service" and forbids WorkManager and JobScheduler.
- If Stop ends the location foreground service, the uploader ends with it, and backlogged fixes plus the `end` record sit there until the next Start. The runner would then show `active` forever, and the CAP-7 gap stays unfilled if the runner stops while offline, which happens often at a finish area with congested cells.
- One agent will keep the location FGS alive after Stop. Another will stop it. A third will quietly add WorkManager.

Missing platform facts that a story implementer will hit:
- **Manifest permissions** (targetSdk 36): `ACCESS_FINE_LOCATION` plus `ACCESS_COARSE_LOCATION` (runtime), `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION`, `POST_NOTIFICATIONS` (runtime, API 33+), `INTERNET`, and `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`. `startForeground(..., FOREGROUND_SERVICE_TYPE_LOCATION)` throws `SecurityException` if the location runtime permission is not granted at that moment, so the Start button must check it first.
- **Process death and restart.** AD-10 says "a process restart keeps the same session", but it does not say who restarts tracking. A `START_STICKY` restart is a start from the background. A location FGS started from the background gets no location under while-in-use permission unless `ACCESS_BACKGROUND_LOCATION` is granted. So restart either (a) requires background location (fine for a sideloaded app, but it adds a "Allow all the time" settings step), or (b) only happens when the runner reopens the app. Pick one.
- Because AD-4 merges sessions into one run, a new session on restart is also valid. The spine should say which of these it uses.

**Suggested fix.** Amend AD-10 with these points:
- "After Stop, the service downgrades to a non-location foreground notification ('Uploading N pending points'). It keeps the uploader running until the outbox is empty, then calls `stopSelf()`. No location requests are made after Stop."
  - Alternatively, allow a single expedited `WorkManager` job only for the post-Stop drain, and say so explicitly.
  - Declare the service with `foregroundServiceType="location|dataSync"`. Switch the type on Stop with `ServiceCompat.startForeground`, and note that dataSync has a 6 h cap on Android 15+.
- List the required permissions and the order in which the Start screen requests them.
- Decide on restart: request `ACCESS_BACKGROUND_LOCATION` at setup and return `START_STICKY` with resume from the persisted session, **or** use `START_NOT_STICKY` and show a "tracking was interrupted, tap to resume" notification. A resume continues the persisted `sessionId` and `seq`.
- Add a line pointing to OEM battery killers (Samsung, Xiaomi; dontkillmyapp.com) as part of the setup checklist.

### F-2 — High — A single rejected record blocks a phone's outbox for the whole race (poison batch), and null vs omitted is undecided

**Problem.**
- AD-3: "A rejected batch (4xx/5xx/network) leaves the outbox untouched" and the phone retries forever, oldest first.
- AD-9: the server "answers `400` with `ErrorBody`" on any schema failure.
- Put together, one malformed record (NaN speed, a negative accuracy, an over-long batch, a schema drift) makes every later batch fail too. Live tracking stops for that runner until a developer steps in.
- The most likely trigger is built into the contract. The fix record has `altitudeM?` and `speedMps?`:
  - zod `.optional()` rejects `null`.
  - kotlinx.serialization emits `"altitudeM": null` by default (`explicitNulls = true`). Moshi and Gson differ again.
  - `Location.getSpeed()` and `getAltitude()` have `hasSpeed()` and `hasAltitude()` guards that the Kotlin side will map to `null`.
- The fixtures in AD-9 catch this only if one of them has a missing optional field and the Android contract test round-trips it. The spine does not require that.
- The same blocking happens on a persistent `401` (a revoked or mistyped key). AD-5 handles that correctly by showing an error, but 400 has no such defined behaviour.

**Suggested fix.**
- In Conventions, add: "Optional wire fields are **omitted, never `null`**. Kotlin uses `explicitNulls = false`. zod schemas use `.optional()`. `shared/fixtures/` must include a fix with every optional field omitted, plus one invalid batch."
  - Alternatively, pick `.nullish()` everywhere. Either works, as long as one choice is written down.
- In AD-3, define poison handling. Recommended: **the server validates per record**. It stores a structurally valid but semantically bad record as `rejected=1` (so it counts as stored for `ackedThroughSeq` and is skipped by projections) and returns `200`.
  - Only an envelope failure (bad `sessionId`, unparseable JSON, more than 200 records) returns `400 INVALID_BATCH`.
  - On `400`, the phone moves that batch to a dead-letter table and goes on. On `401` it pauses uploading and shows an error, as it does now.

### F-3 — High — AD-7's forward window can leave progress stuck for good

**Problem.**
- Projection searches only `[lastProgressM − 50 m, lastProgressM + 1000 m]`, and any fix more than 100 m from the course "leaves `progressM` unchanged".
- Accepted fixes can stop for longer than about 1 km of running:
  - fixes with accuracy over 30 m are skipped, which happens in tunnels, under bridges, in urban canyons, and at many city marathons' underpasses
  - fused-location stalls
  - a phone reboot
  - the runner forgetting to restart after an accidental Stop (AD-4 encourages the session merge)
- At about 5 min/km, 5 minutes of skipped fixes is already 1 km. After that, every later fix projects onto the window's far end at more than 100 m from the runner. `offCourse: true` stays set for the rest of the race, and distance, remaining, percent, ETA, and `avgPace` (which divides by `progressM`) are all wrong from then on.
- That breaks CAP-3, CAP-4, and CAP-5, and it is exactly the race-day failure the AD is meant to prevent.

**Suggested fix.** Add a recovery rule in `server/src/domain`, using named constants:
- Upper window bound = `lastProgressM + max(1000 m, MAX_SPEED_MPS × (recordedAt − lastAcceptedAt) / 1000 + 200 m)`, with `MAX_SPEED_MPS ≈ 7`.
- **Re-acquire:** after `N` (for example 3) consecutive accepted fixes that are off-course within the window, search the whole remaining course `[lastProgressM, lengthM]` for the nearest segment within 100 m and jump forward to it. It still never goes backward.
- Add golden tests for an out-and-back course, a lap course, and a 2 km accuracy gap.
- Also define `avgPace`, `currentPace`, and ETA as `null` when `distanceM = 0`. Today they would divide by zero.

### F-4 — Medium — No testing strategy (an operational-envelope dimension that is missing)

**Problem.** The spine mentions "unit tests" for domain and "contract tests" for Kotlin, and stops there. Agents working on separate stories will each pick:
- a TS runner (vitest vs `node:test` vs jest)
- a projection test style
- whether there are integration tests against a real SQLite file
- how GPS is simulated on Android

The result is several runners, duplicated fixtures, and no shared regression harness for the parts that matter most: replay determinism (AD-1) and progress and pace math (AD-7, AD-8). CAP-1, CAP-2, and CAP-7 success criteria (two phones, airplane mode for 2 minutes) also have no automated or scripted path.

**Suggested fix.** Add a "Testing" convention row or a short AD:
- **TS:** use `node:test` + `node:assert`. They run `.ts` directly under type stripping with no extra dependency, which fits the "Node runs `.ts`" choice. Vitest is the alternative. Choose one.
- **Domain:** golden tests that feed a GPX plus a recorded fix sequence (`shared/fixtures/runs/*.json`) and compare against an expected `RunnerView` timeline.
- **Server integration:** start Fastify on an ephemeral port with a temp SQLite file and a fixture `event.json`. POST batches, read SSE, then kill and restart and assert the snapshot is identical (this tests AD-1).
- **Simulator script:** `server/scripts/simulate-runner.ts`. It replays a GPX as ingest batches with a key, and can add an offline gap, duplicates, and out-of-order resends. It covers CAP-2 and CAP-7 without phones and serves as the pre-race smoke test.
- **Android:**
  - JVM contract tests read `../shared/fixtures` (state how: Gradle `test.resources.srcDir`).
  - An instrumented outbox and uploader test runs against MockWebServer.
  - Manual GPS uses the emulator's GPX route playback or a mock-location provider.
- Say what is manual only: the locked-screen marathon soak, which is the test run.

### F-5 — Medium — Dependency graph contradicts AD-9 and has no enforcement; dev networking contradicts AD-11

**Problem (a).**
- The graph says "anything not drawn is forbidden", yet `ingest`, `projection`, `live`, and `config` have no edge to `shared`.
- AD-9 requires the server to validate ingest against `shared/src/contract.ts`, and `RunnerView` and `Snapshot` are built in projection and live.
- `config` also needs zod (or shared) to validate `event.json`. `main.ts` is not in the graph.
- Taken literally, the rule forbids what AD-9 requires. Agents will either ignore the graph or argue over it.
- Nothing checks the graph mechanically.

**Suggested fix (a).**
- Add `ingest/projection/live/config → shared`. State that `main.ts` (the composition root) may import anything.
- Enforce the graph with `dependency-cruiser` (or `eslint-plugin-boundaries`), wired into a `pnpm check` script together with `tsc --noEmit`.

**Problem (b).**
- The dev environment diagram lists "phone on LAN", but AD-11 binds `127.0.0.1` only, so a LAN phone cannot reach it.
- Android blocks cleartext HTTP by default (API 28+), so neither `http://10.0.2.2:PORT` nor `http://<lan-ip>` works without a network security config.

**Suggested fix (b).**
- Dev uses the emulator with `10.0.2.2`, or a physical phone over USB with `adb reverse tcp:PORT tcp:PORT`. Both keep the `127.0.0.1` binding.
- Add a debug-only `network_security_config.xml` that permits cleartext to `10.0.2.2` and `localhost`. Release builds stay HTTPS only.
- Alternatively, use the Funnel URL in dev too.

### F-6 — Medium — SSE through Fastify and the tunnel needs explicit response rules

**Problem.**
- Cloudflare Quick Tunnels are correctly ruled out.
- Even on Tailscale Funnel or a named Cloudflare tunnel, SSE breaks quietly when:
  - the response is compressed or buffered
  - headers are not flushed right away
  - a framework hook (for example a future `@fastify/compress`) wraps the stream
- In Fastify 5, SSE needs `reply.hijack()` or `reply.raw` handling. Different agents will implement it differently.

**Suggested fix.** Add to AD-6:
- Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
- No compression on `/api/v1/live`. Write via `reply.raw` after `reply.hijack()`. Flush with an initial comment right away.
- Cap concurrent SSE clients (for example 200) on a home PC.
- The 20 s ping is enough for Cloudflare's 100 s idle timeout and for Funnel.

### F-7 — Medium — The fix log is not scoped to an event

**Problem.**
- The test run uses "its own `eventId`", and AD-1 replays "the log" at boot.
- Nothing says that fixes, sessions, or the stored runner are tagged with `eventId` and `runnerId`.
- If the race uses the same `data/` file, test-run sessions from the same runner key join the race run, which breaks AD-4's one-run rule (`runStartedAt` would be the test-run date).

**Suggested fix.** In AD-1 or AD-3, add:
- The store has a `sessions(sessionId PK, eventId, runnerId, sessionStartedAt)` table, written on first sight. A `sessionId` stays bound to its first `runnerId`; a different key using it gets `409 SESSION_OWNED`.
- Replay loads only sessions for the configured `eventId`.
- Alternatively, require a separate data dir per event. Either way, write the choice down.

### F-8 — Medium — Elapsed time after Stop, and two definitions of "elapsed"

**Problem.**
- The web computes `elapsed = now − runStartedAt`, which keeps counting after the runner stops and grows for hours after the finish.
- The server's `avgPaceSPerKm = elapsedS / ...` implies a server-side `elapsedS` that is not defined: last fix minus run start, or server now minus run start?
- The web's and the server's elapsed will disagree, and pace will appear to drift.

**Suggested fix.** In AD-2 and AD-8:
- Server `elapsedS = lastAppliedFixAt − runStartedAt`.
- `RunnerView` carries `runEndedAt` (the recordedAt of the `end` record, or `null`).
- The web shows `(runEndedAt ?? correctedNow) − runStartedAt`.

### F-9 — Medium — The pace window's "200 m" is ambiguous, and progress-as-distance affects CAP-3

**Problem.**
- AD-8's window must "cover at least 60 s **and** 200 m", but it does not say 200 m of what: `progressM` delta or raw track distance.
- It also does not say whether this is the smallest trailing window that satisfies both.
- Because AD-7 makes distance equal to `progressM`, a runner who goes 300 m off course has frozen progress, so `currentPace` will read `null` or very slow if measured on progress.
- Separately, distance measured along the GPX tends to read shorter than a watch, especially where the GPX line is smoothed. CAP-3 "close to watch" may be judged against that.

**Suggested fix.**
- State that `currentPace` uses the smallest trailing suffix of accepted fixes with Δt ≥ 60 s **and** Δ`progressM` ≥ 200 m (when a course is configured), and filtered track distance otherwise.
- Record as an `[ASSUMPTION]` that "distance" follows the course and may differ from a watch by about 1–2%.

### F-10 — Medium — "Backup is a copy of the SQLite file" is unsafe in WAL mode

**Problem.**
- With `journal_mode=WAL`, recent commits live in `*.db-wal` until a checkpoint. Copying only `.db`, or copying while the server runs, can lose data or produce a torn copy.
- On Windows, the file may also be locked by an AV scanner or OneDrive if `data/` sits in a synced folder.

**Suggested fix.**
- Backup is `server/scripts/backup.ts`, which uses better-sqlite3's `db.backup()` or `VACUUM INTO`. Alternatively, stop the server and copy `.db` plus `-wal` plus `-shm`.
- `data/` must not be in a OneDrive or Dropbox folder.
- Consider a periodic `db.backup()` every 10 min during the race, because a dead disk there ends the race.
- Note about better-sqlite3 on Windows: it is a native addon. Confirm that prebuilt binaries exist for Node 24 x64 and Windows, otherwise the Visual Studio C++ build tools are needed. If not, Node's built-in `node:sqlite` is a drop-in alternative that avoids the native build entirely.

### F-11 — Low/Medium — Host-PC failure modes are not on the Deferred list

**Problem.** The runbook is deferred, which is acceptable. But two Windows behaviours that are certain to happen are not even named:
- sleep or hibernate, which by default comes after inactivity
- Windows Update forced restarts

Either one kills the race in the way the spec's constraints warn about.

**Suggested fix.** Add to Deferred (runbook) explicitly:
- a power plan with no sleep
- paused Windows Update and active hours
- Tailscale set to start unattended
- the server started at boot or kept in a terminal

Also note that `tailscale funnel` must expose the server port on 443.

### F-12 — Low — Status of the polling fallback is unclear

AD-6 calls `/api/v1/snapshot` polling the "only supported fallback". The Deferred spike decides whether it is needed. A web agent cannot tell whether to build the polling path now.

**Fix:** "The web client implements both and picks polling with `?transport=poll` or after N failed SSE connects." Alternatively, state that polling is not built until the spike fails.

### F-13 — Low — Version and tooling plausibility (verify at install time)

**Risks to verify.**
- Several pins are at or beyond the edge of what can be confirmed: pnpm 12.11.2, @fastify/static 10.1.6, AGP 9.4.1, Tailscale 1.104.1, better-sqlite3 13.0.3, Node 24.22.0. TypeScript 7.0.2 is the native Go port.
- None is implausible for Oct 2026, but each should be confirmed with `pnpm view <pkg> version` or a Gradle sync before the first story pins it.
- AGP 9 has built-in Kotlin support, so don't add the separate `kotlin-android` plugin.

**Limits of Node type stripping that the spine should state, because agents will hit them:**
- No enums, namespaces, or parameter properties, and no `import x = require` (the spine already says erasable syntax only).
- Relative imports must use the `.ts` extension, which needs `allowImportingTsExtensions` and `rewriteRelativeImportExtensions` or `noEmit`.
- Type-only imports must use `import type` (`verbatimModuleSyntax: true`).
- `tsconfig` `paths` are not honoured at runtime.
- **Node refuses to strip types for files under `node_modules`.** `server` importing `@rlt/shared` through a pnpm workspace symlink works only because Node resolves symlinks to realpath by default. Never run with `--preserve-symlinks`. Point `shared`'s `exports` at `./src/contract.ts`.
- Add a tsconfig base with `erasableSyntaxOnly: true` so `tsc` catches violations before runtime does.

**Leaflet 1.9.4** is fine and stable. If Leaflet 2.x is out, stay on 1.9.4 deliberately, because 2.x is ESM only and its API differs.

### F-14 — Low — Public read side: privacy and abuse

**Problem.**
- `*.ts.net` Funnel URLs reveal the machine and tailnet name and are guessable.
- Live runner positions are public to anyone who has the URL.
- Deferring viewer secrecy is acceptable for a friends-only race, but it should be an explicit decision.

**Suggested fix.**
- Record it as an accepted risk, or decide now on a single unguessable path prefix (`/{viewerToken}/...`). That would change web routing, so it is cheaper to decide now.
- Also:
  - set Fastify `bodyLimit` (for example 256 KB) on ingest
  - add simple per-key rate limiting
  - keep keys at 32 random bytes or more (base64url), so unsalted SHA-256 is fine; state this in the keygen script

### Minor notes (no action strictly required)

- **AD-3:** the batch is single-session, so `ackedThroughSeq` is per `sessionId`. State that the phone sends sessions oldest first and never mixes sessions in one batch. Insert each batch in one SQLite transaction before computing the ack.
- **AD-6:** define `track` points as accepted fixes only (accuracy no worse than 30 m and monotonic `recordedAt`), so web and snapshot agree.
- **Time display:** add an `event.timeZone` to config if ETA should show in race-local time for friends abroad. Otherwise state that it uses the viewer's local time.
- **Status:** a runner whose phone dies stays `active` with a growing age. That is acceptable, but say it is intended.

---

## 3. What is good (keep)

- The source-of-truth discipline (AD-1, AD-2) and replace-only `RunnerView` deltas (AD-6) remove the most common class of live-dashboard bugs.
- The `(sessionId, seq)` + insert-or-ignore + gapless `ackedThroughSeq` design is correct and simple.
- Treating sessions as transport segments (AD-4) neatly absorbs accidental Stop/Start.
- Identity only from the key (AD-5) and a tunnel-agnostic, localhost-only binding (AD-11) are the right security baseline.
- Contract in `shared/` with canonical fixtures shared with Kotlin (AD-9) is the right cross-language mechanism. It just needs the null/omitted rule (F-2).
- Units in field-name suffixes and integer epoch milliseconds remove a whole class of mismatches.
