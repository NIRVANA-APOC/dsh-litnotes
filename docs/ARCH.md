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
  (plain Node ESM, Node >= 20.16, no npm dependencies). Owns the on-disk library, the MinerU API
  client, the on-device local parsing engine (T0/T0.5, bundled pdf.js + optional DSH
  `officeToPdf` service), parse polling, HTTP routes on the harness web server, credential
  storage and the agent tool.
- **Client half** — `lib/client.js`, a generated browser bundle loaded by the web module
  loader. Registers a `sidebar.panellist` icon and a keyed `main` panel (`mineru`), renders the
  reading desk, and talks to the Host over the plugin's own JSON HTTP API.

No iframes, no extra server, no npm dependencies in the browser beyond `react` (provided by the
harness module table) and vendored KaTeX served by the Host. The Host ships no npm dependencies
either: the local PDF extractor is vendored as `vendor/pdfjs/**` (pdfjs-dist 5.4.449, Apache-2.0,
≈1.54 MiB) and imported lazily on the first local parse.

```
┌ browser ─────────────────────────────────────────────────────────┐
│ sidebar.panellist: <MineruIcon/>  ──click──▶ ctx.layout.selectPanel('mineru')
│ main['mineru']: <MineruApp/>                                     │
│    fetch: relative 'dsh-litnotes/api/<method>' (cookie-authenticated)│
└──────────────────────────────────────────────────────────────────┘
┌ host (DSH process) ──────────────────────────────────────────────┐
│ index.js  → createStore / createLocalEngine / createParseManager │
│           → createService / registerRoutes / registerAgentTool   │
│ lib/store.js        $DSH_HOME/litnotes/**  (docs, annotations, …)  │
│ lib/mineru.js       https://mineru.net/api/v4|v1  (fetch)         │
│ lib/local-engine.js  pdf.js text layer (vendor/pdfjs) / Office → PDF │
│ lib/parse-manager.js  async task queue + polling + zip extraction │
│ vendor/pdfjs/**     vendored pdfjs-dist 5.4.449 legacy min build  │
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
  lib/local-engine.js       # local parse engine facade, providers, plan      (host-core)
  lib/local-pdf.js          # vendored pdf.js text-layer extractor            (host-core)
  lib/local-synth.js        # page blocks → full.md + content_list.json       (host-core)
  lib/local-office.js       # optional DSH officeToPdf adapter (T0.5)         (host-core)
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
  vendor/pdfjs/**           # vendored pdfjs-dist 5.4.449 Apache-2.0 min build (host-core)
                            #   (pdf.mjs / pdf.worker.mjs / LICENSE, ≈1.54 MiB)
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
        full.md              # MinerU markdown, or the locally synthesized markdown
        content_list.json    # MinerU content list (standard API) or local synthesis
        images/*             # images extracted from full_zip_url (cloud parses only)
      annotations.json       # { version:1, items: Annotation[] }
      translations.json      # { version:1, targetLanguage, entries: { [blockKey]: string } }
  diagnostics/client.log     # client-reported render/error events (capped 200 lines)
```

`docId = crypto.randomUUID()`. Directory scan of `documents/*/meta.json` is the library index;
there is no separate index file (crash-safe by construction).

Local parses (T0/T0.5) write the same two artifacts — `parsed/full.md` and a synthesized,
MinerU-compatible `parsed/content_list.json` — so the reader, page marks, annotations and
translations work unchanged; they never write `images/` (the local engine extracts the text
layer only) and the data-directory layout is otherwise identical. See §5.5.

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
    "engine": "standard | agent | local",
    "provider": "builtin | system:officeToPdf | null",
    "modelVersion": "vlm",
    "language": "ch",
    "options": { "isOcr": false, "enableFormula": true, "enableTable": true, "pageRanges": "" },
    "phase": "extracting | submitting | uploading | polling",
    "remoteState": "waiting-file | uploading | pending | running | converting / null",
    "taskId": "agent task id / null",
    "batchId": "standard batch id / null",
    "startedAt": "…",
    "finishedAt": "…",
    "pages": 15,
    "progress": { "extracted": 3, "total": 15 }, // pages really extracted; null until > 0
    "hasContentList": true,
    "local": { "pageCount": 15, "textChars": 42871, "extractMs": 812,
               "toolVersion": "pdfjs-dist/5.4.449", "provider": "builtin",
               "warnings": ["no-structure"] }
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
- `engine:'local'` parses use `phase:'extracting'`, `modelVersion:null`, all-`false` `options`,
  and set `provider` + `local` (see §5.5). Cloud parses keep `provider:null`, `local:null` unless
  a cloud engine also reports them.

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
| `status` | `{}` | `{ configured:{token, translator, model, dataDir}, counts:{total,parsed,parsing,failed}, dataDirDisplay, preferences, local:LocalCapabilities\|null, version }` |
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
| `settings.get` | `{}` | `{ tokenConfigured, preferences, providers:[…], defaults, local:LocalCapabilities\|null }` |
| `settings.setToken` | `{ token }` | `{ tokenConfigured:true }` |
| `settings.clearToken` | `{}` | `{ tokenConfigured:false }` |
| `settings.update` | `{ preferences }` | `{ preferences }` |

