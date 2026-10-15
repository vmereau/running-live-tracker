---
status: final
stepsCompleted: [1, 2, 3, 4]
inputDocuments:
  - _bmad-output/specs/spec-running-live-tracker/SPEC.md
  - _bmad-output/planning-artifacts/architecture/architecture-running-live-tracker-2026-10-15/ARCHITECTURE-SPINE.md
---

# running-live-tracker - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for running-live-tracker, decomposing the requirements from the SPEC (used in place of a PRD) and the Architecture Spine into implementable stories. No UX design contract exists.

## Requirements Inventory

### Functional Requirements

FR1: A runner can start and stop tracking a run from the Android app. (CAP-1)
FR2: While tracking is on, the app records a GPS position every 5–10 seconds and sends it to the server. (CAP-1)
FR3: The server stores every position of a run between its start and stop, attributed to the right runner. (CAP-1)
FR4: The web UI shows an interactive street map (Leaflet + OpenStreetMap tiles). Each active runner appears as a marker in their configured color at their latest position, updated live without a manual reload. (CAP-2)
FR5: A spectator can pick out a runner on the map / runner list. (CAP-2)
FR6: The web UI shows live stats for each runner: elapsed time, distance covered, current pace and average pace (min/km). (CAP-3)
FR7: A spectator can view all runners or switch between runners, and the stats shown change with the selection. (CAP-3)
FR8: One GPX course, configured on the server, is shared by all runners of the event and, when configured, drawn on the map as a line. (CAP-4)
FR9: For each runner, the web UI shows progress along the course: km done out of total km, km remaining and percent complete. (CAP-4)
FR10: When a course is configured, the web UI shows each runner's estimated finish time, which updates as their pace changes. (CAP-5)
FR11: The server accepts positions only from phones holding a valid secret runner key; the key identifies the runner. Posts without a valid key are rejected and nothing is stored. (CAP-6)
FR12: The app keeps positions recorded while there is no signal and sends them once the connection returns, filling the gap in the track. (CAP-7)
FR13: The web UI shows how long ago each runner last sent an update, ticking live. (CAP-7)
FR14: Each runner's recorded path (track) is drawn on the map in their color, growing live; gaps fill in when buffered positions arrive. (CAP-2, CAP-7)
FR15: When a spectator selects a runner, the map follows that runner, keeping their marker in view as they move. (CAP-2, CAP-3)

### NonFunctional Requirements

NFR1: Android only for the phone client (no iOS).
NFR2: Tracking keeps working for a full marathon (≥ 5 h) with the phone pocketed and the screen locked.
NFR3: Position cadence while tracking is 5–10 s.
NFR4: The server runs on Valentin's home Windows PC, reachable over public HTTPS through a tunnel only; no router port forwarding, no raw public IP.
NFR5: Viewers reach the page through one shared link — no viewer accounts, no login.
NFR6: Runners, runs (events), secret keys and the GPX course are configured on the server only; neither app nor web UI manages them.
NFR7: Displayed stats stay close to what each runner's own watch/app reports (tolerance measured during the test run).
NFR8: The home PC, power and internet must remain available for the whole race (operational readiness).
NFR9: Live only — no history, analytics or replay UI; no social features. Positions remain stored so replay could be added later.
NFR10: The spectator page works on a friend's phone browser (success signal).

### Additional Requirements

From the Architecture Spine:

