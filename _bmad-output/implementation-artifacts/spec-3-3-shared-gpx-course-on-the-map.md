---
title: 'Shared GPX course on the map'
type: 'feature'
created: '2026-10-20'
status: 'done'
baseline_commit: 'af9632c516f136856dd7e807fc3e4accd3578ac4'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-3-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** `event.json` accepts a `coursePath`, but the server ignores it. `EventInfo` always reports `hasCourse: false`, and spectators cannot see where runners are relative to the route.

**Approach:** At boot, `config` loads the GPX next to `event.json` into a domain `Course` polyline with `lengthM`. `EventInfo` reports the course, and `GET /api/v1/course` serves it as a GeoJSON LineString. The web fetches the course once and draws it beneath the tracks. While no runner has a position, the first view fits the course.

## Boundaries & Constraints

**Always:** `coursePath` is resolved relative to `dirname(event.json)`, and an absolute path is used as is. The points come from the existing `parseGpx`. The polyline and `lengthM` come from `cumulativeDistancesM` in a new pure `domain/course.ts`. The server refuses to boot (a `ConfigError` naming the GPX path, then exit 1) when the file is unreadable, `parseGpx` throws, there are fewer than 2 points, or `lengthM` is 0. `[lon, lat]` appears only in the `/api/v1/course` body. The GeoJSON is built once at app start. The course is never sent over SSE or put in the store. The web fetches the course at most once per page load and retries only after a failed fetch, on the next snapshot. The course line sits in its own pane below the tracks (non-interactive, dashed, neutral color). The course fit happens only once: in the overview, before any runner fit, and only when no runner has a position.

**Never:** Compute progress, km done or remaining, offCourse or ETA (stories 3.4 and 3.5). Show `lengthM` in the UI. Send course geometry over SSE. Let `web` import anything but `shared`. Let `http` import `domain`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Course configured | `coursePath: "courses/race.gpx"` beside event.json | `hasCourse: true`, `lengthM` = haversine length; `/api/v1/course` 200 `{type:"LineString",coordinates:[[lon,lat],…]}` | N/A |
| No course | no `coursePath` | `hasCourse: false`, `lengthM: null`; `/api/v1/course` 404 `NO_COURSE` | N/A |
| Bad GPX | missing file / bad lat / 1 point / all points identical | boot refused | ConfigError message names the GPX path and reason |
| Page, no positions yet | `hasCourse: true`, all `notStarted` | course drawn; map fits the course | N/A |
| Page, runners have positions | first snapshot with positions | map fits runners (as before); course drawn, no refit | N/A |
| Course fetch fails | network error or non-200 | no line; retried on the next snapshot | logged with `console.warn` |
| No course on page | `hasCourse: false` | no fetch, no line | N/A |

</frozen-after-approval>

## Code Map

- `server/src/domain/gpx.ts` (`parseGpx`) and `geo.ts` (`cumulativeDistancesM`, `LatLon`): reuse them, no changes.
- `server/src/config/load-config.ts`: `coursePath` is already in the schema, and `ConfigError` is defined here. `config` may import `domain`. `http` and `projection` may import `config`.
- `server/src/projection/snapshot.ts`: `buildEventInfo(config)` currently hardcodes `hasCourse: false`, and `buildSnapshot(config, now, projected)` calls it. `create-projection.ts` calls `buildSnapshot` with `CreateProjectionOptions { config, store }`. About 24 test call sites use these functions, so the new `course` parameter is optional and defaults to `null`.
- `server/src/http/build-app.ts`: `errorBody(code, message)` and `BuildAppOptions` live here. The not-found handler is registered after the routes.
- `server/src/main.ts`: the config is loaded inside a `try` that catches `ConfigError`. Load the course in the same block, then pass it to `createProjection` and `buildApp`.
- `shared/src/contract.ts` and `contract.test.ts`: the `schemas` map is keyed by the fixture prefix. `android/.../contract/ContractFixturesTest.kt` line 37 has a `readSide` set, and each new prefix must be added there or the Android tests fail.
- `web/src/camera.ts`: holds the pure camera planner (`CameraMemory.fitted`, `planFit`). `web/src/map-view.ts` executes the camera actions inside `guarded()`. It creates a `runners` pane at z-index 450, and the tracks are in Leaflet's `overlayPane` (z-index 400). `web/src/main.ts` only wires the modules together. `web/src/store.ts` stays unchanged.

## Tasks & Acceptance

