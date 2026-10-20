- source_spec: `_bmad-output/implementation-artifacts/spec-1-6-live-map-web-page.md`
  summary: The web live client (SSE event-name wiring to the store and the 3 s EventSource recreate after CLOSED) has no automated test.
  evidence: No test imports `web/src/live-client.ts`; event names are string literals on both server and client, not shared constants; renaming a listener or dropping the recreate passes `pnpm check`. Needs an injectable EventSource factory or shared event-name constants.
- source_spec: `_bmad-output/implementation-artifacts/spec-1-6-live-map-web-page.md`
  summary: The map page may show stale data with no banner if a phone browser keeps an SSE stream "open" but silent after backgrounding (no ping-timeout or visibilitychange recovery).
  evidence: Unverified (would be medium). Settle it in the Story 4.3 phone soak test: background the browser for minutes, return, and check whether EventSource errors/reconnects or stays silently stale.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-1-android-app-scaffold-settings-and-wire-contract.md`
  summary: The Kotlin `HealthResponse` (ok, serverNow, eventId) is not linked by any shared fixture to the server's `/api/v1/health` payload, so drift would pass both test suites.
  evidence: `HealthClientTest` and `build-app.test.ts` each use their own literal body; `shared/fixtures` has no health fixture. Fix by adding a shared health fixture read on both sides (needs a shared change, forbidden in 2.1).
- source_spec: `_bmad-output/implementation-artifacts/spec-2-3-uploading-positions-with-acks-retries-and-offline-buffering.md`
  summary: Strict oldest-session-first uploading lets a session stuck on a persistent retry (e.g. 401 after its key was revoked or rotated) block every newer session, including the live one, with no indication on screen.
  evidence: `Uploader.flush` returns on the first Retry and always restarts at `nextUploadSession()` (oldest with rows). Needs rows stranded in an older session plus a server-side key change; decide a skip/cap policy and an "auth failing" indicator with Story 2.4 draining.
- source_spec: `_bmad-output/implementation-artifacts/spec-2-4-finishing-uploads-after-stop.md`
  summary: On Android 14 and below, draining after Stop never ends when uploads are stuck on a retry (401 after a key change, invalid or cleared server URL), leaving a permanent foreground notification and a flush every 60 s.
  evidence: `onTimeout` (the only exit besides an empty outbox) runs on API 35+ only and minSdk is 29. The 2.4 decision kept strict draining "until the outbox is empty or the OS timeout". Needs a cap (time or attempts) or a skip policy, decided together with the 2.3 oldest-first deferred item.
- source_spec: `_bmad-output/implementation-artifacts/spec-3-1-distance-pace-and-elapsed-time.md`
  summary: Unverified (medium if true): GPS jitter from accepted fixes (≤ 30 m accuracy) on a slow or stationary runner may inflate `distanceM` and make the average pace look faster, because every accepted segment is summed with no minimum-movement filter.
  evidence: `applyRecords` adds `segmentDistanceM` for every accepted fix. Settle it with the Epic 4 test-run comparison against the watch; if confirmed, add a movement threshold inside `domain/stats.ts`.