- **Greenfield scaffold (no starter template):** pnpm workspace (`server`, `web`, `shared`) pinned via `packageManager`, Node 24 native type stripping (erasable syntax only, `.ts` imports, `tsc --noEmit` only), `node:test`, dependency-cruiser enforcing the module dependency graph in CI and pre-commit; `android/` Gradle project with a single `:app` module. Structural seed defines the folder layout. Pinned stack versions per the Stack table.
- **AD-1:** Append-only SQLite (better-sqlite3, WAL) fix log (`sessions`, `records`) is the only source of truth; only `ingest` writes via `store`; derived values never persisted; projections rebuilt at boot by replay.
- **AD-2:** All derived numbers computed only in `server/src/domain` (pure, unit-tested). Web computes only elapsed and staleness age using a server clock offset from `serverNow`; formatting only in web.
- **AD-3:** Outbox protocol: sessions (UUIDv4, `sessionStartedAt`, captured key), per-session `seq` from 0, batches of one session ≤ 200 records oldest-first, single-transaction insert-or-ignore on `(sessionId, seq)`, `IngestAck {ackedThroughSeq}`; 400/409/413 → quarantine, network/5xx/401/429 → capped exponential backoff (max 60 s); validate records before enqueue.
- **AD-4:** Canonical fold `applyRecords` in order `(sessionStartedAt, sessionId, seq)` shared by live and replay; `isAccepted` predicate (fix, accuracy ≤ 30 m, monotonic `recordedAt`); status machine `notStarted → active → stopped → active`; records after `end` ignored; live-equals-replay test.
- **AD-5:** `Authorization: Bearer <runnerKey>`; key = 32 random bytes base64url (43 chars); `keyHash` = hex SHA-256 via single `hashKey()`; constant-time compare; config validates hashes and uniqueness; read endpoints need no auth; only `*.example.json` committed; keygen script.
- **AD-6:** SSE `GET /api/v1/live` (hijacked reply, no compression, `no-cache, no-transform`), named events `snapshot | runner | track`, snapshot-then-replace, projection is single emitter post-commit, 20 s ping, client reconnect = fresh snapshot; `GET /api/v1/snapshot` polling fallback (5 s); course geometry only via `GET /api/v1/course`.
- **AD-7:** GPX loading (relative to `event.json`, concatenate `trkseg`s of first `trk`, fallback first `rte`, refuse < 2 points), forward-only window matching, off-course flag, 6-fix re-acquire, `progressM` never decreases, `distanceM = progressM` with course, null progress fields without course, `/course` → 404 `NO_COURSE`.
- **AD-8:** Average pace, current pace (≥ 60 s and ≥ 200 m trailing window), ETA (`hasCourse ∧ active ∧ distanceM ≥ 1000`), one function each in `domain`.
- **AD-9:** `shared/src/contract.ts` zod schemas are the single wire contract (FixRecord, EndRecord, IngestBatch, IngestAck, ErrorBody, EventInfo strict, TrackPoint, RunnerView, Snapshot, SSE payloads); `shared/fixtures/*.json` mirrored by Kotlin contract tests; API versioned at `/api/v1`.
- **AD-10:** One Android `TrackingService` foreground service (type `location`, then `dataSync` while DRAINING) owns session state, seq allocation + Room outbox insert in one transaction, FusedLocationProvider at 5 s high accuracy, uploader coroutine (10 s flush + on connectivity), `START_STICKY` resuming same session, permissions incl. background location and battery-optimization exemption; no WorkManager.
- **AD-11:** Fastify binds 127.0.0.1 only; public access only via Tailscale Funnel 443; no tunnel-specific code; phone stores `baseUrl` + `runnerKey` in DataStore; release HTTPS-only; debug cleartext to localhost/10.0.2.2 for dev (adb reverse / emulator).
- **AD-12:** `sessions` ownership row inserted on first batch; mismatched runner → 409 `SESSION_OWNER_MISMATCH`; event window `opensAt`/`closesAt` filters sessions in projection; test run and race are separate event configs sharing one DB.
- **AD-13:** Testing: `node:test`; domain golden tests (out-and-back, lap, late start, 2 km gap, no course); projection live-equals-replay + restart test; `server/scripts/simulate-runner` integration/smoke test with offline gaps; Android JVM contract tests + MockWebServer uploader tests; manual ≥ 5 h soak per runner phone.
- **AD-14:** Race-readiness: sleep/hibernate off, Windows Update paused, server + Tailscale autostart with auto-logon, `GET /api/v1/health` → `{ok, serverNow, eventId}`, public-URL simulator dry run the day before, backups via `db.backup()`.
- **Conventions:** error body `{error:{code,message}}` with stable codes; epoch ms UTC; SI units with unit-suffixed field names; `config/event.json` zod-validated at boot, read-only; env vars for port/data dir; pino JSON logs to `data/logs` without keys/bodies, per-batch clock skew logged; single web store mutated only by SSE events.
- **Deferred spike (first):** Prove SSE streams through Tailscale Funnel; fall back to snapshot polling if not.
- **Web stack:** Vite vanilla TS (no framework), Leaflet 1.9.4 with OSM tiles + attribution; built into a folder served by the server at `/`.

### UX Design Requirements

None — no UX design contract exists. Web visual design and Android screens are local choices (Architecture "Deferred"), constrained only by rendering the AD-9 fields and working in a phone browser.

### FR Coverage Map

