# dsh-litnotes — design notes

**页边 (the margin).** dsh-litnotes is a reading desk for English academic papers with a real
right margin. This note records the concept, the token/type systems, the memorable element,
and what was deliberately left out of `ui/styles.css`.

The contract is `docs/UI-SPEC.md`; these notes explain the design decisions inside it.

---

## 1. Concept

The interface behaves like a **carefully set bilingual critical edition**, not a dashboard:
the English original is the page, the Chinese translation is the translator's voice under it,
and highlights and notes live in a **true margin** with numbered slips and a ticked outline.
The metaphor is typographic, not decorative — every structural device in the UI is something a
printed scholarly edition actually uses:

| device | where | why it is here |
|---|---|---|
| warm paper with a hairline edge and a soft lift | `.mru-paper` | separates the reading surface from chrome without a card |
| double rule under the title block | `.mru-paper__rule` | journal title-block rule; marks where the paper proper begins |
| running head with an italic serif doc title | `.mru-paper__runhead` | keeps the identity of the sheet while scrolling |
| folio numerals hanging in the left gutter | `.mru-pagemark` | page marks as reader's side notes, never as badges |
| ticked outline spine | `.mru-outline` | a table of contents drawn as leader ticks, not a stack of cards |
| numbered annotation slips | `.mru-note::before` (CSS counter) | marginalia in a critical edition |
| three-line tables, no vertical rules | `.mru-table` | booktabs-style academic tables |
| translator's slip with a double rule | `.mru-selcard` | the selection translation card (see §4) |

Chrome (topbar, rail, margin, buttons, modals, statusbar) is deliberately quiet: monochrome
host tokens, 1px hairlines, 6px controls, one type family for UI. The only saturated color in
the product is the **four annotation inks** — yellow, sage, sky, rose — used for highlighter
swatches, marks, margin swatches and nothing else. That is the palette identity: a set of four
translucent highlighters on warm paper, not a brand gradient.

---

## 2. Tokens

Tokens are defined on `.mru-root` in `ui/styles.css`. Host theme tokens are used for all
chrome; the plugin only owns the reading surface, the annotation inks, shadows and type stacks.

### Color

| token | source | used for |
|---|---|---|
| `--mru-bg` | `--dsw-alias-bg-base` | main column, drop overlay wash |
| `--mru-surface` | `--dsw-alias-bg-layer-1` | topbar, rail, margin, statusbar, menus, cards |
| `--mru-surface-2` | `--dsw-alias-bg-layer-2` | search field, inputs, active segment, code-tinted surfaces |
| `--mru-paper-bg` | 93% layer-1 + 7% `#c9b489` | the reading sheet (light) |
| `--mru-paper-bg-dark` | 92% layer-1 + 8% `#000` | the reading sheet (dark, via override) |
| `--mru-ink` | `--dsw-alias-label-primary` | body text, titles |
| `--mru-ink-soft` | `--dsw-alias-label-secondary` | translations, margin/rail meta, quiet copy |
| `--mru-rule` / `--mru-rule-strong` | `border-l1` / `border-l2` | hairlines, control borders, rules |
| `--mru-accent` | `--dsw-alias-brand-primary` | focus rings, active marks, progress, switches |
| `--mru-error` / `--mru-warn` / `--mru-success` | host state tokens | status chips, callouts, failures |
| `--mru-hl-yellow / sage / sky / rose` | plugin-owned rgba inks | highlights and swatches only |
| `--mru-hl-active` | accent @ 55% | active-highlight outline |
| `--mru-shadow` | plugin-owned | popovers, menus, modals, selection cards |

A useful property of the host theme: `--dsw-alias-brand-primary` is **monochrome**
(near-black `#0f1115` on light, near-white `#f9fafb` on dark). The product therefore reads as
ink-on-paper in both themes, and the four highlighter inks are the only chroma — no
purple/blue AI gradients, no terracotta.

Other host tokens used directly (not re-exported): `--dsw-alias-interactive-bg-hover`,
`--dsw-alias-button-primary-fill/-hover`, `--dsw-alias-label-primary-inverted`,
`--dsw-alias-label-tertiary`, `--dsw-alias-bg-document-selection` (text selection),
`--dsw-alias-bg-mask-1` (modal scrim), `--dsw-alias-scrollbar-bg-l1/-hover-l1`,
`--dsw-alias-bg-skeleton`, `--dsw-alias-switch-thumb`, `--dsw-alias-toast-bg/-label`.

### Space, radius, motion

- 4px base grid; rail 288px (220–460 draggable); margin 296px (240–520 draggable); topbar 52px;
  statusbar 30px. The rail/margin widths live in `--mru-rail-width` / `--mru-margin-width` on the
  workspace; the reading sheet and both graph views share `--mru-doc-width` (default **880px**,
  adjustable 720 / 880 / 1040 / 1200 from the reader runhead).
- Paper padding 56px 60px; body margin `0 0 1.05em`. The **sheet** follows `--mru-doc-width`
  (so 阅读 ↔ 图谱 never change the column width) and the **type area** inside follows
  `--mru-measure`: 窄 500 / 标准 560 / 宽 700 / 全宽 840px (default 560). The column outer width is
  `measure + 120px` of paper padding, so switching a preset visibly changes the line length as
  well as the page width; figures, tables, code blocks and formulas use the full type-area
  content width. At 1440px the column is clamped by the available main column (standard shows
  560px of text inside an 800px sheet).
- Radii: 6px controls (buttons, inputs, segments, tabs, tools), 10px cards/menus/modals/slips,
  14px paper, 999px chips.
