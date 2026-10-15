---
review: adversary
target: ARCHITECTURE-SPINE.md (running-live-tracker, 2026-10-15, draft)
date: 2026-10-15
method: Build pairs of units one level below the spine. Each unit follows every AD exactly as written, and the pair still fails to fit together.
---

# Adversarial Review — Architecture Spine

## Verdict

**NOT BUILD-READY. The paradigm is sound, but the spine has holes.** The paradigm (an append-only log, a fold-based projection, and a store-and-forward outbox) is the right one. The holes are at the seams. Each of the pairs below obeys AD-1 to AD-11 exactly and still produces a system that is wrong or does not fit together. Five of the holes are severe enough to break the race-day experience:

- H1: test-run data leaks into the race.
- H2: live state differs from state replayed after a restart.
- H4: one bad record jams the outbox forever.
- H7: elapsed time keeps running after Stop.
- H9: `RunnerView` and the track point format are not specified.

All of them can be fixed by tightening a rule. None needs a change of paradigm.

Severity scale: **S1** = wrong data on race day or a stuck system · **S2** = units won't fit together and the problem shows up at integration · **S3** = ambiguity that will cost rework.

---

## H1 — Sessions are not bound to an event (test-run fixes join the race run) — S1

- **Pair:** `server/store` schema story vs `server/projection` replay story (plus the Android outbox).
- **Both obey:** AD-1 says to replay the log at boot. AD-4 says "all sessions a runner sends during that event join into one run". The seed says the test run uses "its own `eventId`", and the data dir is the same for both.
- **Clash:** The store keys records by `(sessionId, seq)` and stores neither an `eventId` nor a `runnerId` per session. The projection replays "all sessions of runner X", so the race-day boot pulls in the test run's sessions and `runStartedAt` becomes the test-run date. There is a second way to hit this. The phone never knows about events, so outbox rows left over from the test run that get delivered on race morning are attributed to the race (they are "sent during that event").
- **Proposed rule (new AD-12 "Session ownership"):** `store` keeps a `sessions` table `(sessionId PK, runnerId, eventId, sessionStartedAt, firstReceivedAt)`. The row is written once by ingest, from the authenticated runner and the *active* `eventId`. The projection replays only `sessions.eventId = activeEventId`. The event config gains `opensAt` (epoch ms). Ingest stores a session whose `sessionStartedAt < opensAt` but tags it `eventId = null`, and acks it normally so the phone drains it, but no event includes it. If a batch arrives for an existing `sessionId` with a different `runnerId`, the reply is `409 SESSION_OWNER_MISMATCH`. The first stored `sessionStartedAt` wins.

## H2 — Projection fold order is undefined, so live state and replayed state diverge (breaks AD-1's restart guarantee) — S1

- **Pair:** `projection` live path (applies each batch as it is ingested) vs `projection` boot replay (applies `ORDER BY session start, seq`).
- **Both obey:** AD-4 says to apply fixes in `(session start, seq)` order and that a fix not later than the last applied one has no effect. AD-1 says to rebuild by replaying.
- **Clash:** The live path applies records in the order they *arrive*. The replay applies them in *sorted* order. The non-monotonic filter and the forward-only `progressM` window both depend on order, so any difference in order gives different stats after a restart. There are three ways the orders can differ:
  - a session's records are stored with a gap that is filled later;
  - two sessions overlap in `recordedAt`;
  - "session start" is read as phone `sessionStartedAt` by one implementer and as server `firstReceivedAt` by another.
- **Proposed rule (tighten AD-4):** The canonical fold order is `(sessions.sessionStartedAt, sessionId, seq)`. The projection consumes **only the contiguous prefix of each session (seq ≤ ackedThroughSeq)**, and a session is consumed only after every earlier-ordered session for that runner has either an `end` record or a later session. Live and replay call the same `applyRecords(state, orderedRecords)` function. There must be a test showing that replaying the DB produces a `RunnerView` deep-equal to the live state after an arbitrary interleaving of batches.

