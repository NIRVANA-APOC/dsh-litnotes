# dsh-litnotes — independent QA / security / design report

Status: **Phase A + Phase B complete.** Host half installed and live; client half executed in the refreshed page (diagnostics + page-level registration); both Phase A P1s were fixed in source during Phase B and re-verified by QA. QA's own client Inspect channel stayed unavailable (see §6.1).
QA owner: `qa` (independent verifier; no deliverable edits, no install, no `plugin_manager`).
Date: 2026-11-06 (Asia/Shanghai). Workspace: `/home/nirvana/Documents/dsh-litnotes`.

> Final verdict: **0 P0**, **0 open P1**, **15 open P2** (16 P2 raised in Phase A, 2 resolved in
> Phase B: P2-06/P2-07; 1 new P2 raised: P2-17). All repository gates pass
> (`node scripts/check.mjs` = 10/10 PASS, `node --test test/` = 220/220 after the P1 fixes).
> The bundle was installed `link:` and the Host half is **live and verified** (Loader row,
> data dir, tool visible *and callable*, live parse progress on disk, fenced routes answering
> 401/403). The Client half **executed in the refreshed page**: `diagnostics/client.log` has
> `active` + `icon-rendered` entries at 19:12:48Z and again at 19:14:11Z, and the page-level
> registration is visible (`sidebar.panellist` occupant `id:"mineru", order:35, active:true`).
> The two Phase A P1s are **fixed in source** (shared client parser for quote-located
> annotations; implemented `cleanDocDir`) and QA re-verified both (key probes all match now;
> init no longer logs a `ReferenceError`; new regression suite `test/unit/qa-fixes.test.mjs`
> = 5/5). The running Host process loaded the pre-fix code at 19:07; whether the 19:14:11
> client re-apply also reloaded the Host fiber is not independently confirmed, so the fix
> remains "in source, live-process reload pending/unconfirmed". Visual rendering is still
> unverified (no browser control).

## 1. Snapshot verified

Files were still moving when QA started; the audited snapshot is the one below. Hashes are
md5 of the checked-in state; QA re-checked them before and after each gate run (stable).

```
ui/app.js            b89ce4f5e62d4d4ddb2d8b7658750e6f   (4134 lines)
ui/styles.css        6e5dd619fcab7eb98a761cdd9e0b5dee   (3697 lines, 511 balanced rule blocks)
ui/markdown.js       80fab1d51c27c05d51b73648d3407ac6
ui/highlight.js      48d38dd3cbf877efc413eaac5c05569f
lib/client.js        165b671208d86f3571b11d315eb129c2   (300.6 KiB, deterministic rebuild)
lib/routes.js        474df7eec81201660fd6ed016c30e076
lib/store.js         d8e6173da64facb8f988c878f52c64b3
lib/service.js       77082eb9ae3ab669d7666b54ea389077
lib/parse-manager.js 62fb0313c84bc8ff4220c0389e18375c
lib/mineru.js        10fe8618fe0114e2939a87eb102c8d66
lib/config.js        01a5cf75b8124b7a52e0a48f80499687
lib/wire.js          ce8592ea47f6b8b1368680a2bb670509
lib/unzip.js         53a55059a9577f8beb1a7c6e77cffa74
lib/agent-tool.js    3def5820162609f6db23df0e589fd765
index.js             4b093a204029cdc9015de1185c8f321f
package.json         2f6805bbcfca9858e4c82585b1a1c3a6
cordis.patch.yml     815c5b9db1fd600666d741308075efb1
docs/UI-SPEC.md      d5db70f30f97b178bdc10948dc42a32b
docs/ARCH.md         80c36b5c05a3072236b3359f01d84fba
docs/HOST-INTERFACES.md de70cf62ca9120d87f23ee4369823080
docs/MINERU.md       e328907960d5a5e9b3ad1bb05ec1609b
README.md            a46ba427cb65c093e2bbdb78648bcc06
```