- Motion: only the paper entry (fade + 6px rise, 180ms `cubic-bezier(.2,.7,.2,1)`), popovers
  (scale .98 + fade, 120ms), one drawer/sheet transition, and functional progress. No ambient
  animation. All of it is disabled under `prefers-reduced-motion: reduce` (the spinner keeps
  turning, slowly, because it is feedback).

---

## 3. Typographic system

Two voices, never mixed:

| role | family | size / leading |
|---|---|---|
| original text | `--mru-font-read` — Source Serif 4 → Iowan Old Style → Palatino → Georgia → Noto Serif → Songti/SimSun | `17.5px × read-scale` / 1.72, no justification |
| Chinese translation | `--mru-font-trans` — Noto Sans SC → PingFang SC → Hiragino → YaHei | `15px × read-scale` / 1.65, hung on a 2px hairline |
| UI chrome | `--mru-font-ui` — system UI stack | 11.5 / 12 / 12.5 / 13 / 14px |
| code and formulas | `--mru-font-mono` / KaTeX | `13px × read-scale`; `.katex { font-size: inherit }` |

- Article title: serif 600, `clamp(27px, 2.6vw, 34px)`, line-height 1.16, tracking −0.012em,
  `text-wrap: balance`.
- Headings: serif 600, h2 21 / h3 18 / h4 16; block h1 24. Sections carry 2.2em of air above;
  headings use `text-wrap: balance`.
- Body: 56ch measure, `text-wrap: pretty`, ragged right, no first-line indent, em-based rhythm.
- Translation: same 56ch measure, quieter sans, secondary ink, left rule; in **translated mode**
  (`.mru-paper--translated`) it becomes the primary body (17.5px, primary ink) and the English
  is hidden, while headings stay in the original language.
- Margin/UI: 12.5–13px, tabular numerals for counts, times and page numbers; no all-caps
  tracked eyebrows anywhere.
- Page marks: 10.5px serif numerals in the left gutter with a 13px leader hairline — the only
  place numbers are used as typography rather than data.
- The measure follows the preset: inside the sheet, the English column, the title block and the
  figures share the same centered type area (500–840px). The running head aligns its title to
  that type area (`max(60px, (sheet − measure) / 2)`) and lets its action row use the page margin
  on the right, so the width/legend/reading controls breathe without pushing the title out of
  view.

---

## 4. The memorable element

**The margin, and the translation slip that comes out of it.**

1. **Outline** (`.mru-outline`): a single hairline spine at the left with leader ticks whose
   length encodes heading depth (l1–l4). The active tick turns into the accent ink and lengthens;
   no boxes, no pills.
2. **Annotation slips** (`.mru-notes` / `.mru-note`): raised 10px slips on the margin surface with
   a hairline border (no soft grey shadow — restraint), a highlighter-ink square, a serif italic
   quote and a UI note. A CSS counter numbers them in serif numerals hung in a 16px gutter, so
   the margin reads like marginalia rather than a feed.