`parse.start` options (all optional, defaulted host-side):

```ts
{
  engine?: 'auto' | 'standard' | 'agent' | 'local', // default 'auto'
  localProvider?: 'auto' | 'builtin' | 'system:officeToPdf', // local only
  modelVersion?: 'pipeline' | 'vlm',        // standard only
  language?: string,                        // default 'ch'
  isOcr?: boolean,
  enableFormula?: boolean,
  enableTable?: boolean,
  pageRanges?: string,                      // '2,4-6'
  extraFormats?: string[]                   // ['docx','html','latex'] optional, standard only
}
```

`engine` policy (`normalizeParseOptions`, `lib/mineru.js:722-857`):

- `auto` (default) — a stored MinerU token → `standard`; no token and the local engine
  `supports()` the file → `local` (on-device, nothing uploaded); otherwise the preference
  `autoAllowAgentFallback` (default `true`) → `agent` (uploads the file), else reject with
  `token-missing` and a "configure a token / use a supported file" hint.
- `standard` — always the precise cloud API; requires a token (`token-missing` otherwise).
- `agent` — the lightweight cloud API; 10 MB / 20 pages, uploads the file.
- `local` — on-device text-layer parsing only; **never** falls back to a cloud engine
  (`local-unsupported` / `local-missing-tool` / `too-large` instead). `localProvider` may force
  `builtin` or `system:officeToPdf`, but a provider that does not match the file is rejected.

Limits: standard ≤ 200 MB, ≤ 200 pages, token required; agent ≤ 10 MB, ≤ 20 pages, no token;
local ≤ 200 MB PDF / ≤ 100 MB Office input / ≤ 500 pages / ≤ 32 MiB extracted text, no token,
no network. `parse.start` rejects early with `too-large` / `token-missing` / `unsupported-type` /
`local-unsupported` / `local-missing-tool` instead of starting a doomed task.

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

## 5. Parsing engines (`lib/mineru.js`, `lib/local-engine.js`)

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

`createParseManager({ store, config, getToken, logger, fetchImpl, localEngine })`:

- `start(id, options)` → validates, persists task phase, enqueues work, returns meta immediately.
  Serialized concurrency cap `config.maxConcurrentParses` (default 2). `executeTask()` is the
  single engine fork: `engine:'local'` → `executeLocalTask()` (never touches the network),
  otherwise the MinerU standard/agent flows below.
- `cancel(id)` → aborts the task's controller; marks `status:'uploaded'` with `error:null`.
- `resume()` → on mount: every doc `status:'parsing'` with `parse.phase==='polling'` restarts the
  poll loop (standard: batchId; agent: taskId). Any other phase — including an interrupted
  `local` extraction, which cannot be resumed — is marked `failed` with
  `"解析被中断，请重试"` (an in-flight upload cannot be resumed safely).
- `dispose()` aborts every task.
- Upstream state: each poll persists the MinerU task state (`waiting-file` / `pending` /
  `running` / `converting`) to `parse.remoteState` whenever it changes, so the client can name
  what MinerU is doing (queued vs parsing vs converting) instead of showing a stagnant bar.
  `getDocument` returns it directly; `listDocuments` includes a compact `parse.remoteState` +
  `parse.ocr` + `parse.startedAt` summary for the progress UI.