FR1: Epic 2 - Start/stop tracking from the Android app
FR2: Epic 2 - Record and send a position every 5–10 s while tracking
FR3: Epic 1 - Server stores a run's positions for the right runner (exercised end-to-end from a phone in Epic 2)
FR4: Epic 1 - Live street map with a colored marker per active runner
FR5: Epic 1 - Pick out a runner on the map / runner list
FR6: Epic 3 - Live stats: elapsed, distance, current pace, average pace
FR7: Epic 3 - Switch between all runners and a single runner
FR8: Epic 3 - Shared GPX course drawn on the map
FR9: Epic 3 - Course progress: km done / total, km remaining, percent
FR10: Epic 3 - Estimated finish time
FR11: Epic 1 - Secret runner key authentication and identity
FR12: Epic 2 - Offline buffering and resend
FR13: Epic 1 - Live "last update" age per runner
FR14: Epic 1 - Recorded track drawn per runner, gaps fill in
FR15: Epic 3 - Map follows the selected runner

## Epic List

### Epic 1: Spectators watch runners live on a map
Friends open the shared public link and see every runner as a colored marker on a street map, with each runner's recorded track growing live and how long ago each last reported. Positions arrive through the real authenticated ingest API, fed by `simulate-runner` until the phone app exists. Includes the greenfield scaffold and the early Funnel + SSE spike.
**FRs covered:** FR3, FR4, FR5, FR11, FR13, FR14

### Epic 2: Runners track their run from their Android phone
A runner configures server URL and key, presses Start, pockets the phone and runs; positions keep flowing with the screen locked, are buffered while offline and sent when the connection returns, and finish uploading after Stop.
**FRs covered:** FR1, FR2, FR12 (FR3 end-to-end from a real phone)

### Epic 3: Race stats, course progress and finish estimates
Spectators see elapsed time, distance, current and average pace; switch between all runners and one runner with the map following the selection; and, with a GPX course, see the course line, km done / total, km remaining, percent complete and an estimated finish time.
**FRs covered:** FR6, FR7, FR8, FR9, FR10, FR15

### Epic 4: Race-day readiness
On race morning the home PC stays up and reachable, data is backed up, and the whole system has been proven on a full-length test run with each runner's own phone.
**FRs covered:** none new — verifies NFR2, NFR4, NFR8 and the SPEC success signal end-to-end.

## Epic 1: Spectators watch runners live on a map

Friends open the shared public link and see every runner as a colored marker on a street map, with each runner's recorded track growing live and how long ago each last reported. Positions arrive through the real authenticated ingest API, fed by `simulate-runner` until the phone app exists.

### Story 1.1: Project scaffold, wire contract and health check

As the developer,
I want the monorepo scaffolded with the shared wire contract, config loading and a health endpoint,
So that every later story builds on the agreed structure, stack and contract.

**Acceptance Criteria:**

**Given** a fresh clone
**When** I run `pnpm install` and the documented check command
**Then** `tsc --noEmit`, `node:test` and dependency-cruiser all pass across the `server`, `web` and `shared` workspaces
**And** the folder layout matches the Structural Seed, the stack versions match the Stack table, and pnpm is pinned via `packageManager`
**And** the dependency-cruiser rules encode the module graph from the Invariants section and run in CI and pre-commit

**Given** `shared/src/contract.ts`
**When** it is inspected
**Then** it defines the zod schemas and inferred types for FixRecord, EndRecord, IngestBatch, IngestAck, ErrorBody, EventInfo (`.strict()`), TrackPoint, RunnerView, Snapshot and the SSE `runner` / `track` payloads exactly as in AD-9
**And** `shared/fixtures/*.json` contains valid and invalid samples (optional fields omitted, out-of-range lat/lon, non-positive accuracy) that tests round-trip through the schemas

**Given** a valid `config/event.json` (`eventId, name, opensAt, closesAt, coursePath?, runners[{runnerId, displayName, color, keyHash}]`)
**When** the server starts
**Then** it validates the config with zod and listens on `127.0.0.1` only, on the port from env (with a default)
**And** `GET /api/v1/health` returns `200 {ok: true, serverNow, eventId}`
**And** an invalid config (bad keyHash format, duplicate runnerId or keyHash, bad color) stops the boot with a clear error
**And** only `config/event.example.json` is committed; `config/event.json`, `config/courses/` and `data/` are git-ignored

### Story 1.2: Live stream spike through Tailscale Funnel

As Valentin,
I want proof that a live SSE stream from the home PC reaches a phone browser on mobile data through Tailscale Funnel,
So that the riskiest infrastructure unknown is settled before building on it.

**Acceptance Criteria:**

