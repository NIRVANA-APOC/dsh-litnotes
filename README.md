# dsh-litnotes

An AI-native literature desk for the DeepSeek Harness Web UI: a local paper library with MinerU
and on-device parsing, a bilingual reading desk, grounded AI conversation whose evidence is
anchored on the page, per-paper and library knowledge graphs, and seven agent tools that let DSH
chat operate the same library. Everything is a plugin bundle: the Host half runs as one ESM file,
the Client half as one module-loader bundle, and the shipped package has **no runtime npm
dependencies**.

Read the shipped docs:

| document | contents |
|---|---|
| [`docs/ARCH.md`](docs/ARCH.md) | architecture, data formats, HTTP wire contract, build/test gate |
| [`docs/PARSING.md`](docs/PARSING.md) | MinerU standard/agent APIs, local engine, repair, re-anchoring |
| [`docs/AGENT.md`](docs/AGENT.md) | the seven library tools and a worked agent flow |
| [`docs/AI-SPEC.md`](docs/AI-SPEC.md) | grounded chat, citations, entailment, knowledge graphs |
| [`docs/UI-SPEC.md`](docs/UI-SPEC.md) | the reading-desk design system and interaction contract |
| [`docs/VISION.md`](docs/VISION.md) | product direction |
| [`CHANGELOG.md`](CHANGELOG.md) | release history |

## Features

### Local library and parsing

- Import by file picker, drag-and-drop or URL; supports PDF, Word, PowerPoint, Excel, images and
  HTML. Each document keeps its original file, parsed markdown, annotations and caches locally.
- **MinerU standard API** (token): precise parsing with `pipeline`/`vlm` models, OCR, formula and
  table extraction, page ranges, up to 200 MB / 200 pages.
- **MinerU agent API** (no token): token-free lightweight cloud parsing for PDFs, images and
  Office formats up to 10 MB / 20 pages.
- **Local engine** (no token, no upload): text-layer extraction through the vendored pdf.js
  5.4.449 runtime for PDFs, plus optional LibreOffice/WASM conversion through the DSH
  `officeToPdf` service for Office files (T0/T0.5). Formulas, tables, figures and OCR are not
  reconstructed locally — use the cloud standard API for rich structure.
- Asynchronous task queue with progress, cancel, failure messages, restart resume and a
  configurable concurrency cap.
- **Page-scoped repair**: re-parse only the pages with unreadable glyphs and splice them back;
  other pages, annotations and pages counts stay untouched, failures roll back.
- Annotations are re-anchored by their verbatim quote after every reparse, so highlights and
  margin notes survive block-boundary changes (stale ones are flagged, never dropped).

### Bilingual reading desk

- Serif English original with a quiet translation column, original / bilingual / translated
  modes, page marks, outline, adjustable reading measure and scale, local KaTeX formula rendering.
- Four-ink highlights and margin notes with aspects (definition, method, result, limitation,
  context), a margin filter by origin/aspect, and clickable AI provenance.
- Reading position, mode, panel widths and the last conversation are restored on return.
- Selection actions: translate, ask AI, explain; block-level "ask about this paragraph".

### Grounded AI conversation

- Answers are generated only from the current paper's parsed text and streamed; stop, regenerate
  and follow-ups are available.
- Citation-first: every answer carries `[n]` citations that hover to the quote and click to the
  block. The host validates quotes against reader blocks and runs a second quote–claim entailment
  pass; unverified or unsupported evidence is dimmed and never annotated.
- Verified citations automatically become aspect-colored AI annotations (capped per answer and
  deduplicated), with model/chat provenance.
- Conversation history is persisted per document, can be cleared, and exported to Markdown.
- Concurrent annotation writes (user save vs AI/agent) merge through a `baseIds` three-way merge.

### Knowledge graphs

- **Per-paper graph**: one action lets the model read the paper and extract concepts, methods,
  findings, definitions, limitations and sections plus their relations, with overview, TL;DR and
  glossary; nodes keep block provenance and jump into the text. Q&A adds question/insight nodes
  over time.
- **Library graph**: deterministic aggregation of all papers into paper/topic nodes with clusters,
  shared-concept edges and an overview; rebuildable on demand.
- Infinite-canvas graph view: pan anywhere, wheel-zoom at the cursor, deterministic layout,
  drag-to-pin. Curate per-paper graphs by renaming, merging and pinning nodes; curated edits
  survive a rebuild. Optional auto-build after a successful parse.

### DSH agent tools

Seven focused tools expose the same operations the UI uses; results always carry
`documentId`/`blockKey`/`page`/`quote` coordinates. A static system-prompt section tells the agent
the library exists and when to use it.

| tool | purpose |
|---|---|
| `library_search` | search passages across the library or one document (documentId/blockKey/page/snippet) |
| `library_read` | metadata/outline, bounded markdown slices, exact block text, or one page |
| `library_ask` | grounded answer with citation coordinates (and auto-annotations) |
| `library_annotate` | list/create/update/delete highlights and margin notes |
| `library_translate` | translate arbitrary text or up to 10 cited blocks |
| `library_graph` | read/search/build/update a paper graph; read/rebuild the library graph |
| `library_manage` | list/status/URL import/parse/page repair/cancel/rename/delete |

