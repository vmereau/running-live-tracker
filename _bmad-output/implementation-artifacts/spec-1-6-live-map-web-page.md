---
title: 'Story 1.6: Live map web page'
type: 'feature'
created: '2026-10-16'
status: 'done'
baseline_commit: '0d54c879775294457d14c1c046a748c856b43c83'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Spectators who open `/` only get the Story 1.2 diagnostic page. They see no map, runners or tracks, even though the server now streams projected `snapshot`/`runner`/`track` events.

**Approach:** Replace `/` with a Vite vanilla-TS page: a full-screen Leaflet map (OSM standard tiles plus attribution) and a runner list. One store module holds the `Snapshot` state. Only SSE events change it. The map and list subscribe to it read-only. The diagnostic page moves to `/diagnostic.html`.

## Boundaries & Constraints

**Always:**
- The store applies events by AD-6: `snapshot` replaces everything, `runner` replaces one view by `runnerId`, `track` appends points to `tracks[runnerId]`. Every payload sets `offsetMs = serverNow − Date.now()`. `runner`/`track` events that arrive before the first snapshot are ignored.
- Age = `max(0, now − lastReceivedAt)` with `now = Date.now() + offsetMs`. It shows as "last update N s ago" below 60 s and "N min ago" (floored) from 60 s up, and re-renders every second. `lastReceivedAt` null shows "no data yet". No other derived numbers (AD-2).
- Each runner with a `lastPosition` gets a marker in their config color (`event.runners[].color`) and a polyline of their track in the same color. `notStarted` runners (no position) are listed but have no marker.
- Tapping a list entry or a marker selects that runner. Its marker gets bigger and its line thicker, both brought to front. A detail line shows the name and status. Tapping it again deselects. Selecting also pans the map to the runner's position, if any.
- On the first snapshot that has any position or track point, the map fits all of them. After that it never moves by itself. Before any data it shows a neutral world view.
- Usable at 360 px width: the map fills the viewport and the list is a compact overlay that does not cover most of the map.
- `web` imports only `web` and `shared` (dependency-cruiser). Only erasable TS syntax.

**Never:**
- No contract or server changes. No distance, pace, progress, ETA or elapsed display (Epic 3). No course drawing (3.3). No follow mode (3.2). No polling: Story 1.2 concluded that SSE works through Funnel.

**Decisions:**
- Reconnect: keep showing the last state with a "reconnecting…" banner. The fresh `snapshot` on reconnect replaces it completely, which is the AD-6 discard. If `EventSource` ends `CLOSED` (for example a 502 while the PC is down), create a new one after 3 s.
- Markers are `L.circleMarker`s (no image assets).
- The diagnostic page is kept as a second Vite entry for the Story 4.3 soak test.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior |
|----------|--------------|---------------------------|
| Snapshot | 2 runners, one active with track | store holds both; 1 marker + 1 line; list shows 2 |
| Runner event | new view for active runner | that view replaced, marker moves, others untouched |
| Track event | 3 points | appended in order to that runner's track |
| Early event | `runner` before any snapshot | ignored |
| Second snapshot | after reconnect, different state | state fully replaced, removed tracks/markers gone |
| Clock skew | serverNow = Date.now()+5 000 | offsetMs 5 000; ages computed against server time |
| Age format | 0 / 59 999 / 60 000 / 3 600 000 ms | "0 s ago" / "59 s ago" / "1 min ago" / "60 min ago" |
| Future receive | lastReceivedAt > now | "0 s ago" |

</frozen-after-approval>

## Code Map

- `web/index.html`, `web/src/main.ts` -- the current diagnostic page. Move them to `web/diagnostic.html` + `web/src/diagnostic.ts` without changing their logic (fix the script src). `sse-frames.ts` + its test stay as they are.
- `shared/src/contract.ts` -- `Snapshot`, `RunnerView`, `RunnerEvent`, `TrackEvent`, `TrackPoint`, `EventInfo` (types only, `import type`).
- `server/src/live/sse-hub.ts` -- the source of event order: `snapshot` on connect, `track` then `runner` per change, a fresh `snapshot` on a track reset.
- `server/src/http/build-app.ts` -- already serves `web/dist` at `/`. Do not change it.
- `web/tsconfig.json` / `tsconfig.test.json` -- `src` is type-checked, tests run with `node --test`. DOM/Leaflet modules stay out of tests.
- `.github/workflows/ci.yml` -- already runs `vite build`.

## Tasks & Acceptance

