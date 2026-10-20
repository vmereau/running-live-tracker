# Epic 3 Context: Race stats, course progress and finish estimates

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Spectators get more than dots on a map. They see each runner's elapsed time, distance, current pace and average pace. They can switch between an overview of all runners and one selected runner that the map follows. When the event has a GPX course, they see the course line, km done out of total, km remaining, percent complete and an estimated finish time. This turns the live map from Epic 1 into a race companion that friends can use to cheer at the right place and time. All numbers are computed once on the server, so every viewer sees the same values, and they should stay close to what the runner's own watch reports.

## Stories

- Story 3.1: Distance, pace and elapsed time
- Story 3.2: Switching runners and following the selected runner
- Story 3.3: Shared GPX course on the map
- Story 3.4: Course progress
- Story 3.5: Estimated finish time

## Requirements & Constraints

- Per runner, show elapsed time, distance, current pace and average pace in min/km. Switching the selected runner changes the stats shown.
- When a runner is selected, the map follows them and keeps their marker in view.
- The event has one GPX course, configured on the server and shared by all runners. When configured, it is drawn on the map as a line.
- With a course, show km done / total km, km remaining and percent complete, plus an estimated finish time that changes as pace changes.
- Without a course, the progress figures and ETA are hidden, never shown as 0.
- Displayed stats should stay close to the runner's watch. The tolerance is measured during the test run (Epic 4). With a course, distance is intentionally the course-projected figure, not raw GPS distance.
- The page shows live data only (no history or replay UI) and must work in a phone browser. The course and runners are configured only on the server.

## Technical Decisions

- **Only the server computes derived numbers.** Distance, pace, progress and ETA are defined once each, as pure functions in `server/src/domain`, with unit tests and thresholds as named constants. The web never recomputes them. It computes only elapsed = `(runEndedAt ?? now) − runStartedAt` and staleness, with `now = Date.now() + offsetMs`, where `offsetMs` comes from the `serverNow` carried by every SSE payload. Formatting (`h:mm:ss`, km with 1 decimal, `m:ss /km`) happens only in the web.
- **Derived values are never persisted.** The projection's `applyRecords` fold, run in canonical order `(sessionStartedAt, sessionId, seq)`, fills `RunnerView` both live and on boot replay. The live-equals-replay test must keep passing. Only accepted fixes feed stats (`kind = fix`, `accuracyM ≤ 30`, `recordedAt` monotonic). While a runner is `stopped`, `currentPaceSPerKm` and `etaAt` are `null`. Server-side `elapsedS = (lastAccepted.recordedAt − runStartedAt) / 1000`.
- **Distance.** Haversine segments. Without a course, `distanceM` is the sum of segments between consecutive accepted fixes. With a course, `distanceM = progressM`.
- **Pace.** `avgPaceSPerKm = elapsedS / (distanceM / 1000)`, `null` while `distanceM < 100`. `currentPaceSPerKm` uses the trailing accepted fixes covering at least 60 s and at least 200 m, measured on the same basis as `distanceM`. It is `null` until that much data exists.
- **ETA.** `etaAt = lastFixAt + remainingM × avgPaceSPerKm / 1000`. It is non-null only when `hasCourse`, status is `active` and `distanceM ≥ 1000`. The pace windows and basing the ETA on average pace are assumptions to revisit after the test run. A blend with current pace is the named alternative, and any change stays inside `domain`.
- **Course loading.** `coursePath` in `event.json` is resolved relative to the directory containing `event.json`. Parse it with the existing `domain` `parseGpx`: concatenate the `trkseg`s of the first `trk`, fall back to the first `rte`, and refuse to boot with fewer than 2 points. Build the polyline with cumulative haversine distance to get `lengthM`. `EventInfo` reports `hasCourse` and `lengthM` (`null` without a course).
- **Course endpoint.** `GET /api/v1/course` needs no auth and returns a GeoJSON LineString. This is the only place `[lon, lat]` order is used. Without a course it returns `404 {error:{code:"NO_COURSE"}}`. Course geometry is never sent over SSE.
- **Progress matching.** Match each accepted fix only within the forward window `[progressM − 50 m, progressM + max(1000 m, 8 m/s × seconds since last match)]`. A fix more than 100 m from the windowed segment leaves `progressM` unchanged and sets `offCourse: true`. After 6 consecutive off-course fixes within 100 m of the course ahead of `progressM`, progress jumps to the nearest such forward point. `progressM` never decreases. `remainingM = lengthM − progressM` and `progressFraction = progressM / lengthM` (0..1). Without a course, `progressM`, `remainingM`, `progressFraction` and `etaAt` are `null`.
- **Contract.** The `RunnerView` fields (`distanceM`, `progressM`, `remainingM`, `progressFraction`, `offCourse`, `avgPaceSPerKm`, `currentPaceSPerKm`, `etaAt`, `runStartedAt`, `runEndedAt`, `lastFixAt`, `lastReceivedAt`) are defined in `shared/src/contract.ts`. All fields except `runnerId`, `status`, `distanceM` and `offCourse` are nullable. A contract change updates the schema, the fixtures and the Kotlin classes together.
- **Live delivery.** A `runner` SSE event carries a full `RunnerView` that replaces the previous one. `track` events append points. On reconnect, the client gets a fresh snapshot. One web store module is changed only by SSE events, and UI modules subscribe to it read-only.
- **Testing.** Use `node:test`. Domain golden tests use the `shared/fixtures` GPX samples and cover an out-and-back course, a lap course, a late Start, a 2 km gap and no course. ETA unit tests cover each null condition and a pace change that moves the ETA.
- **Web stack.** Vite vanilla TypeScript (no framework) and Leaflet 1.9.4 with OSM tiles. The module dependency graph is enforced by dependency-cruiser: `config` and `projection` may import `domain`, and `web` imports only `shared`.