## Install into a DSH profile

The repository is a plugin bundle package (`cordis.patch.yml` inserts one Host row; the Client
half is declared under `dsh.client`). Install it into the Web profile with the Harness plugin
manager, pointing at this checkout:

```
plugin_manager install_bundle link:/path/to/dsh-litnotes
```

Then reload the Web UI. Requirements:

- A DSH Web profile that mounts `webServer` and `connection` (the plugin's hard dependencies).
- Optional services light up features when present: `credentials` (persistent MinerU token),
  `llm` + `agentDefaultModel` (AI features), `translator` (anonymous translation), `officeToPdf`
  (local Office parsing), `tools` (agent tools), `tokenMeter` (context budgeting),
  `systemPrompt` (agent hint).
- Developing from source needs Node ≥ 20.16 and pnpm (dev dependencies only).

## First use

1. Open the **LitNotes library** panel in the sidebar; import a paper from disk or a URL.
2. Start a parse. The default `auto` engine uses the standard API when a MinerU token is
   configured; otherwise it prefers the local engine (no upload) and falls back to the token-free
   cloud API where local parsing cannot handle the file. `autoAllowAgentFallback` controls that
   fallback.
3. Optionally add a **MinerU token** in Settings for precise parsing and page repair. Force the
   local engine in the parse dialog when the paper must stay offline.
4. When parsing finishes, open the paper: read, translate, highlight and add margin notes; ask
   the AI from the margin composer or from a selection.
5. Switch between **Read** and **Graph** for the paper, and between **Library** and **Library
   graph** for the whole collection. Ask an agent in DSH chat to search, read or annotate the
   library — the same data and citations are used.

## Data and privacy

```
~/.dsh/litnotes/                        (or $DSH_HOME/litnotes)
  documents/<id>/source.<ext>           original file
  documents/<id>/parsed/                full.md, content_list.json, images/**
  documents/<id>/annotations.json       highlights and margin notes (with AI provenance)
  documents/<id>/translations.json      paragraph translation cache
  documents/<id>/chat.json              grounded conversation history
  documents/<id>/graph.json             per-paper knowledge graph
  library-graph.json                    library-wide knowledge graph
  preferences.json                      reading/AI/view preferences
  diagnostics/client.log                bounded client diagnostics
```

- Files, parses, annotations, conversations and graphs stay on this machine. The only uploads are
  the source file during a cloud parse (MinerU standard or agent API) — the local engine never
  uploads and, for Office files, converts locally through `officeToPdf`.
- AI questions send only the retrieved, bounded context (relevant passages) to the model route
  configured in the DSH profile — never the whole library.
- The MinerU token is stored in the Host credential store and is never returned to the browser or
  written to logs; without a credential service it lives only for the process lifetime.
- The JSON formats are stable version-1 envelopes: existing libraries load as-is and are read
  directly by the parser, store, AI engine and agent tools.

## Settings

- **MinerU token** — add/clear; shows whether the token persists across restarts.
- **Translation** — target language and provider (host translator providers, LLM fallback).
- **AI** — uses the profile's default model route; per-deployment overrides (`ai.provider`,
  `ai.model`, context/token budgets, annotation cap, reasoning effort, entailment switch) live in
  the plugin row config.
- **Reading preferences** — mode, scale, measure, page marks, panel widths, filters; persisted
  host-side and restored on reload.
- **Row config** (`cordis.patch.yml` → `config:`): `dataDir`, `apiBase`, upload/parse/tool limits,
  `ai:` and `local:` blocks. Every key is validated and clamped; see `docs/ARCH.md` §12.

## Development

```bash
pnpm install                 # dev dependencies only
node scripts/build.ts        # build index.js (Host) + lib/client.js (Client)
node scripts/build.ts --check    # build + syntax-check both artifacts
pnpm typecheck               # tsc -p tsconfig.json (strict, no emit)
pnpm test                    # vitest run
node scripts/check.ts        # pre-install gate (manifest, identity, tsc, build, artifacts, tests)
node scripts/check.ts --no-tests # gate without the test run
node scripts/check.ts --final    # release gate: transition warnings become failures
```

- Source lives in `src/shared/**` (both halves), `src/host/**` (Host), `src/client/**` (Client).
  `index.js` and `lib/client.js` are generated and committed; never edit them.
- TypeScript is strict, `erasableSyntaxOnly` (`enum`/`namespace`/parameter properties are not
  allowed), `verbatimModuleSyntax` (`import type`) and no `any`. Host code may use `node:`
  builtins, shared code stays environment-neutral, Client code must not import `node:` modules.
- Tests live in `test/shared`, `test/host`, `test/client`, `test/integration`, `test/perf`,
  `test/smoke`; parse flows run against an offline mock MinerU server and a fake LLM.
- Vendored runtimes are version-locked by the gate: `vendor/pdfjs/**` (pdf.js 5.4.449) and
  `vendor/katex/**`. The client bundle's only external requests are the platform-provided React
  runtime modules (`react`, `react-dom`, `react-dom/client`); everything else is bundled.
