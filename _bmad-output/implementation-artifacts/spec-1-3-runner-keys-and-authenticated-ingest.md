---
title: 'Story 1.3: Runner keys and authenticated ingest'
type: 'feature'
created: '2026-10-16'
status: 'done'
baseline_commit: '3b561b65353db43ab2112e075a04e37b6f352939'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The server has no way to receive positions. A runner's phone needs an endpoint that accepts batches only with that runner's secret key, stores them durably under that runner, and never lets one runner post as another.

**Approach:** Add a `keygen` script and the single `hashKey()` in `domain`, a SQLite fix log in `store` (`sessions`, `records`, WAL), and `POST /api/v1/ingest` implementing AD-3/AD-5/AD-12: Bearer auth, schema + size checks, session ownership, one insert-or-ignore transaction, ack.

## Boundaries & Constraints

**Always:**
- Runner identity comes only from the key; any runner id in the body is ignored. Key compared in constant time (hash the presented key, `timingSafeEqual` against every configured `keyHash`, no early exit).
- Rejected batches (401/400/413/409) store nothing. Auth runs before the body is parsed, so an unauthenticated request always gets 401.
- `ingest` is the only writer, through `store`, insert-only; the session row is inserted once (first batch) and never updated.
- Error bodies use the standard `{error:{code,message}}`. Logs never contain raw keys, `Authorization` headers or bodies; each accepted batch logs `runnerId`, `sessionId`, record count, `ackedThroughSeq` and `clockSkewMs = receivedAt − max recordedAt`.
- Module graph unchanged (`.dependency-cruiser.cjs` is not edited).

**Never:**
- No projection fold, `onChange`, SSE `runner`/`track` emission or snapshot changes (Story 1.5). No simulator (1.4). No backups (4.1). No contract changes.
- No updates or deletes on `sessions`/`records`; no file copies of the DB.

**Decisions:**
- `ingest` may not import `domain`, so key lookup lives in `config` (`config → domain` is allowed): a `createKeyLookup(config)` returning `(key) => runnerId | undefined`, built on `domain`'s `hashKey`.
- `http` may not import `store`, so `main.ts` opens the store and builds the ingest service, and passes it to `buildApp`. `buildApp`'s routes depend on an `Ingest` interface from `ingest`.
- DB file: `<DATA_DIR>/tracker.db`; `main.ts` creates `DATA_DIR` if missing and closes the DB after `app.close()`.
- Check order after auth: body not JSON / not an object → 400; `records` array longer than 200 → 413; schema failure → 400; owner mismatch → 409.
- Spec size (~2,200 tokens) accepted as-is.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| First batch | valid key, new `sessionId`, seq 0..n | session row (runnerId from key, `sessionStartedAt`, `firstReceivedAt`) + n+1 records with `receivedAt`; `200 {sessionId, ackedThroughSeq: n, serverNow}` | N/A |
| Resend | same batch again | same ack (fresh `serverNow`), row counts unchanged | N/A |
| Overlap | next batch repeats some seqs | new seqs stored, repeats ignored, ack = batch's last seq | N/A |
| Body names runner | extra `runnerId: "bob"` in body, alice's key | stored under alice | N/A |
| No / bad key | header missing, not `Bearer`, or unknown key | `401 UNAUTHORIZED` | nothing stored |
| Bad body | malformed JSON, schema failure (e.g. `lat: 91`, seq not increasing, empty records) | `400 INVALID_BATCH` | nothing stored |
| Too big | 201 records | `413 BATCH_TOO_LARGE` | nothing stored |
| Hijack | bob's key, alice's `sessionId` | `409 SESSION_OWNER_MISMATCH` | nothing stored |
| Restart | close and reopen the same DB file | rows still there, tables not recreated | N/A |

</frozen-after-approval>

## Code Map

