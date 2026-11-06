# dsh-litnotes — architecture & implementation contract

A DeepSeek Harness (DSH) plugin that gives the Web GUI a left-sidebar entry opening a
**literature reading desk**: import local papers, parse them with the official MinerU API,
read the parsed document with bilingual translation, highlights and margin notes, and let the
agent manage the same library through a Host tool.

Primary scenario: **reading English academic papers in Chinese** (对照翻译 / 划词翻译 / 高亮 /
批注). Secondary: any PDF/DOCX/image/HTML document the user wants MinerU to structure.

Runtime target: DSH `0.2.2-rc.1`, Web profile, DSH host + browser client.

---

## 1. Topology

The plugin ships as one installable **bundle** (workspace directory, installed through
`plugin_manager install_bundle`). It has two halves:

- **Host half** — `index.js` + `lib/*.js`, loaded by the Cordis loader in the DSH host process
  (plain Node ESM, Node >= 20, no npm dependencies). Owns the on-disk library, the MinerU API
  client, parse polling, HTTP routes on the harness web server, credential storage and the
  agent tool.
- **Client half** — `lib/client.js`, a generated browser bundle loaded by the web module
  loader. Registers a `sidebar.panellist` icon and a keyed `main` panel (`mineru`), renders the
  reading desk, and talks to the Host over the plugin's own JSON HTTP API.

No iframes, no extra server, no npm dependencies in the browser beyond `react` (provided by the
harness module table) and vendored KaTeX served by the Host.

```
┌ browser ─────────────────────────────────────────────────────────┐
│ sidebar.panellist: <MineruIcon/>  ──click──▶ ctx.layout.selectPanel('mineru')
│ main['mineru']: <MineruApp/>                                     │
│    fetch: relative 'dsh-litnotes/api/<method>' (cookie-authenticated)│
└──────────────────────────────────────────────────────────────────┘
┌ host (DSH process) ──────────────────────────────────────────────┐
│ index.js  → createStore / createParseManager / createService     │
│           → registerRoutes(ctx.webServer) / registerAgentTool     │
│ lib/store.js        $DSH_HOME/mineru/**  (docs, annotations, …)  │
│ lib/mineru.js       https://mineru.net/api/v4|v1  (fetch)         │
│ lib/parse-manager.js  async task queue + polling + zip extraction │
└──────────────────────────────────────────────────────────────────┘
```

### Why HTTP routes instead of generated Remote methods

Generated `ctx.remote` namespaces need Typert code generation at build time; a hand-authored
plain-JS bundle cannot produce them. The Host instead registers ordinary web routes and the
client calls them with same-origin `fetch` (the browser session cookie is sent automatically).
Every request is admitted with `ctx.connection.requestRejection(req)`, which is the same
Host/Origin + browser-cookie fence other first-party plugins use.

---

## 2. Files & ownership

```
dsh-litnotes/
  package.json              # bundle manifest + dsh.bundle / dsh.client      (Lead)
  cordis.patch.yml          # one inserted row                                (Lead)
  index.js                  # host entry: wiring, lifecycle                   (Lead)
  lib/store.js              # on-disk library persistence                     (host-core)
  lib/mineru.js             # MinerU HTTP client + error mapping              (host-core)
  lib/unzip.js              # dependency-free ZIP extractor                   (host-core)
  lib/parse-manager.js      # parse task queue, polling, recovery             (host-core)
  lib/service.js            # operations shared by HTTP API and agent tool    (host-core)
  lib/routes.js             # web routes: JSON API, raw upload, assets        (host-core)
  lib/agent-tool.js         # `mineru` agent tool                             (host-core)
  lib/config.js             # config defaults, data-dir + token helpers       (host-core)
  lib/wire.js               # JSON envelopes, body readers, errors            (host-core)
  lib/mime.js               # extension → content type                        (host-core)
  ui/app.js                 # client application (React, factory template)    (client-ui)
  ui/markdown.js            # pure markdown/parser helpers (ESM, testable)    (client-reader)
  ui/highlight.js           # pure annotation/offset helpers (ESM, testable)  (client-reader)
  ui/styles.css             # design system + all component styles            (design)
  ui/panel-icon.svg         # 24px sidebar icon (inlined at build)            (design)
  ui/empty-art.svg          # empty-state illustration (inlined at build)     (design)
  icon.svg                  # 64px plugin/manager icon                        (design)
  scripts/build-client.mjs  # ui/* → lib/client.js                           (Lead)
  scripts/check.mjs         # manifest + syntax + unit-test gate             (test-harness)
  test/**                   # unit, mock-MinerU and end-to-end tests         (test-harness, client-reader)
  vendor/katex/**           # vendored KaTeX 0.16.x MIT runtime (see LICENSE) (Lead)
  locale/{zh,en}.json       # Plugin Manager title/description                (Lead)
  docs/**                   # this contract + UI spec                        (Lead)
  README.md                 # user docs                                      (Lead)
```

