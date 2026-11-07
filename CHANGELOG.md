# Changelog

## 2.0.0

A full rebuild of the plugin as strict TypeScript with an unchanged feature set, wire contract and
on-disk data formats.

### Platform and toolchain

- TypeScript everywhere: Host, Client, shared model, tests, build and gate scripts (`strict`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, no `any`).
- New typed seams: `src/shared/{constants,model,protocol,preferences,urls}.ts`,
  `src/host/{contracts,host-services,wire}.ts`; the Host and Client halves meet at one typed wire
  contract and one shared paper model instead of duplicated parsers.
- esbuild build (`scripts/build.ts`) generating the Host ESM bundle `index.js` and the Client
  module-loader bundle `lib/client.js`, with size budgets; a 17-check pre-install gate
  (`scripts/check.ts`, `--no-tests`, `--final`) covering manifest, identity, types, build,
  artifacts, vendored runtimes and the vitest suite.
- Zero runtime npm dependencies in the shipped plugin; `react` remains the Client bundle's only
  external module request. pdf.js and KaTeX stay vendored and version-locked.

### Shared paper model

- markdown-it based block parser (+ htmlparser2 for HTML tables) producing the reading model:
  headings, paragraphs, quotes, lists, fenced code, rules, figures, pipe/HTML tables, display and
  inline math, outline and stats — with stable `b<index>:<hash>` annotation anchors and
  `plainText` offset spaces.
- Page marks, quote normalization/location, annotation normalization and re-anchoring live in
  `src/shared/annotate/**`: the reader and the Host use the same implementation, so block keys,
  citation offsets and re-anchored notes cannot drift.

### Host

- Rebuilt store (atomic JSON, per-document write queues, bounded reads, annotation `baseIds`
  three-way merge, aux chat/graph storage, preferences, diagnostics), config/credentials,
  operations service (one implementation for HTTP and agent tools), routes (JSON dispatch, NDJSON
  streams, streaming upload, asset/source/vendor routes, connection fence) and composition root.
- Parsing: MinerU standard and token-free agent clients with structured error mapping, parse
  manager (queue, progress, cancel, restart resume, page-scoped repair), local engine (vendored
  pdf.js 5.4.449 lazy extraction + optional DSH `officeToPdf`), and ZIP extraction moved to
  **fflate** behind a security preflight (caps, traversal rejection, CRC/ZIP64 policy).
- AI engine: LLM gateway over the Host `llm` service with `tokenMeter` budgeting, **MiniSearch**
  retrieval over the shared block model, grounded chat (citation validation, quote–claim
  entailment, auto-annotations, persistence), per-paper and library knowledge graphs with
  curation, and one static system-prompt section advertising the library to the agent.
- Seven agent tools rebuilt with behaviour-first descriptions, bounded outputs and
  citation-ready coordinates.

### Client

- New reading-desk UI on host theme tokens: persistent frame (top bar, scene context bar, status
  bar, library rail), library and read scenes, import/reparse/settings dialogs.
- Reader rebuilt around the shared block model: bilingual column, margin notes with tethers,
  selection actions, translation jobs, outline, page marks, local KaTeX rendering and position
  restore.
- AI as a margin voice: streaming grounded answers with citation chips, hover previews,
  jump-to-block, entailment/unverified states, quick prompts and Markdown export.
- Knowledge-map scene on **d3-force** with a deterministic seeded layout, infinite-canvas camera,
  drag-to-pin, curation (rename/merge/pin) and a deterministic library graph.
- Client state moved to small **zustand** stores per domain; transport covers JSON/NDJSON/upload
  with timeouts and aborts; complete zh/en locale dictionaries; design-system styles compiled into
  the bundle.

### Engineering

- Renamed and restructured source tree (`src/**`) with fresh architecture, parsing, agent, AI, UI
  and vision docs; historical working notes and reports removed.
- Offline test strategy: shared-model snapshot parity, per-module Host suites, parse flows against
  a dependency-free mock MinerU server, fake LLM helpers, Client component/store suites, a real
  built-bundle integration test, recorded perf benchmarks and artifact smoke tests.
- On-disk formats and the HTTP wire contract remain the version-1 shapes: existing libraries load
  as-is with no migration step.

## 1.0.0 — frozen feature baseline

The complete feature set, frozen as the behavioural contract for the refactor:

- Local literature library with MinerU standard/agent parsing and a token-free local engine
  (pdf.js text layer; optional Office→PDF conversion).
- Bilingual reading desk: serif original, quiet translation, reading modes, outline, page marks,
  four-ink highlights and margin annotations; position restore.
- Grounded AI reading conversation: citation-first answers validated against parser blocks, a
  quote–claim entailment pass, auto-annotations, regenerate/stop, follow-ups, Markdown export.
- Per-paper and library knowledge graphs: AI extraction, Q&A enrichment, curated library
  aggregation, infinite canvas, rename/merge/pin curation, auto-build switch.
- Seven DSH agent tools over the library, all returning citation-ready coordinates.
- i18n (zh/en), diagnostics, credential storage.
