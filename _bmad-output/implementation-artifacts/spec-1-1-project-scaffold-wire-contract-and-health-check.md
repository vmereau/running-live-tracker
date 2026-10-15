---
title: 'Story 1.1: Project scaffold, wire contract and health check'
type: 'feature'
created: '2026-10-15'
status: 'done'
baseline_commit: '8ef180cae4babb9954730ab58fe4015f33f8ccb2'
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-running-live-tracker-2026-10-15/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** The repo is empty. Every later story needs the agreed monorepo layout, pinned stack, enforced module graph, single wire contract and a booting server.

**Approach:** Scaffold the pnpm workspace (`server`, `web`, `shared`) on Node 24 type stripping. Write the AD-9 zod contract with fixtures, a zod-validated `event.json` loader, and a Fastify server on `127.0.0.1` exposing `GET /api/v1/health`. Wire `tsc --noEmit`, `node:test` and dependency-cruiser into one `pnpm check`, run by a pre-commit hook and GitHub Actions.

## Boundaries & Constraints

**Always:**
- Erasable TS only, relative imports with `.ts`, `import type` for types, no `paths`/`baseUrl`. `tsc --noEmit` is the only type checker; nothing is compiled for runtime.
- Exact pinned versions from the Stack table (no `^`/`~`). A dependency is added only in the story that first uses it.
- `shared` is consumed as workspace package `@running-live-tracker/shared` (`exports` → `./src/contract.ts`); `injectWorkspacePackages` stays off.
- Every non-2xx response body is `{error:{code,message}}`.
- Server binds `127.0.0.1` only, in every environment.

**Never:**
- No ingest, SQLite, SSE, snapshot, keygen, GPX, Leaflet or Android code (later stories).
- No raw keys or `keyHash` values committed; only `config/event.example.json`, holding obviously fake hashes.
- No enums, namespaces, parameter properties or decorators.

**Decisions:**
- Toolchain: the agent installs Node 24.22.0 on the dev machine via `nvm install 24.22.0` + `nvm use 24.22.0` (global switch accepted) and enables pnpm via `corepack enable`.
- Spec size (~2,200 tokens) accepted as-is; CI and pre-commit stay in this story.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Health | valid config, `GET /api/v1/health` | `200 {ok:true, serverNow:<epoch ms>, eventId}` | N/A |
| Unknown route | `GET /api/v1/nope` | `404 {error:{code:"NOT_FOUND",message}}` | N/A |
| Bad keyHash | uppercase or 63-char hash | boot aborts, exit code ≠ 0, message names the field path | no listen |
| Duplicate ids | two runners share `runnerId` or `keyHash` | boot aborts with clear message | no listen |
| Bad color | `"red"` or `#abc` | boot aborts | no listen |
| Bad window | `opensAt ≥ closesAt` | boot aborts | no listen |
| Missing/unparseable config | no file / invalid JSON | boot aborts naming the path | no listen |
| Fixture round-trip | each `shared/fixtures/valid/*.json` | parses; `JSON.stringify(parse(x))` deep-equals `x` (no `null` added for omitted optionals) | N/A |
| Invalid fixtures | lat 91, lon −181, `accuracyM` 0 or negative, non-v4 `sessionId`, non-increasing `seq`, empty `records`, extra field on `EventInfo` | `safeParse` fails | N/A |

</frozen-after-approval>

## Code Map

Greenfield: only `.gitignore` (`/.claude/skills`, `/_bmad`) and `.gitattributes` (`* text=auto`) exist. Remote is GitHub (`vmereau/running-live-tracker`), so CI = GitHub Actions.

- `package.json` (root) -- `packageManager: pnpm@12.11.2`, `engines.node: ">=24.22.0"`, scripts `check`, `typecheck`, `test`, `depcruise`, `prepare` (sets `git config core.hooksPath .githooks`), devDeps typescript 7.0.2, @types/node 24.19.2, dependency-cruiser 18.6.0
- `pnpm-workspace.yaml` -- packages `server`, `web`, `shared`
- `.node-version` -- `24.22.0`
- `tsconfig.base.json` -- `strict`, `noEmit`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `module`/`moduleResolution` `nodenext`, `target es2024`, explicit `types`
- `shared/` -- `package.json` (zod 4.6.7, `exports`), `tsconfig.json`, `src/contract.ts`, `src/contract.test.ts`, `fixtures/valid/*.json`, `fixtures/invalid/*.json`
- `server/` -- `package.json` (fastify 5.12.7, zod, shared), `tsconfig.json`, `src/main.ts`, `src/config/load-config.ts` (+ test), `src/http/build-app.ts` (+ test), empty module dirs with `.gitkeep`: `store ingest domain projection live`, `scripts/.gitkeep`
- `web/` -- `package.json` (vite 8.3.4, shared), `tsconfig.json` (`bundler`, DOM, `types: ["vite/client"]`), `index.html`, `src/main.ts` (placeholder that imports a contract type)
- `.dependency-cruiser.cjs` -- the AD module graph as `forbidden` rules
- `.githooks/pre-commit` -- `pnpm check`
- `.github/workflows/ci.yml` -- Node 24.22.0, corepack, `pnpm install --frozen-lockfile`, `pnpm check`
- `config/event.example.json`; `.gitignore` adds `node_modules/`, `config/event.json`, `config/courses/`, `data/`, `web/dist/`
- `README.md` -- prerequisites, setup, `pnpm check`, `pnpm dev`, env vars