**Write scopes are exclusive.** Never edit a file outside your task's scope; report needed
changes to the Lead instead.

---

## 3. Data directory & document model

Root: `<DSH_HOME>/mineru` (override `config.dataDir`; `~` expanded; `$DSH_HOME` defaults to
`~/.dsh`). Created lazily. Layout:

```
mineru/
  documents/
    <docId>/
      meta.json              # document metadata (source of truth)
      source.<ext>           # the uploaded original
      parsed/
        full.md              # MinerU markdown
        content_list.json    # MinerU content list (standard API only)
        images/*             # images extracted from full_zip_url
      annotations.json       # { version:1, items: Annotation[] }
      translations.json      # { version:1, targetLanguage, entries: { [blockKey]: string } }
  diagnostics/client.log     # client-reported render/error events (capped 200 lines)
```

`docId = crypto.randomUUID()`. Directory scan of `documents/*/meta.json` is the library index;
there is no separate index file (crash-safe by construction).

### meta.json

```json
{
  "schemaVersion": 1,
  "id": "uuid",
  "title": "Attention Is All You Need",
  "originalName": "attention.pdf",
  "ext": ".pdf",
  "mime": "application/pdf",
  "size": 2210123,
  "sha256": "…",
  "createdAt": "2026-11-06T09:00:00.000Z",
  "updatedAt": "2026-11-06T09:04:00.000Z",
  "status": "uploaded | parsing | parsed | failed",
  "error": null,
  "parse": {
    "engine": "standard | agent",
    "modelVersion": "vlm",
    "language": "ch",
    "options": { "isOcr": false, "enableFormula": true, "enableTable": true, "pageRanges": "" },
    "phase": "submitting | uploading | polling",
    "taskId": "agent task id / null",
    "batchId": "standard batch id / null",
    "startedAt": "…",
    "finishedAt": "…",
    "pages": 15,
    "progress": { "extracted": 3, "total": 15 },
    "hasContentList": true
  }
}
```

Rules:
- All JSON writes are atomic (`write tmp` → `rename`), serialized per document by a promise chain.
- `status: "parsing"` is persisted before the network work starts, so a host restart can resume
  or explicitly fail the task (see `parse-manager.resume()`).
- `title` starts as the filename stem; on successful parse the first `# heading` of the markdown
  becomes the default title when the user has not renamed the document.
- Deleting a doc removes its whole directory. IDs are validated as UUID-shaped before any path use.

---

## 4. Host HTTP API

All routes live under `/dsh-litnotes`. Every request passes the **fence**:

```js
const fence = (req) => ctx.connection.requestRejection(req) === undefined
```