3. **Selection card** (`.mru-selcard`): the one deliberately bold object. It is a translator's
   slip laid over the page: paper-warm surface, **2px ink rule + 1px rule** double top edge
   (the same title-block rule as the paper), the selected sentence in serif italic hung from a
   rule, the translation in the Chinese sans voice at 15px, and a hairline footer with the
   provider name and a small copy button. It scales/fades in, clamps to the viewport and closes
   on Escape — it is the product promise ("read the original, get the meaning without leaving
   the page") made visible.
4. **Selection toolbar** (`.mru-selbar`): stays quiet — a 10px-radius control surface with a
   primary "翻译" button, four 16px highlighter swatches, note and copy. It is the handle to the
   slip, not a second design statement.

Everything else is disciplined: no cards-on-cards, no gradient decoration, no shadows on list
rows, no hover lifts, no icon rainbow.

---

## 5. Dark mode

Only the paper tint and the annotation inks change (`body[data-ds-dark-theme] .mru-root`, with an
`html[data-ds-dark-theme]` twin for robustness):

- paper becomes `color-mix(layer-1 92%, #000 8%)` — slightly darker than the rail surface, so the
  sheet still reads as a separate object under a dark desk light;
- highlight inks drop to 20% alpha so highlights stay visible without glowing;
- everything else is a host token and adapts automatically (ink, rules, hovers, focus ring,
  scrollbars, menu/toast/mask colors). No hand-picked dark hex values.

The focus ring (`--mru-accent`) is near-black on light and near-white on dark, so it is always
visible on both the paper and the chrome.

---

## 6. Responsive behavior

The app is a **panel guest**, so its available width — not the viewport width — decides the
layout. Responsive rules therefore use a named container query, `@container mru-desk`, with the
UI-SPEC breakpoints; an `@media` fallback inside `@supports not (container-type: inline-size)`
keeps old engines working. This matters: in the host shell a 1440px window can host ~1100px of
panel, and a viewport-based query would wrongly show the three-zone desk there.

| width | layout |
|---|---|
| > 1280px | rail 288 · centered paper · margin 296; both toggle buttons hidden |
| 900–1280px | margin hidden; `.mru-root--margin-open` shows it as an absolute right sheet over the paper; rail stays static |
| < 900px | rail hidden; `.mru-root--rail-open` slides it in as a left drawer with the `.mru-scrim`; paper becomes a full-bleed sheet with 28px 20px padding; page marks and block tools hide; brand name/count hide |
| < 560px | tighter topbar, one-column setup grid, 12px modal gutters |

At 360px the topbar is import + three 28px icon buttons; the paper scrolls with no horizontal
overflow, long strings break with `overflow-wrap`, and tables scroll inside `.mru-table-wrap`.
Keyboard toggles the same modifier classes; CSS hides a toggle only where its zone is static, so
the client can render all three unconditionally.

---

## 7. Accessibility and quality floor

- Real buttons/inputs/selects/textarea; icon-only controls carry `aria-label` (client side).
- Visible focus everywhere: 2px `--mru-accent` ring with 2px offset (the search composite uses
  `:focus-within` on its wrapper instead, to avoid a double ring). Icon buttons, tabs, switches,
  swatches, outline items, document rows and menu items all participate.
- Highlights never change text color — only a translucent ink behind the existing ink.
- Body ink on paper and margin text stay at host-token contrasts (≥ 4.5:1 in both themes);
  status chips keep host ink on a tinted background rather than recolored 10.5px text.
- `prefers-reduced-motion: reduce` disables the paper entry, popover scale/fade, sheet slide,
  chip pulse, skeleton pulse and highlight glow; the loading spinner is the only retained motion.
- Scrollbars are scoped to `.mru-root` (8px, host-token thumbs) so the host's scrollbars are
  untouched.
- `@media print` removes the desk and prints only the paper: no chrome, no shadows, highlights
  keep their ink with `print-color-adjust: exact`.

---

## 8. Artwork

All three assets are original line art drawn on the same system as the CSS.

- **`ui/panel-icon.svg`** — 24×24, `width/height: 100%`, `stroke: currentColor` (the host
  sidebar renders it at 16px). A sheet with a ruled margin and two annotation dots: the
  reading desk reduced to one glyph. It reads at 16px because it is only a page, a rule and two
  dots; it inherits the host's active/quiet icon colors.
- **`ui/empty-art.svg`** — 240×160 inline, `currentColor` only, opacity layering. A sheet with a
  title block, one highlighted claim, a margin rule with three marks, an annotation slip and a
  translation slip peeking out — the empty state shows the *thing you will do*, not a generic
  illustration blob.
- **`icon.svg`** — 64×64, self-contained colors, legible at 32px: a warm paper sheet on an ink
  tile, three text rules, one yellow highlight band, sage margin ticks and a rose dot. The
  annotation inks are the only chroma, matching the product palette; no terracotta, no gradient.

---

## 9. Intentionally excluded

- **No gradients, no glass decoration, no glow.** The only translucency is functional (backdrop
  blur behind the sticky runhead, the modal mask, and the selection slip).
- **No uniform rounded-card grid.** Rail rows are rows; the outline is a spine; notes are slips;
  the setup panel is a form sheet.
- **No all-caps tracked eyebrow labels, no numbered section markers `01/02/03`, no monospace
  small-data labels.** Numbers only appear where they mean something (page marks, Unicode note
  counters, counts).
- **No custom display font, no external font/CDN request, no `@import`, no `url()`.** System and
  locally installed serif stacks only, so the plugin ships zero network dependencies.
- **No second palette.** Status colors are host tokens; highlights are the only plugin colors.
- **No ambient animation, no hover transforms, no parallax, no paper texture image.**
- **No print-only chrome or paper decorations**: printing gives a clean article.
- **No design of the parse pipeline states as a separate visual language** — setup, progress and
  failure are quiet chrome cards so the reading surface stays the hero.

---

## 10. Verification

- `node scripts/build-client.mjs` inlines `ui/styles.css`, `ui/panel-icon.svg`,
  `ui/empty-art.svg`; the final build wrote a 300 KiB `lib/client.js` with 74,272 B of CSS.
- `node scripts/check.mjs` passes: 10/10 gate checks (manifest, SVG validity, `node --check`,
  generated bundle, 215 unit/reader/e2e tests).
- CSS is braces-balanced (checked), with no `@import` and no external `url()`.
- Class coverage was reconciled against the final `ui/app.js`: all 220 `mru-*` class tokens it
  renders are styled, including its extension classes (`mru-formula__raw`, `mru-para__error`,
  `mru-chip__progress`, `mru-block--has-translation`, `mru-toggle-row--plain`,
  `mru-note--active`, `mru-confirm__text--name`, `mru-callout--error`,
  `mru-block__translate/__annotate`, `mru-swatch--*`, `mru-hl--*`, `mru-outline__item--l1…l4`).
  Defensive classes for spec'd states the client does not currently emit (`mru-banner__*`,
  `mru-line-skeleton*`, `mru-kbd`, `mru-sr-only`, `mru-loading`, `mru-para__text--muted`) are
  kept for contract completeness.
- Visual verification: a throwaway static harness recreated the UI-SPEC §3 class contract with
  the real stylesheet and host theme tokens, rendered in headless Chromium (Chromium-for-Testing),
  and was reviewed at 1440 / 1100 / 1050 / 820 / 390 / 360 px, in light and dark, across the
  reading, translated, empty, setup, parsing, failure, settings, confirm, reparse, import,
  overlay and drawer states. This caught four real integration defects that were fixed before
  hand-off (see §11). The harness itself was disposable and has been removed.

## 11. Integration notes (against the final `ui/app.js`)

Fixed in CSS after reading the final client (no markup changes required):

1. Element resets had to become `:where()`-wrapped — plain `.mru-root button`/`ul`/`p` rules
   out-specified single-class component styles (primary buttons, swatches, list bullets,
   segmented controls, pointer cursors, paragraph margins).
2. The selection overlays (`.mru-selbar`, `.mru-selcard`, `.mru-noteeditor`) receive only inline
   `left`/`top`; the stylesheet now supplies `position: fixed` + stacking order (70/71/72).
3. The client's `.mru-menu-wrap` is fixed-positioned and its placement math assumes a 226px
   menu; `.mru-menu` is 226px wide (max `100vw - 24px`) and the wrapper stays unpositioned.
4. `.mru-scrim` only paints inside the `<900px` container mode, so a stale rail-open state after
   a resize cannot dim a static-rail layout.
