# dsh-litnotes 1.1.0 — UI/UX spec: the margin voice

Authoritative UI contract for the reading desk. It describes the shipped 1.1.0 client
(`src/client/**`): design tokens, frame geometry, the position principle, component and class
families, interactions, accessibility, responsive behaviour and the performance budget.
Implementation reference: `src/client/styles/**` and each scene's `styles.css`.

## 1. Concept

A **reading desk for English academic papers with AI and a knowledge map**, embedded as the
`main` panel of DeepSeek Harness. The reader is usually a Chinese-speaking researcher. The three
jobs, in priority order, are: **read** long-form prose comfortably; **understand** through
grounded answers whose evidence is visibly on the page; **remember** through accumulated marks
and a concept map that stays legible.

The design metaphor is a **critical edition**: the text is the page, the editor's voice is the
margin. Here the editor is the AI and the reader:

- Highlights, notes and AI conversation are **one stream in one right margin**, ordered by where
  they belong in the text.
- **The tether** is the memorable element: a 1px hairline in the annotation's aspect color runs
  from a margin entry to the sentence it rests on; hovering either side lights both. Tethers
  encode provenance (trust), not decoration. When an AI citation arrives its tether draws in.
- Color is information: chrome is the host theme's monochrome ink; the machine's voice is
  **signal ultramarine**; the four **aspect inks** carry the reader's memory; nothing else uses
  chroma. There is no brand gradient and no second accent.

## 2. Tokens

Defined on `.ln-root` in `src/client/styles/tokens.css`. Chrome inherits the Harness theme
(`--dsw-alias-*`); the reading surface, the signal color and the aspect inks are plugin-owned.
Dark overrides live under `body[data-ds-dark-theme] .ln-root`.

### 2.1 Color

| token | light | dark | use |
|---|---|---|---|
| `--ln-bg` | `--dsw-alias-bg-base` | same | app background |
| `--ln-surface` | `--dsw-alias-bg-layer-1` | same | topbar, contextbar, rail, statusbar |
| `--ln-surface-2` | `--dsw-alias-bg-layer-2` | same | inputs, chips, hover fills |
| `--ln-overlay` | `--dsw-alias-bg-overlay` | same | menus, dialogs, popovers |
| `--ln-ink` | `--dsw-alias-label-primary` | same | body text, titles, user notes |
| `--ln-ink-soft` | `--dsw-alias-label-secondary` | same | translation, meta, quiet copy |
| `--ln-ink-faint` | ink @ 45% | same | folios, disabled, hints |
| `--ln-rule` / `--ln-rule-strong` | `--dsw-alias-border-l1` / `-l2` | same | hairlines / emphasized rules |
| `--ln-paper` | layer-1 96% + `#d8d2c2` 4% | layer-1 94% + `#000` 6% | the reading sheet |
| `--ln-paper-edge` | ink 8% | ink 12% | sheet edge hairline |
| `--ln-signal` | `#2646be` | `#94a8ff` | AI voice, citations, focus, selected node |
| `--ln-signal-soft` | signal @ 12% | signal @ 18% | selection wash, active rows |
| `--ln-yellow` / `--ln-sage` / `--ln-sky` / `--ln-rose` | translucent highlighters | darkened | aspect inks |
| `--ln-hl-active` | signal @ 55% | same | active highlight outline |
| `--ln-shadow` | 2-layer soft shadow | darker | floating overlays only |

Aspect ink mapping: definition = yellow, method = sage, result = sky, limitation = rose,
context = yellow. `[data-aspect]` sets `--ln-aspect-ink` / `--ln-aspect-strong` so swatches,
tethers, margin dots and graph node rings share one vocabulary.

### 2.2 Typography

| token | value |
|---|---|
| `--ln-font-ui` | `system-ui, -apple-system, "Segoe UI", "PingFang SC", …` |
| `--ln-font-read` | `"Source Serif 4", "Iowan Old Style", "Charter", Palatino, Georgia, "Noto Serif", "Songti SC", "SimSun", serif` |
| `--ln-font-trans` | `"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif` |
| `--ln-font-mono` | `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace` |

- UI text: 11.5 / 12.5 / 13 / 14 px; tabular numerals for counts, pages and times.
- Paper title: serif 600 `clamp(25px, 2.4vw, 32px)` / 1.16, tracking −0.012em, `text-wrap: balance`.
- Section headings: serif 600 (h2 21 / h3 18 / h4 16) with a hanging section numeral in the gutter.
- English body: serif `18px * --ln-read-scale` / 1.72, ragged right, `text-wrap: pretty`.
- Chinese translation: sans `14.5px * --ln-read-scale` / 1.68, `--ln-ink-soft`, 2px left rule.
- Measure presets: 52 / 58 / 66 / 74ch (default 58ch); line length never exceeds 80ch.
- Reading scale presets: 0.9 / 1 / 1.12 (`--ln-read-scale`).