## H3 — `ackedThroughSeq` edge cases and outbox deletion scope — S1/S2

- **Pair:** Android uploader story vs server ingest story.
- **Both obey:** AD-3 to the letter.
- **Clashes:**
  1. **No contiguous prefix exists.** Seq 0 was never stored (the phone lost it, or a bug started at 1). The server's value is undefined (`-1`? `null`? field omitted?). If the server returns `-1`, the phone deletes nothing and sends the same oldest batch forever. Nothing in the spine detects that this is a livelock.
  2. **Server gap, phone already deleted.** After a server restore from backup, or a DB wipe during dev, the server's prefix ends below rows the phone has already deleted. The phone resends from its oldest *remaining* row (say seq 300). The server's contiguous prefix stays at 120 forever, the ack never reaches 300, and the outbox never drains.
  3. **Deletion scope.** "Delete outbox rows with `seq ≤ ackedThroughSeq`" does not say *of which session*. An uploader that does `DELETE WHERE seq <= ?` deletes rows from a newer session that are still unsent.
  4. **Batch spanning sessions.** The batch shape `{sessionId, records[]}` forces one session per batch, but no rule says so. An uploader that takes "oldest 200 rows" across sessions mislabels the second session's rows.
  5. **Partial insert.** Insert-or-ignore without a transaction can crash halfway through a batch, and AD-3 does not require atomicity.
- **Proposed rule (tighten AD-3):** `IngestAck = {sessionId, ackedThroughSeq: int ≥ -1}`, where `-1` means nothing contiguous. A batch contains records of exactly one session, ordered by seq, and is inserted in one SQLite transaction. The phone deletes `WHERE sessionId = ack.sessionId AND seq ≤ ack.ackedThroughSeq`. **Gap-tolerant ack:** if the batch's first seq is greater than the server's contiguous prefix + 1, the server replies `409 SEQ_GAP {expectedSeq}`. On `SEQ_GAP` the phone logs the error and, when it holds no rows below `expectedSeq`, sends an explicit `gapAck` request (or the server is allowed to treat the hole as permanent). Without some rule like this, case 2 never recovers. The simpler acceptable alternative is to define the ack as "highest seq stored for this session such that the phone has nothing lower left", which requires the phone to always send its lowest remaining seq, and the server to treat `firstSeqInBatch − 1` as acknowledged.

## H4 — A single bad record jams the outbox forever — S1

- **Pair:** Android fix-writer story (writes a `Location` to Room) vs server ingest validation story (validates against zod, `400` on failure).
- **Both obey:** AD-9 says a validation failure gets `400 ErrorBody`. AD-3 says a rejected batch leaves the outbox untouched and is retried forever.
- **Clash:** Android `Location` can have `hasAccuracy() == false`, `NaN` values, or a `speedMps` that is negative or not reported. If the writer stores `accuracyM = 0` or `null`, or the zod schema requires `accuracyM > 0`, that batch fails permanently. Because the phone always sends the oldest record first, nothing after it is ever delivered. A batch over 200 records, or a body bigger than Fastify's default limit (413), causes the same jam.
- **Proposed rule (new, in AD-3/AD-9):** The phone validates every record against the Kotlin contract **before** writing it to Room, and drops fixes that have no accuracy or have non-finite coordinates. The zod schema and the Kotlin classes share one numeric domain, published in the fixtures: `lat ∈ [-90,90]`, `lon ∈ [-180,180]`, `accuracyM > 0` (required), and optional fields omitted rather than null. The server sets `bodyLimit ≥ 200 × max record size` and rejects with `400 BATCH_TOO_LARGE` only when `records.length > 200`. **`400` is terminal for that batch.** The phone moves the batch's rows to a `quarantine` table, so they are never deleted silently and stay exportable, and carries on with the next ones. Only network errors, `5xx`, `401` and `429` are retried.

## H5 — Two owners of the seq counter and of the `end` record — S2

