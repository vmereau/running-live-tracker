---
title: 'Story 1.5: Live runner projection and change events'
type: 'feature'
created: '2026-10-16'
status: 'done'
baseline_commit: '180a4fe18ee8fa40e0e0fc7f2650ef3a8fc1df65'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Snapshots always show every runner `notStarted` with an empty track, and SSE clients never hear about new positions. Stored records are invisible to spectators.

**Approach:** Add an in-memory projection in `server/src/projection`. A pure `applyRecords(state, records)` folds each runner's in-window records in canonical order `(sessionStartedAt, sessionId, seq)` into a `RunnerView` plus a track. It is rebuilt from SQLite at boot. After each committed batch, ingest notifies the projection, which emits `onChange({runnerId, view, appendedPoints})` to the SSE hub. The hub broadcasts `track` and then `runner`. Snapshots are served from the projected state.

## Boundaries & Constraints

**Always:**
- The fold follows AD-4 exactly. `isAccepted` = `kind fix ∧ accuracyM ≤ 30 ∧ recordedAt > lastFixAt` (no prior fix → true). Only accepted fixes set `runStartedAt` (first only), `lastFixAt`, `lastPosition`, and append `{lat, lon, recordedAt}` to the track. Every folded record sets `lastReceivedAt = max(lastReceivedAt, receivedAt)`. Status: `notStarted` → `active` on the first accepted fix. `active` → `stopped` on an `end` record, with `runEndedAt` = the end's `recordedAt`. `stopped` → `active` on an accepted fix, which clears `runEndedAt`. An `end` while `notStarted` changes nothing except `lastReceivedAt`. Records after their session's `end` are ignored completely.
- Only sessions with stored `sessionStartedAt ∈ [opensAt, closesAt]` (inclusive) of configured runners are folded. The stored `sessionStartedAt` (the first one written) is canonical.
- Epic 3 fields keep the contract defaults: `distanceM` 0, `offCourse` false, the others `null`.
- The live path and boot replay both use `applyRecords`. Live state must always deep-equal a fresh replay of the same DB, whatever order the batches arrived in.
- `onChange` fires only after the store transaction commits. Ingest calls the projection, never `live`. Nothing is emitted when the view is deep-equal to the previous one and no points were appended. The hub writes `track` (only if there are points) and then `runner`, each with `serverNow`.
- `.dependency-cruiser.cjs` stays unchanged. No contract change.

**Never:**
- No persisted derived values and no schema migration (adding a read query is fine). No web changes (Story 1.6). No distance, pace, course or ETA math (Epic 3).

**Decisions:**
- Spec size (~2,000 tokens) accepted as-is.
- **Fast path:** a commit whose lowest inserted canonical key sorts after the runner's last folded key folds only the records after that key. **Fallback:** any other commit refolds that runner from the store. If the refolded track is not the old track plus a suffix, the hub sends a fresh `snapshot` event to every client instead of `track`/`runner`. This only happens when sessions arrive out of order, which AD-3 rules out for a well-behaved phone.
- Ingest notifies the projection after every accepted batch, even when nothing new was inserted. The projection then folds whatever lies after its last key, so a projection failure (500 → phone retries) heals on the next batch.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior |
|----------|--------------|---------------------------|
| First fix | notStarted, fix acc 5 | active, runStartedAt=lastFixAt=recordedAt, one `track` then `runner` |
| Poor accuracy | fix acc 30.1 (30 exactly accepted) | not in track; lastReceivedAt updated; `runner` only |
| Non-increasing time | fix with recordedAt ≤ lastFixAt | ignored except lastReceivedAt |
| Duplicate resend | batch already stored | no emit |
| End then new session | end in S1, accepted fix in S2 | stopped with runEndedAt, then active with runEndedAt null |
| After end | S1 records with seq > end's seq | ignored, lastReceivedAt unchanged |
| Outside window | session started before opensAt | stored and acked; snapshot unchanged; no emit |
| Late older session | S2 folded, then S1 backlog arrives | state = replay; hub sends `snapshot` |
| Restart | file DB with sessions of 2 runners | snapshot deep-equal to before restart |

</frozen-after-approval>

## Code Map

- `server/src/projection/snapshot.ts` -- keep `buildEventInfo` and the not-started view (export it as the initial view). `buildSnapshot` takes the projected views and tracks instead of fabricating them.
- `server/src/store/open-store.ts` -- add `readRunRecords(runnerId, opensAt, closesAt, after?)`: records joined with `sessions.sessionStartedAt`, filtered by runner and window, ordered canonically, optionally strictly after a key (SQLite row-value `>`). `appendBatch` also returns `firstInsertedSeq: number | null`.
- `server/src/ingest/ingest.ts` -- takes a `projection` dependency. After `appendBatch` succeeds, call `projection.recordsCommitted({runnerId, sessionId, firstInsertedSeq})`. Never call it on a rejection.
- `server/src/live/sse-hub.ts` -- add `publish(change)` (track/runner frames, or a snapshot frame on a track reset) and an injected `now` for `serverNow`. Reuse `write()`.
- `server/src/http/build-app.ts` -- takes `projection`. `getSnapshot` = `projection.snapshot(now())`. Subscribe `hub.publish` to `projection.onChange`. `http` may not import `store`, so tests use a stub projection.
- `server/src/main.ts` -- open the store, then `createProjection({config, store})` (boot replay), then ingest, then the app.
- Tests: `ingest.test.ts`, `build-app.test.ts`, `sse-hub.test.ts`, `snapshot.test.ts` and `main.test.ts` follow the existing patterns (`:memory:` store, `app.inject`, `startMain`/`freePort`, temp `DATA_DIR`).

