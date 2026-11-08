# dsh-litnotes — parsing pipeline (1.1.0-alpha.1)

How a source file becomes a readable document: engine selection, the two MinerU cloud APIs, the
local (on-device) engine, artifact formats, progress/cancel/resume semantics, page-scoped repair,
annotation re-anchoring and the offline test strategy. Code:
`src/host/parse/**`, `src/host/service.ts`, `src/host/contracts.ts` (`ParseManagerApi`,
`LocalEngineApi`, `NormalizeParseOptions`, `ReanchorHook`). Wire/limits: `ARCH.md` §12.

## 1. Pipeline at a glance

```
upload/import ─► documents/<id>/source.<ext> + meta.json (status uploaded)
                     │  parse.start  (service validates, engine policy decides)
                     ▼
          parse manager queue  ── status parsing (phase persisted)
                     │
      ┌──────────────┼───────────────────────────────┐
      ▼              ▼                               ▼
 MinerU standard  MinerU agent                   local engine
 (token, ZIP)     (no token, markdown url)      (pdf.js / officeToPdf)
      │              │                               │
      └──────────────┴──────────── parsed/ artifacts ─┘
                     ▼
      status parsed  ─► optional annotation re-anchor
                     ─► optional auto knowledge-graph build (client preference)
```

A parse is **asynchronous**: `parse.start` persists the state, queues the work and returns the
document metadata immediately. Clients (and the agent) poll `status` / `library.list` for
`status`, `parse.phase`, `parse.remoteState` and `parse.progress`. Cancelling is
`parse.cancel`; a failed parse gets `status:'failed'` plus a human-facing `meta.error`, and can be
retried by starting a new parse.

## 2. Accepted inputs and caps

| layer | rule |
|---|---|
| upload / import | `.pdf .doc .docx .ppt .pptx .xls .xlsx .png .jpg .jpeg .jp2 .webp .gif .bmp .html .htm` |
| upload body | resolved `maxUploadBytes` (default 200 MiB, clamp 64 KiB – 2 GiB) |
| MinerU standard | ≤ 200 MiB, ≤ 200 pages (MinerU-enforced) |
| MinerU agent | ≤ 10 MiB, ≤ 20 pages; extensions `.pdf .png .jpg .jpeg .jp2 .webp .gif .bmp .docx .pptx .xlsx` |
| local PDF (T0) | `local.maxPdfBytes` (200 MiB), `local.maxPages` (500), `local.maxTextBytes` (32 MiB), `local.timeoutMs` (120 s) |
| local Office (T0.5) | source ≤ `local.maxOfficePdfBytes` (100 MiB) |
| ZIP result | ≤ 5 000 entries, ≤ 512 MiB total expanded, ≤ 128 MiB per entry; no ZIP64, no encryption, no path traversal |

The extension whitelist is `SUPPORTED_EXTENSIONS` in `src/shared/constants.ts`; images and Office
extensions are subsets used by the local engine and the asset route.

## 3. MinerU standard API (precise, token)

Bearer-token API under `/api/v4`. Requires a configured MinerU token.

1. `POST /api/v4/file-urls/batch` — request a signed upload URL for one file (`batchId`,
   `uploadUrl`). The request carries the parse parameters:
   - `modelVersion`: `pipeline | vlm` (default `vlm`)
   - `language`: MinerU language code (`ch`, `en`, `japan`, `korean`, `chinese_cht`, `latin`,
     `arabic`, `cyrillic`, `east_slavic`, `devanagari`, `ta`, `te`, `ka`, `el`, `th`; the UI offers
     the common subset)
   - `isOcr` — force OCR
   - `enableFormula`, `enableTable` — structure extraction (default on)
   - `pageRanges` — e.g. `2,4-6`; empty means all pages
   - `extraFormats` — optional extra outputs (`docx`, `html`, `latex`)
2. `PUT <uploadUrl>` — raw bytes, no extra headers.
3. `GET /api/v4/extract-results/batch/<batchId>` — poll until the file state is `done` or
   `failed`. The done result carries `full_zip_url` (and per-file progress).
