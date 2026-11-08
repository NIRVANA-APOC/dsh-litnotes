# Changelog

## 1.1.0 — AI 精读 (close reading)

The 1.0.0 AI flow answers one question over a bounded context window, so broad prompts such as
"总结全文" tend to annotate the title, author line and venue: a ledger reading, not a close
reading. `AI 精读` adds a whole-paper, multi-stage close-reading workflow that reads every
substantive section, keeps a rolling reading memory across sections, writes many evidence-anchored
interpretive annotations (front-matter metadata and quote-restatements rejected by an explicit
quality gate) and produces a structured, fully page-anchored report.

### Feature

- New reading-margin view `精读`: idle CTA, live phase checklist (建立阅读地图 → 逐节精读 → 补读薄弱
  章节 → 批注校订 → 撰写报告 → 写入原文) with progress, current section and `停止精读`; the report
  view shows model/time, `通读 N 节 · 生成 M 条批注 · 覆盖率 P%`, all report sections, a collapsible
  list of this run's annotation cards, `复制报告` and `重新精读`.
- Entry points: the primary `AI 精读` button in the read context bar (starts a run when the paper
  has no record) and a fifth, session-only margin filter chip `精读` with the paper's annotation
  count.
- Cancellable between model calls; a cancelled run writes nothing and keeps the previous record
  and annotations. Records are cached: reopening or reloading serves the persisted report without
  model calls. A forced re-run replaces the record and dedupes new annotations against the
  existing ones.
- The eighth agent tool `library_deepread` (`action: get | run`) exposes the persisted report or
  runs the workflow; its highlights carry `documentId/blockKey/page/quote/annotationId`.

### Quality gate

- Every quote is verified against the parsed block text (shared `locateQuote`); offsets and pages
  are Host-computed and block keys are validated before anything is shown or written.
- Front-matter/boilerplate heuristics and an adjudication pass drop title/author/affiliation/venue
  quotes, heading-only quotes, trivial notes and notes that restate their quote; the coverage pass
  re-reads sections that received no annotation; selection is coverage-aware and capped
  (`ai.deepReadMaxAnnotations`).
- The report is validated field by field: bounded strings, unknown block keys dropped, evidence/
  confidence normalised, and a deterministic fallback report when synthesis output is malformed.
- Live isolated-instance acceptance (real model, 24-page paper) verifies annotation quality
  metrics, offset verification, report block-key validity, reload persistence and cancel
  behaviour, alongside the offline engine/wire/client test suites.

### Wire and data

- JSON `deepread.get` (`{ documentId } → { record | null }`).
- NDJSON stream `deepread` (`{ documentId, force?, language? }`) with frames `start`, `progress`,
  `report`, `annotations`, `usage`, `done`, `error`; cached calls replay the record with no model
  calls; aborting the request aborts the run.
- New per-document aux file `deepread.json` (`DeepReadRecord`, version 1) written atomically; the
  frozen formats (`chat.json`, `graph.json`, `annotations.json`, `library-graph.json`) are
  unchanged. Deep-read annotations use the standard annotation format with
  `chatId: "deepread:<documentId>"`, `origin: "ai"` and the run id as `messageId`.
- New `ai.deepRead*` configuration keys: `deepReadMaxChunks` (24), `deepReadMaxSourceChars`
  (240000), `deepReadMaxAnnotations` (24), `deepReadMaxTokens` (2400), `deepReadSynthesisChars`
  (14000), `deepReadCoveragePass` (on), `deepReadJudge` (on), each validated and clamped.

### Engineering

- New Host engine `src/host/ai/deepread.ts` (sequential, abortable, never throws) and the
  `DEEPREAD_*` prompt family with `DEEPREAD_PROMPT_VERSION = 1`; the chat `PROMPT_VERSION` stays 2.
- New client store `deepread-store.ts`, pure report helpers `deepread.ts`, the `DeepReadPanel`
  view + styles + i18n dictionaries, and shell wiring (fifth chip, context-bar entry, margin
  branch, locale seam).