5. Confirm modal drops the nested `.mru-modal__body` padding; reparse drops the setup card's
   border/padding when the form is nested inside a modal; destructive primary buttons
   (`.mru-btn--primary.mru-btn--danger`) are filled with the error ink.
6. `ui/panel-icon.svg` is self-contained (paint attributes on an inner `<g>`), because
   `mruIconMarkup()` rewrites the outer `<svg>` tag and would drop root-level stroke attributes.

One edge case is now covered end-to-end: in 译文 mode an untranslated block renders its original
English inside `.mru-para__translation--source`, and the stylesheet keeps that fallback in the
serif reading voice at body size — so a not-yet-translated block reads as the original page
rather than switching to the translation voice.

## 12. AI layer — the margin voice and the knowledge map

The AI features do not add a second product; they extend the same desk. `ui/styles.css` §18 is
the AI layer, and it inherits everything above: host tokens for chrome, the paper tint, the four
annotation inks, the same 6/10/14px radius language, the same focus ring, the same motion budget.

### 12.1 Chat panel — the margin becomes the conversation

The right margin (296px) already held annotations and the outline; now it also holds a
conversation. It stays a **quiet conversation column, not a chat app**:

- **Assistant answers are paper slips.** `.mru-ai__msg--assistant .mru-ai__bubble` is a warm
  paper-tinted block (paper token mixed into the surface) with a hairline border, an asymmetric
  corner (3px top-left, 10px elsewhere) and no avatar, no tail, no floating card shadow. The
  answer itself is set in the translator's sans voice (12.8px / 1.72); quotes pulled from the
  paper inside the answer switch to the serif reading voice with a rule, exactly like the
  translation block.
- **User questions are pinned notes.** `.mru-ai__msg--user` aligns right; the bubble is a small
  tinted note with a 2px accent edge on the margin side (like a sticky note pinned toward the
  edge of the page), 12.5px UI type.
- **Citations are editorial superscripts.** `.mru-ai__citation` is a 9.5px tabular chip raised on
  the text (14px box, 3px radius, hairline), not a link — `[1]` in a book. `.mru-ai__citation--unverified`
  is dashed and dimmed ("未通过校验"). Hovering/focusing opens `.mru-ai__citation-card`: a small
  paper quote with the same **2px ink + 1px rule double top edge** as the selection translation
  card, then page/block coordinates. The footer aggregation (`4 条引用`) uses the same chip at
  body size.
- **Controls stay host-shaped.** Composer = 8px-radius textarea on the host surface-2 fill, 32px
  primary send square, ghost stop; context chips are 999px, 10.5px; quick prompts are outline
  rectangles (not pills) so they read as "questions to ask", and follow-ups are outline pills.
  `.mru-ai__action` is a tiny text action (copy / regenerate / highlight).
- **The AI origin marker** (`.mru-ai__spark`) is the only place the assistant's provenance is
  decorated. The four annotation inks keep carrying the aspect language across the product: the
  host turns verified citations into aspect-colored margin annotations (existing swatches), and
  graph nodes use the same ink-derived ring colors; the chat citation card names the aspect in
  its meta line. The stylesheet also provides `[data-aspect]` dot hooks on chips/sparks so a
  future module can surface the aspect directly.
- **Streaming** is one 2px caret (`.mru-ai__streaming::after`) — the only moving thing in the
  margin. The panel fills the margin body (`.mru-margin__body:has(> .mru-ai)` drops padding and
  double scroll), with head, scrolling messages, context row and a pinned composer.

### 12.2 Knowledge graph — a map drawn on the paper

The graph is a **quiet knowledge map on the paper surface**, not a dashboard. Two placements:

- **Library graph** (`.mru-main--graph`): the whole center column is the map sheet — 1120px max,
  14px radius, hairline border, soft lift; head + toolbar are quiet surface bands, the canvas is
  the paper.
- **Doc graph** (`.mru-paper__body--graph`): the map is *printed on the reading sheet* — the
  paper widens (up to 1040px), the graph drops its own border/shadow, its head/toolbar become
  unboxed hairlines, and the graph title becomes a small UI caption under the paper title. The
  module owns pan/zoom; the body gives it `min(72vh, 820px)` to breathe.

Canvas: paper tint with a **functional graph-paper dot grid** (1px ink dots at 9% alpha, 22px
pitch via a CSS radial-gradient — texture that helps pan/zoom orientation, not decoration).
Nodes are labeled dots with a **type ring**; labels carry a paper-colored halo (`paint-order`
+ 3px stroke) so they stay legible over edges and the dot grid.

**Infinite canvas.** The SVG viewBox mirrors the canvas' measured CSS pixel box, so the world is
not a fixed 1000×680 sheet and nothing is clipped at an artificial border. The viewport `<g>`
camera (`screen = world * k + (x, y)`) pans without bounds, wheel zoom is anchored at the cursor,
zoom buttons are anchored at the canvas centre, and nodes can be dragged out past the seeded
layout sheet — pinned positions are kept verbatim (the layout only clamps newly laid-out nodes,
and the drag simulation runs unbounded). Opening a graph, switching document/library and the
「适应视图」 button fit every node back into view (capped at 100% for tiny graphs); the dot grid
pans/zooms with the camera (screen step kept between 10–44px); and a filter/collapse relayout
that would leave the visible map out of the camera re-fits it instead of showing empty paper.

| node type | ring / ink | notes |
|---|---|---|
| concept | host ink | the neutral center of the map |
| method | sage | derived from the sage annotation ink |
| finding | sky | derived from the sky annotation ink |
| definition | yellow | derived from the yellow annotation ink |
| limitation | rose | derived from the rose annotation ink |
| section | tertiary grey | structural, quieter |
| question | accent, dashed ring | a question the reader asked |
| insight | accent | an AI insight that emerged in conversation |
| paper | ink, solid fill | library scale, larger |
| topic | accent, larger ring | library scale, cluster centers |