**Given** the server is running
**When** a client opens `GET /api/v1/live`
**Then** the response uses `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, no compression, and writes to the hijacked raw reply
**And** a named `snapshot` event is sent immediately, containing `serverNow`, the public `EventInfo` and every configured runner as `notStarted` with empty tracks
**And** a `: ping` comment is sent every 20 s
**And** no payload contains `keyHash` (EventInfo is built field by field, never by spreading config)

**Given** `GET /api/v1/snapshot`
**When** called
**Then** it returns the same `Snapshot` shape as the SSE `snapshot` event

**Given** Tailscale Funnel exposes the server on `https://<machine>.<tailnet>.ts.net`
**When** a phone on mobile data keeps `/api/v1/live` open for at least 5 minutes
**Then** the snapshot arrives and pings keep arriving about every 20 s without buffering or disconnects
**And** the outcome (SSE works / needs the polling fallback) and the Funnel setup steps are recorded in a short ops note in the repo

### Story 1.3: Runner keys and authenticated ingest

As a runner,
I want my phone's positions accepted only with my secret key and recorded under my name,
So that nobody else can post positions as me.

**Acceptance Criteria:**

**Given** the `server/scripts/keygen` script
**When** I run it for a runner
**Then** it prints a new key (32 random bytes, base64url, no padding, 43 chars) and its `keyHash` (lowercase hex SHA-256 via the single `hashKey()` in `domain`) to paste into `event.json`

**Given** `POST /api/v1/ingest` with a valid `IngestBatch` and `Authorization: Bearer <validKey>`
**When** the batch is received
**Then** the server creates the SQLite `sessions` / `records` tables if needed (WAL mode), inserts the session-owner row on the session's first batch, and inserts all records in one transaction with insert-or-ignore on `(sessionId, seq)`
**And** it replies `200 {sessionId, ackedThroughSeq, serverNow}` with `ackedThroughSeq` = the batch's last seq
**And** resending the same batch stores no duplicates and returns the same ack
**And** the records are stored under the runner identified by the key, never by any id in the body (FR3, FR11)

**Given** a request with a missing or unknown key
**When** it is received
**Then** the server replies `401 {error: {code: "UNAUTHORIZED"}}` and stores nothing; the key is compared in constant time

**Given** a batch that fails the schema, has more than 200 records, or whose sessionId belongs to another runner
**When** it is received
**Then** the server replies `400 INVALID_BATCH`, `413 BATCH_TOO_LARGE` or `409 SESSION_OWNER_MISMATCH` respectively, with the standard error body, and stores nothing from that batch
**And** `ingest` is the only module that writes, and it never updates or deletes rows (beyond the one-time owner insert)
**And** logs record per-batch clock skew (`receivedAt − max recordedAt`) and never contain raw keys or request bodies

### Story 1.4: Runner simulator

As Valentin,
I want a script that replays a GPX file as one or more runners through the real HTTP API, including offline gaps,
So that I can test the whole live pipeline without going for a run.

**Acceptance Criteria:**

**Given** a pure `parseGpx` function in `server/src/domain`
**When** it parses a GPX string
**Then** it returns the points of all `trkseg`s of the first `trk` concatenated, falling back to the first `rte`, with unit tests
**And** sample GPX files (a straight run, an out-and-back, a lap course) are added to `shared/fixtures/` for this and later golden tests

**Given** `server/scripts/simulate-runner` with a base URL, a GPX file, one or more runner keys, a speed and an optional offline-gap spec
**When** it runs
**Then** each simulated runner creates a session (UUIDv4, `sessionStartedAt`), emits fixes along the GPX every 5 s with increasing `seq`, and uploads them as `IngestBatch`es following AD-3 (one session per batch, ≤ 200 records, oldest first)
**And** during a configured offline gap it keeps recording fixes but holds them, then uploads the backlog when the gap ends
**And** at the end it sends an `end` record
**And** it handles acks and retries 5xx / network errors with capped backoff, as the phone will
**And** it works against both `http://127.0.0.1:<port>` and the public Funnel URL
**And** it imports only `domain` and `shared` code (dependency rule `server/scripts → domain`)

### Story 1.5: Live runner projection and change events

As a spectator,
I want the server to keep each runner's position and track up to date and push changes instantly,
So that the page always reflects the latest data without reloading.

**Acceptance Criteria:**

**Given** stored records for the active event
**When** the projection folds them with `applyRecords` in canonical order `(sessionStartedAt, sessionId, seq)`
**Then** only sessions whose `sessionStartedAt ∈ [opensAt, closesAt]` are included
**And** `isAccepted` (kind fix, `accuracyM ≤ 30`, `recordedAt > lastAppliedAt`) gates `runStartedAt`, `lastFixAt`, `lastPosition` and the track
**And** every stored record of the runner updates `lastReceivedAt` (server receive time), which feeds the last-update age (FR3, FR13)
**And** status follows the AD-4 table (`notStarted → active → stopped → active`), setting and clearing `runEndedAt`; records after a session's `end` are ignored
**And** `RunnerView` fields owned by Epic 3 (distance, pace, progress, ETA) hold their contract defaults (`distanceM` 0, others `null`)