- **Pair:** Android Stop-button/Activity story vs tracking foreground-service story.
- **Both obey:** AD-3 says Stop puts an `end` record after the last fix. AD-10 says seq is persisted in Room.
- **Clash:** The Activity's Stop handler reads `nextSeq`, writes `end`, then stops the service. At the same moment, the service's `onLocationResult` callback reads the same `nextSeq` and writes a fix. The result is a duplicate `(sessionId, seq)`, or a fix after `end`. Insert-or-ignore on the server then **silently drops** one of them, possibly the `end`, so the status stays `active` forever. A fix that lands after `end` gives "stopped" a meaning that depends on order.
- **Proposed rule:** The service owns the session state outright. Seq allocation and the outbox insert happen in one Room `@Transaction` inside a single-threaded writer owned by the service. Stop is a command sent *to* the service, and the service does three things in order: it removes location updates, it drains pending callbacks, and it writes `end`. The server stores records with `seq > endSeq` but the projection ignores them. When an ignored duplicate's payload differs from the stored one, the server logs `SEQ_CONFLICT` (it does not reject the batch, to keep retries idempotent).

## H6 — "Keep retrying after Stop" vs the service lifecycle — S2

- **Pair:** AD-10 service story (the service holds a persistent notification and the uploader is a coroutine owned by the service) vs AD-3 uploader story (it retries until the outbox is empty, even after Stop).
- **Both obey:** A natural Stop implementation calls `stopSelf()`, which cancels the uploader coroutine while rows are still pending. AD-10 forbids WorkManager, so nothing else drains the outbox. If the phone is offline when the runner taps Stop at the finish line, the last kilometres and the `end` record never arrive.
- **Proposed rule (tighten AD-10):** After Stop, the service stays in the foreground in a `DRAINING` state, with a notification that reads "Uploading N pending". It calls `stopSelf()` only once the outbox is empty or the user cancels explicitly. When the app launches, the Activity restarts the service if the outbox is not empty. The draining phase must also have a valid foreground-service type (`location` while location is no longer requested is questionable on API 34+, so declare `dataSync|location` and pick the type when calling `startForeground`).

## H7 — Stopped runners, elapsed time, and which "elapsed" avg pace uses — S1

- **Pair:** web stats-panel story vs `domain` pace story.
- **Both obey:** AD-2 says the web computes elapsed as `now − runStartedAt`. AD-8 says `avgPace = elapsedS / km`.
- **Clashes:**
  1. When a runner finishes and is `stopped`, the web's elapsed time keeps growing forever.
  2. The server's `elapsedS` for avg pace is undefined. It could be `lastFixAt − runStartedAt`, or server `now − runStartedAt`. In the second case avg pace would change between batches with no new data, and no event is sent for that. The pace shown and the elapsed shown then disagree.
  3. ETA is still emitted for a stopped runner.
- **Proposed rule (tighten AD-2/AD-8):** `RunnerView` carries `runEndedAt: number | null`, the `recordedAt` of the `end` record of the latest session. The web computes elapsed as `(runEndedAt ?? now) − runStartedAt`. On the server, `elapsedS = (lastAppliedFix.recordedAt − runStartedAt) / 1000` and nothing else. When `status = stopped`: `currentPaceSPerKm = null` and `etaAt = null`. Status transitions are `notStarted → active` on the first *accepted* fix; `active → stopped` on an `end` record in the contiguous prefix of the latest session; `stopped → active` on an accepted fix in a newer session, which also clears `runEndedAt`. A session made only of an `end` record does not change `notStarted`.

## H8 — "Accepted fix" has three different meanings — S2