Hover deepens the fill, the active node uses the accent stroke, and edges are 1.1px hairlines at
20% ink; the active edge turns accent. Legend/filter chips repeat the same dot colors
(`[data-type]`), the filter state is `aria-pressed="true"`, and the search box matches the host
control. Build progress is one 2px accent line. The bottom status line carries node/edge counts
in tabular numerals. The **details card** (`.mru-graph__card`) reuses the translator-slip language
(2px ink + 1px rule top edge, paper-warm surface, serif title) and offers jump-to-source /
ask-AI actions in a row.

### 12.3 Theme, motion, responsiveness

- **No dark-mode-specific overrides** were needed: node/aspect colors are `color-mix` of the
  annotation inks with `--mru-ink`, so they lighten on dark; the assistant slip and the canvas
  use `--mru-paper-bg`; all chrome remains host tokens. The dotted grid and hairlines use ink
  mixes and stay visible in both themes.
- **Motion:** the streaming caret blinks (steps), the citation card and graph details card pop
  in 120–140ms, and a citation/node jump washes the target block with a 1.6s accent flash.
  `prefers-reduced-motion` removes the caret blink, the card pop, the flash animation (static
  wash) and all node/edge/progress transitions.
- **Responsive** uses the same `@container mru-desk` breakpoints: the chat panel lives in the
  existing 296px margin (inline on the desk, right sheet at 900–1280, margin sheet on phones);
  the library graph goes full-bleed below 900 (no radius/borders), and below 560 the toolbar
  wraps into a scrollable legend row plus a full-width search, while the details card becomes a
  bottom overlay (`left/right:10px`, max 46% height). The graph stays readable and pannable at
  360px; the chat column is usable at 296px.
- **Focus/a11y:** every new control uses the existing 2px accent ring; graph nodes (SVG `<g>`
  or `<circle>` with `tabindex`) suppress the outline in favor of an accent node ring;
  citations, follow-ups, legend chips, composer and send/stop are real buttons. Aspect/filter
  states are announced with `aria-pressed`, the graph card is an overlay (not a modal) and the
  composer hint shows the keyboard shortcut.

### 12.4 AI-layer classes and integration hooks (final reconciliation)

The AI-SPEC §8 contract is fully styled (**61/61 classes**, chat + graph), including all ten
graph node-type modifiers and `--unverified` / `--missing` / `--active` / `--streaming` states.
Reconciled against the landed `ui/chat.js` (47 emitted class tokens) and `ui/graph.js` (43
emitted class tokens): **zero missing classes** in `ui/styles.css`, including the documented
modifier classes beyond §8:

- chat: `.mru-ai__msg--streaming` (live answer, accent-tinted slip + inline block caret),
  `.mru-ai__citation--missing` (citation number with no data — amber dotted, distinct from the
  grey dotted unverified state), `.mru-ai__chip--selection` / `.mru-ai__chip--visible`
  (context chips with an accent/ink dot), `.mru-ai__action--compact` (dense text/icon action);
- graph: `.mru-graph__canvas-bg`, `.mru-graph__viewport` (the module owns the transform attribute;
  CSS only adds `will-change`), `.mru-graph__edge-group` (+`--active`/`--dim`), `.mru-graph__edge-hit`
  (14px invisible hit line), `.mru-graph__node-count` (cluster count printed inside the dot),
  `.mru-graph__legend-count` (type counters in filter chips), `.mru-graph__zoom` (status-line zoom
  controls), `.mru-graph__glyph`, `.mru-graph__node--unknown` (malformed-type fallback).

`ui/app.js` integration hooks are covered too:

- `.mru-segmented--view` + `.mru-topbar__view` — compact view switches (文献库 | 全景图谱,
  阅读 | 图谱), 11px, sitting in the topbar actions and the runhead;
- `.mru-selbar__btn--ai`, `.mru-selbar__btn-label` — 问 AI in the selection toolbar (client spark
  glyph + label);
- `.mru-block__ask` — sparkle block-tool beside 翻译/批注;
- `.mru-tab svg` + `.mru-tab__label` — spark + label in the AI margin tab;
- `.mru-block--flash` — citation/node jump flash (reduced-motion aware);
- `.mru-main--graph`, `.mru-paper__body--graph` — the two graph placements;
- `.mru-ai--placeholder`, `.mru-graph--placeholder` and `.mru-graph__empty-text` — the
  intermediate surfaces rendered while the modules were still placeholders.

**Curation/trust round hooks (implemented):** the AI-origin marker on margin notes
(`.mru-note--ai` + `.mru-note__origin` with the spark glyph in `.mru-note__head`) and the
origin/aspect margin filter (`.mru-note-filter*`, see §12c) now ship in `ui/app.js`; the
AI-origin provenance is carried by the annotation model (`origin: 'ai'`, aspect + spark) and
survives the client normalizer and the whole-list save.

### 12.5 Verification

- `node scripts/build-client.mjs` — PASS (589.2 KiB bundle, 124,836 B CSS inlined);
  `node scripts/check.mjs --require-client-ai` — 11/11 PASS, 389 tests (chat and graph modules
  in the bundle, order chat < graph < app).
- Class coverage: AI-SPEC §8 61/61; chat 47/47 emitted tokens; graph 43/43 emitted tokens; all
  app-side AI hooks present. CSS braces balanced; no external assets or `url()`.