**Execution:**
- [x] `server/src/domain/course.ts` + `course.test.ts` -- `type Course = { points: LatLon[]; cumulativeM: number[]; lengthM: number }` and `buildCourse(points)`, which throws on fewer than 2 points or a zero length. Test on `shared/fixtures/gpx/*.gpx` (lengthM > 0, last cumulative = lengthM) and on the error cases.
- [x] `server/src/config/load-course.ts` + test -- `loadCourse(configPath, coursePath): Course` reads, parses and builds the course, wrapping every failure in a `ConfigError` with the resolved path. Re-export `type Course`. Test relative and absolute paths, a missing file, a bad point, 1 point and identical points.
- [x] `server/src/projection/snapshot.ts`, `create-projection.ts` + tests -- thread `course: Course | null = null` into `buildEventInfo` and `buildSnapshot` to fill `hasCourse` and `lengthM`.
- [x] `shared/src/contract.ts` + `contract.test.ts` + fixtures -- add `CourseGeoJson = z.strictObject({ type: z.literal('LineString'), coordinates: z.array(z.tuple([lon, lat])).min(2) })`, with fixtures `valid/course-geo-json.json` and `invalid/course-geo-json.one-point.json`. Add `"course-geo-json"` to the Android `readSide`.
- [x] `server/src/http/build-app.ts` + test -- add the `course?: Course | null` option and `GET /api/v1/course` (200 with the GeoJSON, or 404 `NO_COURSE`). Test the body against `CourseGeoJson`, the lon/lat order, and the 404.
- [x] `server/src/main.ts` -- load the course when `coursePath` is set and pass it on.
- [x] `web/src/course.ts` + test -- `parseCourse(json): LatLon[]` (validate with `CourseGeoJson`, then swap to `{lat, lon}`), and `watchCourse(store, onCourse)`: on a snapshot with `hasCourse`, fetch once, and on failure warn and allow another try.
- [x] `web/src/camera.ts` + test -- add `planCourseLoaded(state, runners, points, memory)`, which returns `fit` only when in the overview, `!memory.fitted` and no runner has a position. It does not set `fitted`.
- [x] `web/src/map-view.ts`, `main.ts`, `styles.css` if needed -- `createMapView` returns `{ setCourse(points) }`. It draws the course in a `course` pane at z-index 350 and runs `planCourseLoaded`. `main.ts` wires `watchCourse` to `setCourse`.
- [x] `README.md` -- document `coursePath` (relative to event.json, GPX trk or rte, the boot refusal cases).

**Acceptance Criteria:**
- Given a configured course, when the page loads, then the course line is visible beneath every runner track, and the selected runner's thick track is still drawn above it.
- Given any course, when the SSE stream is inspected, then no payload contains course geometry.
- Given `pnpm check`, then typecheck, all tests and depcruise pass.

## Review Triage Log

| # | Source | Finding | Verdict | Evidence / route |
|---|--------|---------|---------|------------------|
| 1 | verification-gap | `setCourse` / `main.ts` wiring (lat/lon order, pane z-index, fit call) untested | medium | Pre-verified: no test imports `map-view.ts`/`main.ts`; repo has no DOM test seam (3.2 forbids adding a DOM framework). Defer. |
| 2 | edge-case, blind | Late course fit can override a hand pan/zoom done before the fetch resolves | low | Real but the window is the few ms between first snapshot and the same-origin fetch; fix adds camera state. Rejected (unlikely + adds complexity). |
| 3 | edge-case, blind | Failed fetch is retried only on the next snapshot, possibly never on a healthy stream | low | Matches the frozen matrix row; a same-origin fetch failing right after SSE succeeds is rare; timed retries add timers. Rejected. |
| 4 | edge-case | Snapshot during an in-flight fetch consumes the retry chance | low | Requires a reconnect mid-fetch plus fetch failure; fix adds a pending flag. Rejected. |
| 5 | edge-case, blind | Server restart with changed/removed course leaves the old line drawn | low | Course is fixed per event, a change mid-session means an operator restart; fix adds a clear path + API. Rejected. |
| 6 | edge-case | Multiple trksegs are bridged into one polyline | false | Epic context mandates concatenating the trksegs of the first trk. |
| 7 | blind | `onCourse` throwing becomes an unhandled rejection with no retry | low | `setCourse` gets schema-validated points; Leaflet `polyline` does not throw on them. Rejected. |
| 8 | blind | `watchCourse` relies on the store keeping `snapshot.event` by reference | low | True and undocumented (`store.ts` spreads `...current`); a store refactor would make every event retry after a failure. Patch: document the invariant in `store.ts`. |
| 9 | blind | Overview never shows the whole course once a runner has a position | low | Frozen matrix: "map fits runners (as before)". Rejected as intent-excluded. |
| 10 | blind | No cache headers on `/api/v1/course` | low | Body is a few kB for a race GPX, fetched once per page. Rejected. |
| 11 | blind | No simplification / size limit for huge GPX | low | Leaflet already simplifies polylines at render (`smoothFactor`); a race GPX is bounded. Rejected. |
| 12 | blind | README refusal cases not all tested at `loadCourse` level | false | `gpx.test.ts` covers missing/out-of-range lat/lon, the rte fallback and multi-trkseg; `loadCourse` only wraps those errors, and the wrap is tested. |
| 13 | blind | Thin `CourseGeoJson` invalid fixtures | low | No defect; schema is strict and the swap test exists. Rejected. |
| 14 | blind | `main.test.ts` course check uses a cast and only `lengthM > 0` | low | Direct correction. Patch: parse with `CourseGeoJson`, compare `lengthM` to `loadCourse`. |
| 15 | blind | No legend / start-finish markers for the course line | low | Cosmetic UI addition beyond the story. Rejected. |

## Design Notes

The course fit does not set `fitted`. That way, the first snapshot with a runner position still triggers the existing runner fit, as the epic requires: the course is shown only *while* no runner has a position. The fetch is started from the store subscription, not at page load, because `hasCourse` is known only from the snapshot.

## Verification

**Commands:**
- `pnpm check` -- expected: typecheck, all tests and depcruise pass

**Manual checks:**
- Point a temporary event.json at `shared/fixtures/gpx/lap.gpx`, then run `pnpm dev`. `curl /api/v1/course` should return the GeoJSON. Opening the page should show the course fitted. Run `pnpm simulate` and check that the tracks draw above the course.
