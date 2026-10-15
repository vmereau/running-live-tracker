---
title: 'Story 1.2: Live stream spike through Tailscale Funnel'
type: 'feature'
created: '2026-10-15'
status: 'done'
baseline_commit: 'ae9cfdbf5436b82ec6ffe55a0a79ed2dcfc0e7fc'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Nobody knows yet whether a long-lived SSE stream from the home PC survives Tailscale Funnel to a phone on mobile data. Story 1.6's transport (SSE or 5 s polling) depends on the answer.

**Approach:** Add `GET /api/v1/live` (AD-6 SSE: hijacked reply, immediate `snapshot`, `: ping` every 20 s) and `GET /api/v1/snapshot`, both serving a snapshot built from config with every runner `notStarted` and empty tracks. Then expose the server through Funnel, keep the stream open on a phone on mobile data for 5+ minutes, and record the setup steps and the outcome in an ops note.

## Boundaries & Constraints

**Always:**
- SSE response: status 200, `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, no `Content-Encoding`, written to `reply.raw` after `reply.hijack()`. Named `event: snapshot` + one `data:` line holding the bare `Snapshot` JSON.
- `EventInfo` is built field by field from config (`.strict()` schema); no payload ever contains `keyHash`.
- Snapshot and SSE payloads parse with the `shared` zod schemas.
- Disconnects free their ping timer; `app.close()` ends every open stream so shutdown never hangs.
- Server still binds `127.0.0.1` only; no tunnel-specific code.

**Never:**
- No ingest, SQLite, projection fold, `runner`/`track` emission (Stories 1.3–1.5), no Last-Event-ID replay, no compression plugin.
- No Leaflet/map code; no contract changes.

**Decisions:**
- Phone observation: serve the built web app at `/` now via `@fastify/static` 10.1.6 (pulled forward from 1.6). The `web` placeholder becomes a diagnostic page that shows the snapshot and each ping with arrival time and gap, and whether `EventSource` stays connected. Story 1.6 replaces the page with the map.
- Funnel test: the agent implements and writes the ops note with setup steps and an empty outcome section. The human runs `tailscale funnel` and the 5-minute phone test, then reports the result; the agent records it in the ops note before the story closes. The agent never starts Funnel itself.
- Spec size (~2,000 tokens) accepted as-is.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Snapshot | `GET /api/v1/snapshot` | `200` JSON `Snapshot`: `serverNow`, `event` (hasCourse `false`, lengthM `null`), one `notStarted` RunnerView per configured runner in config order (nullable fields `null`, `distanceM` 0, `offCourse` false), `tracks` = `{runnerId: []}` for each | N/A |
| Live connect | `GET /api/v1/live` | headers above, first bytes are `event: snapshot\ndata: <Snapshot>\n\n` with the same shape as `/snapshot` | N/A |
| Heartbeat | stream open past one interval | `: ping\n\n` per interval (20 s default, injectable for tests) | N/A |
| Client leaves | client aborts | ping timer cleared, hub client count back to 0 | write errors on a dead socket are swallowed |
| Shutdown | `app.close()` with open streams | streams ended, close resolves | N/A |
| Secrets | any response body | contains no `keyHash` field or value | N/A |

</frozen-after-approval>

## Code Map

- `server/src/http/build-app.ts` -- `buildApp({config, now, logger})`; add the two routes here. Reuse `errorBody`, keep the existing error/not-found handlers. `BuildAppOptions` gains an optional `pingIntervalMs`.
- `server/src/http/build-app.test.ts` -- existing `app.inject` tests; SSE needs a real `listen({host:'127.0.0.1', port:0})` + `fetch` reader (inject waits for the response end).
- `server/src/projection/` -- empty; new `snapshot.ts` (`buildEventInfo(config)`, `buildSnapshot(config, now)`). Projection may import `config` and `shared`. 1.5 replaces the empty views with folded state.
- `server/src/live/` -- empty; new `sse-hub.ts`. `live` may import only `projection`/`shared`, so the hub receives a `getSnapshot()` function instead of config.
- `server/src/config/load-config.ts` -- `EventConfig` (has `keyHash`, optional `coursePath`); read only.
- `shared/src/contract.ts` -- `Snapshot`, `EventInfo`, `RunnerView`; no changes. `shared/fixtures/valid/snapshot.json` shows the shape.
- `server/src/main.ts` -- composition root; passes `webRoot = <repo>/web/dist` (resolved from `import.meta.dirname`, like the other defaults) to `buildApp`.
- `web/src/main.ts`, `web/index.html` -- current placeholder; becomes the diagnostic page. `web` may import only `shared` (types via `import type`).
- `server/package.json` -- add `@fastify/static: "10.1.6"` (exact pin).
- Installed Tailscale is 1.98.4 (spine pins 1.104.1); Funnel exists in both. The ops note records the version used; upgrading is out of scope.

## Tasks & Acceptance

**Execution:**
- [x] `server/src/projection/snapshot.ts` + test -- `buildEventInfo` field by field (`hasCourse: false`, `lengthM: null` until Story 3.3 serves `/api/v1/course`), `buildSnapshot(config, now)` -- single snapshot builder for both endpoints
- [x] `server/src/live/sse-hub.ts` + test -- `createLiveHub({getSnapshot, pingIntervalMs})` with `attach(res)` writing headers + snapshot, per-client ping timer, cleanup on `close`, `closeAll()`, `clientCount()` -- AD-6 hub, ready for 1.5's `runner`/`track` broadcast
- [x] `server/src/http/build-app.ts` + test -- `/api/v1/snapshot` and `/api/v1/live` (hijack → `hub.attach(reply.raw)`), `onClose` → `hub.closeAll()`; optional `webRoot`: when the directory exists, serve it at `/` with `@fastify/static`, otherwise log a warning and skip; `/api/*` misses still return the JSON 404. Tests cover every matrix row over a real socket, plus static serving from a temp dir -- wiring
- [x] `server/package.json`, `server/src/main.ts` -- add the dependency; pass `webRoot` -- composition
- [x] `web/index.html`, `web/src/main.ts` -- diagnostic page (see Design Notes) -- what the phone opens
- [x] `docs/ops/tailscale-funnel.md` -- prerequisites, `tailscale funnel` commands for port 8787 (start, status, stop), URL shape, how to run the phone test, outcome section -- the ops note the story demands
- [x] `README.md` -- list the two endpoints and link the ops note

**Acceptance Criteria:**
- Given `pnpm check`, then typecheck, tests and dependency-cruiser pass (projection → config, http → live|projection only).
- Given the server running locally, when `curl -N http://127.0.0.1:8787/api/v1/live` runs for 45 s, then it prints the snapshot immediately and two `: ping` lines about 20 s apart.
- Given Funnel exposing the server, when a phone on mobile data keeps the stream open ≥ 5 minutes, then the snapshot arrives, pings arrive about every 20 s without buffering or disconnects, and the outcome (SSE works / polling fallback needed) is written into the ops note.

## Implementation Notes

- Shutdown uses a `preClose` hook, not `onClose`: Fastify closes the HTTP server before user `onClose` hooks run, so with `onClose` `app.close()` waited on the open SSE sockets (verified: the close test timed out at 8 s). `preClose` ends every stream first.
- `/api/v1/live` sets `exposeHeadRoute: false`. Fastify's auto HEAD route would hijack a HEAD request whose headers never flush, holding a hub slot until the client gives up. HEAD now returns the JSON 404 (tested).
- The hub test covers "client leaves → client count 0, timer cleared" over a real socket. The app-level test checks that an abort leaves the server healthy, because `buildApp` does not expose the hub.
- Web: the SSE frame splitter lives in `web/src/sse-frames.ts` with a `node:test` test. Test files get Node types through `web/tsconfig.test.json` (the web typecheck runs both configs), so browser code stays free of Node globals. A `/// <reference types="node" />` was rejected by dependency-cruiser (`not-to-unresolvable`).
- Verified locally: `pnpm check` exits 0. `curl -N /api/v1/live` for 45 s shows the snapshot at once and pings at +20 s and +40 s. Headers: `text/event-stream`, `no-cache, no-transform`, `X-Accel-Buffering: no`, no `Content-Encoding` even with `Accept-Encoding: gzip`. In Chrome, the built diagnostic page at `/` shows EventSource open (1 open, 0 errors, 1 snapshot) and pings exactly 20.0 s apart.
- Still open: the human-run Funnel and phone test, and its outcome in `docs/ops/tailscale-funnel.md` (AC 3).

## Spec Change Log

## Review Triage Log

Pass 1 (blind = B, edge-case = E, verification-gap = V):

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | B: no cap on SSE clients | low | public endpoint, but a handful of known viewers; a cap adds a branch and a 503 path | reject |
| 2 | B, E: `getSnapshot()` throwing after `writeHead` leaves an untracked open response | false | `buildSnapshot` is a pure object build from validated config and cannot throw today; 1.5 owns the projected version | reject |
| 3 | B, E: `readStream` doesn't cancel the reader when it throws → leaked fetch on retry | low | real on the "stream ended"/parse paths; the fix is a try/finally | patch |
| 4 | B: hub logs no connect/disconnect | low | useful but not required; needs a logger parameter (new surface) | reject |
| 5 | B: no Vite dev proxy for `/api` | low | README and the ops note say to build and serve `web/dist`; `vite dev` isn't the documented path | reject |
| 6 | B: `webRoot` not overridable by env | false | no requirement or caller needs it; fixed path resolved like the defaults | reject |
| 7 | B: ops note command is POSIX-only on a PowerShell machine | low | `VAR=x cmd` fails in PowerShell; direct doc correction | patch |
| 8 | B, E: ops note outcome empty | false | by decision: the human runs the phone test and the agent records it before closing (frozen Decisions) | reject |
| 9 | B: no follow-up for the Tailscale 1.98.4 vs 1.104.1 gap | false | the frozen Decisions settled it: record the version, upgrade out of scope | reject |
| 10 | B, E: close test drain loop has no deadline | low | a `closeAll` regression would hang CI instead of failing; one race | patch |
| 11 | B: `X-Accel-Buffering` header unasserted | low | verified: only cache-control/content-encoding asserted; one assertion | patch |
| 12 | B: static could serve dotfiles / shadow API routes | false | `@fastify/static` ignores dotfiles by default; explicit routes win over the static wildcard | reject |
| 13 | B: `readUntil` helper duplicated | low | test-only duplication, no named harm | reject |
| 14 | B: page can't recover after EventSource CLOSED | low | CLOSED only on non-200/wrong type, which is itself the diagnostic result; the raw reader keeps retrying | reject |
| 15 | B: no static caching policy | false | `@fastify/static` defaults to `max-age=0` + ETag, so browsers revalidate; no stale page | reject |
| 16 | E: socket already destroyed before `attach` → leaked timer | low | narrow window, not demonstrated; writes are guarded and `preClose` ends it | reject |
| 17 | E: no backpressure handling | low | pings are 8 bytes; matters only when 1.5 broadcasts | reject |
| 18 | E: silent stall keeps "Connected for" ticking | low | the ping log and max-gap stop moving, which the ops note tells the tester to read; the fix adds an idle timer | reject |
| 19 | E: malformed snapshot JSON in the EventSource listener | false | the server always sends `JSON.stringify` output | reject |
| 20 | E: CRLF split across chunks | false | the server sends LF only | reject |
| 21 | E: bare `data` field line dropped | false | the server never sends one | reject |
| 22 | E: spec says `onClose`, code uses `preClose` | low | deliberate (onClose runs after the server close waits on streams); the fix would edit the spec | reject |
| 23 | V: main.ts `webRoot` wiring untested | medium | pre-verified: no test reaches main.ts's path; CI runs tests before the web build | patch |
| 24 | V: default 20 s ping interval never exercised | medium | pre-verified: every test injects an interval | patch |

## Design Notes

- Write headers with `res.writeHead(200, {...})` then `res.flushHeaders()` is implicit in the first `write`; also send `X-Accel-Buffering: no` (harmless, defeats buffering proxies). Hijacked replies skip Fastify's `onSend`, so nothing can add compression.
- SSE frame: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`. JSON has no raw newlines, so one `data:` line is valid.
- Per-client `setInterval(...).unref()` is fine at this scale (a handful of viewers).
- `EventSource` never surfaces `: ping` comments to JS. So the diagnostic page uses two connections: an `EventSource` (shows open/error/reconnect counts and snapshot arrival — proves what 1.6 will use) and a `fetch` + `ReadableStream` reader on the same URL that logs every frame, pings included, with local arrival time and the gap since the previous frame. It also shows the elapsed connected time and the runner count from the snapshot. Plain DOM, no framework, readable at phone width.

## Verification

**Commands:**
- `pnpm check` -- expected: exit 0
- `EVENT_CONFIG=config/event.example.json pnpm dev`, then `curl -N http://127.0.0.1:8787/api/v1/live` -- expected: snapshot event, then `: ping` every 20 s
- `curl http://127.0.0.1:8787/api/v1/snapshot` -- expected: JSON with runners `alice`, `bob` `notStarted`, no `keyHash`
- `pnpm --filter web build`, restart the server, open `http://127.0.0.1:8787/` -- expected: the diagnostic page shows the snapshot and then pings

**Manual checks:**
- Phone on mobile data through the Funnel URL for ≥ 5 min (see `docs/ops/tailscale-funnel.md`).