4. Download the ZIP (bounded by `maxUploadBytes`-scale result caps) and extract `full.md`,
   `*_content_list.json` and `images/**` into `documents/<id>/parsed/`.

## 4. MinerU agent API (token-free, lightweight)

No-token API under `/api/v1`, used as the cloud fallback when no MinerU token is configured and
local parsing cannot handle the file.

1. `POST /api/v1/agent/parse/file` — request a signed upload (`taskId`, `uploadUrl`).
2. `PUT <uploadUrl>` — raw bytes.
3. `GET /api/v1/agent/parse/<taskId>` — poll; `done` yields a `markdown_url`.
4. Download the markdown and save it as `parsed/full.md`. **No content list and no images** — page
   marks fall back to none and the reader shows no sourced figures.

## 5. Engine policy (`auto`/explicit)

`normalizeParseOptions` (`src/host/parse/mineru.ts`, injected into the service) resolves the
request against the document and the available capabilities before a task is queued, so a doomed
parse is rejected with a branchable error instead of failing asynchronously.

| request | resolution |
|---|---|
| `auto` + token configured | `standard` |
| `auto`, no token, local engine supports the file | `local` (no upload) |
| `auto`, no token, local unsupported, agent fallback allowed (default) | `agent` |
| `auto`, no token, local unsupported, `autoAllowAgentFallback:false` | reject `token-missing` (401) |
| explicit `standard` without a token | reject `token-missing` (401) |
| explicit `local` | must be supported by the local engine (see below) |
| explicit `agent` | agent-API limits and extension whitelist apply |

Precondition failures: `bad-request` (invalid engine/options/page range), `too-large` (upload or
engine byte cap), `unsupported-type` (extension not accepted by the engine), `local-unsupported`
(engine present but format unsupported), `local-missing-tool` (engine unavailable/disabled or the
Office converter is not mounted; 503). The request is never queued when a precondition fails.

## 6. Local engine (T0 / T0.5)

On-device text extraction with **no token and no network upload**; artifacts are written through
the same parsed contract as cloud parses, so reading/translation/annotations behave identically.

- **T0 builtin — PDF.** The vendored pdf.js legacy build (`vendor/pdfjs/pdf.mjs`, pdf.js
  **5.4.449**, Apache-2.0) is imported **lazily on the first local parse** and never at Host
  startup. Page text is segmented into heading/paragraph page blocks (outline-derived headings
  where available, font-size + numbering heuristics otherwise; a wrapped title is removed from the
  body). The reader trusts pdf.js content-stream order: correct on common two-column papers.
- **T0.5 Office.** `.doc .docx .ppt .pptx .xls .xlsx` first go through the DSH
  `officeToPdf` service (`ctx.get('officeToPdf')`, local LibreOffice/WASM conversion), then through
  the same PDF extractor. The service is optional and resolved lazily per parse; when the profile
  does not mount it, Office cannot be parsed locally and the cloud fallback/token guidance applies.
- **Synthesis.** `host/parse/local/synth.ts` writes `parsed/full.md` (title as `#`, headings as
  `##`–`####`, paragraphs) plus a MinerU-compatible `parsed/content_list.json`
  (`{page_idx, type, text, text_level?}`) used for page marks. Extracted prose is deterministically
  escaped so it can never be reinterpreted as markdown structure while the reader's plain text
  stays byte-identical.
- **Capabilities.** The engine exposes `snapshot()` (enabled/available, providers `builtin` and
  `system:officeToPdf` with versions/reasons, capabilities) and `supports(meta)`; `/status` and
  `/settings.get` surface the snapshot to the client.
- **Limits.** PDF ≤ `local.maxPdfBytes`, pages ≤ `local.maxPages`, extracted text ≤
  `local.maxTextBytes`, job deadline `local.timeoutMs`; paragraph length capped by
  `local.maxParagraphChars`; Office source ≤ `local.maxOfficePdfBytes`. Errors are
  `local-empty-text` (422, likely a scan), `local-encrypted` (422), `local-failed` (500).