### 2.3 Space, radius, motion

- 4px grid. Topbar 52px, contextbar 40px, statusbar 28px, rail 264px (collapsible 44–56px,
  remembered), margin 336px (260–560 remembered), sheet radius 10px, controls 4px,
  cards/popovers 8px, chips 999px. Sheet padding 42/46px desktop → 24/20px narrow; gutter 40px.
- Motion: hover 120ms `cubic-bezier(.2,.7,.2,1)`; popover 140ms scale .98; sheet entry 180ms
  fade+4px rise; tether draw 220ms; margin entry 160ms. `prefers-reduced-motion: reduce`
  removes all transitions/animations except progress/spinner feedback.

## 3. Frame and the position principle

The client renders one grid: topbar / contextbar / desk (rail + stage) / statusbar. **Read** and
**Graph** are the only scenes; the rail already *is* the library, so there is no separate library
page. A control that exists in more than one state keeps the same screen position and order.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ln-topbar: [wordmark] [breadcrumb ▾]        [Read | Graph]  [⌕][Import][◧][⚙] │
├──────────────────────────────────────────────────────────────────────────────┤
│ ln-contextbar (same frame region in every scene)                             │
│  read:  Original|Bilingual|Translation  [page marks] [outline]  ⋯             │
│  graph: This paper|Library  [type filters] [aspect legend]   [build/rebuild]  │
├──────────────────────────────────────────────────────────────────────────────┤
│ ln-desk                                                                       │
│  ln-rail (search, document rows, footer)   ln-stage                          │
│                                            read: gutter | paper | margin+AI   │
│                                            graph: canvas + HUDs + node card  │
├──────────────────────────────────────────────────────────────────────────────┤
│ ln-statusbar: engine · pages · AI model / parse facts · graph stats · width   │
└──────────────────────────────────────────────────────────────────────────────┘
```

Position matrix (must hold in every scene/state):

| control | position | scenes |
|---|---|---|
| wordmark (rail toggle) | topbar far left | always |
| breadcrumb (document title ▾) | topbar left, after wordmark | always ("文献库" when no document) |
| scene switch `[阅读 \| 图谱]` | topbar center | always (graph works without a document = library graph) |
| search / import / margin toggle (read only; reserved space in graph) / settings | topbar utilities, fixed order | always |
| reading controls (mode/page marks/outline) | contextbar left | read |
| document actions (⋯ reparse/repair/rename/delete/translate) | contextbar right | read |
| graph scope/filters/legend/build | contextbar left→right | graph |
| composer | bottom of the margin column, width = margin | read |
| status facts | statusbar, engine/stats left, model/graph/width right | always |

## 4. Component and class families

Prefix `ln-`. Data attributes carry state: `data-scene`, `data-stage`, `data-status`,
`data-aspect`, `data-origin`, `data-ink`, `data-active`, `data-selected`, `data-pressed`,
`data-stale`, `data-kind`, `data-brand`.

### 4.1 Frame

`.ln-root` (grid, `data-scene`), `.ln-topbar` (`.ln-wordmark`, `.ln-crumbs`,
`.ln-topbar__center`, `.ln-topbar__utils`), `.ln-contextbar` (`.ln-contextbar__left/__right`),
`.ln-desk` (positioned ancestor for drawers), `.ln-stage`, `.ln-statusbar`
(`.ln-statusbar__engine`, `.ln-statusdot`), `.ln-toasts`/`.ln-toast[data-tone]`,
`.ln-dropwrap`/`.ln-drop` (drag-import overlay), `.ln-vh` (visually hidden).

### 4.2 Primitives (`src/client/design/**`)

`.ln-btn` (`--primary|--ghost|--quiet|--danger|--sm`), `.ln-iconbtn` (`is-pressed`),
`.ln-seg`/`.ln-seg__item` (radio group, `is-selected`), `.ln-chip` (`is-pressed`,
`--static`, `__count`), `.ln-badge` (`--signal|--success|--warn|--error`), `.ln-aspectdot`,
`.ln-aspectpicker`, `.ln-legend`/`.ln-legend__item`/`.ln-legend__dot` (legend doubles as
aspect filter), `.ln-field`, `.ln-input` (`--area`, `--select`, `--search`), `.ln-switch`,
`.ln-menu`/`.ln-menu__item`, `.ln-dialog` (native `<dialog>`, `.ln-dialog__surface/head/title/
description/body/foot`), `.ln-spinner`, `.ln-progress`, `.ln-empty`, `.ln-kbd`, `.ln-callout`,
`.ln-code`, `.ln-tooltip`.

### 4.3 Rail

`.ln-rail` (`--collapsed`), `.ln-rail__head/__search/__list/__foot`, `.ln-doc[data-status]
[data-active]` (`.ln-doc__open/__status/__body/__title/__meta/__trail/__progress/__cancel`),
`.ln-rail__empty`, `.ln-rail__loading`. Rows show title (serif, 2-line clamp), meta
(ext · pages · status · engine/phase), inline parse progress and a `…` menu; the active row uses
a signal left bar, not a filled card. Search supports arrow-key navigation and ⌘/Ctrl+K focus.

### 4.4 Read scene

`.ln-reader[data-mode=original|bilingual|translated]` → `.ln-reader__main` (paper half) +
`.ln-ai-panel` (docked margin half) → `.ln-reader__scroll` (paper scroll container; restore offset
here) → `.ln-sheet.ln-sheet--read` (grid: `.ln-sheet__gutter`, `.ln-sheet__paper`) →
`.ln-paper__titleblock/__title/__meta/__rule` +
`.ln-block[data-block-key][data-kind]` + `.ln-pagemark[data-page]`.
Annotated ranges render as `.ln-hl[data-ink][data-id]`; `.ln-hl--active` outlines the active
annotation; blocks carry `data-plain-length` (annotation offset space).
Selection toolbar `.ln-selbar` (floating, fixed order: Highlight ▾ · Note · Ask AI · Translate).
Note editor `.ln-noteeditor`; translation blocks `.ln-trans` (`--ru` rule, retry state).
Gutter folios and section ticks (`.ln-tick`) click-scroll; outline popover `.ln-outline`.
Tethers: `.ln-tether[data-aspect][data-active]` in a pointer-events-none fixed layer.

### 4.5 Margin / AI voice

`.ln-ai-panel` (docked right rail, flush with the reader's top/right/bottom edges) →
`.ln-ai-panel__head` (`页边` + note count + filter chips: all / chat / AI notes / my notes / 精读) →
`.ln-ai-panel__body` (its own scroll area: AI entries, then notes) → `.ln-ai-panel > .ln-ai__composer`
(fixed footer: context chip, quick prompts, input, send/stop) → `.ln-margin__stream` → entries `.ln-margin__entry[data-kind=note|question|answer]
[data-aspect][data-origin][data-anchor-block]`. Notes use `.ln-note` (aspect dot, quote
excerpt, note text, edit/delete). AI entries use `.ln-ai`: `.ln-ai__turn`, `__question-label`,
`__question-text`, `__answer`, `__markdown` (`.ln-ai__heading/__paragraph/__list/__code/
__table/__quote/__link/__strong`), citation chips `.ln-ai__chip` with
`__chip-quote`, preview card `.ln-ai__citecard`, evidence summary `.ln-ai__evidence`,
partial/unsupported claim states `.ln-ai__claim--partial/--unsupported`, followups
`.ln-ai__followup`, status/stream rows, notices (entailment notice gated by the
`entailmentNotice` preference), composer `.ln-ai__composer` with context chips
`.ln-ai__context`, input row, send/stop, quick prompts `.ln-ai__prompt`.
Composer: ⌘/Ctrl+Enter send, Shift+Enter newline. The default chip is 全文 (whole paper, no
focus); an explicit paragraph focus (block toolbar → 询问 AI 此段) or a selection shows a removable
此段 / 选中文本 chip. Scrolling never swaps the composer's context; AI unavailable shows the model
setup hint.

#### The 精读 view

The fifth, session-only margin view (`精读`, `MarginFilter = 'deepread'`) is the highest-density
surface in the product and deliberately quieter than chat: a reading report, not a conversation.
It replaces the conversation stream + note slips inside `.ln-ai-panel__body` and hides the
composer footer.

- **Entry points.** A primary `AI 精读` button (sparkle icon, `.ln-btn--primary .ln-btn--sm`) sits
  in the read context bar's left group, left of `翻译全文`; disabled when the paper is not parsed
  or `status.ai.available` is false. The fifth margin chip `精读 <count>` (count = highlights of
  the current paper's record) selects the same view; like `对话`, the filter is session-only and
  never persisted.
- **DOM/state.** `.ln-margin__deepread` wraps `.ln-deepread[data-state][data-busy]` with
  `data-state` = `idle | running | report | error | loading | load-error`. The view keeps the same
  docked rail, width and header as the AI stream, so the paper and the report read side by side.
- **Idle** — `.ln-deepread__cta`: title `AI 精读`, one-sentence promise, a cost/time note
  (`约 3–8 次模型调用 · 2–4 分钟 · 会消耗 token`), `开始精读`, and a hint that only a finished run
  writes the page.
- **Running** — `.ln-deepread__running`: phase checklist (`建立阅读地图 → 逐节精读 → 补读薄弱章节 →
  批注校订 → 撰写报告 → 写入原文`) with done/active/pending states on
  `.ln-deepread__phase[data-state]`, a progress bar plus `done/total · %`, the current section,
  `停止精读`, and the promise that stopping writes nothing.
- **Report** — `.ln-deepread__report`: header with model + generated-at, a faint meta line
  (calls / minutes / tokens), and the stats row `通读 N 节 · 生成 M 条批注 · 覆盖率 P%`; then the
  report sections in order (`一句话结论` · `研究问题` · `研究空白` · `核心贡献` with evidence badge
  强/部分/弱 · `方法` · `实验与证据` · `主要发现` · `局限与风险` · `开放问题` · `论证地图` · `术语` ·
  `阅读路径` · `总体评价` with 优点/不足/信心), empty sections omitted; a collapsible
  `本次批注 M` list of annotation cards (aspect ink, quote excerpt, note, jump); actions
  `复制报告` and `重新精读`. Every point ends with `原文 p.N` reference buttons
  (`.ln-deepread__ref`); clicking one scrolls the paper and flashes the source block. Points
  whose block key no longer resolves simply render without the chip.
- **Error** — `.ln-deepread__error` with the failure message, `重试` and `关闭`; when a previous
  record exists the report stays rendered beneath the notice.
- **Layout.** Report text uses the reading measure inside the 240–560 px margin: refs wrap, long
  glossary terms truncate with a title, and nothing overflows horizontally; light and dark share
  the same token palette, reduced motion is honored.

### 4.6 Graph scene

`.ln-graph[data-scope=doc|library]` → `.ln-graph__canvas` (SVG, `.ln-graph__world`),
`.ln-edge[data-type]`, `.ln-node[data-type][data-aspect][data-selected][data-pinned]`
(circle + `.ln-node__label`), HUDs `.ln-graph__hud--tl` (type filters + aspect legend),
`.ln-graph__hud--br` (zoom −/+/fit), `.ln-graph__empty` (build invitation),
`.ln-graph__progress` (build progress + cancel), node card in the margin seat
(`.ln-nodecard`) with fixed action order: Rename · Merge into… · Pin/Unpin ·
Ask AI · Jump to source. Pinned nodes render a pin glyph.

### 4.7 Library, settings and dialogs

Import dialog `.ln-import` (file picker, queued drops, URL, engine/options form, inline error
guidance), parse options form shared by import/reparse/settings, reparse/repair dialog,
rename/delete dialogs, settings dialog `.ln-settings` with sections parse (token +
local capabilities), translation, AI features, appearance, about. Toast copy names the outcome.

## 5. Interactions (normative)

- **Scene switch** keeps the topbar center; `1`/`2` switch scenes; the graph works with no
  document (library graph).
- **Graph**: background drag pans; wheel zooms at the cursor (0.6×–2.5×); double-click
  background or `F` fits; `Esc` clears selection; node drag moves it and pins on release
  (neighbours spring along); hover highlights the neighbourhood and dims the rest; filters
  animate positions without re-randomising layout; `问 AI` on a node prefills the composer.
- **Selection**: selecting text opens the floating toolbar above the selection; highlight opens
  the aspect picker + note editor; ask AI fills the composer with the quoted context; translate
  renders an inline card with copy/retry/close. Clicking an existing highlight opens its margin
  slip and pulses the sentence.
- **Citations**: hover shows quote/page/aspect/verified state; partially-supported citations show
  a quiet claim warning but remain jumpable; unsupported citations are dimmed and not
  jumpable; clicking scrolls and flashes the source block.
- **Reading position**: last document, block key, reading mode, scale and margin width
  are persisted host-side and restored before content arrives.
- **Import**: drag anywhere over the rail/stage queues files into the import dialog; progress
  shows in the rail row; failures explain the next action.
- **AI 精读**: the context-bar `AI 精读` opens the 精读 view and, when the open paper has no
  record, starts the run in the same click; with a run in flight it only brings the running view
  back (never restarts or cancels). `停止精读` aborts between model calls — nothing is written,
  the previous report and annotations stay, and the view returns to/keeps the report with the
  interruption noted. `重新精读` forces a re-run and the old report stays visible until the new
  record lands. The `精读` chip is session-only: switching documents or reloading never persists
  the filter, while the report itself is persisted per document.
- **Keyboard**: all controls focusable with visible ring; `Esc` closes overlays; `⌘/Ctrl+K`
  search; arrows navigate rail rows and menu items; dialogs trap focus via native `<dialog>`.

## 6. Accessibility & quality floor

- Focus-visible: 2px signal ring, 2px offset. Contrast ≥ 4.5:1 for body/UI text, ≥ 3:1 for
  large text and controls. Aspect inks are decorative: note text is always plain ink.
- Scene switch is `role=tablist`; regions are labelled; streaming answers announce through an
  `aria-live="polite"` status row, not the whole answer; switches use `role=switch`; menus use
  `role=menu`/`menuitem`.
- Light and dark both verified; no hard-coded page colors outside tokens.
- Reduced motion honored; graph simulation pauses when the scene is hidden.
- No layout thrash: the paper and the margin are separate scroll containers (scrolling one never
  moves the other); no per-scroll React state; toasts/popovers portal-free but non-blocking.

## 7. Responsive

- ≥ 1081px: rail + paper + **docked AI panel** side by side; the panel is flush with the reader
  top/right/bottom (fixed header, scrolling body, composer footer) and never moves with the paper.
- 1080–1360px: rail can collapse to 44–56px (remembered); the paper column keeps its
  full-width text measure inside the narrower sheet.
- 820–1080px: the AI panel becomes an overlay drawer over the paper (flush top/right/bottom,
  left hairline + shadow), toggled from the fixed topbar control.
- < 820px: rail becomes a left drawer opened from the wordmark; paper padding shrinks; the AI
  drawer takes up to 86vw with its own header, scrolling body and composer footer at the overlay
  bottom; graph hides labels under a zoom threshold and offers the label toggle in the HUD.
- Interactive min sizes: 30px controls, 24px chips; the reader never drops below
  `calc(15.5px * scale)` text.

## 8. Copy

- zh primary, en fallback; flat dictionaries per area in `src/client/i18n/*.ts` with a typed key
  space; every `t('static.key')` must exist in both languages (gate enforces parity, no
  duplicates, no empty values).
- Labels are verb phrases naming the outcome ("导出对话", "适应视图"); no filler; errors say what
  failed and what to do next; empty states invite an action in one sentence; AI notices never
  double-count (entailment-specific vs generic unverified).
- 精读 labels: `AI 精读`, `精读`, `开始精读`, `停止精读`, `精读报告`, `本次批注`, `通读 {n} 节`,
  `生成 {n} 条批注`, `覆盖率 {p}%`, `原文 p.{n}`, `复制报告`, `重新精读`,
  `精读完成：生成 {n} 条批注`, and the failure vocabulary
  (`模型不可用`, `模型调用失败，重试一次`, `精读被中断`, `这次精读没有完成`).

## 9. Performance budget

- Bundle: client JS ≤ 620 KiB minified, CSS ≤ 160 KiB (enforced by the build); the client
  bundle's only external requests are the platform-provided React runtime modules (`react`,
  `react-dom`, `react-dom/client`) — everything else is bundled; KaTeX loads lazily from vendored
  assets only when a formula appears.
- Library entry interactive < 400 ms after data returns; reader first paint < 500 ms for a
  10k-word paper (skeleton immediately, model parsed after paint); scroll 60 fps; AI stream
  ≤ 1 React commit per frame; graph first layout ≤ 900 ms for 120 nodes; no simulation while the
  scene is hidden.
- Data: markdown model built once per document+content signature (LRU); graph positions cached;
  annotation saves are per-document serialized with baseIds merge.

## 10. Verification

- `node scripts/build.ts --check` (artifact contract + budget), `pnpm typecheck`,
  `npx vitest run` (unit/component/integration/perf), `node scripts/check.ts` (install gate).
- Real GUI acceptance runs an isolated DSH instance (separate `DSH_HOME`, copied library,
  Playwright Chromium over CDP): every scene, light+dark, 1440/1100/900/390 widths, zero
  console exceptions, screenshots + machine-readable summary.
- AI 精读 acceptance (live model, isolated instance): the context-bar entry and fifth chip open
  the view; idle/running/report/error render at 240/360/560 px without horizontal overflow; the
  composer is hidden; `原文 p.N` jumps scroll + flash the block; a page reload restores the
  report; `停止精读` leaves the previous record and annotations untouched. Evidence screenshots:
  `docs/screens/16-deepread-report.png`, `docs/screens/17-deepread-annotated.png`.
