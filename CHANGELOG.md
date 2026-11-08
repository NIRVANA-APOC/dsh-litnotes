# Changelog

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