- **Limitations (by design).** No formulas (linear text), no table structure, no images/figures,
  no OCR of scanned pages, no page-range selection; a local document is re-parsed whole. Use the
  cloud standard API for rich structure.

## 7. Parse manager: queue, progress, cancel, resume

`src/host/parse/manager.ts` owns all parse tasks (`ParseManagerApi`):

- **Queue and concurrency** — at most `maxConcurrentParses` (default 2) tasks run; further starts
  wait in FIFO order. One task per document (`conflict` if a parse is already running).
- **State before network work** — `status:'parsing'` and the parse phase are persisted first
  (`extracting` for local, `submitting` → `uploading` → `polling` for cloud). Progress during
  polling is persisted but throttled (`PROGRESS_THROTTLE_MS`, 2 s) so disk writes never dominate.
- **Polling** — interval `pollIntervalMs` (default 3 s); the remote task state is mirrored into
  `parse.remoteState` so the client can explain long queue waits. A poll failing up to
  `MAX_POLL_FAILURES` consecutive times is retried; a terminal failure persists
  `status:'failed'` + `meta.error` (via `describeMineruError`, never containing the token).
- **Deadline** — the whole cloud job is bounded by `parseTimeoutMs` (default 30 min) and fails as
  a timeout.
- **Cancel** — aborts the in-flight network work; the document returns to `status:'uploaded'`
  (source kept). A cancelled page repair restores the previous parse instead.
- **Resume after restart** — on boot `resume()` scans documents left in `status:'parsing'`:
  tasks that reached polling continue from their persisted `batchId`/`taskId`; tasks interrupted
  mid-submit/upload are failed explicitly (an in-flight upload cannot be resumed safely). Repair
  tasks are rebuilt from the persisted `repairPages`/`repairRestore` fields.
- **Success** — artifacts are written into `parsed/`, page count/progress/hasContentList are
  persisted, `status` becomes `parsed`, and the annotation re-anchor hook runs.

## 8. Artifact contract (`parsed/`)

| file | produced by | purpose |
|---|---|---|
| `full.md` | all engines | parsed markdown; the reading desk and AI retrieval source |
| `content_list.json` or `<name>_content_list.json` | standard API, local synthesis | page/block structure for page marks; accepts a bare array or `{content_list: []}` |
| `images/**` | standard API only | extracted figures served by the asset route |

Reading is bounded (`MAX_PARSED_FILE_BYTES`, 64 MiB per parsed file) and tolerant: a missing or
corrupt content list leaves markdown readable; a missing `full.md` is `not-parsed` (409).

## 9. Page-scoped repair

When a few pages contain unreadable glyphs (MinerU emits U+FFFD), a repair re-parses **only those
pages** instead of the whole paper.

- Request: `parse.start { id, options: { merge: true, pages?: number[], modelVersion?, language?, isOcr?, enableFormula?, enableTable? } }`
  (also exposed as `library_manage` action `repair`). Requires a parsed document with a content
  list; requires the standard API (token).
- Page selection: explicit 1-based pages, or — when omitted — the host detects pages whose
  content-list text contains replacement characters. No pages detected →
  `repair-unavailable` (409); no content list → `repair-unavailable` (409).
- Execution: MinerU is called with `page_ranges` covering the repair set; the returned archive
  contains only those pages, so `host/parse/page-merge.ts` renumbers them and splices their line
  ranges back into the existing `full.md`/content list. Alignment is structural (content-list
  `page_idx` + normalized text prefixes); unalignable pages are reported as failed rather than
  risking a wrong splice.
- Safety: every other page stays byte-identical, annotations are not touched by the merge, and
  failure/cancel restores the previous parse from `parse.repairRestore` and the previous page
  count. Repair bookkeeping is persisted in `parse.repairPages`, `parse.repairPreviousPages`,
  `parse.repairRestore` and the terminal `parse.repair = {pages, failedPages}`.

