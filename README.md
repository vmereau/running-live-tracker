# running-live-tracker

Live tracking of marathon runners: an Android app posts GPS fixes to a home-hosted
Node server, and friends watch every runner on a shared live map.

This repo is a pnpm workspace:

| Package | Path | What it is |
| --- | --- | --- |
| `@running-live-tracker/server` | `server/` | Fastify server, run directly by Node (native type stripping) |
| `@running-live-tracker/web` | `web/` | Vite app (vanilla TS), served by the server at `/` from `web/dist/`: the live map at `/`, and the Story 1.2 live-stream diagnostic page at `/diagnostic.html` |
| `@running-live-tracker/shared` | `shared/` | Wire contract (`src/contract.ts`, zod) and JSON fixtures |

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

## Commands

| Command | What it does |
| --- | --- |
| `pnpm check` | Type-check, tests (`node:test`) and dependency-cruiser module-graph rules, for every workspace. Run by the pre-commit hook and CI. |
| `pnpm typecheck` | `tsc` in each workspace |
| `pnpm test` | `node --test` in each workspace |
| `pnpm depcruise` | Enforce the architecture's module graph (`.dependency-cruiser.cjs`) |
| `pnpm dev` | Start the server on `127.0.0.1` |
| `pnpm keygen <runnerId>` | Make a new runner key: prints the key (for the runner's phone only), its `keyHash` and a runner entry to paste into `config/event.json` |
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
| `GET /api/v1/live` | Server-Sent Events: an `event: snapshot` frame on connect, then `track` (appended points) and `runner` (replaced view) frames on every change, and a `: ping` comment every 20 s |
| `POST /api/v1/ingest` | Runner positions (auth: `Authorization: Bearer <runnerKey>`). Body: one `IngestBatch` (one session, strictly increasing `seq`, at most 200 records). Reply: `IngestAck` `{"sessionId","ackedThroughSeq","serverNow"}`. Resending a batch is safe: already stored `seq`s are ignored. |
| `GET /` | The live map (Leaflet, OpenStreetMap tiles): one colored marker and track per runner, a runner list with ticking "last update" ages; tap a runner to highlight it. `GET /diagnostic.html` is the live-stream diagnostic page. Both come from `web/dist/` (run `pnpm --filter web build` first; skipped with a warning if missing) |

```sh
curl http://127.0.0.1:8787/api/v1/health
curl -N http://127.0.0.1:8787/api/v1/live
```

Until Story 1.5 every runner is `notStarted` with an empty track (positions are stored, not yet shown).

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

Until the Android app exists, `pnpm simulate` feeds realistic positions through
`POST /api/v1/ingest`, behaving the way the phone will: each `--key` becomes one runner
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

## Public access

Spectators reach the server only through Tailscale Funnel. Setup, commands and the
Story 1.2 live-stream test: [docs/ops/tailscale-funnel.md](docs/ops/tailscale-funnel.md).

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port. The server always binds `127.0.0.1` only. |
| `DATA_DIR` | `<repo>/data` | Data folder (git-ignored), created at boot if missing. Holds `tracker.db`, the append-only SQLite fix log (WAL mode, so `tracker.db-wal`/`-shm` sit next to it while the server runs; never copy these files while it is running). Log files arrive in Story 4.2 (logs go to stdout for now). |
| `EVENT_CONFIG` | `<repo>/config/event.json` | Event config, validated at boot; the server refuses to start if it is invalid |

Example: `EVENT_CONFIG=config/event.example.json pnpm dev`.