**Execution:**
- [x] `web/package.json` -- add `leaflet` 1.9.4 and a pinned `@types/leaflet` 1.9.x, then `pnpm install` (lockfile). Add `web/vite.config.ts` with the two HTML entries and a dev proxy `/api → http://127.0.0.1:8787`.
- [x] `web/diagnostic.html`, `web/src/diagnostic.ts` -- moved diagnostic page.
- [x] `web/src/store.ts` + test -- `createStore(clock = Date.now)`: `applySnapshot/applyRunner/applyTrack`, `getState()` (snapshot or null, offsetMs), `now()`, `subscribe(listener)`. Tests cover every store row of the matrix.
- [x] `web/src/format.ts` + test -- `formatAge(ageMs)`, `ageMs(lastReceivedAt, now)`, `statusLabel(status)`. Tests cover the age rows.
- [x] `web/src/live-client.ts` -- EventSource on `/api/v1/live`, parses the payloads into the store, reports connection status, recreates the source on `CLOSED`.
- [x] `web/src/map-view.ts` -- Leaflet map and tiles, one circleMarker + polyline per runner synced from the store, fit-once, selection styling, marker click → select.
- [x] `web/src/runner-list.ts` -- list overlay (color swatch, name, status, age), selection, detail line, banner, 1 s age ticker.
- [x] `web/index.html`, `web/src/main.ts`, `web/src/styles.css` -- the map page wiring and layout (imports `leaflet/dist/leaflet.css`).
- [x] `README.md`, `docs/ops/tailscale-funnel.md` -- `/` is the map, the diagnostic page is at `/diagnostic.html`.

**Acceptance Criteria:**
- Given `pnpm check` and `pnpm --filter @running-live-tracker/web build`, then both pass and `web/dist` holds `index.html` and `diagnostic.html`.
- Given the built server and two simulated runners (one with `--gap`), when `/` is open in a 360 px-wide browser, then both colored markers and tracks move live, the gapped runner's age grows during the gap, and its track fills the gap in order afterwards. Selecting a runner (list or marker) highlights it.
- Given the server restarts while the page is open, then the banner shows and the page rebuilds from the new snapshot without a reload.

## Implementation Notes

## Spec Change Log

## Review Triage Log

Pass 1 (blind = B, edge-case = E, verification-gap = V):

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | B, E: `map-view.sync` re-sets every runner's full polyline on every event | medium | confirmed: `setLatLngs` runs for all runners on each store change; O(total points) per event over a 5 h race on phones; the store keeps untouched track arrays by reference, so a reference check is a direct fix | patch |
| 2 | V, B: `selection.toggle` (deselect on repeat) untested | low | confirmed: no test imports `selection.ts`; pure module, spec requires deselect | patch |
| 3 | V, B: `applyRunner` unknown-runner append branch untested | low | confirmed by reading `store.test.ts`; one-case addition | patch |
| 4 | V, B: live-client event names and CLOSED recreate untested | low | real; closing it needs an injected EventSource factory or shared event-name constants (design change); covered by the manual restart check | defer |
| 5 | B: open-but-silent stream / background tab never detected | maybe-false | browsers usually error and reconnect on resume; unverified on a pocketed phone; would be medium; settled by the Story 4.3 phone soak test | defer |
| 6 | B, E: payloads cast, not zod-validated | low | server and web ship together from one repo; adding zod parsing to the bundle is more than a direct fix; no reachable mismatch shown | reject |
| 7 | B, E: stale selection when a runner leaves a snapshot | low | needs a config change + restart; fix adds a store subscription | reject |
| 8 | B: `panTo` at world zoom does nothing | false | a runner with a position implies the first data snapshot already ran `fitOnce` | reject |
| 9 | B: track overlap duplicates points around reconnect | false | snapshot is the first frame of each stream and replaces everything; later frames carry only new points | reject |
| 10 | E: track for a runner missing from `runners` never drawn | false | server snapshots always list every configured runner (`buildSnapshot`) | reject |
| 11 | B: empty `applyTrack` commits for nothing | false | the hub writes `track` only when points were appended | reject |
| 12 | E: a throwing subscriber skips later ones | low | no reachable throw shown; adding try/catch is a guard for undemonstrated state | reject |
| 13 | B, V: `vite.config.ts` not type-checked | low | CI `vite build` executes it; a separate tsconfig is more than a direct fix | reject |
| 14 | B: markers have no name tooltip | low | intent asks for selection by tap (name shown in detail line), not labels | reject |
| 15 | B: banner/aria/overlap nits, stale docs wording | low | banner sits at 28 px above the ~16 px attribution; the funnel doc's polling sentence describes the spike's question, now answered in its Outcome | reject |
| 16 | B: spec and sprint-status absent from the diff | false | by design: the spec is the claims file given to the edge-case layer | reject |

## Verification

**Commands:**
- `pnpm check` -- expected: exit 0
- `pnpm --filter @running-live-tracker/web build` -- expected: exit 0

**Manual checks (if no CLI):**
- Run the server with a temp config holding 2 keyed runners, and `pnpm -s simulate … --key a --key b --time-scale 20 --gap 1:1m+1m`. Watch `/` in the browser at 360 px width. Check markers, tracks, ages, selection, and recovery after a restart.