**Given** a batch commits
**When** the projection updates
**Then** it calls `onChange({runnerId, view, appendedPoints})` after the transaction commits, and `live` broadcasts `track` (only if points were appended) then `runner` to all SSE clients, each carrying `serverNow`
**And** nothing is broadcast if the view is unchanged and no points were appended
**And** ingest routes never call `live` directly
**And** the SSE `snapshot` and `GET /api/v1/snapshot` now return the projected views and tracks

**Given** the server restarts
**When** it boots
**Then** it rebuilds identical state by replaying the SQLite log through the same `applyRecords`
**And** a test replaying a DB built from an arbitrary interleaving of batches produces `RunnerView`s deep-equal to the live state, and a restart test against a temp SQLite file passes

### Story 1.6: Live map web page

As a spectator,
I want to open the shared link on my phone and see every runner moving on a street map with their track and last-update age,
So that I can follow my friends' race from anywhere.

**Acceptance Criteria:**

**Given** the web app is built with Vite (vanilla TS) and served by the server at `/`
**When** a spectator opens the link on a phone or desktop browser
**Then** a Leaflet map with OpenStreetMap standard tiles and attribution fills the page and is usable at phone width
**And** the page loads state over SSE into a single store changed only by applying SSE events (`snapshot` replaces all, `runner` replaces one view, `track` appends points)

**Given** active runners with positions
**When** the page is open
**Then** each runner appears as a marker in their configured color at `lastPosition`, moving as `runner` events arrive (FR4)
**And** each runner's track is drawn as a polyline in their color, extended by `track` events; after an offline gap, the backlog points fill the gap in order (FR14)

**Given** the runner list
**When** a spectator taps a runner in the list or their marker
**Then** that runner is highlighted (marker emphasised, name and status shown) so they can be picked out (FR5)
**And** `notStarted` runners are listed without a marker

**Given** each runner's `lastReceivedAt`
**When** time passes
**Then** the page shows "last update N s / min ago", ticking every second using `now = Date.now() + offsetMs`, with `offsetMs` taken from the latest `serverNow` (FR13)

**Given** the SSE connection drops
**When** the browser reconnects
**Then** it discards its state and rebuilds from the fresh snapshot
**And** if Story 1.2 concluded SSE is unusable through Funnel, the page polls `GET /api/v1/snapshot` every 5 s instead

**Given** two runners streaming via `simulate-runner`, one with an offline gap
**When** a phone browser watches through the public Funnel URL
**Then** both markers and tracks move live, the gapped runner's last-update age grows during the gap, and the gap in the track fills in afterwards

## Epic 2: Runners track their run from their Android phone

A runner configures server URL and key, presses Start, pockets the phone and runs; positions keep flowing with the screen locked, are buffered while offline and sent when the connection returns, and finish uploading after Stop.

### Story 2.1: Android app scaffold, settings and wire contract

As a runner,
I want to install the app and enter my server address and secret key once,
So that my phone is set up to send my positions to the right server as me.

**Acceptance Criteria:**

**Given** the `android/` Gradle project
**When** I build it
**Then** it is a single `:app` module using Compose, with AGP, Kotlin, KSP, Compose BOM, Room, DataStore and play-services-location at the versions in the Stack table, and compileSdk / targetSdk / minSdk 37 / 36 / 29
**And** it builds a sideloadable debug and release APK

**Given** the settings screen
**When** I enter a base URL and a runner key
**Then** both are stored in DataStore and survive app restarts
**And** the key is trimmed and rejected with a clear message unless it is 43 base64url characters
**And** release builds accept only `https://` base URLs; debug builds also allow cleartext to `localhost` and `10.0.2.2` via a debug-only network security config (for `adb reverse` and the emulator)
**And** a "Test connection" action calls `GET /api/v1/health` and shows success with the `eventId`, or the error

**Given** hand-written Kotlin classes for FixRecord, EndRecord, IngestBatch, IngestAck and ErrorBody (kotlinx.serialization with `explicitNulls = false`)
**When** JVM contract tests run
**Then** they decode and re-encode every valid sample in `shared/fixtures/*.json` without loss, omit absent optional fields rather than writing `null`, and reject the invalid samples

### Story 2.2: Foreground tracking service recording to the outbox

As a runner,
I want to press Start, lock my phone and put it in my pocket while it keeps recording my position,
So that my whole marathon is captured even with the screen off.

**Acceptance Criteria:**