- Progress: write `parse.progress` ({extracted,total}) at each poll (throttled to ≥2 s) so the
  client sees movement. MinerU only reports `extract_progress` while `running`, and pipeline/OCR
  tasks routinely report `extracted_pages: 0` for the whole queue/warm-up phase — a zero
  extracted count is treated as "no page progress yet" and is not persisted (the client shows
  the upstream phase + a ticking elapsed time + an indeterminate bar). The counter is monotonic
  within a run, and `resume()` re-seeds it from the persisted value so a host restart cannot move
  it backwards either. A successful parse keeps the final page count (a terminal poll reporting
  zero pages falls back to the last real value); cancel, page-repair rollback and interrupted-parse
  recovery clear progress together with the task ids.
- Local parsing reuses the same progress path: the local engine reports `{extracted,total}`
  per extracted page through the same throttled `parse.progress` write.
- Page repair (`merge:true`) is rejected with `repair-unavailable` (409) when
  `parse.engine==='local'`; local documents must be fully re-parsed (§5.5).

### 5.5 Local parsing engine (T0/T0.5)

The local engine (`lib/local-engine.js`, `createLocalEngine`) turns files into the same reader
artifacts without any MinerU request and without uploading anything. It is one more engine
behind `executeTask()`; `lib/mineru.js` stays cloud-only and the two do not import each other.

**Providers** (`meta.parse.provider`):

| provider | how it works | extensions |
|---|---|---|
| `builtin` | vendored `pdfjs-dist/5.4.449` legacy min build (`vendor/pdfjs/`), PDF text layer + outline | `.pdf` |
| `system:officeToPdf` | DSH web-profile `officeToPdf` service (`ctx.get('officeToPdf')`, LibreOffice kit/WASM) converts the Office file to PDF locally, then the same builtin extractor runs | `.doc .docx .ppt .pptx .xls .xlsx` |

`snapshot()` → `{ enabled, available, recommended, providers:[{id,available,version,reason?}],
capabilities:{textLayerPdf, office, images:false, html:false} }`. `supports(meta)` answers
"can this file be parsed locally, and by which provider" without throwing; `plan()` applies the
size caps and maps failures to `local-*` codes. The Office service is optional: when
`ctx.get('officeToPdf')` is absent (`lib/local-office.js`), Office capability is `false` (reason
`office-to-pdf service is not mounted in this profile`) and those files fall back to a cloud
engine (or `local-missing-tool` when `engine:'local'` was explicit).

`lib/local-pdf.js` is lazy — pdf.js (~1.5 MiB) is imported on the first local parse only, never
at Host startup — and installs inert `DOMMatrix`/`ImageData`/`Path2D` stubs because the legacy
build expects a DOM and the text path never rasterizes. It builds visual lines from
`getTextContent()` (`hasEOL` + baseline jumps), drops repeated running heads and page-number
lines, picks a document title (PDF metadata match or the largest first-page lines), maps
`getOutline()` titles to heading levels 1–4 and falls back to a numbered/font-size heuristic.
`lib/local-synth.js` turns the page blocks into `full.md` (`#` title, `##`–`####` headings,
paragraphs escaped so extracted prose can never be reinterpreted as Markdown) plus the
MinerU-compatible pure-array `content_list.json` `[{page_idx,type:'text',text,text_level?}]`
used by the client's page-mark alignment; long paragraphs are split at sentence boundaries.

**Limits** (`config.local`, defaults; `lib/config.js` clamps them):

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | master switch; `false` restores cloud-only behaviour |
| `maxPages` | `500` | PDFs above this → `too-large` (413) |
| `maxPdfBytes` | `200 MiB` | local PDF input cap → `too-large` (413) |
| `maxOfficePdfBytes` | `100 MiB` | Office input cap → `too-large` (413) |
| `maxTextBytes` | `32 MiB` | extracted-text cap → `too-large` (413) |
| `minCharsPerPage` | `30` | below `max(200, 30×pages)` chars → `local-empty-text` (422) |
| `maxParagraphChars` | `4000` | paragraph split bound (hard max 8000; translation API limit 20000) |
| `keepContentList` | `true` | write synthesized `content_list.json` (page marks) |
| `timeoutMs` | `120000` | extraction deadline → `local-failed` (500) |

