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