- **Pair:** `domain` filter functions vs `projection` fold (and the web track renderer).
- **Both obey:** AD-4 says `runStartedAt` is the first *accepted* fix and that a non-monotonic fix has no effect. AD-7 says fixes worse than 30 m are skipped by all projections, and an off-course fix leaves progress unchanged. AD-8 says current pace uses accepted fixes.
- **Clash:** One implementer takes "accepted" to mean *stored* (insert succeeded), so a 60 m-accuracy warm-up fix sets `runStartedAt`. Another takes it to mean "passes accuracy". Off-course fixes might count toward the track, `lastFixAt`, the pace window, or no-course distance, depending on who reads the rule. Current pace's "200 m" could be measured along the track or along the course. And `lastFixAt` could come from the last stored fix (which keeps "age" fresh when the GPS is bad) or the last accepted fix.
- **Proposed rule:** `domain` exports `isAccepted(fix, state): boolean`, true when `accuracyM ≤ 30` and `recordedAt > state.lastAppliedAt`. That one predicate defines `runStartedAt`, `lastFixAt`, track membership, `lastPosition`, and pace-window membership. Off-course fixes are accepted, so they are tracked and timed, but they don't move `progressM`. The pace-window distance uses the same basis as `distanceM` (course progress when a course exists, filtered track distance otherwise).

## H9 — `RunnerView`, `Snapshot.event`, and the track point format are not enumerated — S1/S2

- **Pair:** `projection` RunnerView builder vs `web` store, map, and stats panel. A second pair: snapshot serializer vs config loader.
- **Both obey:** AD-9 says the shapes live in `shared/contract.ts`, but the spine fixes no fields. AD-7 says `percent = progressM / lengthM`.
- **Clashes:**
  1. `percent` could be 0–1 or 0–100.
  2. The marker could come from `RunnerView.lastPosition` or from the last track point.
  3. `displayName`/`color` could be in `RunnerView` or in `snapshot.event.runners`.
  4. **Coordinate order:** the course is GeoJSON `[lon, lat]`, while a Leaflet-minded projection emits track points as `[lat, lon]`. Every point would land in the wrong place, maybe in the sea.
  5. `tracks` could be `Record<runnerId, Point[]>` or `Array<{runnerId, points}>`.
  6. **Key leak:** a snapshot story that serializes the loaded config object as `event` publishes every `keyHash` on an unauthenticated endpoint. AD-5 does not forbid this.
- **Proposed rule (extend AD-9 with the normative field list):**
  - `RunnerView = {runnerId, status, runStartedAt|null, runEndedAt|null, lastFixAt|null, lastPosition: {lat, lon}|null, distanceM, progressM|null, remainingM|null, progressFraction (0..1)|null, offCourse: boolean, avgPaceSPerKm|null, currentPaceSPerKm|null, etaAt|null}`. Rename `percent` to `progressFraction`.
  - `EventInfo = {eventId, name, hasCourse, runners: [{runnerId, displayName, color: "#rrggbb"}]}`. This is a separate public schema, `.strict()`, and **never** derived by spreading the config object.
  - `TrackPoint = {lat, lon, recordedAt}`. Objects are used, never tuples, everywhere except the GeoJSON course.
  - `Snapshot.tracks: Record<runnerId, TrackPoint[]>` includes every configured runner (empty array if there are no fixes).

## H10 — SSE framing, emission owner, and event order — S2

- **Pair:** `live` SSE hub story vs `web` live-client story. A second pair: `http` ingest route vs `projection` change emitter.
- **Both obey:** AD-6 names the events `snapshot`, `runner`, and `track`.
- **Clashes:**
  1. Framing: the server could use `event: runner` + `data: RunnerView`, while the client uses `onmessage` and expects `{type, payload}`, so it receives nothing.
  2. Emission owner: the dependency graph lets `http → live` and also `live → projection`. One story has the ingest route call `live.broadcast()` after ingest, while another has `live` subscribe to a projection emitter. Every update is then sent twice, or never if each story assumes the other one sends it.
  3. A resend made only of duplicates may or may not emit events. A batch whose fixes are all filtered out may or may not emit an empty `track` event.
  4. Events might go out before the DB commit (so they are lost if the commit fails), and `runner` and `track` might arrive in either order.
