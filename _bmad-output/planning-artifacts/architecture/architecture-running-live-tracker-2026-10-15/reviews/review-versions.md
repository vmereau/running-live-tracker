# Review — Stack versions & technology reality check

- **Target:** `ARCHITECTURE-SPINE.md` (Stack table, AD-6, AD-10, AD-11)
- **Date:** 2026-10-15
- **Method:** live queries against npm registry, nodejs.org/dist/index.json, Google Maven (dl.google.com), Maven Central, Android SDK repository2-3.xml, pkgs.tailscale.com, AAR metadata of the actual artifacts, the published better-sqlite3 tarball, and official docs (Node 24 TypeScript docs, TypeScript 7.0 announcement, AGP 9 release notes / built-in Kotlin migration guide, Tailscale Funnel KB, Cloudflare Quick Tunnel docs).

## Verdict

**PASS WITH CHANGES.** Every pinned version in the Stack table is real and is the current stable release as of today; nothing was invented or stale. The problems are compatibility gaps the table doesn't show: a **missing `compileSdk 37`** (it's a hard build failure with this Compose BOM), a Kotlin pin that **AGP's built-in Kotlin ignores unless you declare it explicitly**, a **missing KSP entry** that Room needs, and some TS 7 / Node type-stripping configuration that the spine should state.

## 1. Version check (Stack table)

| Name | Spine | Verified current (2026-10-15) | Source | Status |
| --- | --- | --- | --- | --- |
| Node.js | 24.22.0 | 24.22.0 (released 2026-10-14, LTS "Krypton"). Node 26.12.0 is Current, not LTS yet | nodejs.org/dist/index.json | OK |
| TypeScript | 7.0.2 | 7.0.2 `latest` (2026-07-08); 7.1 only as `-dev` | npm | OK |
| pnpm | 12.11.2 | 12.11.2 `latest` | npm | OK |
| Fastify | 5.12.7 | 5.12.7 | npm | OK |
| @fastify/static | 10.1.6 | 10.1.6 (built against fastify ^5.1) | npm | OK |
| better-sqlite3 | 13.0.3 | 13.0.3, engines `node >=22` | npm | OK |
| zod | 4.6.7 | 4.6.7 | npm | OK |
| Vite | 8.3.4 | 8.3.4, engines `^20.19 \|\| >=22.12` (Rolldown + LightningCSS) | npm | OK |
| Leaflet | 1.9.4 | 1.9.4 is `latest`; 2.0.0-alpha.1 (2025-08) is the only 2.x and it is still alpha | npm dist-tags | OK, correct choice |
| Kotlin | 2.4.21 | 2.4.21 latest stable (2.5.0-Beta1 exists) | Maven Central | OK, but see F2 |
| AGP | 9.4.1 | 9.4.1 latest stable (9.5.0-alpha10 exists) | Google Maven | OK |
| Compose BOM | 2026.09.00 | 2026.09.00 latest (maps compose-ui 1.12.1) | Google Maven | OK, but see F1 |
| Room | 2.8.5 | 2.8.5 latest 2.x. `androidx.room3` 3.0.3 is also stable | Google Maven | OK (see note) |
| DataStore Preferences | 1.2.1 | 1.2.1 latest stable (1.3.0-rc01 exists) | Google Maven | OK |
| play-services-location | 21.4.0 | 21.4.0 | Google Maven | OK |
| targetSdk / minSdk | 36 / 29 | API 37 (37.0–37.2) platforms are published; 36 is still allowed | SDK repository2-3.xml | OK, but compileSdk is missing (F1) |
| Tailscale | 1.104.1 | 1.104.1 stable (Windows exe/MSI) | pkgs.tailscale.com | OK |

## 2. Findings

### F1 — HIGH: Compose BOM 2026.09.00 requires `compileSdk 37` and AGP ≥ 9.1; the spine pins neither compileSdk nor a floor
I read `aar-metadata.properties` from the actual artifacts:
- `androidx.compose.ui:ui-android:1.12.1` (from BOM 2026.09.00): `minCompileSdk=37`, `minAndroidGradlePluginVersion=9.1.0`
- `androidx.core:core:1.19.1`: `minCompileSdk=37`
- `room-runtime-android:2.8.5`: `minCompileSdk=34`

