# running-live-tracker

Live tracking of marathon runners: an Android app posts GPS fixes to a home-hosted
Node server, and friends watch every runner on a shared live map.

This repo is a pnpm workspace:

| Package | Path | What it is |
| --- | --- | --- |
| `@running-live-tracker/server` | `server/` | Fastify server, run directly by Node (native type stripping) |
| `@running-live-tracker/web` | `web/` | Vite app (vanilla TS), served by the server at `/` from `web/dist/` (for now a live-stream diagnostic page; the map arrives in Story 1.6) |
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
| `pnpm --filter web build` | Build the web app into `web/dist/` |

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
| `GET /api/v1/live` | Server-Sent Events: an `event: snapshot` frame on connect, then a `: ping` comment every 20 s |
| `POST /api/v1/ingest` | Runner positions (auth: `Authorization: Bearer <runnerKey>`). Body: one `IngestBatch` (one session, strictly increasing `seq`, at most 200 records). Reply: `IngestAck` `{"sessionId","ackedThroughSeq","serverNow"}`. Resending a batch is safe: already stored `seq`s are ignored. |
| `GET /` | The built web app from `web/dist/` (run `pnpm --filter web build` first; skipped with a warning if missing) |

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