- **Proposed rule (tighten AD-6):** Events use named SSE `event:` fields with exactly the names `snapshot | runner | track`, and the `data:` is the bare zod payload (`Snapshot`, `RunnerView`, `{runnerId, points: TrackPoint[]}`). The projection is the **only** emitter, through `onChange({runnerId, view, appendedPoints})`, called after the store transaction commits. `live` is the only subscriber, and `http` never calls `live` for ingest. For each change the server emits `track` (only if `points.length > 0`) **before** `runner`. It emits nothing if the `RunnerView` is deep-equal to the previous one and no points were appended.

## H11 — Clock offset and phone clock skew — S2/S3

- **Pair:** web age-ticker story vs projection `lastFixAt` story.
- **Both obey:** AD-2 says to correct `now` by the `serverNow` offset. The conventions say `recordedAt` is phone time.
- **Clashes:**
  1. Only `snapshot` carries `serverNow`, so in SSE mode the offset is measured once, and its sign convention is not stated (`serverNow − Date.now()` or the reverse).
  2. `lastFixAt` and `runStartedAt` are on the *phone* clock, so correcting the browser to the server clock does not remove phone/server skew. When a fused-provider fix comes from the network rather than GNSS, `Location.time` is the system time, and the age can be negative or wrong by minutes.
- **Proposed rule:** `offsetMs = snapshot.serverNow − Date.now()` at receipt, and `now = Date.now() + offsetMs`. Displayed ages are clamped to `≥ 0`. The phone uses `Location.getTime()` (UTC) for `recordedAt` and never `elapsedRealtimeNanos` arithmetic against wall time. Ingest logs `receivedAt − max(recordedAt)` per batch, and when the skew is above 30 s, the `RunnerView` carries `clockSkewSuspect: true`. It would also be reasonable to define the age as `now − lastReceivedAt`, using a server-clock field, and decide the meaning in the spec. Pick one explicitly.

## H12 — The course-absent case is unspecified across three units — S2

- **Pair:** `http` `/api/v1/course` story vs `web` map story vs `projection`.
- **Both obey:** AD-7 says to use filtered track distance when there is no course. `coursePath?` is optional.
- **Clash:** With no course, the course route could return `404 COURSE_NOT_FOUND`, `200 null`, or an empty `LineString`. The web might treat 404 as an error state and retry forever. The `RunnerView` might carry `progressM = 0` or `null`, and the web might show "0% of 0 km" or divide by zero. It is also unclear where a relative `coursePath` resolves from (the cwd or `config/`), and which GPX elements count (`trk/trkseg`, several segments, or `rte`).
- **Proposed rule:** `EventInfo.hasCourse` is authoritative. If it is false, the web never requests `/course`, and the server answers `404 NO_COURSE`. When there is no course, `progressM`, `remainingM`, `progressFraction` and `etaAt` are `null`, never 0. `coursePath` is resolved relative to the directory containing `event.json`. The GPX loader concatenates all `trkseg`s of the first `trk` in file order (falling back to the first `rte`), uses haversine 2D for `lengthM`, and refuses to boot when there are fewer than 2 points.

## H13 — Keygen and config loader disagree on the key and hash encoding; the dependency graph leaves keygen and course building without a home — S2

- **Pair:** `server/scripts/keygen` vs `server/config` loader + `ingest` auth.
- **Both obey:** AD-5 says SHA-256 of the key is compared in constant time with `keyHash`.
- **Clashes:**
  1. Keygen prints the hash as base64 while the loader expects hex, or the reverse. Or the phone user pastes the key with a trailing newline or space and gets a 401.
  2. `scripts/` and `config/` are not in the dependency graph. Config may not import `domain` (it has no outgoing arrows), but AD-7 says config builds "a polyline with cumulative distance", which needs `domain`'s haversine. That forces either a second distance function or a graph violation.
  3. `http` serves `/api/v1/course` and `lengthM` but may not import `config`.