Anyone who copies "targetSdk 36" into `compileSdk` will hit `checkDebugAarMetadata` failures.
**Correction:** add a row: `compileSdk 37 / targetSdk 36 / minSdk 29`. AGP 9.4.1 meets the AGP ≥ 9.1 floor. targetSdk 36 can stay because this is a sideloaded app, and moving to 37 adds Android 17 behaviour changes that nobody has tested.

### F2 — HIGH: Kotlin 2.4.21 only takes effect if you declare it; AGP 9 built-in Kotlin otherwise runs KGP 2.2.10
The AGP 9.4.1 POM has a runtime dependency on `kotlin-gradle-plugin:2.2.10`. The AGP 9 release notes say AGP bundles KGP 2.2.10, upgrades anything lower, and that "to use a higher version of KGP or KSP" you must declare it yourself.
**Correction:** add to the spine:
- Pin KGP 2.4.21 in the root build (the buildscript classpath / settings `plugins` with `apply false`), as the AGP "Upgrade to a higher KGP version" section describes.
- Apply `org.jetbrains.kotlin.plugin.compose` at **2.4.21**, the same as Kotlin.
- Do **not** apply `org.jetbrains.kotlin.android`, because it errors with built-in Kotlin.
- Do not use kapt. It is incompatible with built-in Kotlin.

### F3 — MEDIUM: KSP is missing from the Stack, and Room needs it
Room's annotation processor has to run through KSP, because kapt is incompatible with built-in Kotlin. **Correction:** add `KSP | 2.3.12` (released 2026-09-09; KSP2 version line, decoupled from Kotlin). 2.3.10 fixed Kotlin 2.4 default module names and R-class resolution under AGP 9 built-in Kotlin, so the version needs to be **≥ 2.3.10**.

### F4 — MEDIUM: TS 7 + Node 24 type stripping need specific tsconfig/import rules that the spine leaves out
Verified facts:
- Node 24 docs: type stripping is **Stable since v24.12.0**. It runs only erasable syntax: no `enum`, no namespaces with runtime code, no parameter properties, no `import x = require()` aliases, no decorators.
- It ignores `tsconfig.json`, so `paths` aliases fail at runtime. Use pnpm workspace package names or `#` subpath imports instead.
- Import specifiers need the `.ts` extension, and type-only imports need `import type` / `{ type X }`.
- Node **refuses to strip types for files under a `node_modules` path**. A pnpm workspace link to `shared` resolves to its real path (`shared/src/...`), so it works with default settings. `injectWorkspacePackages`, `node-linker=hoisted` copies, or `--preserve-symlinks` would put `contract.ts` under `node_modules` and break it.
- TS 7.0 announcement: TS 7.0 has **no programmatic API**, so typescript-eslint and other API-based tools need `@typescript/typescript6` (6.0.2, `tsc6`) side by side.
- TS 7.0 removes `moduleResolution: node/node10`, `baseUrl`, and `target: es5`. `strict` is now the default, and `types` defaults to empty, so `"types": ["node"]` / `["vite/client"]` have to be listed.
- `typescript@7.0.2` ships native binaries through optional deps, and `@typescript/typescript-win32-x64` exists.

**Correction:** add one convention line: tsconfig `module/moduleResolution: nodenext` (server/shared) or `bundler` (web), plus `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions` (or `rewriteRelativeImportExtensions`), `noEmit`, explicit `types`, and no `paths`/`baseUrl`. The `shared` package `exports` should point at `./src/contract.ts`. Pin `@types/node` to the **24.x** line (currently 24.19.2), not `latest` (26.6.5), so you don't type-check against APIs that Node 24 lacks.
Type defs: Fastify 5.12.7 ships its own `.d.ts` (built with TS ~6.0.2, which TS 7 accepts), and so do zod 4 and Vite 8. better-sqlite3 13 ships **no** types, so it needs `@types/better-sqlite3` 9.6.0 (DefinitelyTyped, updated 2026-08-01; the version number doesn't follow the package's, so treat it as a minor API-drift risk). Leaflet 1.9.4 needs `@types/leaflet` 1.9.22.

