# Epic 1 Context: Spectators watch runners live on a map

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Friends open one shared public link and see every runner as a colored marker on a street map, with each runner's recorded track growing live and a ticking "last update" age. Positions arrive through the real authenticated ingest API, fed by a GPX-replaying simulator until the Android app exists (Epic 2). The epic also lays the greenfield monorepo scaffold and settles the riskiest infrastructure unknown first: whether a live SSE stream survives Tailscale Funnel to a phone on mobile data.

## Stories

- Story 1.1: Project scaffold, wire contract and health check
- Story 1.2: Live stream spike through Tailscale Funnel
- Story 1.3: Runner keys and authenticated ingest
- Story 1.4: Runner simulator
- Story 1.5: Live runner projection and change events
- Story 1.6: Live map web page

## Requirements & Constraints

- The server stores every position of a run, attributed to the runner identified by their secret key — never by an id in the request body. Posts without a valid key are rejected and nothing is stored.
- The web page shows a Leaflet street map (OpenStreetMap standard tiles with attribution) with one marker per active runner in their configured color, their track as a growing polyline, and a live "last update N ago" age. No manual reload; works in a phone browser.
- Spectators can pick out a runner (tap list entry or marker).
- After an offline gap, buffered positions fill the gap in the track in order.
- Viewers use one shared link: no accounts, no login. Read endpoints need no auth.
- Runners, keys, event window and course are configured on the server only (`config/event.json`, read-only at runtime, restart to change).
- Server runs on a Windows home PC, bound to `127.0.0.1` only; public access only via Tailscale Funnel on 443. No tunnel-specific code. Cloudflare Quick Tunnels, port forwarding and raw public IPs are forbidden.
- Live only: no history/replay UI, but all positions stay stored.

## Technical Decisions

- **Monorepo:** pnpm workspace (`server`, `web`, `shared`) with pnpm pinned via `packageManager`; `injectWorkspacePackages` off. `android/` is a separate Gradle project (Epic 2).
- **TS runtime:** Node 24 native type stripping — erasable syntax only (no enums, parameter properties, namespaces), relative imports with `.ts` extensions, `import type` for types, no `paths` aliases. `tsc --noEmit` is the only type checker. Tests use `node:test`.
- **Pinned stack:** Node 24.22.0, TypeScript 7.0.2, @types/node 24.19.2, pnpm 12.11.2, Fastify 5.12.7, @fastify/static 10.1.6, better-sqlite3 13.0.3 (+ @types 9.6.0), zod 4.6.7, dependency-cruiser 18.6.0, Vite 8.3.4 (vanilla TS, no framework), Leaflet 1.9.4.
- **Module graph (enforced by dependency-cruiser in CI and pre-commit):** `http → ingest | live | projection | config`; `ingest → store | projection | config`; `live → projection`; `projection → domain | config | store`; `config → domain`; `server/scripts → domain`; `domain → shared`; `web → shared`. Every server module and web may import `shared`. `server/src/main.ts` is the sole composition root. Anything else is forbidden.
- **Layout:** `server/src/{config,store,ingest,domain,projection,live,http}/`, `server/src/main.ts`, `server/scripts/` (keygen, simulate-runner, backup), `web/src/`, `shared/src/contract.ts`, `shared/fixtures/`, `config/` (only `event.example.json` committed; `event.json` and `courses/` ignored), `data/` (SQLite, backups, logs — ignored).
- **Source of truth:** append-only SQLite fix log (WAL; tables `sessions`, `records`). Only `ingest` writes, via `store`, insert-only (plus the one-time session-owner row). Derived values are never persisted; the in-memory projection is rebuilt at boot by replaying the log.
- **Wire contract:** `shared/src/contract.ts` zod schemas + inferred types are the only definition of FixRecord, EndRecord, IngestBatch, IngestAck, ErrorBody, EventInfo (`.strict()`, never built by spreading config), TrackPoint (objects, never tuples), RunnerView, Snapshot, and SSE `runner`/`track` payloads. Optional ingest fields are omitted, never `null`. `shared/fixtures/*.json` hold valid/invalid samples (also used by Android contract tests later). A contract change updates schema, fixtures and Kotlin classes together. API versioned at `/api/v1`.
- **Auth:** `Authorization: Bearer <runnerKey>`; key = 32 random bytes base64url no padding (43 chars); `keyHash` = lowercase hex SHA-256 via one `hashKey()` in `domain`; constant-time compare; config enforces `/^[0-9a-f]{64}$/` and unique `runnerId`/`keyHash`.
- **Ingest protocol:** batches of exactly one session, increasing seq, ≤ 200 records; one transaction, insert-or-ignore on `(sessionId, seq)`; ack `{sessionId, ackedThroughSeq, serverNow}`. Errors: 401 `UNAUTHORIZED`, 400 `INVALID_BATCH`, 413 `BATCH_TOO_LARGE`, 409 `SESSION_OWNER_MISMATCH`.
- **Projection:** one `applyRecords` fold in canonical order `(sessionStartedAt, sessionId, seq)` shared by live and replay; `isAccepted` = fix ∧ `accuracyM ≤ 30` ∧ `recordedAt > lastAppliedAt`; status `notStarted → active → stopped → active`; event window `[opensAt, closesAt]` filters sessions; every stored record updates `lastReceivedAt`.
- **Live delivery:** SSE `GET /api/v1/live` on a hijacked reply, `text/event-stream`, `no-cache, no-transform`, no compression; named events `snapshot | runner | track`; `runner` replaces, `track` appends; projection is the single emitter post-commit (ingest never calls `live`); `: ping` every 20 s; reconnect = discard state + fresh snapshot (no Last-Event-ID). Fallback: poll `GET /api/v1/snapshot` every 5 s.
- **Web:** single store mutated only by SSE events; computes only elapsed and staleness locally with `now = Date.now() + offsetMs`, `offsetMs` from `serverNow` on every payload; formatting only in web. Vite builds web into a folder served by the server at `/`.
- **Conventions:** error body `{error:{code,message}}` with SCREAMING_SNAKE codes; epoch ms UTC; SI units with unit-suffixed fields (`distanceM`, `accuracyM`); TS camelCase fields, PascalCase types, kebab-case files; "track" = recorded points, never the course. Port and data dir from env vars with defaults. pino JSON logs to `data/logs`, never raw keys or bodies; per-batch clock skew logged.

## Cross-Story Dependencies

- 1.1 provides the scaffold, contract, config loading and health endpoint everything else builds on.
- 1.2's outcome (SSE works through Funnel, or polling fallback needed) determines 1.6's transport.
- 1.3 provides `hashKey()` and ingest; 1.4 (simulator) feeds data through 1.3's API; 1.4 adds `parseGpx` and GPX fixtures reused by Epic 3 golden tests.
- 1.5 replaces 1.2's empty snapshot with projected state; RunnerView fields for distance/pace/progress/ETA stay at contract defaults until Epic 3.
- Epic 2 (Android) mirrors `shared/fixtures` in Kotlin contract tests and posts to 1.3's ingest.