- `server/src/domain/` -- empty; add `hash-key.ts` (`hashKey(key): string`, lowercase hex SHA-256 of UTF-8 bytes) + test.
- `server/src/config/load-config.ts` -- `EventConfig`, `RunnerConfig` (already enforces hash format and uniqueness). Add sibling `key-lookup.ts`.
- `server/src/store/` -- empty; `store` may import only `shared`. Add `open-store.ts`.
- `server/src/ingest/` -- empty; may import `store`, `config`, `projection`, `shared`.
- `server/src/http/build-app.ts` -- reuse `errorBody`; global error handler maps 400 → `BAD_REQUEST`, 413 → `PAYLOAD_TOO_LARGE`, so the ingest route needs its own mapping to `INVALID_BATCH`. `BuildAppOptions` gains `ingest`.
- `server/src/http/build-app.test.ts` -- existing tests build the app with `{config, now}`; they must keep passing (pass a stub ingest).
- `server/src/main.ts` / `main.test.ts` -- composition root and boot tests; `DATA_DIR` already resolved but unused. `main.test.ts` is outside module folders, so it may import anything: the end-to-end HTTP + SQLite test goes there or in `ingest`.
- `shared/src/contract.ts` -- `IngestBatch`, `IngestAck`, `ErrorBody`, `MAX_BATCH_RECORDS` (200). `shared/fixtures/valid/ingest-batch.*.json` and `invalid/*` are reusable test inputs.
- `server/scripts/` -- empty; may import only `domain` and `shared`. `server/tsconfig.json` already includes `scripts`.
- `pnpm-workspace.yaml` -- pnpm 12 blocks dependency build scripts by default; `better-sqlite3` must be allowed to install its native binary.

## Tasks & Acceptance

**Execution:**
- [x] `server/src/domain/hash-key.ts` + test -- `hashKey` with a known SHA-256 vector -- AD-5 single hash
- [x] `server/scripts/keygen.ts` + test, root `package.json` script `keygen` -- `pnpm keygen <runnerId>` prints the key, its `keyHash` and a ready-to-paste runner entry; key from `randomBytes(32)` base64url (43 chars) -- AC 1
- [x] `server/src/config/key-lookup.ts` + test -- `createKeyLookup(config)` constant-time match; rejects empty and wrong-length input without throwing -- auth without breaking the graph
- [x] `server/package.json`, `pnpm-workspace.yaml` -- add `better-sqlite3` 13.0.3 and `@types/better-sqlite3` 9.6.0 (exact pins), allow its build -- storage dependency
- [x] `server/src/store/open-store.ts` + test -- `openStore(path)`: WAL, `CREATE TABLE IF NOT EXISTS sessions/records` (PK `(sessionId, seq)`), `sessionOwner(sessionId)`, `appendBatch(...)` in one transaction with `INSERT OR IGNORE`, `close()`; works with `:memory:` and a temp file -- AD-1/AD-12 storage
- [x] `server/src/ingest/ingest.ts` + test -- `createIngest({store, findRunner, now})` exposing `authenticate(authorizationHeader)` and `ingestBatch(runnerId, body)` returning an ack or `{status, code, message}` plus `clockSkewMs`; tests cover every matrix row against a real store -- the protocol
- [x] `server/src/http/build-app.ts` + test -- `POST /api/v1/ingest`: `onRequest` auth → 401, handler maps results, route error handler maps parse errors to `INVALID_BATCH`; logs the batch line; tests assert status/code mapping with a stub and that captured log output never contains the key or body -- wiring
- [x] `server/src/main.ts`, `main.test.ts` -- create `DATA_DIR`, open store, build ingest, pass to `buildApp`, close DB on shutdown; boot test posts a batch through HTTP with a temp `DATA_DIR` and generated key, then checks the DB -- composition
- [x] `README.md` -- document `pnpm keygen`, `POST /api/v1/ingest`, `DATA_DIR` now holding `tracker.db` -- docs

**Acceptance Criteria:**
- Given `pnpm check`, then typecheck, tests and dependency-cruiser pass with the graph unchanged.
- Given `pnpm keygen alice`, then it prints a 43-char base64url key and a 64-char lowercase hex `keyHash` equal to `hashKey(key)`.
- Given a config holding that hash and the server running, when `curl` posts `shared/fixtures/valid/ingest-batch.mixed.json` with the key twice, then both replies are `200` with the same `ackedThroughSeq` and the DB holds one copy of each record under `alice`.
- Given the server logs during those requests, then no line contains the key or a record coordinate, and each accepted batch line has `clockSkewMs`.

## Implementation Notes

- `pnpm-workspace.yaml` unchanged: better-sqlite3 13.0.3 has no install script and bundles prebuilt binaries (`prebuilds/` incl. `win32-x64`, `linux-x64`), so pnpm has nothing to approve. The Code Map's build-approval note was wrong.
- Duplicate seqs are skipped with `ON CONFLICT (sessionId, seq) DO NOTHING`, not `INSERT OR IGNORE`, which would also silently drop rows breaking CHECK/NOT NULL constraints. Same observable behavior.
- Ingest route parse failures: malformed/empty JSON and non-JSON content type → 400 `INVALID_BATCH`; body over Fastify's 1 MiB limit → 413 `BATCH_TOO_LARGE`. Other routes keep the generic codes.
- `server` test script now also runs `scripts/**/*.test.ts` (keygen test). `main.test.ts` gives every boot a temp `DATA_DIR`, so tests never write `<repo>/data`.
- `main.ts` closes the DB after `app.close()` on SIGINT/SIGTERM; not exercised by tests on Windows (`child.kill()` terminates outright). WAL makes an unclean stop safe.
- Store also exposes `readSession` / `readRecords` (used by tests; 1.5 replay will need a reader).
- Verified: `pnpm check` exits 0 (93 server tests); manual `pnpm keygen` + `pnpm dev` + two curl posts gave identical `ackedThroughSeq: 3`, no-header → 401, one session under alice, no key or coordinates in logs.

