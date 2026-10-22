# running-live-tracker

Live tracking of marathon runners: an Android app posts GPS fixes to a home-hosted
Node server, and friends watch every runner on a shared live map.

This repo is a pnpm workspace:

| Package | Path | What it is |
| --- | --- | --- |
| `@running-live-tracker/server` | `server/` | Fastify server, run directly by Node (native type stripping) |
| `@running-live-tracker/web` | `web/` | Vite app (vanilla TS), served by the server at `/` from `web/dist/`: the live map at `/`, and the Story 1.2 live-stream diagnostic page at `/diagnostic.html` |
| `@running-live-tracker/shared` | `shared/` | Wire contract (`src/contract.ts`, zod) and JSON fixtures |

The Android app lives in `android/` (Gradle, not part of the pnpm workspace): see [Android app](#android-app).

## Prerequisites

- Node.js **24.22.0** (see `.node-version`). With nvm: `nvm install 24.22.0 && nvm use 24.22.0`.
- pnpm **12.11.2**, pinned through `packageManager`: run `corepack enable` once.

TypeScript is only type-checked (`tsc --noEmit`, TS 7). Nothing is compiled for runtime:
use erasable syntax only (no enums, namespaces, parameter properties or decorators),
relative imports with `.ts` extensions, and `import type` for types.

## Setup

```sh
pnpm install
```

`pnpm install` also sets `git config core.hooksPath .githooks`, so every commit runs `pnpm check`.

Create your event config from the example (the real one is git-ignored because it holds key hashes):

```sh
cp config/event.example.json config/event.json
```

Every `config/*.json` except `*.example.json` is git-ignored. For separate test-run and race
configs sharing one database, switching between them, backups and restore, see
[docs/ops/events-and-backups.md](docs/ops/events-and-backups.md).

### Course (optional)

To show the event's course on the map, add `"coursePath"` to `config/event.json`:

```json
"coursePath": "courses/race.gpx"
```

A relative path is resolved from the folder that holds `event.json` (so the example
above is `config/courses/race.gpx`); an absolute path is used as is. The GPX is read
once at boot: the points of every segment of its first track, or of its first route
when the track has none. The server refuses to start (exit code 1, with the GPX path and
the reason) when the file cannot be read, a point has a missing or invalid `lat`/`lon`,
there are fewer than 2 points, or the course has zero length (all points identical).
Without `coursePath` the event has no course: `hasCourse` is `false` and
`GET /api/v1/course` returns 404.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm check` | Type-check, tests (`node:test`) and dependency-cruiser module-graph rules, for every workspace. Run by the pre-commit hook and CI. |
| `pnpm typecheck` | `tsc` in each workspace |
| `pnpm test` | `node --test` in each workspace |
| `pnpm depcruise` | Enforce the architecture's module graph (`.dependency-cruiser.cjs`) |
| `pnpm dev` | Start the server on `127.0.0.1` |
| `pnpm keygen <runnerId>` | Make a new runner key: prints the key (for the runner's phone only), its `keyHash` and a runner entry to paste into `config/event.json` |
| `pnpm backup` | Write a consistent copy of `<DATA_DIR>/tracker.db` (SQLite online backup, safe while the server runs) to `<DATA_DIR>/backups/tracker-<UTC time>.db` and print its path (see [docs/ops/events-and-backups.md](docs/ops/events-and-backups.md)) |
| `pnpm race-check --base-url <url> [--config <file>]` | Race-readiness check of the home PC: public health, live `eventId` = config `eventId`, event window, runners, course, Windows sleep/hibernate on AC. One `PASS`/`FAIL`/`SKIP` line per check, exit 1 on any `FAIL` (see [docs/ops/race-readiness.md](docs/ops/race-readiness.md)) |
| `pnpm session-report [--config <file>] [--session <id>] [--gap 30s]` | Read-only report of the stored sessions of an event (sessions started in its window, or one session): fixes, duration, km, `end` received, missing seqs, gaps between fixes over `--gap`, upload delay. `COMPLETE`/`INCOMPLETE` per session, exit 1 unless all are `COMPLETE` (see [docs/ops/race-readiness.md](docs/ops/race-readiness.md#pnpm-session-report)) |
| `pnpm run-log --base-url <url> [--interval 15s] [--out <file>]` | During a test run, poll `GET /api/v1/snapshot` and append each runner's distance, pace, progress and ETA to `<DATA_DIR>/run-logs/<eventId>-<UTC start>.csv`; once every runner that started is stopped (or on Ctrl-C), print finish, elapsed, km, average pace and the ETA error at each 5 km checkpoint (see [docs/ops/race-readiness.md](docs/ops/race-readiness.md#two-runner-test-run)) |
| `pnpm simulate --base-url <url> --gpx <file> --key <k> …` | Replay a GPX file as one or more simulated runners through the real ingest API (see [Simulating runners](#simulating-runners)) |
| `pnpm --filter web build` | Build the web app (`index.html` map + `diagnostic.html`) into `web/dist/` |
| `pnpm --filter web dev` | Vite dev server for the web app; `/api` is proxied to `http://127.0.0.1:8787` |

## Runner keys

Each runner posts with their own secret key. Generate one per runner:

```sh
pnpm keygen alice
```

It prints a 43-char base64url key and its `keyHash` (lowercase hex SHA-256). Put the
printed runner entry (with its `keyHash`) in `config/event.json` and restart the server;
give the key itself to the runner's phone only. The server never stores raw keys and
never logs them. To revoke a key, generate a new one and replace the `keyHash`.

## HTTP API

All read endpoints are public (no auth). The server binds `127.0.0.1` only.

| Endpoint | What it returns |
| --- | --- |
| `GET /api/v1/health` | `{"ok":true,"serverNow":...,"eventId":"..."}` |
| `GET /api/v1/snapshot` | The current `Snapshot` (event info, one view and one track per runner). Polling fallback. |
| `GET /api/v1/course` | The event's course as a GeoJSON `LineString` (`{"type":"LineString","coordinates":[[lon,lat],...]}`, note the `[lon, lat]` order), or `404 NO_COURSE` when none is configured. Never sent over SSE. |
| `GET /api/v1/live` | Server-Sent Events: an `event: snapshot` frame on connect, then `track` (appended points) and `runner` (replaced view) frames on every change, and a `: ping` comment every 20 s |
| `POST /api/v1/ingest` | Runner positions (auth: `Authorization: Bearer <runnerKey>`). Body: one `IngestBatch` (one session, strictly increasing `seq`, at most 200 records). Reply: `IngestAck` `{"sessionId","ackedThroughSeq","serverNow"}`. Resending a batch is safe: already stored `seq`s are ignored. |
| `GET /` | The live map (Leaflet, OpenStreetMap tiles): one colored marker and track per runner, a runner list with ticking "last update" ages; tap a runner to highlight it. `GET /diagnostic.html` is the live-stream diagnostic page. Both come from `web/dist/` (run `pnpm --filter web build` first; skipped with a warning if missing) |

```sh
curl http://127.0.0.1:8787/api/v1/health
curl -N http://127.0.0.1:8787/api/v1/live
```

Posting a batch:

```sh
curl -X POST -H "Authorization: Bearer <runnerKey>" -H "content-type: application/json" --data @shared/fixtures/valid/ingest-batch.mixed.json http://127.0.0.1:8787/api/v1/ingest
```

Ingest errors (`{"error":{"code","message"}}`); a rejected batch stores nothing:

| Status | Code | When |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | Missing, malformed or unknown key (checked before the body is read) |
| 400 | `INVALID_BATCH` | Body is not JSON (malformed, empty, or a non-JSON content type), not an object, or fails the `IngestBatch` schema |
| 413 | `BATCH_TOO_LARGE` | More than 200 records (or a body over 1 MiB) |
| 409 | `SESSION_OWNER_MISMATCH` | The `sessionId` already belongs to another runner |

The runner is always the key's owner; a `runnerId` in the body is ignored.

## Simulating runners

To test without a phone, `pnpm simulate` feeds realistic positions through
`POST /api/v1/ingest`, behaving the way the phone does: each `--key` becomes one runner
with its own session, records a fix every 5 s (of simulated run time) into an in-memory
outbox while walking the GPX at a constant pace, and uploads the outbox oldest first in
batches of at most 200 records, deleting what the server acks. Network errors, 5xx, 401
and 429 are retried with backoff (1 s, 2 s, 4 s … capped at 60 s); a 400/409/413 batch is
dropped and logged. Each runner finishes with an `end` record. The exit code is 0 when
every record was acked, 1 otherwise. The simulator never prints a key, but `pnpm`
echoes the command line (keys included) before running a script: use `pnpm -s simulate …`
when the output is shared or saved.

```sh
# one runner, real time, on the local server
pnpm simulate --base-url http://127.0.0.1:8787 --gpx shared/fixtures/gpx/out-and-back.gpx --key <key>

# two runners (5:00 and 5:30 /km) 30 s apart, 20x faster than real time,
# everyone offline from 2 min to 3 min, runner 1 also offline from 6 min for 90 s
pnpm simulate --base-url http://127.0.0.1:8787 --gpx shared/fixtures/gpx/lap.gpx --key <alice-key> --key <bob-key> --pace 5:00,5:30 --time-scale 20 --stagger 30s --gap 2m+1m --gap 1:6m+90s

# through the public Funnel URL: same code, just an https base URL
pnpm simulate --base-url https://<machine>.<tailnet>.ts.net --gpx shared/fixtures/gpx/straight.gpx --key <key>
```

| Option | Meaning |
| --- | --- |
| `--base-url` | Server base URL; posts go to `<base>/api/v1/ingest` |
| `--gpx` | GPX file: the points of every segment of its first track, or of its first route |
| `--key` | Runner key (from `pnpm keygen`); repeat for more runners |
| `--pace` | min/km, default `5:00`; a comma list gives one pace per runner in key order, a shorter list repeats its last value |
| `--time-scale` | Simulated seconds per wall-clock second, default `1`. `recordedAt` always follows simulated run time, so the pace looks realistic |
| `--stagger` | Runner *i* (0-based) starts *i* × stagger of simulated time later, default `0` |
| `--gap` | `[i:]<at>+<duration>`: offline from `<at>` for `<duration>` of the runner's simulated run time. Fixes keep being recorded; the backlog is uploaded when the gap ends (or at the finish). Without `i:` it applies to every runner. Repeatable |

Durations take an `s`, `m` or `h` suffix (a bare number is seconds). Sample tracks are in
`shared/fixtures/gpx/` (`straight.gpx`, `out-and-back.gpx`, `lap.gpx`).

## Android app

`android/` is a Gradle project with a single `:app` module (Kotlin, Compose, package
`com.runninglivetracker`). It is sideloaded, never published. Pins live in
`android/gradle/libs.versions.toml`: AGP 9.4.1 with built-in Kotlin (KGP and the compose
plugin 2.4.21, no `kotlin-android`, no kapt), KSP 2.3.12, Compose BOM 2026.09.00, Room 2.8.5,
DataStore Preferences 1.2.1, compileSdk / targetSdk / minSdk 37 / 36 / 29, Gradle 9.6.1 through
the wrapper, JDK 17 toolchain.

The app has three screens: the main screen (tracking state, elapsed time since Start, count of
recorded fixes, pending records, time of the last ack, quarantined records, Start / Stop), a Permissions setup screen and Settings. Settings hold the server
URL and the runner key (from `pnpm keygen`), saved in DataStore, plus a "Test connection" button
that calls `GET /api/v1/health`. Rules:

- The key is trimmed and must be 43 base64url characters.
- The URL must be `https://<host>` (a port and a path prefix are allowed). Debug builds also accept `http://localhost`
  (physical phone through `adb reverse tcp:8787 tcp:8787`) and `http://10.0.2.2` (emulator).
  A trailing `/` is dropped; a query or fragment is rejected. Release builds pin cleartext
  off in the network security config; `app/src/debug/res/xml/` overrides it for those two hosts.

- The key field is locked while a session is active (the session keeps the key captured at Start).

Tracking: Start sends a command to the foreground `TrackingService` (type `location`, persistent
notification, GPS every 5 s at high accuracy). It is the only writer of the Room database
(`tracking.db`, schema JSON committed under `app/schemas/`): a `sessions` row (UUIDv4
`sessionId`, `sessionStartedAt`, captured key, next seq, fix count) and an `outbox` of wire
records keyed by `(sessionId, seq)`. Fixes without accuracy or with out-of-range values are
dropped before the insert. Stop (behind a confirmation dialog; the notification has no Stop
action) removes location updates, writes the queued fixes, then an `end` record with the next
seq. The service is `START_STICKY` and resumes the same session after the OS kills it; opening
the app with an active session also resumes it.

Uploading: while the service runs, an uploader coroutine drains the outbox to
`POST /api/v1/ingest`, every 10 s and at once when a network becomes available
(`ConnectivityManager` default-network callback). It always sends the oldest session first, from
its lowest remaining seq, at most 200 records of one session per batch, with
`Authorization: Bearer <the key captured at that session's Start>`; the server URL is re-read from
the settings at each flush. On `200` it deletes `seq <= ackedThroughSeq` for that session and
records the ack time. `400` / `409` / `413` are final: the batch moves to a local `quarantine`
table and the flush continues. Network errors, `5xx`, `401`, `429`, any other status, a `200` that
is not a valid ack for the batch, or an invalid server URL keep the rows and retry after 1 s, 2 s,
4 s … up to 60 s (a success or a reconnect resets it). Recording never waits on the network:
fixes keep getting their seq while offline and are sent in order once the network returns. The
database is at schema v2 (`lastAckedAt` + `quarantine`), auto-migrated from v1 with no data loss.

Finishing uploads after Stop: if the outbox still has rows once `end` is written, the service stays
in the foreground (type `dataSync`) with the notification "Uploading N pending", N counting down
as acks arrive, and stops itself (removing the notification) when the outbox is empty. The same
uploader policy applies (oldest session first, same retries and quarantine), with an immediate
flush when draining starts; a session stuck on a retry (e.g. `401`) keeps it draining. The main
screen headline reads "Uploading" while records are pending and no session is active. Draining is
not stored: it is derived from Room ("no active session and a non-empty outbox"), so a sticky
restart drains too, and opening the app in that state sends a Drain command (no location
permission needed). A Start while draining goes back to tracking (type `location`); the old
session's rows are still sent first. On Android 15+ `dataSync` is capped at 6 h per 24 h: on that
timeout the service stops and keeps the rows; draining resumes on a later app launch, once Android
allows `dataSync` again (until the quota frees up, going foreground fails and the service just stops).

Start stays disabled until the settings are valid and the Permissions screen shows every item
granted:

- Precise location (fine + coarse).
- Location "Allow all the time" (background), requested after precise location; Android
  opens its settings page for it.
- Notifications (Android 13+).
- No battery optimization (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`).

If a permission was denied, its button opens the app's system settings instead. The list is
re-checked every time the app comes back to the foreground.

The wire contract is hand-written in `app/src/main/java/com/runninglivetracker/contract/Contract.kt`
and checked by JVM tests against `shared/fixtures` (valid fixtures round-trip, invalid ones are
rejected).

Setup (once):

- JDK 17 (`JAVA_HOME`).
- An Android SDK with `platforms;android-37.0`, `build-tools;37.0.0` and `platform-tools`.
  Point `android/local.properties` (git-ignored) at it, for example `sdk.dir=D\:/Android/Sdk`,
  or set `ANDROID_HOME`.
- Optional: set `GRADLE_USER_HOME` to put the Gradle cache (a few GB) on another disk.

```sh
cd android
./gradlew test assembleDebug assembleRelease   # JVM tests + app/build/outputs/apk/{debug,release}/
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Release signing: create a git-ignored `android/keystore.properties` with `storeFile` (path
relative to `android/`), `storePassword`, `keyAlias` and `keyPassword`. Without it the
release APK is signed with the debug key, so it is always installable.

Try it on the emulator: run `pnpm dev`, install the debug APK, enter `http://10.0.2.2:8787`
and press Test connection: it shows `Connected — event <eventId>`.

Manual tracking check on a real phone (debug APK, so `run-as` works):

1. Grant everything on the Permissions screen, press Start: the "Tracking your run"
   notification appears.
2. Lock the phone for 5 minutes, unlock: the fix count is about 60 and the elapsed time is right.
3. Lock again and kill the process with `adb shell am kill com.runninglivetracker` (or let the
   OS do it): tracking resumes on its own and the fix count keeps growing.
4. Press Stop and confirm, then inspect the outbox:

```sh
adb shell "run-as com.runninglivetracker sqlite3 databases/tracking.db 'SELECT sessionId, seq, kind FROM outbox ORDER BY sessionId, seq'"
```

The seq values are contiguous from 0 for each session and the last row is `end`. If the phone
has no `sqlite3`, copy the database out (`adb exec-out run-as com.runninglivetracker cat
databases/tracking.db > tracking.db`, plus the `-wal` file) and open it locally.

Manual offline check (airplane mode) on a real phone against the server, with the live map open
in a browser:

1. Press Start and wait until Pending stays near 0 and Last ack updates every ~10 s.
2. Turn airplane mode on for 2 minutes (GPS keeps working): Pending grows by about 12 a minute,
   Last ack stops, and on the web page the runner's last-update age keeps growing.
3. Turn airplane mode off: within seconds Pending drops back to 0, Last ack jumps to now, and the
   gap in the track fills in on the map. Quarantined stays 0.
4. On the server, the positions are stored under the right runner.

Manual check of finishing uploads after Stop (real phone, live map open):

1. Press Start, turn airplane mode on, record about 1 minute, then press Stop and confirm.
2. The notification shows "Uploading N pending" and the main screen headline reads "Uploading".
3. Swipe the app away from recents, then turn airplane mode off.
4. N drops to 0, the notification disappears, and on the web page the track fills in to the end.

## Public access

Spectators reach the server only through Tailscale Funnel. Setup, commands and the
Story 1.2 live-stream test: [docs/ops/tailscale-funnel.md](docs/ops/tailscale-funnel.md).
Keeping the home PC up for the race (server restarted at logon and after a crash, power
settings, `pnpm race-check`, the race-week checklist): [docs/ops/race-readiness.md](docs/ops/race-readiness.md).

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port. The server always binds `127.0.0.1` only. |
| `DATA_DIR` | `<repo>/data` | Data folder (git-ignored), created at boot if missing. Holds `tracker.db`, the append-only SQLite fix log (WAL mode, so `tracker.db-wal`/`-shm` sit next to it while the server runs; never copy these files while it is running). `backups/` holds the `pnpm backup` copies. `logs/` holds the server's JSON logs: every line goes to stdout and is appended to `logs/server-<UTC date of boot>.log` (no raw keys, no request bodies); under the Windows supervisor also `stdout.log`, `stderr-*.log` and `supervisor.log` (see [docs/ops/race-readiness.md](docs/ops/race-readiness.md)). |
| `EVENT_CONFIG` | `<repo>/config/event.json` | Event config, validated at boot; the server refuses to start if it is invalid |

Example: `EVENT_CONFIG=config/event.example.json pnpm dev`.