## UX & Interaction Patterns

- There is no UX design contract, so the visual design is your choice, as long as it renders the contract fields and works on a phone.
- **"All runners" overview.** List each runner with color, name, status, distance, current pace and last-update age. Fit the map to all runners that have a position. With a course, add "X.X / Y.Y km", km remaining, percent complete and an "off course" indicator.
- **Selection.** Select a runner from the list or by tapping their marker. The stats panel shows elapsed time, distance, both paces, last-update age, progress figures and the ETA. The map centers on the runner and follows them as `runner` events arrive. A `notStarted` runner can be selected: the panel says they haven't started and the map does not move.
- **Follow mode.** Panning or zooming by hand pauses following and shows a "Re-center" control. Pressing it, or selecting the runner again, resumes following. Choosing "All runners" stops following and fits all runners again. The selection survives an SSE reconnect.
- **Elapsed time** ticks every second and freezes once the runner is `stopped`. When a value is `null`, show "—".
- **Course line.** Draw it beneath the runner tracks, visually distinct from them. Fetch it once when `hasCourse` is true. While no runner has a position, the initial map view fits the course.
- **ETA.** Show the local clock time ("Finish ≈ 12:41") plus the projected finishing time from `runStartedAt` (`h:mm:ss`). Hide it when `etaAt` is `null`. A `stopped` runner shows their final elapsed time instead.

## Cross-Story Dependencies

- Builds on Epic 1: the projection and `applyRecords` fold, the status machine, the SSE hub and web store, the live map with markers, tracks and the last-update age, `parseGpx` from Story 1.4, and `simulate-runner` for exercising the stats.
- 3.1 provides the distance and pace functions used by 3.2 (stats panel), 3.4 (with a course, distance becomes `progressM`) and 3.5 (ETA uses average pace).
- 3.3 provides course loading, `lengthM`, `hasCourse` and `/api/v1/course`, which 3.4 and 3.5 require.
- 3.4 provides `remainingM`, which 3.5 needs.
- Epic 4's test run measures the watch tolerance and may tune the pace, progress and ETA constants inside `domain` only.
