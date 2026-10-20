---
title: 'Switching runners and following the selected runner'
type: 'feature'
created: '2026-10-20'
status: 'done'
baseline_commit: 'cfc49031d8cab9157055f7fa9e21ba8af123c2a3'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** A spectator can highlight a runner, but the map pans to them only once, the panel shows only "name · status", and tapping the runner again deselects them. There is no way to keep one friend in view or to read that runner's full stats.

**Approach:** Turn the selection into a small view-mode state: "All runners" (overview) or one selected runner that is followed or paused. The map follows the selected runner on every `runner` event, pauses when the spectator pans or zooms, and offers "Re-center". The panel gains an "All runners" control and a stats block for the selected runner. All of this is web-only view state, outside the store.

## Boundaries & Constraints

**Always:** View state lives in one pure module (`selection.ts`): `{ selectedId: string | null, following: boolean }`. `select(id)` always selects and resumes following, including when `id` is already selected (no more toggle-off). `showAll()` clears the selection. `pauseFollow()` and `resumeFollow()` only act while a runner is selected. The overview fits the map to runners' `lastPosition` only (not tracks) on the first snapshot with any position and on every `showAll()`, and does not refit on later events. While following, each store change re-centers on the selected runner's `lastPosition` at the current zoom. Selecting zooms in to at least `FOLLOW_MIN_ZOOM = 15`. Hand pan is detected with Leaflet `dragstart` and hand zoom with `zoomstart` outside programmatic moves. Programmatic moves that change the zoom use `animate: false`, so their `zoomstart` fires synchronously inside a guard. Never use `movestart`: programmatic pans and `invalidateSize` (phone rotation, address bar) fire it too. Panel stats are the server values, formatted only (AD-2). Elapsed time and last-update age tick every second.

**Never:** Put view state in the store or in the URL/localStorage. Recompute distance or pace. Change the server, the contract or the SSE client. Draw the course or show progress or ETA (stories 3.3 to 3.5). Add a DOM test framework.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior |
|----------|--------------|---------------------------|
| Select active runner | tap row or marker | panel shows name, status, elapsed, distance, now/avg pace, last update; map centers on them (zoom ≥ 15) |
| Runner moves | `runner` event, following | map re-centers on the new position, zoom kept |
| Hand pan or zoom | following | following pauses; "Re-center" appears; later events do not move the map |
| Re-center or re-select | paused | following resumes and the map centers at once; "Re-center" hides |
| Switch runner | B selected while A followed | panel shows B's values; map centers on B; following on |
| Select notStarted | no `lastPosition` | panel says "Not started yet"; map does not move; follows once a position arrives |
| All runners | any selection | selection cleared, following off, map fits all runners with a position (no move if none) |
| Reconnect | fresh snapshot | selection and following state kept; panel and map use the new snapshot |
| Runner gone | snapshot without the selected id | falls back to "All runners" |
| Stopped runner | selected | panel shows final elapsed; current pace "—" |

</frozen-after-approval>

## Code Map

- `web/src/selection.ts` + `selection.test.ts` -- today `{get, toggle, subscribe}` with toggle-off. Replace with the view-mode API. `subscribe` gets the full state.
- `web/src/map-view.ts` -- `sync` (markers keyed per runner; the marker click calls `selection.toggle`), `fitOnce` (includes tracks; switch to positions only), and the selection subscriber that pans once. Follow logic, the guard and the Re-center control go here. Keep the pane, styles and the layer diffing.
- `web/src/runner-list.ts` -- keyed rows, `renderTicking` (1 s), `renderDetail` (one-line `.panel-detail`). The row click calls `selection.toggle`. Add an "All runners" button and replace the detail line with the stats block.
- `web/src/format.ts` + `format.test.ts` -- reuse `runnerStatsText`, `ageMs`, `formatAge`, `statusLabel`. Add the pure panel builder here.
- `web/src/styles.css` -- `.panel` (280 px, 40vh, scrolls), `.panel-detail`, `.runner.selected`.
- `web/src/main.ts` -- wiring only; no change expected.
- Leaflet 1.9.4 (verified in source): `dragstart` fires only for user drags. An animated zoom fires `zoomstart` in a later animation frame. `panBy` and `invalidateSize` fire `movestart`.

## Tasks & Acceptance

**Execution:**
- [x] `web/src/selection.ts` -- the view-mode state with `get()`, `select`, `showAll`, `pauseFollow`, `resumeFollow`, `subscribe`. Notify only on real changes. -- one source of view state.
- [x] `web/src/selection.test.ts` -- re-select resumes following, pause/resume no-ops without a selection, showAll clears, no duplicate notifications.
- [x] `web/src/format.ts` + `format.test.ts` -- `selectedPanelText(view, name, now)` → `{ title, notStarted, rows: [label, value][] }` covering elapsed, distance, now pace, avg pace and last update. Test active, notStarted and stopped cases.
- [x] `web/src/map-view.ts` -- use `select` on marker click. Fit to positions in overview (first data and `showAll`). Follow on store changes and selection changes. Pause on `dragstart` or unguarded `zoomstart`. Add a Leaflet "Re-center" control (top-left, under the zoom buttons), visible only while selected, paused and with a position. If the selected id is missing from a snapshot, call `showAll()`.
- [x] `web/src/runner-list.ts` -- the row click calls `select`. Add an "All runners" button at the top of the panel (pressed state while in overview). Render the selected-runner stats block from `selectedPanelText`, with elapsed and last update refreshed in the 1 s tick.
- [x] `web/src/styles.css` -- the "All runners" button, the stats block (label/value grid, tabular numbers) and the Re-center control, readable on a phone.

**Acceptance Criteria:**
- Given the "All runners" view, when the page opens, then every row shows color, name, status, distance, current pace and last-update age, and the map fits all runners that have a position.
- Given a followed runner, when the window is resized or the phone rotated, then following stays on.
- Given any interaction, when the panel renders, then no web code derives distance or pace from track points.

## Design Notes

The guard is a counter or boolean set around synchronous `map.setView(..., { animate: false })` and `fitBounds(..., { animate: false })` calls. Follow updates at an unchanged zoom use `panTo` (animated). That fires only `movestart`, which is ignored, so no guard is needed for them.

## Verification

**Commands:**
- `pnpm check` -- expected: typecheck, all tests and depcruise pass

**Manual checks:**
- `pnpm dev` + `pnpm simulate --key <k1> --key <k2> --pace 5:00,6:00 ...` (two runners), open the map: select one (the map follows), drag (Re-center appears), press Re-center, then "All runners" (refits). Also try a phone-width window.