- Contrast pass (QA follow-up): the two dimmed AI states no longer use opacity for text.
  `.mru-ai__citation--unverified` is secondary ink + dotted underline (5.61:1 light / 10.68:1 dark
  on the assistant slip), `.mru-ai__citation--missing` is a dark amber mix (6.06:1 / 10.66:1), the
  citation-card meta line went tertiary → secondary ink (5.80:1 / 10.42:1), and
  `.mru-graph__edge-label` went tertiary → secondary ink with the paper halo (5.56:1 / 10.81:1 on
  the paper canvas) — all ≥4.5:1 while still reading as quiet/secondary.
- The disposable headless-Chromium harness rendered the **real** chat and graph markup in light
  and dark at 1440px, in the 296px margin sheet at 390px, and the library graph at 900/1000/360px,
  covering: message bubbles (user note / assistant slip), inline `[n]` superscripts with the
  fixed hover card, evidence footer, unverified notice, follow-up chips, context chips, composer
  + send/stop, streaming caret and thinking row, error line; graph head/toolbar/legend with
  counts, dotted canvas, type rings for all ten node types, cluster nodes (dashed ring + count),
  active path edges, details card, determinate/indeterminate progress, empty/loading/error states
  and the two placements (full-column library map, printed-on-paper doc map).

### 12.6 Intentionally excluded from the AI layer

- No chat-app furniture: no avatars, no tails, no typing dots, no gradient "AI glow", no
  full-width hero for the assistant, no dashboard cards.
- No second palette: aspect and graph colors are derived from the four annotation inks mixed with
  host ink; nothing new is introduced.
- No graph hairball by default: the client curates visible nodes; CSS only provides the quiet
  map language (hairlines, halos, progressive filter chips).
- No external assets, fonts, icon sets or graph libraries: SVG + CSS only, all chrome on host
  tokens.
- No new motion vocabulary: the caret, the popovers and the jump flash are the entire AI-layer
  motion budget.

## 12b. UI polish round — resizers, shared width, navigator, legions, anchored cards

Added for docs/UI-POLISH-SPEC.md (styles only; §19 of `ui/styles.css`). The polish round keeps the
same desk language: dividers are hairlines with a quiet grip, the legend is text-first, and the
new floating pieces are paper slips rather than dashboard widgets.

### 12b.1 Resizable rail and margin

- `.mru-resizer` is a 6px handle between rail/main and main/margin, pulled back over the
  neighbouring hairlines with `margin: 0 -3px` so it does not change the desk geometry. The grip
  is a 2×28px rounded hairline (`::after`) that appears on hover, keyboard focus and while
  dragging (`--active` becomes a 2×52px accent line); an invisible `::before` extends the hit
  target to 16px. `cursor: col-resize`, `role=separator` and the existing 2px accent focus ring
  are carried by the handle.
- `.mru-root--resizing` disables text selection and forces the resize cursor across the
  workspace while a drag is live.
- Widths are applied from `--mru-rail-width` / `--mru-margin-width` (fallbacks 288 / 296) set
  inline on the workspace by `ui/app.js`; the margin sheet and mobile drawers clamp the same
  variables (`min(var(--mru-margin-width), 88vw)`), so a remembered width survives every
  responsive mode. Resizers hide entirely in the drawer modes (margin below 1280, both below
  900) because those zones are overlays, not columns.

### 12b.2 One document width for reading and graph

- `--mru-doc-width` (default 880px) and `--mru-measure` (default 560px) are set on `.mru-root` by
  the app from the persisted layout preset. `.mru-paper`, `.mru-main--graph > .mru-graph` and the
  doc-graph sheet all use `min(100%, var(--mru-doc-width, 880px))`; the old independent 1040/1120px
  widths are gone, so switching 阅读 ↔ 图谱 keeps the column identical and the graphs never shrink
  to the text measure.
- Inside the sheet the type area follows `--mru-measure`: 窄 500 / 标准 560 / 宽 700 / 全宽 840px.
  `.mru-paper__col` is `max-width: calc(var(--mru-measure, 560px) + 120px)` (60px paper padding
  each side), and all eight type caps (headings, paragraphs, translations, translated-mode body,
  lists, quotes, modal section copy) use `max-width: var(--mru-measure, 56ch)`. The block tools
  follow the text edge: `right: max(-42px, calc(100% - var(--mru-measure, 56ch) - 34px))` keeps
  the 8px gap after the last line and stays inside the paper padding when the column is clamped.
  Figures/tables/code/formulas keep `max-width: 100%` = the full type area.
- Measured in Chromium at 1920px: 窄 sheet 720 / col 620 / type 500; 标准 880 / 680 / 560;
  宽 1040 / 820 / 700; 全宽 1200 / 960 / 840 — no horizontal overflow in any preset, the figure
  always matches the type area, and the graph view keeps `--mru-doc-width` (1200 / 880) regardless
  of measure. At 360px the column is 360 with 320px of text (preset caps clamp naturally).
- The runhead title aligns with the type area's left edge and the action row uses the page
  margin on the right; the 窄/标准/宽/全宽 control (`.mru-runhead__width-group`,
  `--active`/`aria-pressed`) is a compact 4-item group (20px rows, 10.5px labels) styled like the
  reading-mode segmented control. It is hidden below 1024px of panel width; the runhead 图例
  trigger collapses to its spark icon below 560px, and at 360px the runhead still fits on one row.

### 12b.3 AI question navigator and “back to latest”

- `.mru-ai__nav` floats on the AI panel's right edge (absolute inside the panel, 56% max height):
  one 9×3px tick per user question, current = 16px accent tick, hover/focus = 13px secondary ink
  tick. The panel reserves 22px on the right of the message list only while a navigator exists
  (`:has`), so the conversation does not shift for a single question.
- Hover/focus shows `.mru-ai__nav-preview`, a small paper slip with the question ordinal and a
  two-line question; it is anchored to the left of the rail and is pointer-transparent. The nav
  itself never clips it (`overflow: visible`).
