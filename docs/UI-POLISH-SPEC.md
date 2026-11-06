# UI polish round — contract

Five reading-experience changes requested after the AI upgrade. This file is the
coordination contract for the three write scopes; keep class names and storage
keys exactly as written so the modules compose without rework.

## 0. Ownership

| Scope | Owner | Files |
|---|---|---|
| app shell + AI panel | client-ui | `ui/app.js`, `ui/chat.js` |
| knowledge graph | lead | `ui/graph.js` |
| visual design | design | `ui/styles.css`, `docs/DESIGN-NOTES.md` |
| tests / gates | test-harness | `test/client/**`, `scripts/check.mjs` |

Rules: plain ESM-style exports stripped by `scripts/build-client.mjs`; no new
dependencies; every visible string goes through the existing copy mechanism
(`t()` in app/graph, local bilingual deck in chat.js); light/dark and 360px must
keep working; reduced motion respected.

## 1. Graph node popover anchored to the node (lead, `ui/graph.js`)

Currently the node details card sits in a fixed corner. Clicking a node must
open it **next to that node**:

- Card keeps its existing content (title, summary, meta, sources, relations,
  actions) and classes; add modifier `.mru-graph__card--anchored` plus inline
  `left`/`top` (px) inside the graph container.
- Placement: prefer right of the node, then left; vertically centered and
  clamped to the graph viewport with an 8px gap. Flip placement near edges.
- Keep it inside the container, never over the zoom/status controls.
- Re-position on layout/pan/zoom/resize; close on outside click, Esc, close
  button, graph rebuild, or node deselect. Clicking another node replaces it.
- Pure exported helper for tests:
  `mruGraphAnchoredCardPosition({node, container, card, gap = 8, padding = 8})`
  → `{ left, top, placement: 'right'|'left' }`, finite and clamped.
- No markup/class removal from the old card: the library graph keeps using the
  same component (anchored mode only when a node is selected).

## 2. Resizable left rail and right margin, remembered (client-ui)

- Drag handles: `.mru-resizer` (modifiers `.mru-resizer--rail`,
  `.mru-resizer--margin`, state `.mru-resizer--active`), rendered between
  `.mru-rail` / `.mru-main` and `.mru-main` / `.mru-margin`; hidden while the
  corresponding side is collapsed or under 900px viewport.
- ARIA: `role="separator"`, `aria-orientation="vertical"`, `aria-label`
  (`layout.resizeRail` / `layout.resizeMargin`), `tabIndex=0`; ArrowLeft/
  ArrowRight adjust by 8px, double-click resets the default.
- Widths live on the workspace inline style as CSS variables
  `--mru-rail-width` and `--mru-margin-width` (px), applied by styles.css.
  Defaults 288 / 296; clamps 220–460 (rail) and 240–520 (margin).
- Persist in `localStorage['dsh-litnotes:layout']` as
  `{ railWidth, marginWidth, docWidth }` (numbers, unknown values ignored),
  debounced on pointerup; restore on mount before paint if possible.

## 3. Floating question navigator inside the AI panel (client-ui, `ui/chat.js`)

- A slim floating rail on the panel's right edge shows one mark per user
  question of the current document conversation
  (`.mru-ai__nav`, `.mru-ai__nav-mark`, current `.is-current`, hover/focus
  `.is-active`).
- Hover/focus a mark → small preview card (`.mru-ai__nav-preview`) with the
  question text (≤2 lines) and its ordinal; click → smooth-scroll that message
  into view and flash it; the current mark follows scroll position.
- While scrolled away from the bottom, show a floating “回到最新”
  (`.mru-ai__toLatest`) pill; clicking scrolls to the newest message.
- Hide the rail with fewer than 2 user questions; no layout shift; keyboard
  reachable (Tab + Enter); aria-labels bilingual in chat.js's own deck.
- App passes nothing new: the navigator lives entirely inside `MruAiPanel`.

## 4. Same width for reading and graph, adjustable reading width (client-ui + styles)

- New CSS variable `--mru-doc-width` (px, default **880**) sets the width of
  the reading sheet AND both graph views:
  - `.mru-paper` / `.mru-paper-scroll` center the sheet at `min(100%, var(--mru-doc-width))`;
  - `.mru-main--graph > .mru-graph` and `.mru-paper:has(.mru-paper__body--graph)`
    use the same variable (no separate 1040/1120 px widths).
- Adjustable: reader runhead gains a width control (`.mru-runhead__width` with
  label + `aria-pressed` presets 窄 720 / 标准 880 / 宽 1040 / 全宽 1200, or a
  small menu). Choice persists as `docWidth` in the layout storage above.
  The effective width is clamped to the available main column; switching
  阅读 ↔ 图谱 must not visibly change the column width (same max-width var).
- Keyboard: the control is a normal button/radiogroup; no drag required.

## 5. Aspect colour legend in several places (all three scopes)

Single source of truth for the copy (app `t()` keys, chat local deck, graph `t()`):

| colour | aspect(s) | zh label | en label |
|---|---|---|---|
| yellow | definition, context | 定义 / 背景 | definition / context |
| sage | method | 方法 | method |
| sky | result | 结果 | result |
| rose | limitation | 局限 | limitation |

- Markup: `.mru-aspect-legend` with `.mru-aspect-legend__item`,
  `.mru-aspect-legend__dot--definition|context|method|result|limitation`
  (dot reuses the annotation ink tokens), text label next to each dot —
  never colour alone. Optional `title`/`aria-label` with the long meaning.
- Placement (all four):
  1. margin 批注 tab header: persistent compact legend row under the tabs
     (`.mru-margin__legend`), also in the empty state;
  2. AI panel: under the citations footer / above the composer
     (`.mru-ai__legend`, rendered once per answer card is fine);
  3. reader runhead help: a 「图例」 button opening a small popover with the
     legend + one-line explanation;
  4. graph: legend footer under the type filters (`.mru-graph__aspect-legend`)
     and the aspect label already shown in the node card.
- app `t()` keys to add: `aspect.legendTitle`, `aspect.definition`,
  `aspect.context`, `aspect.method`, `aspect.result`, `aspect.limitation`,
  `aspect.legendHint`; chat deck: `legendTitle`/`legendHint` + the five labels;
  graph: `graph.aspectLegend`, `graph.aspectHint` (+ reuse type labels).

## 6. Acceptance (all owners)

- `node scripts/build-client.mjs` clean; no placeholder modules.
- `node scripts/check.mjs --require-client-ai` → 11/11 PASS.
- `node --test test/` green (new helpers have unit tests).
- Client harness (`test/client/**`) covers: resizer clamp/persist helpers,
  doc-width presets, chat nav mark mapping, anchored-card position, aspect
  legend presence in margin + AI panel.
- Live: reload the page, verify resize + memory, width consistency on
  阅读↔图谱, node popover near node, AI history marks, aspect legends in all
  four places; light/dark and 360px screenshots/behavior checked by design.