**Given** a fresh install
**When** I go through setup
**Then** the app requests `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION` ("Allow all the time"), `POST_NOTIFICATIONS` and battery-optimization exemption, explaining each, before tracking can start
**And** the manifest declares `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` and `FOREGROUND_SERVICE_DATA_SYNC`

**Given** settings are valid and permissions granted
**When** I press Start
**Then** a Start command goes to the single `TrackingService`, which creates a session (UUIDv4 `sessionId`, `sessionStartedAt`, the runner key captured at that moment) and enters the foreground with type `location` and a persistent notification
**And** it requests `FusedLocationProviderClient` updates every 5 s at high accuracy (FR1, FR2)
**And** each fix is validated (has accuracy, finite coordinates) and written to the Room outbox, with `seq` allocated and the row inserted in one `@Transaction` on a single-threaded writer, starting at 0 and increasing by 1
**And** changing the runner key is blocked while a session is active

**Given** tracking is active
**When** I press Stop
**Then** the service removes location updates, drains pending callbacks, then writes an `end` record with the next seq

**Given** the OS kills and restarts the service during a session
**When** it restarts (`START_STICKY`)
**Then** it resumes the same session from persisted state, continuing seq without gaps or duplicates

**Given** the main screen
**When** tracking is active
**Then** it shows tracking state, elapsed time since Start and the number of fixes recorded (no race stats; AD-2)

### Story 2.3: Uploading positions with acks, retries and offline buffering

As a runner,
I want my recorded positions sent to the server automatically, and held safely whenever I lose signal,
So that my friends see me live and the gaps fill in when I'm back online.

**Acceptance Criteria:**

**Given** the outbox has records
**When** the uploader coroutine owned by `TrackingService` runs (every 10 s, and immediately when connectivity returns)
**Then** it sends the oldest remaining session first, from its lowest remaining seq, in batches of one session, increasing seq, at most 200 records, with `Authorization: Bearer <that session's captured key>`
**And** on `200 IngestAck` it deletes exactly `WHERE sessionId = ack.sessionId AND seq ≤ ack.ackedThroughSeq`

**Given** the server answers `400`, `409` or `413`
**When** the response arrives
**Then** the batch's rows move to the local `quarantine` table and uploading carries on with the next records

**Given** a network error, `5xx`, `401` or `429`
**When** the response arrives
**Then** the outbox is left untouched and the batch is retried with capped exponential backoff (max 60 s)
**And** recording continues unaffected while uploads fail

**Given** OkHttp MockWebServer tests
**When** they run
**Then** they cover ack-and-delete, 400 quarantine, 401 retry, offline backlog draining in order, and multi-session ordering

**Given** a real phone tracking against the server
**When** airplane mode is on for 2 minutes mid-run and then off
**Then** the web page shows the runner's last-update age growing during the gap, and afterwards the track gap fills in (CAP-7 success)
**And** the run's positions are stored under the right runner (FR3 end-to-end)

### Story 2.4: Finishing uploads after Stop

As a runner,
I want the app to keep uploading my last positions after I press Stop, even if I close it,
So that the final kilometres aren't stranded on my phone.

**Acceptance Criteria:**

**Given** I press Stop with records still in the outbox
**When** the `end` record is written
**Then** the service stays in the foreground in a `DRAINING` state with type `dataSync` and a notification "Uploading N pending" that updates as acks arrive
**And** it calls `stopSelf()` only when the outbox is empty (FR12)

**Given** the app is launched while the outbox is not empty and no session is active
**When** it starts
**Then** it restarts the service in `DRAINING` state to finish the upload

**Given** the main screen
**When** the service is draining or idle
**Then** it shows the number of pending records, the time of the last successful ack and the number of quarantined records

## Epic 3: Race stats, course progress and finish estimates

Spectators see elapsed time, distance, current and average pace; switch between all runners and one runner with the map following the selection; and, with a GPX course, see the course line, km done / total, km remaining, percent complete and an estimated finish time.

### Story 3.1: Distance, pace and elapsed time

As a spectator,
I want to see each runner's elapsed time, distance, current pace and average pace,
So that I know how their race is going, not just where they are.

**Acceptance Criteria:**

**Given** `server/src/domain`
**When** the stats functions are implemented
**Then** haversine segment distance, `distanceM` without a course (sum of segments between consecutive accepted fixes), `avgPaceSPerKm` and `currentPaceSPerKm` each live in exactly one pure function, with thresholds as named constants
**And** `avgPaceSPerKm = elapsedS / (distanceM / 1000)` and is `null` while `distanceM < 100`
**And** `currentPaceSPerKm` uses the trailing accepted fixes covering at least 60 s and at least 200 m, measured on the same basis as `distanceM`; it is `null` until that much exists and `null` while `stopped`