**Errors** (stable `WireError` codes; `lib/wire.js` maps HTTP status):

| code | status | when |
|---|---|---|
| `local-unsupported` | 415 (422 from the Office adapter for invalid/unsupported Office content) | extension/provider not supported locally |
| `local-missing-tool` | 503 | local parsing disabled, vendored pdf.js missing/unloadable, Office service absent/busy |
| `local-empty-text` | 422 | no usable text layer — typically a scanned PDF |
| `local-encrypted` | 422 | password/owner-password PDF |
| `local-failed` | 500 (422 for "not a valid PDF") | corrupt input, timeout, unexpected extractor/converter failure |
| `too-large` | 413 | page/size/text caps above |

**Quality boundary (do not overstate):** local parsing keeps text, paragraph breaks and page
numbers well; it does **not** reconstruct formulas (they come out as linear text), table
structure (text rows), images (not extracted), or scanned pages (→ `local-empty-text`). Office
files are converted to PDF first, so the layout is kept but the original OOXML structure is not.
Local documents support whole-document re-parsing only — page-scoped repair is rejected with
`repair-unavailable` (409). The reader shows a local-parse banner and appends a missing-fonts hint
when `local.warnings` contains `missing-fonts`. Explicit `engine:'local'` never silently falls
back to a cloud engine.

**Network:** the extraction path makes no network calls and uploads nothing. In `auto`, the
cloud fallback to `agent` (which does upload) is controlled by the `autoAllowAgentFallback`
preference (default `true`); with it disabled, an unsupported file without a token fails with
`token-missing` guidance instead of uploading.

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
  parse?: { engine?, localProvider?, modelVersion?, language?, isOcr?, enableFormula?,
            enableTable?, pageRanges? },
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
        dataDir: ~/.dsh/litnotes
        apiBase: https://mineru.net
        maxUploadBytes: 209715200
        maxConcurrentParses: 2
        pollIntervalMs: 3000
        parseTimeoutMs: 1800000
        toolMaxChars: 40000
        local:                      # T0/T0.5 local engine (docs/ARCH.md §5.5)
          enabled: true
          maxPages: 500
          maxPdfBytes: 209715200
          maxOfficePdfBytes: 104857600
          maxTextBytes: 33554432
          minCharsPerPage: 30
          maxParagraphChars: 4000
          keepContentList: true
          timeoutMs: 120000