- `.mru-ai__toLatest` is a centered 24px pill placed after the message list in the panel column
  and pulled up 30px over the conversation's bottom edge, so it floats correctly regardless of
  composer/legend/context height. It uses secondary ink with a hairline border and only appears
  when the reader is away from the newest message.
- Jumping via a mark flashes the target message (`.mru-ai__msg--flash`): a soft accent wash on
  the bubble (`::after`, 1.2s fade) matching the block flash; with reduced motion the wash is
  static while the class is present instead of animating.

### 12b.4 Aspect-colour legend in four places

`.mru-aspect-legend` is one small row of dot + always-visible text labels (never colour alone;
WCAG 1.4.1). The dots are literal samples of the highlight inks: `background: var(--mru-hl-yellow /
sage / sky / rose)` (the exact tokens behind `.mru-hl--*` text highlights) plus a same-hue 1px
inset ring for definition on light surfaces; yellow = definition/context, sage = method,
sky = result, rose = limitation. Pixel-sampled in the harness, dot and real highlight composite to
identical RGB in light (`247,231,184` / `211,223,207` / `208,221,231` / `237,214,217`) and dark
(`73,64,40` / `50,59,51` / `47,56,65` / `65,50,54`). The same component is placed:

1. under the margin tabs on the 批注 tab (`.mru-margin__legend`), including the empty state;
2. above the AI composer (`.mru-ai__legend`, with a small `批注颜色` title row);
3. under the graph canvas (`.mru-graph__aspect-legend`, with a 批注颜色 label);
4. in the runhead 图例 popover (`.mru-aspect-popover`, a fixed paper slip with title and legend),
   opened from the `.mru-runhead__legend` ghost button.

The old `.mru-ai__legend-hint` and `.mru-aspect-popover__hint` styles were removed with their
markup; both surfaces now read as title + legend only.

All new text uses secondary ink on the host surface: aspect labels **5.80:1 light / 10.42:1 dark**,
runhead width labels **5.56:1 / 10.81:1**, popover title **18.9:1 / 15.0:1**, popover hint and
navigator preview index **5.80:1 / 10.42:1**, preview question and “回到最新” labels
**18.9:1 / 15.0:1 and 5.80:1 / 10.42:1** respectively.

### 12b.5 Node-anchored graph card

`.mru-graph__card--anchored` keeps the translator-slip surface/typography of the corner card but
is positioned with inline `left`/`top` by `ui/graph.js` next to the selected node:
`width: min(300px, 100% - 16px)`, `max-width: 320px`, `max-height: min(58%, 340px)`, stronger
lift shadow and a 140ms fade + 0.98 scale entrance from the node side (`data-placement="left"`
flips the transform origin). It never overflows at 360px (max-width is relative to the graph
container and the module clamps the position); no caret is drawn because the card scrolls its
own content and a protruding caret would be clipped.

### 12b.6 Stale annotations after a reparse

When a reparse moves an anchor, the annotation keeps its quote and aspect ink but is shown as
stale in the 批注 tab (markup added by client-ui):

- `.mru-margin__stale` / `.mru-margin__stale-title` — the stale annotations are grouped at the
  end of the 批注 list under a hairline, with a quiet 10.5px section title.
- `.mru-note--stale` — normal note language with a **2px dashed left edge** in secondary ink, a
  slightly flatter surface, secondary-ink quote/body, default cursor and no hover mutation, so the
  card no longer reads as a jump affordance. The aspect swatch keeps its ink colour.
- `.mru-note__stale-tag` — 10px uppercase/quiet tag (`位置已变化` / "Position changed") in
  secondary ink with a dotted underline, placed in the head row right after the aspect dot (the
  time is pushed to the far edge). Contrast 5.80:1 light / 10.42:1 dark.
- `.mru-margin__notice--stale` — neutral info variant of the margin notice: hairline border with a
  soft secondary-ink left rule and a 3% ink wash instead of the warning tint; text in secondary
  ink (same 5.80 / 10.42 contrast).

### 12b.7 Checks

- Light/dark, 1440/1000/390/360 and 720/880/1040/1200 doc-width presets verified in the same
  headless-Chromium harness (removed afterwards): resizer grip/active states, runhead fit at
  360px (width group hidden, legend icon-only), width consistency, margin/AI/graph legends,
  navigator + preview + to-latest, anchored card at 1440 and 360, popover, and the stale-note
  cards/notice in light + dark.
- Text measure now follows the presets (500/560/700/840px), verified by measured geometry:
  no horizontal overflow, figures equal to the type area, block tools 8px after the last text
  column, graph widths tied to `--mru-doc-width` only.
- Legend dots match the real highlight inks pixel-for-pixel (above), and the removed hint styles
  leave clean title+legend surfaces.
- Braces balanced, no `@import`/external `url()`; only `ui/styles.css` + this file changed.

## 12c. Curation & trust round — margin filter, graph curation, exported chats

The reading desk grows a quiet curation layer; all of it reuses the existing ink/rule language and
the four annotation inks (no new palette, no new external assets).

### 12c.1 Margin AI filter and spark

- `.mru-note-filter` sits between the 大纲/批注/AI tabs and the aspect legend. One row of origin
  chips `全部 / AI 批注 / 我的批注` with tabular counts; the **aspect legend itself is the aspect
  filter** (this round removed a duplicated dot-only filter row): `.mru-margin__legend` gains a
  quiet `.mru-margin__legend-hint`（按侧重点）, the legend renders
  `.mru-aspect-legend--interactive` items as `.mru-aspect-legend__item--button` buttons with
  `aria-pressed` (dot + label unchanged, pressed = ink ring + 7% ink wash + 600 weight, hover/focus
  states), clicking the active aspect again clears it, and `.mru-margin__legend--filtering` marks
  the filtering state. Origin × aspect is an AND filter; the active state shows
  「显示 {shown} / {total} 条」 plus a dotted-underline 清除筛选 action, and an empty result
  renders `.mru-margin__empty--filtered` with the same clear action.