**Given** the projection
**When** accepted fixes are folded
**Then** `RunnerView.distanceM`, `avgPaceSPerKm` and `currentPaceSPerKm` are filled in from the domain functions, live and on replay alike (the live-equals-replay test still passes)
**And** golden tests from `shared/fixtures` GPX samples cover a no-course run, a late Start and a 2 km gap

**Given** the web page
**When** a runner is shown
**Then** it displays elapsed time `h:mm:ss` computed locally as `(runEndedAt ?? now) − runStartedAt` with the server clock offset, ticking every second and frozen once `stopped`
**And** it displays distance in km with 1 decimal and both paces as `m:ss /km`, or "—" when `null` (FR6)
**And** the web never recomputes distance or pace (AD-2)

### Story 3.2: Switching runners and following the selected runner

As a spectator,
I want to switch between an overview of all runners and a single runner the map follows,
So that I can keep my eye on one friend without panning around.

**Acceptance Criteria:**

**Given** the "All runners" view
**When** the page is open
**Then** every runner is listed with their color, name, status, distance, current pace and last-update age
**And** the map fits all runners that have a position

**Given** the overview
**When** I select a runner from the list or by tapping their marker
**Then** the stats panel shows that runner's elapsed time, distance, current and average pace and last-update age, and switching to another runner changes the values shown (FR7)
**And** the map centers on the selected runner and keeps following them as `runner` events move their marker (FR15)
**And** a `notStarted` runner can be selected; the panel says they haven't started and the map does not move

**Given** follow mode is on
**When** I pan or zoom the map by hand
**Then** following pauses and a "Re-center" control appears; pressing it, or selecting the runner again, resumes following

**Given** a selected runner
**When** I choose "All runners"
**Then** following stops and the map fits all runners again
**And** the selection survives an SSE reconnect / fresh snapshot

### Story 3.3: Shared GPX course on the map

As a spectator,
I want to see the race course drawn on the map,
So that I can see where the runners are relative to the route.

**Acceptance Criteria:**

**Given** `event.json` with `coursePath`
**When** the server boots
**Then** `config` resolves the GPX relative to the directory containing `event.json`, parses it with the `domain` `parseGpx` from Story 1.4, and refuses to boot with fewer than 2 points
**And** it builds a course polyline with cumulative haversine distance using `domain` functions, giving `lengthM`
**And** `EventInfo` reports `hasCourse: true` and `lengthM`

**Given** no `coursePath`
**When** the server boots
**Then** `EventInfo` reports `hasCourse: false`, `lengthM: null`, and `GET /api/v1/course` returns `404 {error: {code: "NO_COURSE"}}`

**Given** a configured course
**When** `GET /api/v1/course` is called
**Then** it returns the course as a GeoJSON LineString (`[lon, lat]` coordinates, the only place this order is used); course geometry is never sent over SSE

**Given** the web page and `hasCourse: true`
**When** it loads
**Then** it fetches `/api/v1/course` once and draws the course as a line beneath the runner tracks, visually distinct from them (FR8)
**And** while no runner has a position, the initial map view fits the course

### Story 3.4: Course progress

As a spectator,
I want to see how many km each runner has done out of the total, how many remain and their percent complete,
So that I know how far into the race they are.

**Acceptance Criteria:**

**Given** a configured course and accepted fixes
**When** the projection folds them
**Then** each fix is matched only within the forward window `[progressM − 50 m, progressM + max(1000 m, 8 m/s × seconds since last match)]`
**And** a fix more than 100 m from the windowed segment leaves `progressM` unchanged and sets `offCourse: true`
**And** after 6 consecutive off-course fixes within 100 m of the course ahead of `progressM`, progress jumps to the nearest such forward point
**And** `progressM` never decreases; `distanceM = progressM`; `remainingM = lengthM − progressM`; `progressFraction = progressM / lengthM` (0..1)
**And** without a course, `progressM`, `remainingM` and `progressFraction` are `null`, never 0
**And** all thresholds are named constants in `server/src/domain`

**Given** golden tests from `shared/fixtures` GPX samples
**When** they run
**Then** they cover an out-and-back course, a lap course, a late Start, a 2 km gap and no course, and the live-equals-replay test still passes

**Given** the web page with a course
**When** a runner is shown (overview row and selected-runner panel)
**Then** it displays "X.X / Y.Y km", km remaining and percent complete (FR9)
**And** an "off course" indicator appears while `offCourse` is true
**And** without a course these figures are hidden rather than shown as 0