- Tests: engine unit suite over a fake LLM, wire/service/route/agent-tool tests, client store and
  panel suites; full suite 865 tests across 75 files. Bundles stay within the enforced budgets
  (Host 986.6 KiB, client 617.0 KiB, CSS 78.1 KiB).

### Compatibility

- Existing libraries need no migration. A document without `deepread.json` reports "never
  deep-read"; old readers ignore the new file; existing annotations (user, chat, earlier
  deep-read runs) win dedupe and are never deleted by a new run.

## 1.0.0

First stable release. The complete pre-refactor feature set (0.3.0, preserved as tag `v0.3.0`)
was rebuilt end to end — TypeScript, a new reading-desk UI, mature algorithms, platform reuse —
with the same user-facing capabilities, the same HTTP wire contract and the same on-disk data
formats. Existing libraries load as-is; no migration step.

### UI/UX

- New reading desk ("页边 / the margin voice"): the paper is the page and one right margin carries
  notes and the AI conversation, ordered by their place in the text.
- **Tethers**: every margin entry is connected to its sentence by a 1px aspect-ink hairline that
  lights up on either side; arriving AI citations draw their tether.
- One frame, two scenes (read / graph): the scene switch, breadcrumb, utilities, context bar and
  status bar keep the same position in every state (position principle).
- Reader: bilingual column, four aspect inks, selection toolbar (highlight/note/ask/translate),
  anchored annotation card on highlight click, outline, page marks, reading modes/measure/scale,
  lazy KaTeX, figures, tables and scroll restore.
- AI margin: streaming grounded answers, citation chips with hover previews and jump-to-block,
  entailment/unsupported states, quick prompts, follow-ups, stop/regenerate and Markdown export;
  the composer stays pinned in the margin.
- Knowledge map: d3-force layout with a deterministic seed, infinite canvas (pan, zoom at cursor,
  fit), drag-to-pin, hover focus, type/aspect filters, curation card (rename, merge, pin, ask,
  jump) and a library-wide map.
- Import / settings / reparse dialogs rebuilt on the same design tokens; drag-and-drop import,
  inline parse progress in the rail, status filters, sort and instant search (MiniSearch).
- Light and dark themes inherit the host tokens; reduced-motion honored; keyboard operation and
  focus rings throughout.

### Algorithms

- ZIP extraction: **fflate**, behind a security preflight (caps, path-traversal rejection,
  CRC/ZIP64/multi-disk policy).
- Paper model: **markdown-it** (+ **htmlparser2** for HTML tables) replacing the hand-written
  Markdown scanner; block keys/anchors are byte-identical to 0.3.0 for the fixtures and two real
  library documents.
- Retrieval: **MiniSearch** (BM25+, ASCII + CJK tokenizer) replacing the hand-written scoring.
- Graph layout/camera: **d3-force** with a seeded deterministic layout and a custom canvas camera.
- Overlay positioning: **@floating-ui**; client state: **zustand**; relative time/numbers:
  `Intl`. Domain logic (anchors, citation validation, curation, prompts) stays ours.

### Platform reuse

- Host: `llm`, `tools`, `credentials`, `translator`, `officeToPdf`, `tokenMeter` (context budget),
  `systemPrompt` (one static library section), connection fence and web server.
- Client: locale service, theme tokens, Harness module table and host layout/slot contracts.
- Agent interface: seven `library_*` tools (search/read/ask/annotate/translate/graph/manage) with
  bounded outputs and `documentId`/`blockKey`/`page`/`quote` coordinates, plus a static
  system-prompt section so the agent discovers the library.

### Engineering