## 10. Annotation re-anchoring after a reparse

Full reparse or repair can change block keys, block boundaries and offsets. After every
successful (re)parse the manager runs the shared `ReanchorHook` — by default
`reanchorDocumentAnnotations` from `src/shared/annotate/reanchor.ts`:

1. same block key and offsets still cover the quote → unchanged;
2. same block key, quote moved inside the block → offsets updated;
3. quote found in another block → `blockKey` + offsets updated (preferring the block nearest the
   old page/index to keep multi-occurrence quotes in place);
4. quote gone → the annotation is kept and marked `stale:true` with a reason (`no-quote`,
   `quote-not-found`), so the margin can show "位置已变化" instead of losing the note.

The store preserves `stale`/`staleReason`/`reanchored` across whole-list saves, so a client save
can never erase a re-anchoring outcome. Citation checks in the AI engine use the same shared
anchor helpers, so reader anchors and citations cannot drift.

## 11. ZIP extraction safety

MinerU results are untrusted archives. `host/parse/unzip.ts` combines **fflate** (central
directory, local headers, stored/deflate payloads) with a small security preflight that runs
before any decompression: End-Of-Central-Directory/central-directory validation, entry and
size caps, ZIP64 and encryption refusal, CRC verification for stored entries, and path
normalization that **rejects traversal** (recorded as warnings). The caller receives
`{entries: [{name, data: Buffer}], skipped, warnings}` in archive order. Failure codes:
`zip-truncated`, `zip-invalid`, `zip-unsupported`, `zip-limit`.

## 12. Error mapping

- Upstream MinerU API errors become a `MineruError` carrying the upstream code, HTTP status and a
  structured safe `detail` (`apiCode`, `msg`, `state`, `limit`, …). `describeMineruError` maps
  codes to bilingual user-facing messages: token problems (`A0202` invalid, `A0211` expired),
  quota (`-60018`, `-60019`), queue full (`-60009`), size/page limits (`-60005`, `-60006`,
  `-30001`, `-30003`), unsupported type (`-30002`, `-60002`), parse failure (`-60010`), task not
  found/owned (`-60012`, `-60013`), etc. The one-line result is persisted in `meta.error` and
  shown by the client.
- Client-side codes from the same class: `network-error`, `bad-response`, `http-<status>`,
  `timeout`, `aborted`, `parse-failed`.
- Precondition wire codes surfaced to the API: `token-missing`, `too-large`, `unsupported-type`,
  `local-unsupported`, `local-missing-tool`, `local-empty-text`, `local-encrypted`,
  `local-failed`, `not-parsed`, `repair-unavailable`, `conflict`, `bad-request`.
- The MinerU token is never included in an error, log line, persisted metadata or response.

## 13. Testing strategy (offline and deterministic)

- `test/helpers/mock-mineru.ts` — dependency-free (`node:http`) local mock of both APIs
  (`/api/v4/file-urls/batch`, signed `PUT`s, batch results, agent parse/upload/result, artifact
  files). Tests script a poll-state sequence per task (last state repeats) and read captured
  request/upload state; `extract_progress` is attached only in configurable states, mirroring the
  real API.
- `test/helpers/e2e-harness.ts` — real Host stack (store + parse manager + service + mock MinerU +
  temp data dir) with `pollIntervalMs:10` so flows finish in milliseconds; every wait is bounded.
  Covering suites: `parse-flow-standard`, `parse-flow-local`, `parse-flow-failure-cancel-resume`,
  `parse-flow-limits`, `parse-flow-progress-liveness`; unit suites cover the MinerU client,
  engine policy, page merge, ZIP security, local PDF/Office/synthesis and the manager itself.
- `test/helpers/zip-builder.ts` + parse fixtures build deterministic PDFs/ZIPs in memory;
  `test/host/local-real-library.test.ts` (read-only) validates extraction against a copied real
  library when present.
- Nothing in the parse test path touches the network or the user's real MinerU token; the vendored
  pdf.js is exercised as a real runtime in a smoke test.