Failures answer `403 {ok:false,error:{code:'forbidden'}}`. The client resolves route URLs
relative to `document.baseURI` (prefix-safe, like dsh-better-sidebar's `hostRouteUrl`), so a
reverse-proxied GUI keeps working.

### 4.1 JSON API — `POST /dsh-litnotes/api/<method>`

Body: one JSON object (≤ 2 MiB). Response envelope:

```json
{ "ok": true, "value": <json> }
{ "ok": false, "error": { "code": "token-missing", "message": "…" } }
```

HTTP status: 200 on success; 400/401/403/404/405/409/422/500 according to the error. The client
shows `error.message`; `error.code` also drives UI branches (e.g. `token-missing`).

| method | payload | returns |
|---|---|---|
| `health.ping` | `{ clientVersion, event }` | `{ ok:true, hostVersion, receivedAt }` — appends to diagnostics log |
| `status` | `{}` | `{ configured:{token, translator, model, dataDir}, counts:{total,parsed,parsing,failed}, dataDirDisplay, version }` |
| `library.list` | `{}` | `{ documents: DocSummary[] }` newest first; `DocSummary` = meta sans heavy fields |
| `library.get` | `{ id }` | `{ document: meta, annotations: Annotation[], translations: translations.json }` |
| `library.update` | `{ id, title? }` | `{ document }` |
| `library.remove` | `{ id }` | `{ removed:true }` |
| `library.importUrl` | `{ url, title? }` | `{ document }` — downloads into library (≤ maxUploadBytes) |
| `parse.start` | `{ id, options }` | `{ document }` — starts async parse; options below |
| `parse.cancel` | `{ id }` | `{ document }` — stops local polling; keeps source |
| `document.markdown` | `{ id }` | `{ markdown, contentList: object[]\|null, pages:number\|null }` |
| `annotations.save` | `{ id, annotations }` | `{ saved:true }` — replaces whole list (client owns merge) |
| `translations.save` | `{ id, targetLanguage, entries }` | `{ saved:true }` |
| `translate` | `{ text, targetLanguage?, sourceLanguage?, provider? }` | `{ translation, provider, targetLanguage }` |
| `settings.get` | `{}` | `{ tokenConfigured, preferences, providers:[…], defaults }` |
| `settings.setToken` | `{ token }` | `{ tokenConfigured:true }` |
| `settings.clearToken` | `{}` | `{ tokenConfigured:false }` |
| `settings.update` | `{ preferences }` | `{ preferences }` |

`parse.start` options (all optional, defaulted host-side):

```ts
{
  engine?: 'auto' | 'standard' | 'agent',   // auto = standard when token present else agent
  modelVersion?: 'pipeline' | 'vlm',        // standard only
  language?: string,                        // default 'ch'
  isOcr?: boolean,
  enableFormula?: boolean,
  enableTable?: boolean,
  pageRanges?: string,                      // '2,4-6'
  extraFormats?: string[]                   // ['docx','html','latex'] optional, standard only
}
```

Limits: standard ≤ 200 MB, ≤ 200 pages, token required; agent ≤ 10 MB, ≤ 20 pages, no token.
`parse.start` rejects early with `too-large` / `token-missing` / `unsupported-type` instead of
starting a doomed task. `engine:'auto'` picks standard when a token is stored; if the file
exceeds the agent limits and no token is stored, reject with a message pointing at token setup.

### 4.2 Raw upload — `POST /dsh-litnotes/api/upload`

- Body: the file's raw bytes (streamed; no base64, no multipart).
- Header `x-file-name`: `encodeURIComponent(file.name)`.
- Header `x-doc-title`: optional `encodeURIComponent(title)`.
- Returns the same JSON envelope as 4.1 with `{ document }`.
- Enforced cap: `maxUploadBytes` (default 200 MiB); on overflow, delete the partial file and
  answer 413 `too-large`.
- Supported extensions (case-insensitive): `.pdf .doc .docx .ppt .pptx .xls .xlsx .png .jpg
  .jpeg .jp2 .webp .gif .bmp .html .htm`. Unknown types answer 415 `unsupported-type`.

### 4.3 Asset routes (GET, browser `<img>` / download)

| route | purpose |
|---|---|
| `/dsh-litnotes/api/asset?id=<docId>&path=<parsedRelativePath>` | serves an extracted parsed file image (path confined to `<docDir>/parsed/**`; `..` rejected). `Cache-Control: private, max-age=86400`. |
| `/dsh-litnotes/api/source?id=<docId>&download=0\|1` | serves the original file; PDF is inline, others `attachment` when `download=1`. |
| `/dsh-litnotes/assets/<rel>` | serves vendored package assets from `vendor/` (KaTeX): `.js .css .woff2` (+). Immutable cache. |

MIME map in `lib/mime.js`. Assets are also fenced.

### 4.4 Diagnostics

`health.ping` and client-side render/error reports append one JSON line to
`<dataDir>/diagnostics/client.log` (capped; rotate by truncating oldest). The Lead uses this file
to verify the client half really executed in the live page. Client reports:
`{ at, clientVersion, event: 'active'|'icon-rendered'|'panel-error', detail }`.

---

## 5. MinerU integration (`lib/mineru.js`)

API docs snapshot: `docs/MINERU.md`. Base `https://mineru.net` (override `config.apiBase` for
tests/proxies). `fetchImpl` is injectable for unit tests.

### 5.1 Standard (precise) API — token required

1. `POST /api/v4/file-urls/batch`
   `{ files:[{ name, data_id: docId }], model_version, language, is_ocr, enable_formula,
      enable_table, page_ranges?, extra_formats? }`
   → `{ data: { batch_id, file_urls: [url] } }`
2. `PUT <file_url>` with raw bytes, **no Content-Type header**.
3. Poll `GET /api/v4/extract-results/batch/<batch_id>` until the result matched by `data_id`
   (fallback `file_name`) is `done` → `full_zip_url`; `failed` → `err_msg`.
   States: `waiting-file pending running converting done failed`.
4. Download the zip, extract `full.md`, `*_content_list.json`, `images/**` into `parsed/`.
   (Pure-JS extractor, see §6.)

### 5.2 Agent lightweight API — no token

1. `POST /api/v1/agent/parse/file`
   `{ file_name, language, enable_table, is_ocr, enable_formula, page_range? }`
   → `{ data: { task_id, file_url } }`
2. `PUT <file_url>` raw bytes.
3. Poll `GET /api/v1/agent/parse/<task_id>`; `done` → `markdown_url`; `failed` → `err_msg`.
4. Download markdown text; save as `full.md`. No content list / local images (remote or missing).

### 5.3 Errors

`class MineruError extends Error { code, httpStatus, detail }`. Map API `code`/`err_code` to
friendly bilingual messages: `A0202` token wrong, `A0211` token expired, `-60005` too large,
`-60006` too many pages, `-60009` queue full, `-30001/-30003` lightweight limits, etc. Network
failures: retry `GET` polls up to 3 consecutive failures; `PUT`/`POST` retry once. Overall task
timeout 30 min (`config.parseTimeoutMs`). Cancellation via an `AbortController` per task.

### 5.4 Parse manager

`createParseManager({ store, config, getToken, logger, fetchImpl, translator })`:

- `start(id, options)` → validates, persists task phase, enqueues work, returns meta immediately.
  Serialized concurrency cap `config.maxConcurrentParses` (default 2).
- `cancel(id)` → aborts the task's controller; marks `status:'uploaded'` with `error:null`.
- `resume()` → on mount: every doc `status:'parsing'` with `parse.phase==='polling'` restarts the
  poll loop (standard: batchId; agent: taskId). Any other phase is marked `failed` with
  `"解析被中断，请重试"` (an in-flight upload cannot be resumed safely).
- `dispose()` aborts every task.
- Progress: write `parse.progress` at each poll (throttled to ≥2 s) so the client sees movement.

---

## 6. ZIP extractor (`lib/unzip.js`)

Dependency-free, memory-based ZIP reader sufficient for MinerU result archives:

- Parse EOCD, central directory, local headers; support method 0 (stored) and 8 (deflate,
  `node:zlib.inflateRawSync`).
- Path safety: reject absolute paths, drive letters, `..` segments, backslashes normalized;
  skip directories.
- Caps: `maxEntries` (default 5000), `maxTotalBytes` (default 512 MiB), single entry 128 MiB.
- API: `unzip(buffer, { filter?, maxEntries?, maxTotalBytes? }) → { entries: [{ name, data }], skipped }`.
- Reject ZIP64 (`0xFFFFFFFF` sizes) with a clear error (MinerU archives do not need it).
- The parse manager only keeps: `full.md`, `*_content_list.json`, `images/**` (all extensions);
  every other entry is skipped to keep disk usage bounded.

---

## 7. Agent tool (`mineru`)

Registered globally with `ctx.tools.register`. One tool, `action` parameter (same operations as
the HTTP API through `lib/service.js` — one implementation, two callers).

```
mineru({
  action: 'list' | 'status' | 'get' | 'import_url' | 'parse' | 'read' | 'annotations'
        | 'annotate' | 'unannotate' | 'translate' | 'delete' | 'update',
  documentId?, url?, title?, text?, targetLanguage?, query?,
  offset?, maxChars?,
  parse?: { engine?, modelVersion?, language?, isOcr?, enableFormula?, enableTable?, pageRanges? },
  annotation?: { id?, blockKey?, start?, end?, quote?, note?, color? }
})
```

- `list`: compact rows (`id, title, status, pages, engine, createdAt`).
- `read`: markdown slice with `offset` (chars, default 0) and `maxChars` (default 12000, cap
  `config.toolMaxChars` 40000), returns `{ text, offset, nextOffset, totalChars, truncated }`.
- `annotate` without `blockKey` uses `quote`/`text` to locate the unique block containing it
  (host searches the markdown and stores a `b<index>:<hash>` key matching the client's scheme).
- Every result is human-readable too: `output.render` returns a `text` content block with a
  compact JSON/README-style rendering. Errors become tool failures with the message.

Tool name must not collide: `mineru`.

---

## 8. Config & credentials

Raw config (no schema export; validated in `lib/config.js`):

```yaml
- insert:
    - id: dsh-litnotes
      name: dsh-litnotes
      config:
        # all optional
        dataDir: ~/.dsh/mineru
        apiBase: https://mineru.net
        maxUploadBytes: 209715200
        maxConcurrentParses: 2
        pollIntervalMs: 3000
        parseTimeoutMs: 1800000
        toolMaxChars: 40000
```

Token storage: `ctx.get('credentials')` → `modifyRecord('dsh-litnotes/api-token', …)` with
`ApiKeyRecord` `{ kind:'api-key', key }`; `deleteRecord` clears it. The token is never returned
by any API (only `configured: boolean`). If `credentials` is unavailable, the plugin keeps an
in-memory token for the session and reports `writable:false` in `status`.

Preferences (client-owned JSON, stored host-side to survive reloads) are persisted in
`<dataDir>/preferences.json`:
`{ targetLanguage:'zh', translationProvider:'auto', readingScale:1, defaultEngine:'auto',
   defaultModelVersion:'vlm', defaultLanguage:'ch', showPageMarks:true }`.

Translation: `lib/service.js` `translate()` uses `ctx.get('translator')` when available:
`resolve({text,targetLanguage,sourceLanguage,provider})` then `translate(spec)`, preferring an
anonymous provider (`google`, `bing`). If translator is unavailable or fails, fall back to
`ctx.get('llm')` with the agent default model (`ctx.get('agentDefaultModel').currentSelection()`)
and a strict "translate only" prompt. Errors surface with code `translate-unavailable`.

---

## 9. Client half

### 9.1 Module format

`lib/client.js` is generated by `scripts/build-client.mjs` from `ui/*` and must load as:

```js
window.__ModuleLoader__.load({
  id: 'dsh-litnotes',
  factory(require) {
    const React = require('react'); const h = React.createElement
    /* ui/markdown.js body (exports stripped) */
    /* ui/highlight.js body (exports stripped) */
    return clientMain(require)            // defined at the end of ui/app.js
  },
})
```

`clientMain` returns `{ inject: ['slots','locale','layout'], apply(ctx) }`.

- `apply` registers locale dictionaries (`ctx.locale.register('dsh-litnotes', { zh, en })`), then
  `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name:'sidebar.panellist',
  id:'mineru', order:35, locale:'dsh-litnotes', label: () => t('panel.label') }, MineruPanelIcon))`
  and `ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key:'mineru',
  locale:'dsh-litnotes' }, MineruApp))`.
- Styles: the generated bundle carries the full `ui/styles.css` as a JS string; a `<style>`
  React element is rendered inside the app root (removes itself on unmount). The icon SVG comes
  from `ui/panel-icon.svg`, the empty-state art from `ui/empty-art.svg`, both inlined by the
  build script and read from placeholder constants in `ui/app.js`:
  `const CSS = __MINERU_CSS_JSON__;`, `const PANEL_ICON = __MINERU_PANEL_ICON_JSON__;`,
  `const EMPTY_ART = __MINERU_EMPTY_ART_JSON__;` — **keep these exact statements**.
- Do not import harness Client packages; only `require('react')` is available.
- Do not touch `document.body`; all DOM lives in the slot's React tree. The one exception is
  loading KaTeX assets: create `<link>`/`<script>` elements inside `apply` with `ctx.effect`
  cleanup (they are inert assets, not app UI).
- Client global error handling: a React error boundary around the app; both boundaries and a
  one-shot "active" ping call `health.ping` so the Lead can verify the live page.

### 9.2 Transport

`api/<method>` URLs resolve against `document.baseURI` (strip leading `/`). JSON POST helper +
raw upload helper + cancellation (`AbortSignal`). Client tolerates a missing Host route
(404/403) by showing a `尚未就绪` banner and retrying status every 4 s up to ~30 s.

### 9.3 Behaviour

- Load `status` + `library.list` on mount and on `visibilitychange`/window focus.
- While any document is `status:'parsing'`, poll `library.list` every 2.5 s; stop when none.
- Import: file input (multiple), drag & drop onto the app, or URL import modal. Upload shows a
  determinate progress via `XMLHttpRequest` upload events (or a spinner when unavailable).
- Parse: options form (engine/model/language/OCR/formula/table/page range) with inline token
  warning; progress line; cancel; retry on failure. Reparse opens the same form in a modal.
- Reader: fetch `document.markdown` once per open, `parseMarkdown` client-side into blocks;
  render headings/paragraphs/lists/quotes/code/tables/figures/formulas; heading list = outline;
  page marks from `contentList.page_idx` alignment (best effort).
- Translation modes: `原文` / `对照` / `译文`; per-block translate + "translate whole document"
  (batched, sequential, progress, cancellable). Translation cache is per document and persisted
  through `translations.save` (debounced 1 s).
- Selection: on `selectionchange` (mouseup + keyboard selection) inside the reader, show a
  popover with translate / highlight swatches / note / copy. Translation of a selection is
  cached by text hash in memory for the session.
- Highlights/notes: offsets relative to the block's plain text (`data-block-key`); colors
  `yellow|sage|sky|rose`; notes editable; margin column lists them; click scrolls to block and
  pulses the highlight. Persist via `annotations.save` (debounced 800 ms).
- Settings modal: token add/clear + provider/engine defaults + reading preferences. Shows the
  data directory symbolically (`~/.dsh/mineru`) and a link-less copy for support.
- i18n: zh + en dictionaries in `ui/app.js` under `dsh-litnotes` namespace. zh is the default when
  the harness locale is zh; the plugin must look correct in either. All visible copy goes
  through `t()`.
- Accessibility: buttons are `<button>`, icons carry `aria-label`, highlight marks are
  `<mark role="mark">` with a note, popovers close on Escape, modal traps focus minimally,
  `prefers-reduced-motion` disables the open animation.

---

## 10. Build & checks

- `node scripts/build-client.mjs` → `lib/client.js` (must keep the `window.__ModuleLoader__.load`
  shell; strip `export ` tokens from the three UI modules; inline CSS/SVG placeholders;
  fail on missing placeholders or leftover `export`/`import` statements).
- `node scripts/check.mjs` → validates `package.json` (`dsh.bundle.patch`, `dsh.client`,
  exports/files), YAML patch shape, JS syntax of every shipped `.js` (`node --check`), the
  presence of locale metadata + icon, runs `node --test test/` and prints a compact report.
- Unit tests: `node --test test/**/*.test.mjs` (Node's built-in runner, no dependencies).
- End-to-end: `test/mock-mineru.mjs` starts a local fake MinerU; `test/e2e/*.test.mjs` drives
  `lib/` against it (injected `fetchImpl` and `apiBase`), including a full standard-parse flow,
  an agent-parse flow, an error flow, and a ZIP fixture.

---

## 11. Conventions

- Host code: plain ESM, `node:` builtins only, no TypeScript, no npm imports. JSDoc on exported
  functions. Never `process.exit()`; log via `ctx.logger` inside `index.js`, pass `logger` down.
- Errors: throw `SidebarError`-like objects with `{ code, message, status }`; `wire.writeError`
  maps them. Unknown errors → 500 with a safe message.
- No hardcoded absolute paths; everything hangs off `dataDir`/`import.meta.dirname`.
- Client code: plain ES2022 + React 18 `createElement` (no JSX, no build step inside app.js).
  No network calls except the plugin API. No `localStorage` (preferences live host-side), except
  a tiny UI-only flag if unavoidable (document why).
- UTF-8, LF line endings, no trailing whitespace.
- Security: validate every `id` as UUID, every relative asset path against traversal, cap all
  bodies, never return the token, never trust client-provided filesystem paths.