```

Token storage: `ctx.get('credentials')` → `modifyRecord('dsh-litnotes/mineru-token', …)` with
`ApiKeyRecord` `{ kind:'api-key', key }`; `deleteRecord` clears it. The token is never returned
by any API (only `configured: boolean`). If `credentials` is unavailable, the plugin keeps an
in-memory token for the session and reports `tokenPersistent:false` in `status`.

Preferences (client-owned JSON, stored host-side to survive reloads) are persisted in
`<dataDir>/preferences.json`:
`{ targetLanguage:'zh', translationProvider:'auto', readingMode:'original', readingScale:1,
   defaultEngine:'auto', defaultModelVersion:'vlm', defaultLanguage:'ch', defaultIsOcr:false,
   defaultEnableFormula:true, defaultEnableTable:true, showPageMarks:true,
   autoAllowAgentFallback:true }`.
`defaultEngine` accepts `auto|standard|agent|local`. `autoAllowAgentFallback:false` forbids the
`auto` policy's implicit upload fallback to the token-free agent API (§5.5).

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
- Parse: options form with four engine options — 自动 (`auto`) / 精准解析 (`standard`) / 本地解析
  (`local`, disabled with a reason hint when unsupported) / 轻量云端解析 (`agent`) — plus
  model/language/OCR/formula/table/page range and an effective-engine hint (「将使用：本地解析」…).
  The token callout only opens for engines that need it; inline token warning; progress line;
  cancel; retry on failure. Reparse opens the same form in a modal; a local parse has no
  page-scoped repair, only whole-document reparse.
- Reader: fetch `document.markdown` once per open, `parseMarkdown` client-side into blocks;
  render headings/paragraphs/lists/quotes/code/tables/figures/formulas; heading list = outline;
  page marks from `contentList.page_idx` alignment (best effort). A local parse
  (`parse.engine==='local'`) shows a dismissible quality banner (「本地解析结果」 + formula/table/
  figure caveat, `missing-fonts` / `scanned` warnings) with 配置 Token 解锁精准解析 / 重新解析 actions.
- Translation modes: `原文` / `对照` / `译文`; per-block translate + "translate whole document"
  (batched, sequential, progress, cancellable). Translation cache is per document and persisted
  through `translations.save` (debounced 1 s).
- Selection: on `selectionchange` (mouseup + keyboard selection) inside the reader, show a
  popover with translate / highlight swatches / note / copy. Translation of a selection is
  cached by text hash in memory for the session.
- Highlights/notes: offsets relative to the block's plain text (`data-block-key`); colors
  `yellow|sage|sky|rose`; notes editable; margin column lists them; click scrolls to block and
  pulses the highlight. Persist via `annotations.save` (debounced 800 ms).
- Settings modal: token add/clear + reading preferences; a 「本地解析」 section lists the
  capability snapshot (`内置文字层提取` / `Office 转换（office-to-pdf）` with 可用/不可用 +
  version) and a 重新检测 action that re-reads `settings.get`. Shows the data directory
  symbolically (`~/.dsh/litnotes`) and a link-less copy for support.
- Status bar: engine label (`MinerU 精准解析` / `MinerU 轻量解析` / `本地解析`), plus the local
  provider (`内置` / `Office 转换`) and page/word/translation counts.
- Error mapping: `local-unsupported` / `local-missing-tool` / `local-empty-text` /
  `local-encrypted` / `local-failed` have their own i18n copy (scanned-page guidance included);
  a failed local parse suggests 换用云端解析或配置 Token.
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
  presence of locale metadata + icon, the vendored pdf.js assets (`vendor/pdfjs/**` presence and
  version match against `lib/local-pdf.js`), the generated client bundle, runs `node --test test/`
  and prints a compact report.
- Unit tests: `node --test test/**/*.test.mjs` (Node's built-in runner, no dependencies).
- End-to-end: `test/mock-mineru.mjs` starts a local fake MinerU; `test/e2e/*.test.mjs` drives
  `lib/` against it (injected `fetchImpl` and `apiBase`), including a full standard-parse flow,
  an agent-parse flow, an error flow, and a ZIP fixture.
- Local engine tests (T0/T0.5): `test/unit/local-{engine,pdf,synth,office}.test.mjs` (synth
  golden/determinism, the pdf.js adapter against a minimal synthesized PDF, engine/plan/extract
  branching, Office error mapping), `test/e2e/local-flow.test.mjs` (real Host stack, token-free
  `auto` → local with zero mock-MinerU requests, scanned file → `local-empty-text`) and
  `test/reader/local-artifact.test.mjs` (reader artifact contract). The vendored bundle is
  covered by a real lazy `import()` smoke test in `test/unit/local-pdf.test.mjs` and by the
  `vendor pdf.js assets` gate in `scripts/check.mjs` (file presence + `PDFJS_VERSION` match
  against `lib/local-pdf.js`). Last recorded run: `node scripts/check.mjs` 11/11 PASS, 301 tests
  passed (docs/LOCAL-FALLBACK.md 实现状态).

---

## 11. Conventions

- Host code: plain ESM, `node:` builtins only, no TypeScript, no npm imports. JSDoc on exported
  functions. Never `process.exit()`; log via `ctx.logger` inside `index.js`, pass `logger` down.
- Local parsing modules follow the same rules and stay independent of `lib/mineru.js`; the
  vendored pdf.js is data, not a dependency — only `lib/local-pdf.js` imports it, lazily on the
  first local parse. No native modules (the text path needs no canvas).
- Errors: throw `SidebarError`-like objects with `{ code, message, status }`; `wire.writeError`
  maps them. Unknown errors → 500 with a safe message.
- No hardcoded absolute paths; everything hangs off `dataDir`/`import.meta.dirname`.
- Client code: plain ES2022 + React 18 `createElement` (no JSX, no build step inside app.js).
  No network calls except the plugin API. No `localStorage` (preferences live host-side), except
  a tiny UI-only flag if unavoidable (document why).
- UTF-8, LF line endings, no trailing whitespace.
- Security: validate every `id` as UUID, every relative asset path against traversal, cap all
  bodies, never return the token, never trust client-provided filesystem paths.