Phase B delta (after the Lead's P1 fixes, 19:10–19:11): `lib/service.js ad8c0e5193ea70b4d7bfa817b2d4b860`
(now imports `parseMarkdown` from `../ui/markdown.js`), `lib/store.js fe35410178c869977d8eff628f8e971e`
(`cleanDocDir` implemented), `package.json 0f4440fa66a4ff06d3f576c325fc5b11` (+`ui/*.js` files entry,
`engines.node >=20.11`, root `icon`), new `test/unit/qa-fixes.test.mjs 6264dc44a35b398e613b8a067db2117c`;
`lib/client.js` unchanged/rebuild-identical; gate re-run = **220/220 tests, 10/10 checks PASS**.
`docs/QA-REPORT.md` itself is the only file QA edits.

Environment: Linux, Node **v26.13.0**, DSH `0.2.2-rc.1` Web profile
(`~/.dsh/profiles/web`), `$DSH_HOME=/home/nirvana/.dsh`. Reference implementation for API
verification: the installed DSH packages and the `cordis_inspect` Host providers (read-only,
no profile or Loader changes were made).

## 2. Verification matrix

### 2.1 Gates (run from the repo root, clean state)

| # | Check | Command | Result |
|---|---|---|---|
| G1 | Manifest / patch / locale / SVG / syntax / bundle / tests gate | `node scripts/check.mjs` | **PASS** — 10 checks: 10 passed, 0 failed, 0 skipped (215 tests at Phase A; re-run after the Phase B P1 fixes: **220 tests, still 10/10 PASS**) |
| G2 | Full test suite | `node --test test/` | **PASS** — 215 tests at Phase A; **220 pass** after the Phase B P1-fix regression suite (0 fail, 0 skipped) |
| G3 | Client build, byte-for-byte reproducible | `node scripts/build-client.mjs` twice + `cmp` | **PASS** — identical 300.6 KiB output both times |
| G4 | Generated bundle parses and has the required shell | `node --check lib/client.js`; tail inspection | **PASS** — ends `return clientMain(require);\n  },\n});`; loader id `dsh-litnotes`; no `__MINERU_*` placeholders; no surviving `export ` statements; only `require('react')` |
| G5 | No stray installable artifacts (design harness claim) | tree inspection | **PASS** — `.design-harness/` was removed before hand-off; only contract files remain |

### 2.2 Host security (`lib/**`, `index.js`) — full static read + tests

| Check | Evidence | Result |
|---|---|---|
| Every web route is fenced with `ctx.connection.requestRejection(req)` **before any work** | `lib/routes.js:131-141` (helper), `:310-312` (api prefix), `:346-348` (assets prefix); sub-routes (JSON dispatch, upload, asset, source) all dispatch inside the fenced handler. **Phase B live proof:** unauthenticated API/asset/vendor requests → 401 with the plugin's JSON envelope, cross-origin → 403, `/dsh-litnotes/nope` → 404 (§6.1 B6) | PASS |
| Fence failure mapping / fail-closed | `rejection === undefined` admits; `401`/`403` answered as envelopes, thrown fence errors → 403 (`routes.js:131-141`) | PASS |
| Route kinds match the real DSH API | verified against `webServer.register(route: WebRoute \| WebResourceRoute)` (`kind: 'exact' \| 'prefix'`, `handler(req,res)`) via `cordis_inspect` host Service and the installed `dsh-better-sidebar` pattern | PASS |
| Document id validation before any path | `wire.requireUuid` (`lib/wire.js:239-246`); used by `routes.js:236,268`, `store.docDir/parsedDir/sourcePath/createFromFile/update/remove/...`, `service.requireDocument` | PASS |
| Path traversal on asset / vendor routes | `safeSegments` + `resolveWithin` (`routes.js:84-104`); unit + e2e traversal suites (`test/unit/routes.test.mjs:280`, `test/e2e/routes.test.mjs:196`) | PASS |
| Raw upload confinement | UUID temp name (`store.newTempPath`), streamed to disk with `flags:'wx'`, running-byte + `content-length` caps, partial file removed on abort/overflow (`routes.js:172-224`); 413/415 covered by tests | PASS |
| Body caps | JSON: 2 MiB (`routes.js:30/304` + running total in `wire.readTextBody`); upload: `config.maxUploadBytes` (default 200 MiB, clamp 64 KiB–2 GiB); import download: same cap; MinerU downloads: zip 512 MiB / markdown 64 MiB / control JSON 8 MiB guard | PASS (upload/import/zip/markdown); see P2-03 for the control-JSON guard being ineffective on the `response.json()` path |
| Token never returned / logged | token read via `credentials.readRecord('dsh-litnotes/api-token')` (`lib/config.js:162-172`); set/clear via `modifyRecord`/`deleteRecord` (`:199-230`); status/settings expose only `tokenConfigured`/`tokenPersistent` (`lib/service.js:576-577,808-810`); grep of all host log calls for token = 0 hits; boot test asserts the token string absent from the status body (`test/e2e/boot.test.mjs:106`) | PASS |
| Credentials key format | `TOKEN_KEY = 'dsh-litnotes/api-token'` (`config.js:24`) is exactly two segments; verified against installed `dsh-credentials` `parseCredentialKey` which requires `<scope>/<id>` (`@deepseek-ai/dsh-credentials/lib/index.js:67-72`); record shape `{kind:'api-key', key}` matches `ApiKeyRecord` | PASS |
| Token persistence fallback | when the credentials service is absent, a process-lifetime memory token is used and `tokenPersistent:false` is reported (`config.js:69-71,162-249`); covered by `test/unit/service.test.mjs:145` | PASS |
| ZIP path traversal | entry names normalized to `/`; absolute paths, drive letters, `..`, NUL and encrypted/ZIP64 archives rejected or skipped (`lib/unzip.js:80-96,150-169,199`); caps entries 5000 / total 512 MiB / entry 128 MiB; inflate capped by declared size; CRC verified where `zlib.crc32` exists (`:105-109,240,250`) | PASS — plus e2e `test/e2e/unzip.test.mjs` (traversal, backslashes, caps, CRC, truncation) |
| Parse-result extraction confinement | keep-set `full.md`, `*_content_list.json`, `images/**` only (`lib/parse-manager.js:134-139`); staged write via `resolveWithin` then atomic `rename` (`:462-479`); content-list saved as `basename` | PASS |
| No shell execution in shipped host code | grep for `child_process`/`exec*`/`spawn(` in `index.js`, `lib/**`, `scripts/build-client.mjs`, `scripts/check.mjs` = 0 (only `RegExp.exec` calls) | PASS |
| Atomic JSON persistence | temp-file + `rename` for meta/annotations/translations (`lib/store.js:60-70`) and preferences (`lib/config.js:308-318`); per-document promise queue serializes writes (`store.js:72-106`); concurrent-save test (`test/unit/store.test.mjs:113`) | PASS |
| Diagnostics cap | one JSON line per ping, ≤ 200 lines, file reset above 2 MiB, never throws (`store.js:38,650-672`); client-supplied `detail` capped at 2 000 chars and `event`/`clientVersion` bounded (`lib/service.js:538-554`) | PASS |
| Source route content-type hardening | HTML/SVG sources forced `attachment` + `Content-Security-Policy: default-src 'none'; sandbox`; PDF inline; `X-Content-Type-Options: nosniff` (`routes.js:258-292`) | PASS |
| Asset route content-type hardening | path confined to `parsed/`; `nosniff`; **but** `.svg` assets are served as active `image/svg+xml` without a sandbox CSP — see P2-05 | PASS with P2-05 |
| Import-from-URL hardening | only `http:`/`https:` accepted, name sanitized, body size capped, partial file removed; **no private-IP / link-local / metadata-address guard, redirects followed without re-validation, no fetch timeout** — see P2-01 | P2 |
| Unbounded reads | parsed markdown / content list capped at 64 MiB, state files at 32 MiB, preferences at 1 MiB (`store.js:108-113,116-122`); parse source is read fully by design — see P2-02 | PASS with P2-02 |
| Concurrency / task lifecycle | parse concurrency cap, cancel via `AbortController`, resume semantics, dispose; covered by `test/unit/parse-manager.test.mjs` and e2e failure/cancel/resume suites | PASS |
| Real Host wiring (`inject`, `ctx.effect`, `ctx.get`, `registerRoutes`, `tools.register`) | Statically verified against installed `@deepseek-ai/cordis` types and the `cordis_inspect` service contracts; boot e2e mounts the real `index.js`. **Phase B live confirmation:** Loader row resolvable (`include:dsh-litnotes`), data dir created, `mineru` tool visible in `Tool.listTools` and executed (status/list), a real agent-API parse task persisted to `meta.json` (`phase: polling`), routes registered and fenced live (§6.1 B1/B2/B6/B7) | PASS |

### 2.3 Client security & correctness (`ui/app.js`, `ui/markdown.js`, `ui/highlight.js`)

| Check | Evidence | Result |
|---|---|---|
| `dangerouslySetInnerHTML` sites | exactly 4: KaTeX `renderToString` output (`app.js:841`, options `throwOnError:false, strict:'ignore'`, KaTeX default `trust:false` so `\href`/`\url` stay inert), vendored `EMPTY_ART` (`:1392`), vendored `PANEL_ICON` through `mruIconMarkup` (`:1634`), and the same icon markup for the sidebar (`:4062`). No document-derived text reaches innerHTML | PASS |
| Fetch targets resolve against `document.baseURI`, only `dsh-litnotes` routes | `mruApiUrl()`/`mruAssetUrl()` (`app.js:453-460`); only 3 network call sites: JSON POST `:474`, XHR upload `:508-512`, diagnostics ping `:574`; every target is `dsh-litnotes/api/*` or `dsh-litnotes/assets/*` | PASS |
| Slot registrations match the real client slot API | compared with installed plugins and runtime: `ctx.slots.inject(name, () => ctx.slots.register(opts, Component))` is the documented pattern (`dsh-client-ui-sidebar/lib/client.js:749-780`, `SlotRegistry.inject` in `dsh-client-ui-renderer`); sidebar uses `label`, `order`; `resolveSlotLabel` calls function labels (`dsh-web-frontend` bundle: `typeof e=="function"?e():e`), so `label: () => t('panel.label')` re-resolves on locale change; `locale: NS` injects the `t` prop into slot components (`PluginManagerPage({t,...})` pattern) which `MineruRoot`/`MineruApp` consume via `props.t` | PASS |
| Locale dictionaries | `ZH`/`EN` under namespace `dsh-litnotes`; 171 keys each, 0 one-sided keys; **all 107 rows of the UI-SPEC §5 copy deck compared string-for-string in both languages — 0 mismatches**; no CJK outside the zh dictionary except language endonyms (`中文`, `日本語`, …) and one JSDoc comment; no hardcoded English user-facing copy except one unreachable-ish error string (P2-11) | PASS |
| Reader block model ↔ annotation offset contract | contract at `ui/markdown.js:1-74`: `plainText === runsText(runs)` for every run block; list block runs are the **concatenation of item runs with no separator** (`mdMakeListBlock`, `markdown.js:711-728`) and the client advances `cursor += itemText.length` (`app.js:1160-1185`); table plainText joins cells with one space (`mdMakeTableBlock`, `:742-760`) and the client advances `cellText.length + 1` (`app.js:1205-1242`); paragraph/heading/quote use baseOffset 0. Covered by 40+ parser + highlight unit tests plus page-mark stability tests | PASS statically (DOM selection → offset mapping is not runtime-tested; see §5) |
| Annotation/highlight clamping | `normalizeAnnotation` clamps to block plain text and drops unusable anchors (`ui/highlight.js:128-162`); client normalizes stored annotations against the freshly parsed model and counts dropped anchors (`app.js:3567-3593`); margin notice renders the dropped count (`:1827-1829`) | PASS |
| Persistence debounce / flush | annotations: debounced 800 ms, latest-wins pending buffer (`app.js:2560-2585`); translations: 1 000 ms (`:2586-2615`); both flushed synchronously on unmount (`:3731-3764`); failures surface as toasts | PASS |
| Abort / unmount cleanup | translate-all uses an `AbortController` (`app.js:3211`), cancelled on button/escape/unmount (`:3190-3196,3740`); reader/timer/toast timers cleared; window/document listeners removed (`:3554-3557,3630-3633,3657-3661,3705-3710,3731-3764`); KaTeX `<link>/<script>` removed on plugin unload via `ctx.effect` (`:4118`); client never writes `document.body`, never uses `localStorage` | PASS (one minor gap: in-flight XHR uploads are not aborted on unmount, P2-12) |
| Error boundary + diagnostics pings | one React error boundary around the panel (`app.js:4067-4100`), `health.ping` on first apply (`:4119`) and on `panel-error` with capped detail (`:4077-4088`), `icon-rendered` ping from the sidebar icon (`:4046-4048`); the empty/crash state renders the CSS and localized copy | PASS (no window-level `error`/`unhandledrejection` reporter — P2-13) |
| Link rendering | all parsed links render as `<a href={styles.link} target="_blank" rel="noopener noreferrer">` (`app.js:1021`); the parser does **not** validate URL schemes (`markdown.js:309-341,464-523`), so `javascript:`/`data:` destinations can be produced from document text — see P2-04 for the assessed risk and the headless-Chromium probe | PASS with P2-04 |
| KaTeX loading | assets only from `dsh-litnotes/assets/katex/...` via `document.baseURI`, inert `<link>`/`<script>` added once in `document.head`, removed on unload (`app.js:762-823`); vendored KaTeX is 0.16.47 with MIT LICENSE and local fonts (verified); formulas render as raw monospace text until ready and on failure | PASS (rendering itself not exercised — §5) |
| Accessibility basics | real `<button>/<input>/<select>/<textarea>` controls, `aria-label` on icon buttons, `aria-current="page"` on the active rail row, `aria-pressed`/`aria-selected`/`aria-checked` state, `role="listitem"` on rows, Escape closes overlays, modals trap Tab and restore focus, selection toolbar autofocuses after a keyboard selection, `role="status"` toasts with `aria-live` | PASS (one spec-mandated pattern uses `role="button"` inside the row `<button>`, which is invalid nested-interactive markup; P2-14) |

### 2.4 Design (`ui/styles.css`, `ui/panel-icon.svg`, `ui/empty-art.svg`, `icon.svg`)

| Check | Evidence | Result |
|---|---|---|
| Host-token discipline | chrome tokens are `var(--dsw-alias-*)` only (`styles.css:25-44`); plugin-owned literals are exactly the spec-sanctioned ones: paper tint `color-mix(...#c9b489 / #000)`, four annotation inks, shadow rgba values, font stacks; `#fff/#111` appear only inside `@media print` (`:3638-3695`) | PASS |
| Dark theme | `body[data-ds-dark-theme]`/`html[...] .mru-root` overrides only paper tint + inks (`styles.css:53-61`); every other color is a host alias that adapts | PASS |
| Focus visible | 2 px accent ring + 2 px offset on buttons/roles/inputs/links/tabindex across the tree (`styles.css:129-143`), plus search-specific rule (`:717`) | PASS |
| Responsive container queries + fallback | `container-type: inline-size` on `.mru-root`; `@container mru-desk` at 1280/900/560 (`:3223,3246,3365`) and an `@supports not (container-type: inline-size)` viewport fallback (`:3430-3695`) | PASS |
| Reduced motion | animations/transitions disabled under `prefers-reduced-motion: reduce` (`:3161-3215`), including paper entry, popovers, chip pulse, skeleton, highlight pulse | PASS |
| Reading contrast | computed from the live host token values (`--dsw-alias-label-primary`/`-secondary` and `-bg-layer-1`, light and dark): paper #fbfaf7 with ink #0f1115 = **18.08:1**, soft #61666b = **5.55:1**; dark paper #202021 with #f9fafb = **15.54:1**, soft #cfd3d6 = **10.78:1**. All ≥ 4.5:1 | PASS |
| No external resources | no `@import`, no `url(...)` in `ui/styles.css`; 511/511 balanced braces; every selector is namespaced (`mru-*`/`dsw-*`) — only `@keyframes` percentage steps appear "unscoped" to a naive scanner, which is expected | PASS |
| UI-SPEC layout metrics | rail 288 px (`:633`), topbar 52 px (`:238`), statusbar 30 px (`:309`), paper column `max-width:760px` (`:2028`), padding `56px 60px` (`:1170`), title `clamp(27px,2.6vw,34px)` (`:1177`), body `calc(17.5px * --mru-read-scale)` / translation `calc(15px * …)`, 56ch measure, margin 296 px sheet, print stylesheet | PASS |
| Class coverage vs `ui/app.js` | scanner over `app.js`+`markdown.js`+`highlight.js` vs 263 CSS classes: every emitted class token is styled; dynamic families (`mru-block--h1…h4`, `mru-h--1…4`, `mru-outline__item--l1…l4`, `mru-chip--uploaded/parsing/parsed/failed`, `mru-swatch--*`, `mru-hl--*`) individually verified as present. **Stricter UI-SPEC §3 check: all 194 code-formatted class tokens in the component contract are either emitted by the client (directly or through a dynamic family) and styled by CSS.** Spec'd-but-never-emitted defensive classes are styled but unused by the client (accepted; P2-10) | PASS |
| Icons | `icon.svg`, `ui/panel-icon.svg`, `ui/empty-art.svg` are valid SVG; panel icon is self-contained so `mruIconMarkup()`'s attribute rewrite cannot drop paint; design notes document the `:where()` reset fix, overlay positioning, scrim scoping and translated-mode fallback | PASS |

### 2.5 Contract / manifest / documentation

| Check | Evidence | Result |
|---|---|---|
| `package.json` | `name/version/private/type` OK; `exports` `.` → `index.js`, `./client` → `lib/client.js` (string form accepted by `dsh-client-modules` resolver, verified in its source), `./locale/*.json`, `./icon`; `files` allowlist (10 entries, now including `ui/*.js` because the Host imports the shared parser) covers every runtime need and every entry resolves; `main` → `index.js`; `engines.node` is `>=20.11` as of Phase B (P2-06 resolved) | PASS |
| `dsh.bundle.patch` + `cordis.patch.yml` | patch target exists; YAML = one `- insert:` row `id/name: dsh-litnotes`, no tabs; format matches installed bundles (e.g. `dsh-experimental-auto-review/cordis.patch.yml`) | PASS |
| `dsh.client` | `platform:'web'`, `immediately:true`, `inject:['@deepseek-ai/dsh-client-locale','@deepseek-ai/dsh-client-ui-layout','@deepseek-ai/dsh-client-ui-sidebar']`; all three are installed packages that declare `dsh.client` (verified from their manifests and installed `lib/client.js`); bundle requests only the baseline `react` module, so no `external` list is needed; schema matches `DshClientManifest` from `@deepseek-ai/dsh-package-manifest` | PASS |
| Locale metadata | `locale/{zh,en}.json` have exactly the installed-plugin shape `{meta:{title,description}}` (compared with `dsh-client-ui-sidebar`, `dsh-client-ui-open-in-app`); check.mjs validates non-empty title+description | PASS |
| Icon manifest | `icon.svg` valid; `exports["./icon"]` present; Phase B also added the package-root `"icon": "./icon.svg"` field (P2-07 resolved); manager icon rendering remains visually unconfirmed (no browser control) | PASS |
| README accuracy | data path (`$DSH_HOME/mineru`, default `~/.dsh/mineru`) matches `lib/config.js`; token storage claim `~/.dsh/.credentials.yaml` verified against installed `dsh-credentials-local` (`CREDENTIALS_FILENAME = '.credentials.yaml'`); supported formats match `lib/mime.js`; MinerU limits match `lib/mineru.js`/`docs/MINERU.md`; agent actions match `lib/agent-tool.js`; diagnostics 200-line cap matches; fence description matches. Discrepancy: remote image URLs in agent-parsed markdown are loaded by the browser (P2-08) | PASS with P2-08 |
| `docs/HOST-INTERFACES.md` accuracy | modules and signatures match the implementation except: the `wire.js` section omits the implemented/imported `requireUuid` and `isPlainObject` (routes/service/store import `requireUuid`), and `docs/ARCH.md` §8 says status reports `writable:false` while the implementation reports `tokenPersistent` (matching HOST-INTERFACES). Documentation drift only | PASS with P2-15 |
| Node builtins only (Host) | all host imports are `node:crypto/events/fs/fs-promises/os/path/zlib` or local `./`; no npm imports; browser bundle imports only `react` | PASS |

### 2.6 Known-risk targets flagged by builders (assessed, not rubber-stamped)

| Risk | QA assessment |
|---|---|
| `mineru` tool `annotate` without `blockKey` uses a best-effort host block splitter | **Confirmed real defect, not dismissible.** Reproduced key divergence and index drift against `ui/markdown.js` (see P1-01). Tool reports success while the annotation may never render. Severity P1 (agent-facing, not install-blocking); recommend sharing the parser or failing loudly. |
| `import_url` has no private-IP SSRF guard | **Confirmed, severity P2.** Route is same-origin/fenced and requires a browser session or the agent; the response body is stored locally (not returned to a caller), so this is blind SSRF with user-click/agent-instruction preconditions, plus no timeout and redirect re-validation. Recommend a public-IP allowlist check (see P2-01). |
| Standard upload buffers ≤ 200 MB in memory | **Confirmed, severity P2.** `readFile(sourcePath)` + fetch body per task, `maxConcurrentParses` default 2; transient peak can reach several hundred MB but is bounded by config. Acceptable for a local desktop Harness, but should be documented and ideally streamed (see P2-02). |

## 3. Findings

### 3.1 P0 — blocking: none

No blocking issue was found. Gates pass; no route bypass, token leak, path escape, zip-slip,
or unauthenticated surface was identified; the client bundle loads in the expected module format.

### 3.2 P1 — both FIXED in source during Phase B (verified by QA; live Host reload pending)

> Status: the Lead fixed both findings in source at 19:10–19:11 (+08:00) while Phase B was
> running. QA re-tested both fixes (`node scripts/check.mjs` = **220/220 tests**; the new
> `test/unit/qa-fixes.test.mjs` = 5/5; QA's own divergence probe now returns `KEY-OK` for every
> previously failing case; store init emits no `ReferenceError`). The running Host process was
> loaded from the pre-fix tree at 19:07; its reload/recomposition after the edit is not
> independently confirmed from outside, so the fixes stay described as **in source** until a
> restarted/recomposed Host exercises them live. One new P2 (P2-17) was raised *against the new
> cleanup implementation*.

**P1-01 — `mineru` agent tool `annotate` (quote mode) can store a `blockKey` the client can never render. — FIXED IN SOURCE (verified)**

- Where: `lib/service.js:126-251` (`approximateBlocks`), `:262-288` (`locateQuote`), used by
  `toolAnnotate` at `:906-951`; contract promise in `docs/ARCH.md:339-341`
  ("stores a `b<index>:<hash>` key matching the client's scheme").
- What diverges from `ui/markdown.js`:
  1. **Blockquote merge**: the host splitter keeps consuming `>` lines **and blank lines**
     (`service.js:195-203`), so two consecutive blockquotes become one host block; the client
     emits two blocks (`mdTryQuote`). Every later block index shifts.
  2. **Unseparated pipe table**: the host paragraph loop does not break on a pipe-table start, so
     `text` + `| a | b |` + delimiter row merge into one host paragraph; the client
     (`mdStartsNewBlock` → `mdIsPipeTableStart`) emits paragraph + table and every later index shifts.
  3. **List blocks**: host `plainText` = `items.join('\n')` (`service.js:216`) vs the client's
     separator-free concatenation (`markdown.js:711-727`) → same index, wrong hash.
  4. **Table blocks**: host plain text is the flattened HTML/`|` text (`service.js:169-179`);
     client table plain text is cells joined by one space (`markdown.js:742-760`) → wrong hash.
  5. Minor: entity decoding differs (`&nbsp;` etc. decoded by the client, not by `plainInline`).
- Reproduction (QA scratch script, no repo changes): parse a doc with the client parser, call
  `service.toolAnnotate(id, { quote })` against the same markdown, compare keys.
  Observed on `test/fixtures/paper.md`: heading/paragraph/quote probes matched; **list item
  probe matched no client key** and the whole-list quote was "not found"; HTML-table cell probes
  were ambiguous; synthetic consecutive blockquotes yielded host `b1:30442667` for both quotes
  while client keys were `b1:907745b5`/`b2:541ea3b1`, and a later paragraph host `b2` vs client
  `b3`; an unseparated pipe table shifted a later paragraph from `b2` to client `b3`.
- Impact: annotations created by the agent with `quote` are saved successfully and count as
  "annotations", but the browser cannot attach them (`normalizeAnnotation` drops them and the
  margin shows "N notes no longer match this draft"). No user data corruption; agent path only.
  Client-side annotation creation is unaffected (client always supplies its own `blockKey`).
- Recommendation (any one): (a) make the host locate/annotate path use the exact client parser
  (e.g. move the pure parser to a shared `lib/` module and inline it into the bundle at build
  time), or (b) when the host cannot prove the client key, return a warning / refuse the
  annotate call instead of "success", or (c) at minimum document the limitation in the tool
  description and README and prefer `blockKey` in agent guidance. Add a regression test that
  compares host-derived keys against `parseMarkdown()` on the fixture.

- **Fix verified in source (Phase B):** `lib/service.js` now imports `parseMarkdown` from
  `../ui/markdown.js` (`lib/service.js:33`) and `locateQuote` (`:125-163`) walks the client
  parser's `model.blocks`, using `block.plainText`/`block.key` directly. QA re-ran the Phase A
  divergence probes against the fixed service: list item, whole list, pipe-table cell, cell after
  an unseparated pipe table, consecutive blockquotes, and the later paragraph that previously
  shifted indices — **all now return the client's exact key (`KEY-OK`)**; a genuinely short,
  duplicated cell quote is correctly rejected as ambiguous. The Lead also added 4 regression
  tests (`test/unit/qa-fixes.test.mjs`: blockquotes / list / table / ambiguity). Remaining
  deployment note: because the Host now imports a `ui/*.js` file, `package.json.files` had to
  include `ui/*.js` (it now does) — a packed install without that entry would fail to load the
  Host. Live process still runs the pre-fix code until reload/recomposition.

**P1-02 — `lib/store.js` calls undefined `cleanDocDir()` on every document at boot; error is swallowed. — FIXED IN SOURCE (verified)**

- Where: `lib/store.js:282` (`await cleanDocDir(join(documentsDir, dirent.name))` inside the
  metadata-scan `try`). No `cleanDocDir` definition exists anywhere in the repository
  (grep: single occurrence).
- Reproduction: create a store over a temp data dir containing one valid `documents/<uuid>/meta.json`,
  call `store.init()`; observed warning from the store logger:
  `cannot read metadata for %s: %s <uuid> cleanDocDir is not defined` — while the library still
  loads (`list()` returns 1). The catch at `store.js:283-285` converts the `ReferenceError` into a
  misleading "cannot read metadata" warning, so this never fails tests or the boot sequence.
- Impact: every boot with an existing library emits one bogus warning per document and can mask
  genuine metadata-read errors; the intended per-document stale-file cleanup (likely stale
  `.parsed-*` staging directories / `.tmp-*` atomic-write leftovers) never runs, so crash
  leftovers under `documents/<id>/` are never cleaned. No UI/user data impact.
- Recommendation: implement the cleanup (remove stale `.<name>.tmp-*` files and stale
  `.parsed-*` staging dirs under each doc dir, bounded by an age threshold) or delete the call;
  add a store test that asserts a clean init logs no warnings with an existing document.

- **Fix verified in source (Phase B):** `lib/store.js:304-325` now defines `cleanDocDir(dir)` and
  the boot-time `ReferenceError` is gone — QA reproduced init over a document with stale files:
  library loads and **no warnings are logged**. The Lead added a regression test
  (`test/unit/qa-fixes.test.mjs: "store init removes interrupted-operation leftovers…"`). **New
  P2-17:** the implemented patterns (`*.part`, `*.tmp`, `tmp-*`/`.tmp-*` dirs) do not match the
  artifact names this codebase actually produces (`.parsed-<uuid>` staging dirs and
  `.<file>.tmp-<pid>-<uuid>` atomic-write temps survive); see P2-17 for the repro and fix.

### 3.3 P2 — nits / hardening (all optional for shipping)

_Resolved during Phase B: **P2-06** (engines now `>=20.11`) and **P2-07** (root `icon` field added; `ui/*.js` added to `files` because the Host now imports the shared parser — without that a packed install would break). Still open below: 15 items._

| ID | Finding | Evidence | Assessment / recommendation |
|---|---|---|---|
| P2-01 | `library.importUrl` has no private/link-local/metadata-address guard, follows redirects without re-validation, and has no fetch timeout | `lib/service.js:291-305` (only protocol check), `:669` (`redirect:'follow'`, no signal) | Same-origin fenced route + user/agent trigger; response stored locally, not returned, so blind SSRF is low risk; add public-IP validation + redirect re-check + timeout (`AbortSignal.timeout`) when touching this code |
| P2-02 | Standard parse reads the whole source into memory before PUT (up to 200 MB; default concurrency 2); the result path can also peak high — a 512 MiB ZIP buffer is held while up to 512 MiB of entries are decoded before the staged write | `lib/parse-manager.js:302,314,335`; `lib/config.js:144`; `lib/parse-manager.js:33` (`ZIP_MAX_BYTES 512 MiB`); `lib/unzip.js:31-35` (`maxTotalBytes 512 MiB`) | Bounded by config/caps and acceptable for a local desktop Harness (real MinerU archives are far smaller), but document the peak or stream the upload and tighten `maxTotalBytes` to a realistic MinerU archive size |
| P2-03 | MinerU control responses are parsed with `response.json()` with no byte cap; the 8 MiB guard only applies to the fallback `.text()` branch. `putBytes` also does not drain a successful response body | `lib/mineru.js:64,215-235`; success return `:499` | Only relevant for a hostile/compromised `apiBase` (user config) or DNS hijack; enforce a cap via `arrayBuffer()`/`text()` with `MAX_JSON_RESPONSE_BYTES` and `drain(response)` on success |
| P2-04 | Markdown link destinations are not scheme-validated; parser can emit `javascript:`/`data:`/`file:` links that render as anchors | `ui/markdown.js:309-341` (`mdReadLink`), `:464-523` (inline HTML/autolink), `ui/app.js:1021` (`href` + `target=_blank rel=noopener`) | QA headless-Chromium probe (same-origin http page): a `javascript:` URL executed when navigated in the same context but **did not execute** with `target=_blank` (only `self` probe hit the server; `blank` probe did not). So current browsers mitigate the anchor-click XSS, but the app relies on target behavior. Defense-in-depth: allowlist `http(s)://`, `mailto:`, `#`, and relative URLs in the parser/renderer; keep `target=_blank rel=noopener noreferrer` |
| P2-05 | Parsed assets are served as whatever `mimeForPath` returns: a `.svg` asset (MinerU keep-set allows `images/*`) is served `image/svg+xml` with `nosniff` but no sandbox CSP. Direct navigation to a crafted SVG would execute script under the harness origin (embedding via `<img>` is safe) | `lib/routes.js:227-256` (content-type at `:247`), contrast the source route's CSP at `:276-286` | Low likelihood (requires MinerU output to contain an SVG + the user opening the asset URL directly). Add `Content-Security-Policy: default-src 'none'; sandbox` (and force `attachment`) for `.svg`/`.html` asset responses, mirroring `handleSource` |
| P2-06 | ~~`engines.node: ">=20"` but `import.meta.dirname` needs Node ≥ 20.11~~ **RESOLVED in Phase B** | `package.json` now `"node": ">=20.11"` (source mtime 19:11) | Fixed by Lead; no further action |
| P2-07 | ~~No package-root `"icon": "./icon.svg"` field~~ **RESOLVED in Phase B** | `package.json` now declares root `"icon": "./icon.svg"` (source mtime 19:11); `ui/*.js` also added to `files` so the Host import of `../ui/markdown.js` resolves in packed installs | Fixed by Lead; manager icon rendering still not visually confirmed (no browser control) |
| P2-08 | README privacy claim ("only MinerU sees file content") is precise for uploads but the reader can fetch remote CDN image URLs from agent-API markdown, and figures have no referrer policy | `ui/app.js:463-467` (http(s) `src` passthrough), `README.md:70-75` | Add a note: agent-parsed documents may reference remote images that the browser fetches; optionally set `referrerPolicy="no-referrer"` and/or proxy through the host |
| P2-09 | Host `getStatus` exposes absolute paths (`configured.dataDir`, `versionInfo.dataDir`) while ARCH says the settings surface shows the data directory symbolically (`dataDirDisplay`) | `lib/service.js:582-588`; `docs/ARCH.md` status row | Same-origin authenticated client only; low sensitivity. Drop the extra absolute fields or adjust the docs |
| P2-10 | Dead/defensive CSS: `.mru-chip--plain` is styled but the client never emits keyword chips (UI-SPEC §3.3 lists it); `.mru-para__text--muted`, `.mru-para__translation-provider`, `.mru-translation__provider`, `.mru-loading`, `.mru-statusbar__group`, `mru-line-skeleton--w60/w80` are unreferenced | `ui/styles.css:473,1288,1371-1385`; `ui/app.js` grep | Cosmetic only; the UI-SPEC copy/state contract remains satisfied elsewhere; design notes deliberately keep defensive classes. Remove or keep as documented |
| P2-11 | One non-localized user-visible fallback: `library.get` returning no document surfaces the hardcoded `'document missing'` message through the toast/error path | `ui/app.js:2672` (`new MruApiError('not-found','document missing')`), shown at `:2695` | Extremely unlikely (host returns a bilingual message otherwise); route it through `err.generic`/a dictionary key |
| P2-12 | In-flight `XMLHttpRequest` uploads are not aborted when the panel unmounts (and `setUploads` state updates are dropped) | `ui/app.js:2752-2775` (`mruUpload` called without signal), `:3731-3764` (unmount cleanup aborts only translate-all) | Upload continues server-side (document may still be created) but the row/user feedback disappears; pass an `AbortController` signal if this matters |
| P2-13 | No window-level `error`/`unhandledrejection` reporter; only the React render boundary pings `panel-error` (ARCH §9.1 mentions "both boundaries") | `ui/app.js:4067-4100,4087` | Event-handler/async errors are invisible in `diagnostics/client.log`; add `window.addEventListener('error'|'unhandledrejection')` → capped `health.ping` |
| P2-14 | The doc row is a `<button>` containing a `<span role="button">` (nested interactive content, invalid a11y markup) | `ui/app.js:1686-1718` | Pattern is prescribed by UI-SPEC §3.3; works in browsers with `stopPropagation`. If accessibility is audited later, split the row into a container + sibling buttons |
| P2-15 | Documentation drift: `docs/HOST-INTERFACES.md` wire section omits implemented exports `requireUuid`/`isPlainObject` (imported by routes/service/store); ARCH §8 calls the non-persistent token state `writable:false` while the implementation/interface use `tokenPersistent` | `docs/HOST-INTERFACES.md:8-22`; `docs/ARCH.md` §8; `lib/config.js:238-249`; `lib/service.js:577` | Docs only; update before publishing the bundle |
| P2-16 | `resolveConfig` accepts a plain-`http:` `apiBase`; the MinerU Bearer token would then travel in clear text over the network | `lib/config.js:129-138` (http accepted), `lib/mineru.js:409-416` (`authorization: Bearer <token>`) | Requires an explicit non-default config edit; keep for local proxies but warn in README/settings when `apiBase` is `http:` and not loopback |
| P2-17 | **New in Phase B (fix review):** `cleanDocDir` is implemented, but its patterns do not match the leftovers this codebase actually creates on a crash. It removes `*.part` / `*.tmp` files and `tmp-*`/`.tmp-*` directories; the real artifacts are `.<file>.tmp-<pid>-<uuid>` atomic-write temps (`lib/store.js:62`) and `.parsed-<uuid>` extraction-staging dirs (`lib/parse-manager.js:465`). QA repro: `.meta.json.tmp-999-abc` and `.parsed-abc123` both survive `init()`, while only an invented `annotations.json.tmp` is removed (it is the one name the code never creates). The new unit test also uses invented `upload.part`/`extract.tmp`/`tmp-extract` names | `lib/store.js:298-325` (patterns), `lib/store.js:62`, `lib/parse-manager.js:465`, `test/unit/qa-fixes.test.mjs:188-235` | P2: stale-file cleanup is currently a no-op against real leftovers (no user impact; disk litter only). Align the patterns (`/^\.parsed-/` dirs, `/\.tmp-[0-9a-f-]+$/i` files) or rename the artifacts, and make the regression test use the real names |

## 4. Residual risk / unverified (explicit)

**Phase B status: Host half and client-half page execution verified; visual/GUI unverified.**
The bundle was installed `link:` at 19:07 and the page refreshed ~19:12. Host evidence (§6.1):
Loader row resolvable, data dir created, `mineru` tool visible *and callable* (live status/list
plus a real persisted agent-parse task), routes registered and correctly fenced (401/403 with the
plugin envelope). Client evidence: `diagnostics/client.log` contains `active` + `icon-rendered`
at 19:12:48Z and 19:14:11Z with no `panel-error`, and the sidebar entry is visible with its
locale-resolved label; the Lead's Slots inspection shows the `sidebar.panellist` occupant
`{id:"mineru", order:35, active:true}`. What remains unverified: (a) **visual rendering and GUI
interactions** — QA has no browser control; (b) **direct `main` slot evidence** — QA's client
Inspect provider times out for all client queries in this session (before and after install), so
the `main` key `mineru` is only indirectly inferred from the same `apply()`; one desk-open by the
user/Lead closes it; (c) the **live process reload** of the P1-fixed Host code (fixed in source,
verified in source, but the running Host loaded the pre-fix tree at 19:07 — reload/recomposition
unconfirmed); (d) completion of the in-flight real MinerU parse (QA observed `phase:"polling"`,
not a terminal state).

Other things this environment cannot or did not verify:

- **Visual rendering / layout cannot be independently confirmed here.** QA has no browser
  control over the live GUI; design's own headless-Chromium visual pass is the designer's claim,
  not an independent QA observation. QA used one headless-Chromium run only for a behavior probe
  (`javascript:` URL handling), not for visual verification. Light/dark visuals, fonts, focus
  rings, overlays and responsive breakpoints are therefore contract/token-verified, not
  pixel-verified by QA.
- **Real MinerU API not exercised.** All parse tests use `test/mock-mineru.mjs` and an injected
  `fetchImpl`; real network behavior, real error payload variants and real archives are unverified.
- **Real DSH credentials service not exercised.** Tests use a fake credentials store; the actual
  `~/.dsh/.credentials.yaml` write/read path, `describeRecord` writability, and cross-session
  token refresh are unverified until Phase B (or a manual token save).
- **DOM selection → annotation offset mapping is not runtime-tested.** The pure helpers
  (`overlayRuns`, `normalizeAnnotation`, parser offsets) are unit-tested and the math was audited
  to match the parser contract, but actual `Range` behavior over the rendered DOM (KaTeX spans
  change text length; bilingual translation nodes) was not exercised in a browser.
- **KaTeX rendering not exercised.** Version/license/font files and loader wiring were verified;
  actual formula rendering and the CSS-in-shadow-free `<style>` injection were not.
- **Browser matrix**: only Node 26 and one Chromium build were available; Firefox/Safari/older
  Chromium behavior is unknown (the link-scheme probe is Chromium-specific evidence).
- **Node 20 support**: `engines` claims ≥ 20; QA ran Node 26 only. `import.meta.dirname` needs
  ≥ 20.11 (P2-06).
- **Page-mark alignment** is contractually best-effort; only the checked-in fixture/content list
  is covered.
- **Concurrency / crash-recovery under load** is covered by unit/e2e interleavings but not
  stress-tested; no fuzzing of markdown/zip inputs beyond the unit cases.
- Windows/macOS path behavior was not tested (Linux only).

## 5. Method notes / QA constraints

- QA read the complete `index.js`, `lib/**` (excluding the generated `lib/client.js` body beyond
  targeted checks), `ui/app.js`, `ui/markdown.js`, `ui/highlight.js`, `ui/styles.css` (token/rule
  verification via scripts + targeted reads), `scripts/**`, `test/**`, all docs and the README.
- API contracts were verified against the installed DSH implementation: `cordis_inspect` Host
  Service queries (webServer, connection, credentials, tools) and source of installed packages
  (`@deepseek-ai/dsh-client-ui-sidebar`, `dsh-client-ui-renderer`, `dsh-client-locale`,
  `dsh-client-ui-plugin-manager`, `dsh-client-modules`, `dsh-package-manifest`,
  `dsh-credentials`, `@deepseek-ai/cordis`) — no profile or Loader changes were made.
- Scratch analysis scripts (class coverage, i18n parity, contrast, annotate-key comparison,
  headless-Chromium probe) were throwaway files under `/tmp` only; nothing was added to the repo.
- **Phase B live methods:** `cordis_inspect` host `Config.listConfigs`/`Tool.listTools`;
  unauthenticated `curl` probes against `http://127.0.0.1:3080` for API/asset/vendor/nonexistent
  paths and for cross-origin Origin headers (no authentication attempted); read-only live
  `mineru` tool calls (`status`/`list`) and inspection of `$DSH_HOME/mineru/**` (diagnostics log,
  document `meta.json`); source re-verification of the Lead's P1 fixes with throwaway `/tmp`
  scripts and the project's own new regression test file. QA's client-side Inspect
  (`Slots`/`Theme`/`Builtin`) is unavailable to a subagent session (queries time out even with
  the page live and even for pre-install baseline queries), so client Slots rows rely on the
  Lead's page inspection + QA's diagnostics evidence, as stated in §6.1.
- QA did not run `plugin_manager`, did not install/modify the harness profile, did not edit any
  deliverable file, and did not run `npm install`. The only file QA created/edits is this report.

## 6. Phase B — live verification results (COMPLETE)

Install context (Lead, confirmed by QA): `plugin_manager install_bundle link:/home/nirvana/Documents/dsh-litnotes`
→ **applied, warnings []**, at ~19:07 +08:00. The user refreshed the page (~19:12 +08:00); the
client half then executed in the live page. All checks below were run by QA between 19:08 and
19:15 +08:00, from this agent session, against the running Host at `http://127.0.0.1:3080` and
`$DSH_HOME=/home/nirvana/.dsh`.

### 6.1 Results

| # | Live check | Result / evidence |
|---|---|---|
| B1 | Loader row registered and resolvable | **PASS (with expected "no schema").** `cordis_inspect host Config.listConfigs name='dsh-litnotes'` → one entry `id:"include:dsh-litnotes"`, `patchId:"dsh-litnotes"`, `name:"dsh-litnotes"`, `packageDir:".../.dsh/profiles/web/node_modules/dsh-litnotes"`. `status:"absent"` means **no Config schema is declared** (by design: ARCH §8 / `lib/config.js` export no schema; the patch carries raw `config: {}`), not that the Loader row is missing. |
| B2 | `mineru` tool visible and callable | **PASS.** `cordis_inspect host Tool.listTools` lists `mineru` with the full 12-action enum/parameter schema. QA **called the live tool**: `mineru {action:"status"}` → `Host 0.1.0+host；文档 1 篇（已解析 0，解析中 1，失败 0）；Token 已配置；翻译 可用；默认模型 可用；数据目录 ~/.dsh/mineru`, followed by the library row for the imported demo PDF (`[parsing] MinerU 示例文档 — id=8cf9864b-…（页数未知，agent）`). The `list`/`status` output matches `lib/agent-tool.js` rendering and exercises the same `service.getStatus()`/`toolList()` the HTTP API uses. |
| B3 | Client half executed in the live page | **PASS.** QA read `$DSH_HOME/mineru/diagnostics/client.log` directly: 4 lines — `{"clientVersion":"client","event":"active","at":"2026-11-06T11:12:48.125Z"}`, `{"event":"icon-rendered","at":"…11:12:48.396Z"}`, and the same pair again at `…11:14:11.809Z/.923Z`. **No `panel-error` line.** This proves the client bundle materialized, `clientMain().apply()` ran, the locale/slot effects ran, the sidebar icon rendered, and the client→Host `health.ping` route is reachable through the live fence (the log is written by the Host on that call). The second pair matches the page-level reload/recomposition observed by the Lead. |
| B4 | Sidebar registration in live Slots | **PASS (page-level, via Lead's inspection + QA diagnostics).** Lead's `Slots.listSubTree root 'sidebar.panellist'` (after refresh) shows occupant `{registrant:"tk", id:"mineru", order:35, active:true}`; the user-visible sidebar shows the **文献库** entry (label resolved through the plugin's `dsh-litnotes` locale namespace, proving `locale.register` + `label: () => t('panel.label')`). QA's own `Slots.listSubTree` queries **time out (10 s) in this session** — the client Inspect provider is not answerable for a subagent session; it also timed out for `Theme`/`Builtin` before install, so this is an environment limitation, not a plugin fault. B3's diagnostics are QA's independent evidence that `apply()` ran. |
| B5 | Main panel registration in live Slots | **PARTIALLY VERIFIED (indirect).** QA cannot issue the `main` Slots query (same client-Inspect timeout as B4), so the `main` key `mineru` occupant was not independently observed. Strong indirect evidence: the main registration is the **second `ctx.effect` in the same `apply()`** that produced the observed panellist occupant, `apply()` certainly ran (B3), and no `panel-error` was logged. Remaining step for full confirmation: open the reading desk once (click 文献库 in the sidebar) and read the `main` tree — expected occupant `{key:"mineru", locale:"dsh-litnotes"}`. |
| B6 | Routes registered and fenced in the live Host | **PASS — strongest live security evidence.** Unauthenticated requests from the shell: `POST /dsh-litnotes/api/status` → **HTTP 401** body `{"ok":false,"error":{"code":"forbidden","message":"请求被拒绝（Request rejected）"}}`; the same 401 for `GET /dsh-litnotes/api/status`, `POST /dsh-litnotes/api/nope`, `GET /dsh-litnotes/api/asset?...`, and `GET /dsh-litnotes/assets/katex/katex.min.js`; `GET /dsh-litnotes/nope` → **404** (outside the plugin prefixes); `POST /dsh-litnotes/api/status` with `Origin: http://evil.example` → **HTTP 403** with the same JSON envelope. This proves the two prefix routes are registered in the live Web server, `ctx.connection.requestRejection` is wired and runs before dispatch/method checks, missing browser auth is refused with the plugin envelope, and cross-origin is refused. No authentication was attempted by QA. |
| B7 | Host boot / live library & parse manager | **PASS.** `$DSH_HOME/mineru/{documents,tmp,diagnostics}` created at 19:07 by `store.init()`; live tool output and on-disk state show a real agent-API parse: `documents/8cf9864b-…/{source.pdf,meta.json}` where `meta.json` persists `status:"parsing"`, `parse:{engine:"agent", phase:"polling", taskId:"16dab7dd-…", startedAt:"2026-11-06T11:13:04.529Z"}` — i.e. the route/tool → service → parse-manager → MinerU-client → persisted-state chain works end-to-end on the user's machine (external MinerU network call was still polling at check time). Host log files under `~/.dsh/logs` predate this run and are not readable as live evidence from QA's sandbox; the created data dir + tool calls + persisted meta.json substitute. |
| B8 | Visual rendering / clicks | **NOT VERIFIED — no browser control in QA.** QA did not see or drive the GUI; no screenshots/DOM. The sidebar entry is reported visible by the Lead/user (second-hand evidence) and the icon-rendered ping is host-side evidence it painted; the reading desk itself is unverified visually. |

### 6.2 P1 fix verification (source) — both PASS

Both Phase A P1s were fixed by the Lead in source at 19:10–19:11 while Phase B was running. QA
re-verified the source (the **running Host process loaded the pre-fix tree at 19:07**; the
19:14:11 client re-apply may or may not have recomposed the Host fiber, so treat these as
"fixed in source, live-process reload pending/unconfirmed"):

| P1 | Fix present in source? | QA re-verification |
|---|---|---|
| P1-01 quote-located annotate keys | `lib/service.js:33` imports `parseMarkdown` from `../ui/markdown.js`; `locateQuote` (`:125-163`) uses the client parser's blocks/keys; `approximateBlocks` removed; new regression tests in `test/unit/qa-fixes.test.mjs` (blockquotes/list/table/ambiguous) | **PASS.** QA's Phase A divergence probes re-run against the fixed service return `KEY-OK` for all previously failing cases (fixture list item, whole list, pipe-table cell, unseparated-pipe-table drift, consecutive blockquotes + later paragraph). `node --test test/unit/qa-fixes.test.mjs` = 5/5; full suite **220/220** |
| P1-02 `cleanDocDir` ReferenceError | `lib/store.js:304-325` implements `cleanDocDir`; boot `init()` no longer references an undefined symbol; new regression test added | **PASS for the crash/warning.** QA re-ran the init repro: library loads with **no warnings** (previously "cleanDocDir is not defined"). New **P2-17** raised against the cleanup's effectiveness (patterns don't match the artifacts actually created) — non-blocking |

Additionally, the Lead resolved Phase A **P2-06** (`engines.node` now `>=20.11`) and **P2-07**
(root `icon` field added; `ui/*.js` added to `files`, which is now *required* because the Host
imports the shared parser — without it a packed install would break). Matrices/gates re-run after
these edits: **`node scripts/check.mjs` = 10/10 PASS; `node --test test/` = 220/220**; client
bundle rebuild byte-identical; `node --check lib/client.js` OK.

### 6.3 Phase B conclusion

- **Host half: verified live** (Loader row, data dir, tool visible + callable, real parse task
  persisted, routes fenced with 401/403 envelopes, no auth bypass found).
- **Client half: verified live** at the page level (diagnostics `active`+`icon-rendered` at
  19:12:48Z and 19:14:11Z, no `panel-error`; sidebar entry visible with resolved label; Lead's
  panellist inspection). Main-panel key is only indirectly verified from QA's side (same `apply()`
  path) because QA's client Inspect channel is unanswerable; a single desk-open check closes it.
- **P1s: fixed in source, QA-verified; live Host reload pending/unconfirmed.** No new P0/P1.
- **Still unverified:** visual rendering/GUI interactions (no browser control), main-slot direct
  evidence, post-reload live behavior of the fixed Host code, and real-MinerU success path for
  the in-flight `agent` parse (QA observed the polling state, not its completion).