- TypeScript everywhere (Host, Client, shared model, tests, scripts) under `strict`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`; zero `any` in the
  shipped tree.
- Typed seams: `src/shared/{constants,model,protocol,preferences,urls}.ts`,
  `src/host/{contracts,host-services,wire}.ts`, one shared paper model.
- esbuild bundles: Host ESM `index.js`, Client module-loader `lib/client.js`; zero runtime npm
  dependencies. The client bundle's only external requests are the platform React runtime
  modules; pdf.js and KaTeX stay vendored and version-locked. Enforced budgets: client
  ≤ 620 KiB, CSS ≤ 160 KiB, Host ≤ 2 MiB.
- One gate (`scripts/check.ts`, 17 checks incl. `--final`) covering manifest, identity, strict
  types, build, artifact contracts, vendored runtimes, docs and the vitest suite; 790 tests.
- Offline test strategy: shared-model snapshot parity, Host unit/integration suites, parse flows
  against a dependency-free mock MinerU server, fake-LLM engine and cross-half AI stream tests,
  agent-tools end-to-end, Client component/store suites, real built-bundle integration tests and
  recorded perf benchmarks.
- New docs: README plus `docs/{ARCH,PARSING,AGENT,AI-SPEC,UI-SPEC,VISION}.md`; legacy identity and
  historical working notes removed.

### Fixes included

- Rail document menu anchored to its button; dialogs sized to their content without clipping.
- Highlight click reopens an anchored annotation card (note, quoted source, edit/delete).
- Import dialog lays out in one column at every width.
- AI questions over the whole paper now see the document body, not just its title: after the
  ranked lexical selection the context retriever fills the remaining budget with the first body
  block of every section, so overview prompts (including a Chinese "总结全文" against an English
  paper, which has no lexical hits) can actually summarise the paper.
- The AI panel body is the only scroll container inside the panel (the inner stream no longer
  carries its own `ln-scroll`/overscroll box), so the mouse wheel always scrolls the conversation
  history instead of being swallowed by a nested scroll area.
- Provenance tethers are annotation-only: AI conversation turns (block-level anchors) no longer
  draw lines, so the 对话 filter shows no lines between the paper and the right panel; note
  tethers still render when a note and its sentence are both visible.
- The reader's AI margin is a properly docked right rail: flush with the reader top, right and
  bottom edges (no gap above), with a fixed header (`页边` + count + filter chips), its own
  scrolling body, and the composer as a panel footer — so the panel never floats, never overlaps
  the reader scrollbar, and cannot overflow at the 240–560px width range.
- Margin filter chips (全部 / 对话 / AI 批注 / 我的批注) moved into the sticky margin
  header, so after scrolling the independent margin down to its notes the
  conversation stays one click away (对话) instead of being scrolled out of reach.
- The paper column and the AI margin scroll independently: the margin is a
  pinned, separately scrollable column on desktop (its own scrollbar, sticky
  composer and sticky filters), so reading the paper never drags the AI
  conversation and vice versa; the tether layer recomputes on either scroll.
- The AI composer is pinned to the bottom of the reader panel again: it now
  lives at the end of the margin column (not inside the AI stream container) and
  the scroll container no longer pads its bottom, so sticky never leaves a gap
  above the panel bottom while reading or streaming.
- Paragraph hover toolbar: `content-visibility` paint containment clipped the
  absolutely positioned tools at the block's right edge, so the last action
  (询问 AI 此段) was invisible; blocks no longer use paint containment and all
  three icon-only actions stay visible.
- The reading-width preset control (窄/标准/宽/全宽) is gone: the text column always uses the
  full paper width, so the toolbar is shorter and the paper never leaves unused side margins.
- The AI composer now always offers the preset whole-paper questions (总结全文 / 这篇论文解决了
  什么 / 方法是什么 / 有什么局限 / 解释这个概念) above the input — in a fresh conversation and in
  every later one, not only in the empty state.
- AI Q&A defaults to the whole paper: the composer no longer follows scrolling with an implicit
  "current paragraph" context; a per-paragraph "Ask AI about this paragraph" button (next to
  translate/annotate) applies an explicit paragraph focus, and a text selection applies a
  selection focus.
- No stale annotation/graph counts after deleting documents: an empty library shows the import
  invitation and the graph context bar hides all graph facts.
- AI composer pinned in the margin; graph margin hint names the selection action.