### Story 3.5: Estimated finish time

As a spectator,
I want to see when each runner is expected to finish,
So that I can plan to be at the finish line or cheer at the right moment.

**Acceptance Criteria:**

**Given** the domain ETA function
**When** it is computed
**Then** `etaAt = lastFixAt + remainingM × avgPaceSPerKm / 1000`, defined in exactly one function
**And** it is non-null only when `hasCourse`, status is `active` and `distanceM ≥ 1000`; otherwise `null`
**And** unit tests cover each null condition and a pace change moving the ETA

**Given** the web page
**When** a runner has an `etaAt`
**Then** it shows the estimated finish as local clock time (e.g. "Finish ≈ 12:41") plus the projected finishing time from `runStartedAt` (`h:mm:ss`) (FR10)
**And** the value updates as `runner` events arrive with new pace data
**And** it is hidden when `etaAt` is `null`; a `stopped` runner shows their final elapsed time instead

## Epic 4: Race-day readiness

On race morning the home PC stays up and reachable, data is backed up, and the whole system has been proven on a full-length test run with each runner's own phone.

### Story 4.1: Backups and separate test-run / race events

As Valentin,
I want safe backups of the fix log and separate event configs for the test run and the race,
So that no data is lost and test-run positions never show up in the race.

**Acceptance Criteria:**

**Given** `server/scripts/backup`
**When** I run it while the server is live
**Then** it writes a timestamped copy to `data/backups/` using better-sqlite3 `db.backup()`, never a file copy of the WAL database
**And** booting the server against a backup copy produces the same snapshot as the live server had at backup time (verified by a test)

**Given** a test-run event config and a race event config, each with its own `eventId`, `opensAt` / `closesAt` and runners, sharing one DB
**When** I switch configs and restart the server
**Then** only sessions inside the active event's window appear; test-run sessions are stored but never shown in the race (AD-12)
**And** `config/event.example.json` and a short ops note document how to create both configs, generate keys and switch between them

### Story 4.2: Always-on home PC

As Valentin,
I want the home PC to bring the server and tunnel back up on its own and never sleep or update on race day,
So that tracking stays available for the whole race without me touching it.

**Acceptance Criteria:**

**Given** the home PC
**When** it is configured per the race-readiness runbook
**Then** Windows sleep and hibernate are disabled, Windows Update is paused for race week, auto-logon is enabled, and the server and Tailscale start automatically at logon
**And** the server writes JSON logs to `data/logs`

**Given** the PC is rebooted
**When** it comes back
**Then** without any manual step, `GET /api/v1/health` on the public Funnel URL returns `200 {ok, serverNow, eventId}` with the expected `eventId`

**Given** a `race-check` script
**When** I run it
**Then** it reports pass/fail for the public health check, the active `eventId` and window, the configured runners, course loaded or not, and the power settings it can query
**And** the runbook lists the remaining manual checks (Windows Update paused, auto-logon) as a checklist

### Story 4.3: Public dry run and phone soak test

As Valentin,
I want the full pipeline proven through the public URL and each runner's phone proven over a marathon-length session,
So that I trust it will hold for the whole race.

**Acceptance Criteria:**

**Given** the race configuration on the home PC
**When** `simulate-runner` replays the race GPX as all runners through the public Funnel URL, with an offline gap, while a phone browser on mobile data watches
**Then** markers, tracks, stats, progress and finish estimates update live, and the gap fills in afterwards
**And** the result is recorded in the ops note; the dry run is repeated the day before the race

**Given** each runner's own phone
**When** it tracks for at least 5 hours pocketed with the screen locked (a test-run event)
**Then** the server holds a continuous track for the whole session, with gaps only where there was no signal, and the outbox is empty after Stop
**And** battery use over the session is noted, along with any vendor-specific battery settings needed on that phone

### Story 4.4: Two-runner test run and tuning

As Valentin,
I want a real test run with two runners and a friend watching,
So that the product is proven against the SPEC success signal before the marathon.

**Acceptance Criteria:**

**Given** two runners stream at the same time during a test-run event with the course configured
**When** a friend opens the shared link on their phone
**Then** from start to finish they can switch between runners and see live position, pace and stats, and for each runner km done out of total km and an estimated finish time (SPEC success signal)

**Given** each runner's watch or running app data for the same run
**When** distance, pace and finish time are compared with the page
**Then** the differences are recorded as the accepted tolerance (NFR7)
**And** any tuning of the AD-7 / AD-8 constants (matching window, off-course distance, pace window, ETA basis) happens only in `server/src/domain`, with golden tests updated and still passing