### F5 — LOW/INFO: better-sqlite3 13 on Windows x64 / Node 24 / pnpm 12 works, and the reason has changed
I inspected the 13.0.3 tarball. It **bundles N-API prebuilds** (`prebuilds/win32-x64.node`, plus win32-arm64, darwin, linux, linuxmusl). It has **no install script** (the 12.x line used `prebuild-install || node-gyp rebuild`) and depends only on `node-addon-api`. The binary doesn't depend on the Node ABI, so it loads on Node 24 (ABI 137) or 26 without Visual Studio Build Tools. It also isn't affected by pnpm 10+ blocking dependency build scripts by default, so no `allowBuilds`/`onlyBuiltDependencies` entry is needed. Optional alternative: Node 24's built-in `node:sqlite` would remove the native dependency entirely, but the spine's choice is fine.

### F6 — LOW: The tunnel and SSE assertions check out, and the spike is still worth doing
- Cloudflare docs confirm "Quick Tunnels do not support Server-Sent Events (SSE)", and also a 200 in-flight request cap. The AD-11 ban is correct.
- Tailscale Funnel KB: Funnel relays TCP through its relay servers to the node, which terminates TLS. Limits: ports 443/8443/10000 only, `*.ts.net` names only, "non-configurable bandwidth limits", needs v1.38.3+, MagicDNS + HTTPS certs + a `funnel` node attribute in the policy file. The docs list no idle or stream timeout. tailscaled proxies to localhost with Go's reverse proxy, which flushes `text/event-stream` immediately, so SSE should work.
- The AD-6 20 s `: ping` is a sensible keep-alive for mobile-carrier NATs. Keep the "prove SSE through tunnel" spike as already deferred.
- Add a note: `tailscale funnel` must target the localhost port, for example `tailscale funnel --bg 3000`, and the public port must be 443, 8443 or 10000.

### F7 — MEDIUM: AD-10 foreground-service requirements for targetSdk 34+ aren't spelled out
For a `location` FGS on targetSdk 36, the build needs these, which the spine should state:
- Manifest: `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_LOCATION`, `ACCESS_FINE_LOCATION` (+ COARSE), `POST_NOTIFICATIONS` (runtime prompt on API 33+, or the persistent notification is hidden), and `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (fine for sideload; restricted on Play).
- `startForeground(id, notif, FOREGROUND_SERVICE_TYPE_LOCATION)`, called only after location permission has been granted. Otherwise it throws `SecurityException` on API 34+.
- Starting from a visible activity on tap (as AD-10 already says) is what makes while-in-use location sufficient. `ACCESS_BACKGROUND_LOCATION` isn't needed for that path.
- **Gap:** AD-10 says a process restart keeps the same session. If the OS restarts the service itself (`START_STICKY`) with no visible activity, while-in-use location access is not granted, and Android 15+ also forbids starting a location FGS from `BOOT_COMPLETED`. Either accept that a restart only resumes **uploading** the outbox (with a notification asking the runner to reopen the app to resume GPS), or request `ACCESS_BACKGROUND_LOCATION`. Pick one explicitly. Test on a real device, because this exact behaviour isn't confirmed on API 36/37.

### Notes (no change required)
- Room 2.8.5 is fine. The `androidx.room3` (3.0.x) artifact line now exists as a separate stable line; staying on 2.x is the conservative choice.
- Leaflet: staying on 1.9.4 is right. 2.0 is still alpha (ESM-only, no global `L`).
- Gradle: the current Gradle is 9.8.1. The spine doesn't pin a Gradle wrapper version, so consider adding the wrapper version that AGP 9.4 supports (JDK 17+).
- Node 24 moves from Active to Maintenance LTS around now (Node 26 becomes LTS in late October 2026). That still covers a race in the next ~18 months.