- `.mru-note--ai` is a slightly firmer hairline around an AI note; `.mru-note__origin` is a
  10px spark + 「AI 批注 · 方法」 badge (accent spark, ink-soft text) with the title
  「由 AI 阅读生成」. User notes keep the plain head. The note editor shows the same badge
  (`.mru-noteeditor__head` / `__origin` / `__aspect`) so provenance is visible while editing.
- The filter is host-persisted (`notesFilter` preference); the aspect toggle is session-local. The
  tab count stays the total number of notes.

### 12c.2 Graph curation

- The document graph's details card gains `.mru-graph__card-actions` with
  `.mru-graph__card-action` buttons (重命名 / 合并到… / 固定位置·取消固定, plus the existing 问 AI).
  Rename swaps the card title for `.mru-graph__rename` (input + 保存/取消, Enter/Escape), 80 chars
  max, empty blocked; merge shows `.mru-graph__merge-bar--hint` (dashed accent rule + source
  label) while the canvas stays clickable and other nodes become
  `.mru-graph__node--merge-candidate` (dashed accent ring, copy cursor); the confirmation swaps to
  `.mru-graph__merge-bar--confirm` (`.mru-graph__merge-title` + `.mru-graph__merge-labels` /
  `__merge-node` / `__merge-arrow`, solid accent rule, 保存/取消). Pin uses the node's current
  laid-out position, and drag-release also persists. Pending/error/notice rows are
  `.mru-graph__card-pending` (spinner, `graph.saving`) / `.mru-graph__card-error` /
  `.mru-graph__card-notice`; actions disable while pending. The source node during merge is
  `.mru-graph__node--merge-source` (accent dashed ring).
- Pinned nodes get `.mru-graph__node--pinned` (label weight) and a `.mru-graph__node-pin` accent
  dot at the node's top-right (`.mru-graph__node-pin-group`); the stored `position` seeds the
  seeded layout, so reopening the paper keeps the arrangement and "reset view" keeps persisted
  pins. The library map keeps the same read-only surface (no curation actions at all; read-only
  is enforced by hiding the controls, so no extra note class is emitted). Mode/pending states are
  exposed as data hooks (`data-merge-mode`, card `data-pending`/`data-merging`, node
  `data-pinned`/`data-merge-source`/`data-merge-candidate`) for the harness.

### 12c.3 Entailment states and exported conversations

- `.mru-ai__citation--partial` is the third citation state: amber dotted underline and amber-mixed
  ink (full ink on hover/focus), distinct from the grey `--unverified` and the amber
  `--missing`. The citation card gains an `.mru-ai__claim` row (「论点核对」 + the partial/
  unsupported sentence); the answer-level notice reuses `.mru-ai__notice` (`--entailment`
  modifier for the claim-specific wording). Unsupported citations stay in the dimmed
  `--unverified` state and are not jumpable — they never became annotations.
- The chat header's 导出对话 action reuses `.mru-ai__action`; the downloaded Markdown is the
  panel's own serialization (title, model, time, per-turn question/answer + citation list), so it
  prints/reads like the rest of the desk.
- Settings: the auto-build switch lives in a dedicated AI section with a hint line and a disabled
  state (`.mru-switch--disabled`, `.mru-toggle-row--disabled`) when no graph engine is available.

### 12c.4 Checks

- Braces balanced in `ui/styles.css`; only `mru-*` selectors and host tokens
  (`--mru-*`, `--dsw-alias-*`); no `@import`/`url()`/new assets. The new controls are ≥18px hit
  targets, real buttons with `aria-pressed`/`aria-label`, and honour reduced motion.
- The fake-React harness drives the full loop: AI spark + filter chips (counts, empty state,
  persistence), rename/merge/pin patches through `onUpdateGraph` with the returned KG adopted,
  the export hook (download filename) and the AI settings toggle.
- Full gate (`node scripts/check.mjs --require-client-ai`) green after the round; docs updated in
  `docs/AI-SPEC.md` §2/§3/§4/§5/§6/§8/§9/§10.
---

---

## 13. Engine extension: local parsing (T0/T0.5)

The parse form now carries a fourth engine, `local`, because "offline / nothing uploaded" is a
different promise from "cloud, no token" — not a hidden mode of `auto`. In the interface this is
expressed as one extra option in the existing select (`自动 / 精准解析 / 本地解析（离线 · 不上传）/
轻量云端解析`), a disabled state with a concrete reason when the file cannot be parsed locally, and
a small 「将使用：…」 line that states *before* the click which engine will run (and whether the
file will be uploaded). The reader then labels the result with the quieter
`.mru-banner--local` strip — informational, not an error — carrying the quality caveat and the
"configure a token for precise parsing" path; the status bar adds the provider
(`本地解析 · 内置` / `Office 转换`) so a locally produced draft is never mistaken for a MinerU
one. The settings modal gained a compact 「本地解析」 capability list (built-in text layer, Office
conversion) instead of a generic toggle, mirroring the host's `local` snapshot.

No new visual language was introduced: the local banner reuses the existing info banner with
`--local`, the capability rows reuse hairlines and the `.mru-field__hint` voice, and the engine
labels reuse the statusbar text style. The deliberate asymmetry — local parsing appears *less*
prominent than precise parsing — is intentional: it is the zero-setup fallback, while formulas,
tables, figures and scanned pages still point at MinerU.
