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

- 4px base grid; rail 288px; margin 296px; topbar 52px; statusbar 30px.
- Paper padding 56px 60px; body measure 56ch; body margin `0 0 1.05em`. The sheet is sized
  from the measure: `max-width: 680px` (56ch of English + 120px of paper padding + rules),
  safely under the UI-SPEC 760px cap. On the rendered desk this keeps the English text filling
  the page instead of floating in a wide empty column; figures, tables, code and formulas use
  the full 560px content width inside the same sheet.
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
- The measure decides the page: the paper sheet is 680px wide (not a 760px banner), so the
  56ch English column, the title block and the figures share the same page edge.

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
  decorated; when an aspect is known, `[data-aspect]` dots on chips/spark reuse the four
  annotation inks (definition yellow, method sage, result/finding sky, limitation rose) — the same
  color language as the margin notes.
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

### 12.4 AI-layer classes and integration hooks

The AI-SPEC §8 contract is fully styled (**61/61 classes**, chat + graph), including the graph
node-type modifiers and `--unverified`/`--active` states. In addition, the stylesheet carries the
integration hooks client-ui reported for `ui/app.js`:

- `.mru-segmented--view` + `.mru-topbar__view` — compact view switches (文献库 | 全景图谱,
  阅读 | 图谱), 11px, sitting in the topbar actions and the runhead;
- `.mru-selbar__btn--ai`, `.mru-selbar__btn-label` — 问 AI in the selection toolbar (spark glyph
  from the client + label);
- `.mru-block__ask` — sparkle block-tool beside 翻译/批注;
- `.mru-tab svg` + `.mru-tab__label` — spark + label in the AI margin tab;
- `.mru-block--flash` — citation/node jump flash (reduced-motion aware);
- `.mru-main--graph`, `.mru-paper__body--graph` — the two graph placements;
- `.mru-ai--placeholder`, `.mru-graph--placeholder` and `.mru-graph__empty-text` — the
  intermediate surfaces rendered while `ui/chat.js` / `ui/graph.js` are still placeholders.

### 12.5 Verification

- Every AI-SPEC §8 class plus all integration hooks above is present in `ui/styles.css`; CSS is
  braces-balanced and the client build inlines it (`node scripts/build-client.mjs`).
- The same disposable headless-Chromium harness used for the reading desk rendered the AI panel
  (messages / empty / dark / phone margin sheet) and the graph (library light+dark, doc-printed
  variant, 360px, empty) against the §8 markup and host theme tokens; the class contract was
  reviewed for both themes before hand-off.

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