## Tasks & Acceptance

**Execution:**
- [x] root files, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.node-version`, `.gitignore` -- workspace + toolchain -- foundation
- [x] `shared/src/contract.ts` -- AD-9 schemas + `z.infer` types; also export `MAX_BATCH_RECORDS = 200` (the batch schema itself does not cap length, so 1.3 can return 413, not 400) -- single wire contract
- [x] `shared/fixtures/**` + `shared/src/contract.test.ts` -- valid/invalid samples per I/O matrix, plus a round-trip test -- contract proof, reused by Android in 2.1
- [x] `server/src/config/load-config.ts` + test -- zod `EventConfig` (slug ids, `#rrggbb` color case-insensitive, keyHash `/^[0-9a-f]{64}$/`, unique runnerId/keyHash, `opensAt < closesAt`, optional `coursePath` string); `loadConfig(path)` throws `ConfigError` with the issue paths -- AD-5/AD-12 boot validation
- [x] `server/src/http/build-app.ts` + test -- `buildApp({config, now})`; health route; not-found and error handlers producing ErrorBody (`NOT_FOUND`, `INTERNAL_ERROR`); test via `app.inject` -- testable without a port
- [x] `server/src/main.ts` -- env `PORT` (default 8787), `DATA_DIR` (default `<repo>/data`), `EVENT_CONFIG` (default `<repo>/config/event.json`); defaults are resolved from `import.meta.dirname`; on `ConfigError`, print it and `process.exit(1)`; listen on `127.0.0.1`; JSON logs to stdout (writing them to `data/logs` is Story 4.2) -- composition root
- [x] `web/**` -- minimal Vite app that builds -- workspace exists for the graph and checks
- [x] `.dependency-cruiser.cjs`, `.githooks/pre-commit`, `.github/workflows/ci.yml`, `README.md` -- enforcement + docs

**Acceptance Criteria:**
- Given a fresh clone on Node 24.22.0, when `pnpm install && pnpm check` runs, then typecheck, tests and dependency-cruiser all pass for every workspace.
- Given a file in `server/src/domain` importing from `server/src/store`, when `pnpm depcruise` runs, then it fails naming the rule (verified once by hand, then reverted).
- Given `pnpm install`, then `git config core.hooksPath` is `.githooks`, and a commit runs `pnpm check`.
- Given `git status` after creating `config/event.json` and `data/x`, then neither is listed.

## Implementation Notes

- **dependency-cruiser vs TS 7:** with TS 7 installed it warns `missing-typescript-transpiler` and cruises 0 modules. dependency-cruiser declares no `typescript` dependency/peer, so a plain `overrides` entry has no edge to target; the working fix is option (1) via `packageExtensions` in `pnpm-workspace.yaml`, giving `dependency-cruiser@18.6.0` its own `typescript: npm:@typescript/typescript6@6.0.2`. Root `tsc` stays 7.0.2. Now cruises 13 modules / 24 deps. Option (2) (swc) not needed.
- **No-test workspaces:** `node --test "src/**/*.test.ts"` with no matching files exits 0, so `web` has no trivial test.
- **Fixture naming:** `shared/fixtures/{valid,invalid}/<schema>.<case>.json`; the kebab-case `<schema>` prefix selects the schema (e.g. `ingest-batch`, `event-info`). Android contract tests (2.1) should use the same rule.
- **Error codes:** besides `NOT_FOUND`/`INTERNAL_ERROR`, framework 4xx errors keep their status and map to `BAD_REQUEST`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` (fallback `BAD_REQUEST`); a wrong method gets 404 `NOT_FOUND` from Fastify 5. 500 messages are generic (no leak).
- `HealthResponse` is a local type in `server/src/http/build-app.ts`, not part of the AD-9 contract.
- `pnpm dev` runs `node server/src/main.ts` from the repo root, so a relative `EVENT_CONFIG` resolves against the root.
- `.githooks/pre-commit` needs the executable bit in git for non-Windows clones (`git add --chmod=+x .githooks/pre-commit` when committing).
- Matrix audit: added `server/src/main.test.ts`, which spawns `main.ts` against invalid and missing configs and asserts exit 1, the field paths in stderr, and no "server ready". The dependency-cruiser loose-file rule now also allows `main.test.ts`.
- Review pass 1: `PORT` must be 1–65535 (blank means 8787; `0` is rejected), so the happy-path boot test picks a free port with `node:net`. The patch pass rewrote `main.test.ts` and dropped the two failing-boot tests; they were restored using async spawn.

## Spec Change Log

## Review Triage Log

Pass 1 (blind = B, edge-case = E, verification-gap = V):

| # | Finding | Verdict | Evidence | Route |
|---|---------|---------|----------|-------|
| 1 | B, E: `.githooks/pre-commit` added as mode 100644 | medium | `core.fileMode=false` here; Unix git ignores non-executable hooks, so the AC fails on Unix clones | patch |
| 2 | (triage) the hook gets CRLF on Windows checkout | medium | `core.autocrlf=true`, and `.gitattributes` is `* text=auto`; `exec pnpm check\r` breaks | patch (grouped with 1) |
| 3 | B, E: `prepare` fails outside a git work tree | low | real only for tarball/Docker installs, which the project doesn't use; the fix adds a guard | reject |
| 4 | B, E: depcruise loose-file rule misses files with no imports | low | true (rules fire per dependency), rare in practice, and the fix adds a separate mechanism | reject |
| 5 | B: IngestBatch allows records after `end` / non-monotonic `recordedAt` | false | AD-4: records after `end` are stored but ignored; `isAccepted` gates `recordedAt`. Rejecting them would break the architecture | reject |
| 6 | B, E: invalid-fixture tests don't assert why parsing fails | low | real test weakness, no current mis-rejection found; the fix adds a per-fixture expectation map | reject |
| 7 | B: wire ids looser than config slugs | false | the server builds wire ids from validated config; no bad outcome | reject |
| 8 | B, E, V: `PORT=""` → port 0 (random); hex/exponent accepted | medium | `Number('')===0` passes the range check; E verified it bound :50689 | patch |
| 9 | B, E: no SIGINT/SIGTERM graceful close | false | no state to flush in 1.1; Ctrl-C exits cleanly; belongs to the stories that add the store and SSE | reject |
| 10 | B, V: no happy-path boot test; the 127.0.0.1 bind is untested | medium | V pre-verified: both main tests exit before `listen` | patch |
| 11 | B: README says web is served at `/` and DATA_DIR holds data | low | `/` returns 404 today; a direct text correction | patch |
| 12 | B: `coursePath` base dir and existence unchecked | false | GPX loading is excluded by frozen intent (Never: GPX); Story 3.3 owns it | reject |
| 13 | B, E: unmapped 4xx (401/403/429) → `BAD_REQUEST` | low | no such status is reachable in 1.1; 1.3 sends its codes explicitly | reject |
| 14 | B: `METHOD_NOT_ALLOWED` is dead code | low | verified: wrong method → 404 `NOT_FOUND`; deletion | patch |
| 15 | B: not-found message echoes `request.url` | false | JSON-encoded, no injection vector | reject |
| 16 | V: 413/415 mappings untested | medium | V pre-verified: only the 400 path is covered | patch |
| 17 | E: 4xx path forwards `error.message` | false | only framework errors carry 4xx today; their messages are designed to be shown | reject |
| 18 | B, E, V: web `test` script matches no files | false | the spec Design Note chose this explicitly; exits 0 | reject |
| 19 | B: CI lacks permissions/cache/concurrency | low | hardening, no defect | reject |
| 20 | E: CI hardcodes the Node version instead of using `.node-version` | low | drift risk; one-line direct correction (`node-version-file`) | patch |
| 21 | B: `.gitignore` lacks `.env*`, `*.log`, sqlite sidecars | low | none of these exist in the project | reject |
| 22 | E: UTF-8 BOM in `event.json` → "not valid JSON" | medium | `readFileSync('utf8')` keeps the BOM; Windows PowerShell 5.1 writes BOMs; one-line strip | patch |
| 23 | E: relative env paths resolve against cwd while defaults use the repo root | false | standard cwd semantics; `pnpm dev` runs from the root (Implementation Notes) | reject |
| 24 | E: `INTERNAL` regex omits `config/` | low | a server import of `config/*` would bypass the graph rules; direct regex correction | patch |
| 25 | E: EventInfo allows `hasCourse`/`lengthM` contradiction | low | the server builds it in one place (1.2); the fix adds a refinement guard | reject |

## Design Notes

- **TS 7 has no JS compiler API.** dependency-cruiser parses `.ts` through the `typescript` API, so first check whether it works with TS 7 installed. If it doesn't, try these in order: (1) a pnpm override that aliases `typescript` to `npm:@typescript/typescript6@6.0.2` for `dependency-cruiser` only, (2) set its `parser` option to `swc` and add `@swc/core`. Record whichever works in Implementation Notes. The root `tsc` must remain TS 7.0.2.
- **No-test workspaces.** If `node --test` with no matching files fails, `web` gets a trivial test of a pure helper rather than a skipped script.
- The schemas strip unknown keys by default (they don't reject them), so a phone sending an extra field isn't quarantined. Only `EventInfo` is `.strict()`.

## Verification

**Commands:**
- `pnpm install --frozen-lockfile && pnpm check` -- expected: exit 0
- `pnpm --filter web build` -- expected: `web/dist/index.html` produced
- `EVENT_CONFIG=config/event.example.json pnpm dev`, then `curl http://127.0.0.1:8787/api/v1/health` -- expected: `{"ok":true,...,"eventId":"example"}`