- **Proposed rule:**
  - The key is 32 random bytes, base64url, with no padding (43 chars). `keyHash` is lowercase hex SHA-256 of the key's UTF-8 bytes. The config schema enforces `/^[0-9a-f]{64}$/` and unique `runnerId`/`keyHash`. The phone trims the key before saving and validates it with the same regex.
  - Put `hashKey()` in `shared/` (or `domain`) and use it from both keygen and auth.
  - Add arrows to the graph: `config → domain` (for course building) or move polyline building into `projection`; `http → config` (read-only, for `/course` + `EventInfo`); and `scripts → shared/domain`. Name `main.ts` as the only composition root.

## H14 — The forward window can lock a runner off-course for the whole race — S3

- **Pair:** `domain` progress function vs the race-day operator.
- **Both obey:** AD-7 says the window is `[last − 50, last + 1000]`, starting from `progressM = 0`.
- **Clash:** If a runner presses Start late (1.2 km in), or the app is restarted after a long tunnel or offline stretch with only filtered fixes, every fix falls outside the window. The runner is `offCourse` and stuck at progress 0 for the rest of the run. AD-7 has no recovery path. It is also ambiguous whether "more than 100 m from the course" means distance to the windowed segment or to the whole course.
- **Proposed rule:** The off-course distance is measured to the **windowed** segment. After `N = 6` consecutive accepted fixes that are off-course in the window but within 100 m of the course *ahead* of `progressM`, the projection re-acquires at the nearest forward point (forward only). N and the thresholds are named constants in `domain`.

## H15 — Changing the runner key while the outbox is pending — S3

- **Pair:** Android settings (DataStore) story vs uploader story.
- **Both obey:** AD-5 says identity comes only from the key. AD-11 says `runnerKey` is in DataStore.
- **Clash:** If the phone is lent to another runner, or the key is fixed after a typo, the rows still pending upload under the old key's session are sent with the new key and land in another runner's run. Before H1's owner check exists, this happens silently.
- **Proposed rule:** The key, or its hash, is captured in the session row at Start, and the uploader authenticates each batch with its session's key. Changing the key is blocked while a session is active. Rows left over from an older key get a `409 SESSION_OWNER_MISMATCH` (H1) and are quarantined (H4).

---

## Summary of proposed spine edits

| Hole | Edit | Sev |
| --- | --- | --- |
| H1 | New AD-12: sessions table binds `sessionId → (runnerId, eventId)`; config `opensAt`; 409 on owner mismatch | S1 |
| H2 | AD-4: canonical order `(sessionStartedAt, sessionId, seq)`, contiguous-prefix-only consumption, live ≡ replay test | S1 |
| H3 | AD-3: ack shape `{sessionId, ackedThroughSeq ≥ -1}`, one-session batch, txn insert, delete scoped by session, `SEQ_GAP` recovery | S1 |
| H4 | AD-3/9: validate before enqueue; 400 is terminal, so quarantine; shared numeric domain in fixtures | S1 |
| H5 | AD-10: service is the only seq/outbox writer; Stop is a command; post-`end` records ignored | S2 |
| H6 | AD-10: `DRAINING` foreground state after Stop; restart on launch if outbox not empty | S2 |
| H7 | AD-2/8: `runEndedAt`; server `elapsedS` from last applied fix; status transition table | S1 |
| H8 | AD-7/8: single `isAccepted` predicate drives all derived fields | S2 |
| H9 | AD-9: enumerate `RunnerView`, `EventInfo` (no keyHash), `TrackPoint {lat,lon,recordedAt}`, `tracks` map | S1 |
| H10 | AD-6: named SSE events, bare payloads, projection is the only emitter post-commit, track-before-runner, no empty events | S2 |
| H11 | AD-2: offset formula + sign, clamp ages, skew flag; pick the meaning of "age" | S2 |
| H12 | AD-7: `hasCourse`, null (not 0) fields, 404 `NO_COURSE`, path resolution, GPX parsing rule | S2 |
| H13 | AD-5 + graph: key/hash encoding, shared `hashKey()`, add `config→domain`, `http→config`, `scripts→shared` | S2 |
| H14 | AD-7: windowed distance, re-acquire after N forward-near fixes | S3 |
| H15 | AD-5: key bound to session; key change blocked during active session | S3 |