## Tasks & Acceptance

**Execution:**
- [x] `server/src/store/open-store.ts` + test -- `readRunRecords` (order, window bounds, other runner excluded, `after`) and `firstInsertedSeq` -- data source for the fold
- [x] `server/src/projection/apply-records.ts` + test -- `RunRecord`, `RunnerState`, `initialRunnerState`, `isAccepted`, pure `applyRecords`, `toRunnerView`. Tests cover every fold row of the matrix -- AC 1
- [x] `server/src/projection/create-projection.ts` + test -- boot replay, `recordsCommitted` (fast path / refold / track reset), `snapshot(now)`, single `onChange` listener. Tests: emit/no-emit rows, out-of-window, live-equals-replay over seeded random batch interleavings (2 runners, 3 sessions, duplicates), restart against a temp SQLite file -- AC 2, 3
- [x] `server/src/projection/snapshot.ts` + test -- builds from projected state
- [x] `server/src/live/sse-hub.ts` + test -- `publish` frame order, `serverNow`, snapshot on reset, dead clients skipped
- [x] `server/src/ingest/ingest.ts` + test -- projection called after commit (including duplicates), never on 400/409/413
- [x] `server/src/http/build-app.ts` + test, `server/src/main.ts` + `main.test.ts` -- wiring. E2E: the SSE client receives `track` then `runner` after a POST, and the snapshot is identical after a restart

**Acceptance Criteria:**
- Given `pnpm check`, then typecheck, tests and dependency-cruiser pass.
- Given a running server and an open `/api/v1/live` stream, when `pnpm simulate` runs, then the stream carries `track`/`runner` events and `/api/v1/snapshot` shows the runner `active` and then `stopped`, with the full track.

## Implementation Notes

## Spec Change Log

## Review Triage Log

Pass 1 (blind = B, edge-case = E, verification-gap = V):

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | B: new build-app SSE test read loops ignore `done` and have no deadline | low | confirmed at `build-app.test.ts:503-506`; an early stream end spins forever; the file's own `readUntil` helper is a direct correction | patch |
| 2 | V, E: a missed notification for a batch keyed at or before `lastKey` is not healed by a duplicate resend | low | real, but needs `readRunRecords`/`readSession` to throw right after the same DB committed; the spec decision only promises healing after the last key; fix adds a dirty-flag guard | reject |
| 3 | E, B: listener throwing after state update loses the broadcast | false | `hub.publish` only builds plain JSON and writes through `write()`, which swallows socket errors; no reachable throw | reject |
| 4 | E, B: projection throw after commit returns 500, ambiguous in logs | low | the frozen decision chooses 500 + phone retry; Fastify logs the error with its stack | reject |
| 5 | E, B: single `onChange` listener with no unsubscribe | low | `main.ts` builds one app per projection; after `close()` the hub has no clients so `publish` returns early | reject |
| 6 | E: duplicate resend does not refresh `lastReceivedAt` | false | AD-4 defines it from stored records' `receivedAt`; refreshing it on duplicates would make live differ from replay | reject |
| 7 | B: out-of-window sessions are acked silently | low | AD-12 mandates "stored and acked but never shown"; window misconfiguration is caught by the 4.3 dry run | reject |
| 8 | B: no index for `readRunRecords` | low | `sessions` holds a handful of rows; records are reached via the `(sessionId, seq)` PK; ~3,600 rows per runner per race | reject |
| 9 | B: track copied per batch (O(n²)) | low | ~1,800 batches × ≤3,600 points over 5 h is a few million element copies in total; negligible | reject |
| 10 | B: fixed 200 ms sleep in e2e "no emit on resend" | low | can only pass vacuously on a slow box, never fail falsely; a sentinel needs test restructuring | reject |
| 11 | B: track reset not covered end to end | low | covered at projection (`late older session` test) and hub (`snapshot on reset`) level; web handling is Story 1.6 | reject |
| 12 | V, B: boot-replay failure path and replay duration unlogged/untested | low | only reachable with a corrupt DB; without the catch the process still exits non-zero | reject |
| 13 | B: `views` map duplicates derivable state | low | both maps are set together in one function; no named caller that diverges | reject |
| 14 | B: missing tests (`now` source, unknown runner via HTTP, 500 route, `after` with out-of-window sessions) | low | the query ANDs the window filter with the row-value key; unknown runner unreachable (keys map to configured runners); rest are wiring already covered by typecheck | reject |
| 15 | B: `deepStrictEqual` on a number; double `live.close()` | false | both are correct and harmless | reject |
| 16 | B: spec and sprint-status absent from the diff | false | by design: the spec is the claims file given to the edge-case layer | reject |

## Verification

**Commands:**
- `pnpm check` -- expected: exit 0

**Manual checks (if no CLI):**
- `pnpm dev` with a temp config, `curl -N http://127.0.0.1:8787/api/v1/live` in one shell and `pnpm -s simulate …` in another: frames arrive live. After restarting the server, `/api/v1/snapshot` is unchanged.