## Spec Change Log

## Review Triage Log

Pass 1 (blind = B, edge-case = E, verification-gap = V):

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | V: `clockSkewMs` never asserted where max `recordedAt` is not the last record | medium | pre-verified: the only computed assertion uses the mixed fixture, whose max is also the last record | patch |
| 2 | V, B: SIGINT/SIGTERM shutdown path untested | low | real, but a portable signal test on Windows needs new harness; Implementation Notes record the gap | reject |
| 3 | V: `SessionOwnerMismatchError` catch in ingest unreachable/untested | low | synchronous check precedes it; defensive only, store-level test covers the throw | reject |
| 4 | B: end-record coordinates discarded | false | `EndRecord` has no lat/lon; zod strips unknown keys, so there is nothing to store | reject |
| 5 | B: repeated seq with different content accepted silently | low | AD-3 insert-or-ignore by design; `recordCount` vs `inserted` in the log already shows skipped rows | reject |
| 6 | B: later batch with a different `sessionStartedAt` goes unnoticed | low | the owner row is written once by design (AD-12); no named harm | reject |
| 7 | B: no schema version / `user_version` | low | no schema change is planned; a guard for an undemonstrated state | reject |
| 8 | B, E: `ackedThroughSeq` should be the highest contiguous seq / meaning undocumented | false | AD-3 defines it as the batch's last seq; the phone sends oldest-first from its lowest remaining seq, so gaps are seqs the phone never had | reject |
| 9 | B: `clockSkewMs` mixes delay with skew | false | it is the exact formula AD-3/the epics specify | reject |
| 10 | B, E: parse-error response echoes a body snippet (V8 `JSON.parse` message); 415→400 undocumented | low | route errorHandler sends `error.message` as is; fixed messages are a direct correction | patch |
| 11 | B: 401 lacks `WWW-Authenticate` | low | no client reads it; phone branches on status + code | reject |
| 12 | B: no tighter route `bodyLimit` | low | 1 MiB default is bounded; only key holders reach parsing | reject |
| 13 | B, E: `shutdown()` unhandled rejection; repeated signal swallowed while close hangs | low | real: `void shutdown()` with a rejecting close escapes, `shuttingDown` returns silently; small fix | patch |
| 14 | B: `createKeyLookup` trusts hash length | low | the only production caller passes a `loadConfig`-validated config | reject |
| 15 | B: tests leave temp dirs, fixed 100 ms log wait | low | works today; the log line is written before the reply | reject |
| 16 | B: sprint-status `in-progress` vs spec `in-review` | false | the workflow syncs sprint status when the story closes | reject |
| 17 | B: spec task line contradicts Implementation Notes | low | fix edits this spec | reject |
| 18 | B: README stray spaces in curl; no 500 row | low | stray spaces are a direct correction (bundled with #10); 500 is generic, not an ingest code | patch |
| 19 | E: uppercase UUID variant splits a session | low | the phone emits lowercase `UUID.toString()`; a variant creates a separate session, never touches another runner's rows | reject |

## Design Notes

- Fastify `onRequest` runs before body parsing; replying 401 there is what keeps unauthenticated bodies unparsed.
- Constant time: `hashKey(presented)` always runs, then compare its 32 bytes with `timingSafeEqual` against every runner's hash buffer and remember the match; never `===` on strings.
- Optional fields (`altitudeM`, `speedMps`, end-record coordinates) are SQL `NULL` in storage; the wire rule "omitted, never null" applies to JSON only.

## Verification

**Commands:**
- `pnpm check` -- expected: exit 0
- `pnpm keygen alice` -- expected: key + hash + JSON entry
- Temp config with that hash, `EVENT_CONFIG=<it> DATA_DIR=<tmp> pnpm dev`, then `curl -X POST -H "Authorization: Bearer <key>" -H "content-type: application/json" --data @shared/fixtures/valid/ingest-batch.mixed.json http://127.0.0.1:8787/api/v1/ingest` twice -- expected: identical `ackedThroughSeq`; without the header → 401
