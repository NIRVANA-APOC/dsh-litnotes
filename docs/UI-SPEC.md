# dsh-litnotes — UI/UX spec & class contract (authoritative)

Scenario: **English academic paper reading in Chinese**. The user imports a paper, MinerU
structures it, and the reading desk is where the real work happens: read the English original,
see a Chinese translation when needed, select a sentence to translate, highlight a claim, leave
a margin note. The agent can see the same library through the `mineru` tool.

Visual direction: **"页边" — a reading desk with a real margin.** The interface behaves like a
carefully set bilingual edition: the original (English) is set in a warm serif on paper; the
translator's voice (Chinese) is a quieter sans block; highlights and notes live in a true right
margin, not in a floating panel salad. One memorable element: the **margin rail** with its
outline ticks and annotation cards, plus the **selection card** that turns any sentence into a
translation without leaving the page. Everything else stays quiet.

The plugin is a guest in the Harness UI: it inherits the host theme tokens
(`--dsw-alias-*`), typography rhythm, and control shapes. Only the reading surface gets its
own "paper" treatment and annotation ink colors (artwork-level colors).

---

## 1. Design tokens

Defined on `.mru-root` in `ui/styles.css` (design owns these). Reading scale is set by
client-ui as an inline custom property on `.mru-root`: `--mru-read-scale` (0.9 / 1 / 1.12).

### Color (light; dark overrides under `body[data-ds-dark-theme] .mru-root`)

| token | value | use |
|---|---|---|
| `--mru-bg` | `var(--dsw-alias-bg-base)` | app background |
| `--mru-surface` | `var(--dsw-alias-bg-layer-1)` | rail, bars, cards |
| `--mru-surface-2` | `var(--dsw-alias-bg-layer-2)` | nested chips, inputs |
| `--mru-paper-bg` | `color-mix(in srgb, var(--dsw-alias-bg-layer-1) 93%, #c9b489 7%)` | reading paper |
| `--mru-paper-bg-dark` | `color-mix(in srgb, var(--dsw-alias-bg-layer-1) 92%, #000 8%)` | dark paper |
| `--mru-ink` | `var(--dsw-alias-label-primary)` | body text |
| `--mru-ink-soft` | `var(--dsw-alias-label-secondary)` | meta text |
| `--mru-rule` | `var(--dsw-alias-border-l1)` | hairlines |
| `--mru-rule-strong` | `var(--dsw-alias-border-l2)` | emphasized rules |
| `--mru-accent` | `var(--dsw-alias-brand-primary)` | primary actions, focus |
| `--mru-error` | `var(--dsw-alias-state-error-primary)` | errors |
| `--mru-warn` | `var(--dsw-alias-state-warn-primary)` | warnings |
| `--mru-success` | `var(--dsw-alias-state-success-primary)` | parsed state |
| `--mru-hl-yellow` | light `rgba(240,196,72,.36)` / dark `rgba(240,196,72,.20)` | annotation ink |
| `--mru-hl-sage` | light `rgba(126,168,124,.32)` / dark `rgba(126,168,124,.20)` | annotation ink |
| `--mru-hl-sky` | light `rgba(110,155,197,.30)` / dark `rgba(110,155,197,.20)` | annotation ink |
| `--mru-hl-rose` | light `rgba(201,123,139,.28)` / dark `rgba(201,123,139,.20)` | annotation ink |
| `--mru-hl-active` | `color-mix(in srgb, var(--mru-accent) 55%, transparent)` | active highlight outline |
| `--mru-shadow` | `0 1px 2px rgba(0,0,0,.04), 0 12px 32px -16px rgba(0,0,0,.18)` | popovers/modals |

### Type

| token | value |
|---|---|
| `--mru-font-ui` | `system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif` |
| `--mru-font-read` | `"Source Serif 4", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", "Noto Serif", "Songti SC", "SimSun", serif` |
| `--mru-font-trans` | `"Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif` |
| `--mru-font-mono` | `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace` |

Scale (px, fixed; the reader scales only with `--mru-read-scale`):
UI 12 / 13 / 14; article title `clamp(27px, 2.6vw, 34px)` serif 600; section h2 21px, h3 18px,
h4 16px (all serif 600); body `calc(17.5px * var(--mru-read-scale,1))` / 1.72; translation
`calc(15px * var(--mru-read-scale,1))` / 1.65; margin text 13px; status bar 11.5px.

Reading measure: `56ch` for body text (English), max paper column 760px; translations same
width. Article title line-height 1.16, letter-spacing -0.012em. Body paragraphs have no indent;
`margin: 0 0 1.05em`. Sections get `margin-top: 2.2em`, a small serif section number if present.

### Space / radius / motion

4px base grid; rail 288px; margin 296px; topbar 52px; statusbar 30px; paper padding 56px 60px
(desktop) / 28px 20px (mobile). Radii: 6px controls, 10px cards, 14px paper (subtle, not cards on
cards), 999px chips. Motion: one entry per document open — paper fades in with 6px rise over
180ms `cubic-bezier(.2,.7,.2,1)`; popovers scale from 0.98 + fade 120ms; all disabled under
`prefers-reduced-motion: reduce`. No ambient animation.

---

## 2. Layout

```
┌───────────────────────────────────────────────────────────────────────────┐
│ mru-topbar: mark + 文献库 + count            [导入文献 ▾] [rail] [margin][⚙]│
├──────────────┬────────────────────────────────────────────┬───────────────┤
│ mru-rail     │ mru-main (scroll)                          │ mru-margin     │
│  文献 · 12   │   ┌ sticky runhead: doc title … mode A-/A+ │  大纲 | 批注   │
│  [search]    │   ┌───────────────────────────────────┐    │  · 1 Intro     │
│  ▸ doc       │   │  mru-paper                        │    │  · 2 Method    │
│  ▸ doc       │   │   article title (serif)           │    │  ─────────     │
│  …           │   │   meta · rule                     │    │  note cards    │
│              │   │   body: paragraphs, figures,      │    │               │
│              │   │   tables, formulas, page marks    │    │               │
│              │   │   translation under paragraph     │    │               │
│              │   └───────────────────────────────────┘    │               │
├──────────────┴────────────────────────────────────────────┴───────────────┤
│ mru-statusbar: MinerU 精准解析 · vlm        15 页 · 6,240 词 · 已翻译 12%   │
└───────────────────────────────────────────────────────────────────────────┘
```

Alignment: the paper is centered in the center column; its text is left-aligned (English ragged
right, no justification). Rail and margin content are left-aligned, dense 13px UI text. Titles
are never centered except the empty state.

Status bar engine label: `MinerU 精准解析` (standard), `MinerU 轻量解析` (agent) or `本地解析`
(local); a local parse appends the provider (`· 内置` / `· Office 转换`).

Responsive:
- `> 1280px`: all three zones visible.
- `900–1280px`: margin hidden by default; the topbar `margin` toggle adds
  `.mru-root--margin-open`, showing the margin as an absolute right-side sheet (full height,
  `--mru-surface`, left border, shadow) above the paper.
- `< 900px`: rail hidden; topbar `rail` toggle adds `.mru-root--rail-open`, showing the rail as
  an absolute left drawer with a scrim `.mru-scrim`; paper padding shrinks; topbar brand name is
  hidden. `Escape` closes drawers and overlays.
- The reader never goes below `calc(15.5px * scale)` text size.

---

## 3. Component tree & class contract (authoritative)

Client-ui MUST use these class names verbatim; extra classes may be added but every listed
class must appear where specified. Design styles exactly these names. State is expressed with
modifier classes (`--active`, `--open`, …) and `data-*` attributes listed below.

### 3.1 Root

```
<div class="mru-root" data-status="idle|ready|error" style="--mru-read-scale: 1">
  <style>{CSS}</style>
  <div class="mru-topbar"> … </div>
  [<div class="mru-banner mru-banner--warn"> … </div>]        // host not ready / token hint
  <div class="mru-workspace">
    <aside class="mru-rail"> … </aside>
    <main class="mru-main"> … </main>
    [<aside class="mru-margin"> … </aside>]
  </div>
  <div class="mru-statusbar"> … </div>
  <div class="mru-scrim" />                                  // only when a drawer is open on mobile
  [<div class="mru-drop"> … </div>]                          // drag-over overlay
  <div class="mru-toasts"> … </div>
</div>
```

- Root modifier classes: `mru-root--rail-open`, `mru-root--margin-open`, `mru-root--dragging`.
- `data-status="error"` shows the recovery banner; `data-status="idle"` while the first
  status/list request is in flight (skeleton rows in rail, spinner in main).

### 3.2 Topbar

```
<div class="mru-topbar">
  <div class="mru-brand">
    <span class="mru-brand__mark" aria-hidden="true"><svg…/></span>   // sidebar icon, currentColor
    <span class="mru-brand__name">MinerU 文献库</span>
    <span class="mru-brand__count">12 篇</span>
  </div>
  <div class="mru-topbar__spacer"></div>
  <div class="mru-topbar__actions">
    <button class="mru-btn mru-btn--primary" data-action="import">导入文献</button>
    [<div class="mru-menu-wrap"><div class="mru-menu">…</div></div>]  // import dropdown
    <button class="mru-btn mru-btn--ghost mru-btn--icon mru-toggle-rail" aria-label="文献列表">…</button>
    <button class="mru-btn mru-btn--ghost mru-btn--icon mru-toggle-margin" aria-label="页边">…</button>
    <button class="mru-btn mru-btn--ghost mru-btn--icon" aria-label="设置">…</button>
  </div>
</div>
```
The rail/margin toggles are always rendered; CSS hides them where the zone is static
(`>1280px` hides `.mru-toggle-margin`, `>900px` hides `.mru-toggle-rail`).

### 3.3 Library rail

```
<aside class="mru-rail">
  <div class="mru-rail__head">
    <h2 class="mru-rail__title">文献</h2>
    <span class="mru-rail__count">12</span>
  </div>
  <div class="mru-search">
    <span class="mru-search__icon" aria-hidden="true">svg</span>
    <input class="mru-search__input" placeholder="搜索标题、文件名或批注" />
    <button class="mru-search__clear" aria-label="清除搜索">×</button>
  </div>
  <div class="mru-rail__list" role="list">
    <button class="mru-doc mru-doc--active" data-status="parsed" role="listitem">
      <span class="mru-doc__title">Attention Is All You Need</span>
      <span class="mru-doc__meta">PDF · 15 页 · vlm</span>
      <span class="mru-chip mru-chip--parsed">已解析</span>
      <span class="mru-doc__actions">
        <span class="mru-icon-btn" role="button" aria-label="更多">…</span>
      </span>
    </button>
    <div class="mru-doc-skeleton"></div>          // only while idling
  </div>
  <div class="mru-rail__empty">还没有文献。导入第一篇 PDF 开始。</div>
  <div class="mru-rail__foot">共 12 篇 · 已解析 9</div>
</aside>
```
- `mru-doc` is a `<button>`; `data-status` = `uploaded|parsing|parsed|failed`.
- Status text in `mru-chip`; chip modifiers: `mru-chip--uploaded`, `--parsing`, `--parsed`,
  `--failed`, and `mru-chip--plain` (keyword chips in meta).
- Parsing docs animate a 2px indeterminate strip inside the chip: `.mru-chip__pulse`.

### 3.4 Main / empty states

```
<main class="mru-main">
  <div class="mru-paper-scroll"> … </div>          // scroll container, owns scroll position
  [<div class="mru-empty"> … </div>]
</main>
```

Empty library (no documents at all):
```
<div class="mru-empty">
  <div class="mru-empty__art" aria-hidden="true">[inline SVG from ui/empty-art.svg]</div>
  <h1 class="mru-empty__title">把第一篇文献放进来</h1>
  <p class="mru-empty__text">PDF、Word、图片或网页都行。MinerU 把它们转成可翻译、可批注的阅读稿。</p>
  <div class="mru-empty__actions">
    <button class="mru-btn mru-btn--primary">选择文件</button>
    <button class="mru-btn mru-btn--ghost">从链接导入</button>
  </div>
  <p class="mru-empty__hint">也可以直接把文件拖进这个窗口</p>
</div>
```
No document selected (library non-empty): `.mru-empty mru-empty--quiet` with
`.mru-empty__title` = 「从左侧选一篇文献」 and no actions.

### 3.5 Paper & reader

```
<article class="mru-paper" key="{docId}">
  <header class="mru-paper__runhead">
    <div class="mru-paper__runhead-title">Attention Is All You Need</div>
    <div class="mru-paper__runhead-actions">
      <div class="mru-segmented" role="group" aria-label="阅读模式">
        <button class="mru-segmented__item mru-segmented__item--active">原文</button>
        <button class="mru-segmented__item">对照</button>
        <button class="mru-segmented__item">译文</button>
      </div>
      <button class="mru-btn mru-btn--ghost mru-btn--icon mru-font-dec" aria-label="缩小字号">A−</button>
      <button class="mru-btn mru-btn--ghost mru-btn--icon mru-font-inc" aria-label="放大字号">A+</button>
      <button class="mru-btn mru-btn--ghost mru-btn--icon mru-more" aria-label="更多操作">…</button>
    </div>
  </header>
  <div class="mru-paper__col">
    <h1 class="mru-paper__title">Attention Is All You Need</h1>
    <div class="mru-paper__meta">attention.pdf <span class="mru-dot">·</span> PDF
      <span class="mru-dot">·</span> 15 页 <span class="mru-dot">·</span> MinerU vlm
      <span class="mru-dot">·</span> 2026-11-06</div>
    <div class="mru-paper__rule"></div>
    <div class="mru-paper__body"> …blocks… </div>
  </div>
</article>
```

Reader block classes (client-reader supplies block model; client-ui renders):

Local parse result banner (inside the scrolling reader, above the paper body; dismissible):
```
<div class="mru-banner mru-banner--info mru-banner--inline mru-banner--local" role="status">
  <div class="mru-banner__body">
    <strong class="mru-banner__title">本地解析结果</strong>
    <span class="mru-banner__text">本文由本地解析生成：保留文字、段落与页码；公式、表格、图片未还原。[个别字体缺失…] [几乎没有提取到文字…]</span>
  </div>
  <div class="mru-banner__actions">
    <button class="mru-btn mru-btn--ghost mru-btn--sm">配置 Token 解锁精准解析</button>
    <button class="mru-btn mru-btn--ghost mru-btn--sm">重新解析</button>
    <button class="mru-icon-btn" aria-label="关闭">×</button>
  </div>
</div>
```
It renders only when `doc.parse.engine==='local'`; `banner.missingFonts` / `banner.scanned` are
appended when `parse.local.warnings` contains `missing-fonts` / `scanned`. Other block classes:

| block | markup |
|---|---|
| heading | `<div class="mru-block mru-block--h1" data-block-key="b3:ab12cd"><h2 class="mru-h mru-h--1">…</h2></div>` (h1→`mru-h--1`…`mru-h--4`; article title itself is not a block) |
| paragraph | `<div class="mru-block mru-block--p" data-block-key="…"><p class="mru-para__text">…</p>[<div class="mru-para__translation">…</div>]</div>` |
| list | `<div class="mru-block mru-block--list" data-block-key="…"><ul class="mru-list"><li class="mru-list__item">…</li></ul>[translation]</div>` (ordered adds `mru-list--ordered`, `<ol>`) |
| quote | `<blockquote class="mru-block mru-block--quote">…</blockquote>` (inner `<p class="mru-para__text">`) |
| code | `<div class="mru-block mru-block--code"><pre class="mru-code"><code>…</code></pre></div>` |
| formula (block) | `<div class="mru-block mru-block--formula"><div class="mru-formula" data-latex="…">…katex…</div></div>` |
| figure | `<figure class="mru-block mru-block--figure"><span class="mru-figure__img-wrap"><img class="mru-figure__img" loading="lazy" src="…"></span><figcaption class="mru-figure__caption">…</figcaption></figure>` |
| table | `<div class="mru-block mru-block--table"><div class="mru-table-wrap"><table class="mru-table">…</table></div><div class="mru-table__caption">…</div></div>` |
| page mark | `<div class="mru-pagemark" data-page="3"><span class="mru-pagemark__label">3</span></div>` |

`appendPageMarks(model, contentList)` keeps every original block's `index`/`key` unchanged and gives inserted page blocks synthetic keys (`page:<n>:<at>`); toggling page marks therefore never invalidates annotation anchors. `block.key` is the only anchor; `block.index` is not the array position.
| rule | `<hr class="mru-hr">` |

Inline: highlights are `<mark class="mru-hl mru-hl--yellow" data-annotation-id="…" role="mark">…</mark>`;
active/pulsed highlight adds `mru-hl--active`. Inline code `mru-inline-code`; formula
`<span class="mru-formula mru-formula--inline" data-latex="…">`; links `mru-link`; citation-ish
brackets area inline text stays plain.

Per-block hover tools (paragraph/list/blocks with text):
`<div class="mru-block__tools"><button class="mru-icon-btn mru-block__translate" aria-label="翻译本段">…</button><button class="mru-icon-btn mru-block__annotate" aria-label="高亮并批注">…</button></div>`
Absolutely positioned at the block's right edge, revealed on `:hover`/`:focus-within`.

Parse setup (document not yet parsed, or reparsing):
```
<section class="mru-setup">
  <div class="mru-setup__intro">
    <h2 class="mru-setup__title">准备解析</h2>
    <p class="mru-setup__text">MinerU 会识别版式、公式和表格，把文件转成可翻译、可批注的结构化阅读稿。</p>
  </div>
  [<div class="mru-callout mru-callout--warn">配置 Token 可解锁 MinerU 精准解析（公式/表格/OCR）。本地解析无需 Token，文件不会上传。<button class="mru-link-btn">去设置</button></div>]
  <div class="mru-setup__grid">
    <div class="mru-field"><label class="mru-field__label">解析引擎</label>
      <select class="mru-select">
        <option value="auto">自动（有 Token 用精准解析，否则优先本地）</option>
        <option value="standard">精准解析</option>
        <option value="local">本地解析（离线 · 不上传）</option>
        <option value="agent">轻量云端解析（免 Token · 会上传文件）</option>
      </select>
      [<span class="mru-field__hint mru-field__hint--warn">本地解析不可用：{reason}</span>]
    </div>
    … model / language / page ranges …
  </div>
  <div class="mru-setup__toggles">
    <label class="mru-toggle-row"><span class="mru-toggle-row__text"><span class="mru-toggle-row__title">公式识别</span><span class="mru-toggle-row__hint">保留 LaTeX 公式</span></span><span class="mru-switch mru-switch--on" role="switch" aria-checked="true"></span></label>
    … OCR / 表格 (disabled while the local engine is selected) …
  </div>
  <div class="mru-setup__foot">
    <button class="mru-btn mru-btn--primary">开始解析</button>
    <span class="mru-setup__effective">将使用：本地解析</span>
    <span class="mru-note-text">本地解析只提取文字层，保留段落与页码；公式、表格、图片与扫描件需云端精准解析。文件不会上传。</span>
  </div>
</section>
```

Engine select order is `auto, standard, local, agent`. When the current file cannot be parsed
locally (`capabilities` / extension; `enabled:false` or no parser), the `local` option is
`disabled` and renders 「本地解析（离线 · 不上传） — 本地解析不可用」 plus
`本地解析不可用：{reason}` (`setup.localReasonDisabled` / `localReasonUnavailable` /
`localReasonType`). The `mru-setup__effective` hint mirrors the host `auto` policy
(将使用：MinerU 精准解析 / 本地解析 / 轻量云端解析（文件会上传） / 没有可用引擎…), and the
foot note switches to `setup.noteLocal` while `local` is selected. `modelVersion`, `language`,
OCR/formula/table controls are disabled for `local` (and `modelVersion` for `agent`).

Parsing state (replaces setup when `status==='parsing'`):
```
<div class="mru-parsing">
  <div class="mru-parsing__row"><span class="mru-spinner" aria-hidden="true"></span>
    <span class="mru-parsing__text">MinerU 正在解析 · 3 / 15 页</span>
    <span class="mru-parsing__elapsed">已用时 1:24</span>
    <button class="mru-btn mru-btn--ghost mru-btn--sm">取消</button></div>
  <div class="mru-progress"><div class="mru-progress__fill" style="width:20%"></div></div>
  [<p class="mru-parsing__hint">pipeline 模型或 OCR 解析较慢…</p>]
</div>
```

MinerU only reports page progress while the upstream task is `running`; the pipeline model and
OCR often report `extracted_pages: 0` for the whole queue/warm-up phase. While no page has been
extracted yet the panel must **not** show a determinate 0 % bar: it names the upstream phase
(`parsing.phaseWaiting` / `parsing.phaseQueued` / `parsing.phaseRunning` /
`parsing.phaseConverting`), ticks `.mru-parsing__elapsed` every second, and renders
`.mru-progress--indeterminate` (a moving 36 % fill) instead of a frozen bar. `.mru-parsing__hint`
appears for `modelVersion==='pipeline'` or OCR parses.

When an already-parsed document is reparsed or page-repaired, the reading desk keeps showing the
old paper and renders the same panel inline above it — `.mru-parsing.mru-parsing--inline`
(680 px max width, bottom margin) — with the same phase/elapsed/indeterminate behaviour, so the
long upstream wait never looks like a dead UI.

Failed state: `.mru-fail` with `.mru-fail__title` 「解析没有完成」, `.mru-fail__text` (host
message), `.mru-fail__actions` [重试] [换个引擎]. `mru-btn--primary` retry.

### 3.6 Margin column

```
<aside class="mru-margin">
  <div class="mru-margin__tabs" role="tablist">
    <button class="mru-tab mru-tab--active" role="tab" aria-selected="true">大纲</button>
    <button class="mru-tab" role="tab">批注<span class="mru-tab__count">3</span></button>
  </div>
  <div class="mru-margin__body">
    <nav class="mru-outline">
      <button class="mru-outline__item mru-outline__item--l2">1 Introduction</button>
      <button class="mru-outline__item mru-outline__item--l3 mru-outline__item--active">1.1 Background</button>
    </nav>
    <div class="mru-notes">
      <article class="mru-note">
        <div class="mru-note__head">
          <span class="mru-note__swatch" data-color="yellow"></span>
          <span class="mru-note__time">今天 14:20</span>
          <button class="mru-icon-btn mru-note__delete" aria-label="删除批注">…</button>
        </div>
        <blockquote class="mru-note__quote">…highlighted text…</blockquote>
        <p class="mru-note__body">…note…</p>
      </article>
      <div class="mru-margin__empty">选中正文后，可以高亮或写下批注。</div>
    </div>
  </div>
</aside>
```

### 3.7 Selection tools (overlays, fixed-position)

```
<div class="mru-selbar" role="toolbar" aria-label="划词工具" style="left:…;top:…">
  <button class="mru-selbar__btn mru-selbar__btn--primary">翻译</button>
  <span class="mru-selbar__sep"></span>
  <span class="mru-swatches" role="group" aria-label="高亮颜色">
    <button class="mru-swatch mru-swatch--yellow" data-color="yellow" aria-label="黄色高亮"></button>
    … sage / sky / rose …
  </span>
  <button class="mru-selbar__btn">批注</button>
  <button class="mru-selbar__btn">复制</button>
</div>

<div class="mru-selcard" style="left:…;top:…">
  <div class="mru-selcard__head"><span class="mru-selcard__label">划词翻译</span>
    <button class="mru-icon-btn" aria-label="关闭">×</button></div>
  <p class="mru-selcard__src">selected sentence…</p>
  <div class="mru-selcard__body">
    [<span class="mru-spinner"></span>]
    [<p class="mru-selcard__text">译文…</p>]
    [<p class="mru-selcard__error">翻译暂时不可用。<button class="mru-link-btn">重试</button></p>]
  </div>
  <div class="mru-selcard__foot"><span class="mru-selcard__provider">Google</span>
    <button class="mru-btn mru-btn--ghost mru-btn--sm">复制译文</button></div>
</div>

<div class="mru-noteeditor" style="left:…;top:…">
  <blockquote class="mru-noteeditor__quote">…</blockquote>
  <textarea class="mru-textarea mru-noteeditor__input" placeholder="写点批注…"></textarea>
  <div class="mru-noteeditor__foot">
    <span class="mru-swatches">…mru-swatch…</span>
    <button class="mru-btn mru-btn--ghost mru-btn--sm">取消</button>
    <button class="mru-btn mru-btn--primary mru-btn--sm">保存</button>
  </div>
</div>
```
The selection bar and cards are `position: fixed`, clamped to the viewport with 12px margins,
and close on Escape / outside pointerdown / scroll of the reader.

### 3.8 Menus, modals, dialogs

```
<div class="mru-menu" role="menu">
  <button class="mru-menu__item" role="menuitem">重新解析</button>
  <button class="mru-menu__item" role="menuitem">导出 Markdown</button>
  <div class="mru-menu__sep"></div>
  <button class="mru-menu__item mru-menu__item--danger" role="menuitem">删除文献</button>
</div>

<div class="mru-modal" role="dialog" aria-modal="true" aria-labelledby="…">
  <div class="mru-modal__mask"></div>
  <div class="mru-modal__panel mru-modal__panel--settings">
    <header class="mru-modal__head"><h2 class="mru-modal__title">设置</h2>
      <button class="mru-icon-btn" aria-label="关闭">×</button></header>
    <div class="mru-modal__body">
      <section class="mru-section">
        <h3 class="mru-section__title">MinerU 接入</h3>
        <p class="mru-section__desc">本地解析无需 Token；配置 Token 可解锁 MinerU 精准解析（公式/表格/OCR）。</p>
        <div class="mru-field"><label class="mru-field__label">API Token</label>
          <div class="mru-field__row">
            <input class="mru-input" type="password" placeholder="粘贴 Token" />
            <button class="mru-btn mru-btn--ghost mru-btn--sm">保存</button>
            <button class="mru-btn mru-btn--ghost mru-btn--sm mru-btn--danger">清除</button>
          </div>
          <span class="mru-field__hint mru-field__hint--ok">已配置 · 保存在本机凭据中</span>
          [<span class="mru-field__hint">当前默认将使用本地解析（文件不会上传）</span>]
        </div>
      </section>
      <section class="mru-section">
        <div class="mru-section__head"><h3 class="mru-section__title">本地解析</h3>
          <button class="mru-btn mru-btn--ghost mru-btn--sm">重新检测</button></div>
        <p class="mru-section__desc">本地解析不上传文件；扫描件需云端解析或 OCR 侧车。</p>
        <div class="mru-local-list">
          <div class="mru-local-row"><span class="mru-local-row__name">内置文字层提取</span>
            <span class="mru-local-row__state mru-local-row__state--ok">可用</span>
            <span class="mru-local-row__version">pdfjs-dist/5.4.449</span></div>
          <div class="mru-local-row"><span class="mru-local-row__name">Office 转换（office-to-pdf）</span>
            <span class="mru-local-row__state">不可用</span></div>
        </div>
      </section>
      <section class="mru-section"> … 阅读偏好: 目标语言 / 翻译服务 / 显示页面标记 … </section>
      <section class="mru-section"> … 存储: 数据目录 · 版本 … </section>
    </div>
    <footer class="mru-modal__foot">
      <button class="mru-btn mru-btn--ghost">关闭</button>
    </footer>
  </div>
</div>
```

Delete confirmation uses the same modal shell: `.mru-modal__panel--confirm` with
`.mru-confirm__title` / `.mru-confirm__text` / `.mru-confirm__actions`.

Import-by-URL modal: `.mru-modal__panel--import` with `.mru-input mru-input--url` and a hint
「支持 PDF、Word、图片与网页链接」.

### 3.9 Toasts & misc

```
<div class="mru-toasts">
  <div class="mru-toast mru-toast--error" role="status">
    <span class="mru-toast__text">上传失败：文件超过 200 MB</span>
    <button class="mru-toast__close" aria-label="关闭">×</button>
  </div>
</div>
<div class="mru-drop"><div class="mru-drop__card"><strong class="mru-drop__title">松开即可导入</strong>
  <span class="mru-drop__text">PDF · Word · 图片 · HTML</span></div></div>
```
Utilities: `.mru-dot` (middle dot separator, but content is a real `<span>·</span>`),
`.mru-spinner` (1em border spinner), `.mru-sr-only`, `.mru-kbd`, `.mru-link-btn`,
`.mru-note-text`, `.mru-hr`, `.mru-setup__effective` (effective-engine hint).
Skeleton surfaces: `.mru-doc-skeleton`, `.mru-line-skeleton`.
Local parsing: `.mru-banner--local` (info banner variant, see §3.5), `.mru-local-list`,
`.mru-local-row`, `.mru-local-row__name`, `.mru-local-row__state`
(`--ok` = available), `.mru-local-row__version` (settings capability rows).

---

## 4. Interactions (behaviour client-ui must implement)

1. **Import**: primary button opens a menu (上传文件 / 从链接导入). File input multiple, accept
   `.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.png,.jpg,.jpeg,.jp2,.webp,.gif,.bmp,.html,.htm`.
   Drag & drop anywhere on the app adds `.mru-root--dragging` + `.mru-drop`; drop imports.
   Upload progress is a determinate bar inside the new rail row's chip when XHR reports it.
2. **Open**: selecting a doc loads `library.get` (+ `document.markdown` when parsed); the paper
   re-mounts with the entry animation and scrolls to top. Unparsed docs show the setup panel.
3. **Parse**: start → optimistic status `parsing`, poll list every 2.5s while any parsing; when
   done the doc auto-opens with the parsed body. Failure keeps the setup panel with the error and
   a 「换用云端解析或配置 Token」 hint for local failures. Engine selection is
   `auto|standard|local|agent`; `local` is disabled when the host `local` snapshot / extension
   says it is unsupported, and the effective-engine hint mirrors the host `auto` policy
   (token → precise; else local when supported; else lightweight cloud with upload; else no
   engine). Local parses never upload; a parsed local document is shown with the local-result
   banner (§3.5) and only offers whole-document reparse.
4. **Reading modes**: 原文 hides translations; 对照 shows `.mru-para__translation` under blocks;
   译文 shows only translation blocks (`.mru-paper--translated` styles originals as `.mru-para__text--muted`
   small above translation? Keep simple: 译文 mode renders translation as the primary body and
   hides the original text visually (`display:none` for `.mru-para__text` within translated mode),
   but headings stay in original language with translation below when available).
   Mode is persisted in preferences (`readingMode`).
5. **Paragraph translation**: hovering a paragraph shows the block tools; 「翻译本段」 opens a
   floating translation slip (`.mru-selcard.mru-selcard--block`) anchored to the button — it
   shows a spinner while the request runs, the translation when it lands, retry on failure and
   a copy action, and it never changes the reading mode. An already-translated paragraph opens
   the same card instantly. "Translate all" fills translations per block for 对照/译文 modes;
   failed blocks show a retry affordance. Translated text is rendered as rich content (inline
   markdown + KaTeX for `$…$` formulas), never as raw plain text.
6. **Selection**: after a text selection inside `.mru-paper__body` (non-empty, ≤ 2000 chars),
   compute `{blockKey, start, end, quote}`; show `.mru-selbar`. Translate shows `.mru-selcard`.
   Highlight swatch saves immediately and shows a toast. 批注 opens `.mru-noteeditor`; saving
   creates a highlight + note.
7. **Highlights**: click a `<mark>` opens the note editor for that annotation (edit note /
   change color / delete). Clicking a margin note scrolls to the mark and applies
   `mru-hl--active` for 1.6s. Offsets are clamped to block text length on load; annotations whose
   `blockKey` is missing after a reparse are dropped with a quiet note in the margin
   (`.mru-margin__notice`).
8. **Search**: filter rail by title/originalName; empty result `.mru-rail__empty`.
9. **Settings**: token save/clear (never displays the token), reading preferences, show page marks,
   reading scale, and a 「本地解析」 capability section (built-in text-layer extraction + Office
   conversion rows with 可用/不可用/version; 「重新检测」 re-reads `settings.get`). Save persists
   via `settings.update` + token endpoints; failures toast and keep the form open.
10. **Keyboard**: `Escape` closes overlays; `Cmd/Ctrl+F` focuses search (prevent default only
    inside the plugin); `Cmd/Ctrl+Enter` starts parse when the setup panel is visible; arrow
    navigation in the rail list works because rows are buttons.
11. **Loading**: first load shows rail skeletons; document body shows a centered `.mru-spinner`
    with 「正在载入解析稿…」 only after 400ms delay to avoid flashing.
12. **Knowledge graph canvas**: the graph view is an infinite canvas. Drag empty space to pan
    (unbounded), scroll to zoom anchored at the cursor (the `+`/`−` buttons zoom about the
    canvas centre), drag a node anywhere — nodes may leave the seeded layout sheet and linked
    neighbours follow — and press 「适应视图」/Fit view (or `0`) to fit the whole map again.
    The SVG viewBox mirrors the measured canvas, so no fixed drawing window clips the map; the
    dot-grid graph paper pans/zooms with the camera. Opening a graph and switching
    document/library starts fitted; filters and cluster collapse keep the camera unless the
    relayout leaves the visible map out of view (then it re-fits); resizing the panel re-fits an
    untouched camera, while an already navigated camera keeps its centre point anchored.

## 5. Copy deck (zh primary / en fallback)

Keys live in the client dictionary; strings are exactly as below (sentence case, no exclamation).

| key | zh | en |
|---|---|---|
| panel.label | 文献库 | Literature |
| brand.name | MinerU 文献库 | MinerU Library |
| topbar.import | 导入文献 | Import |
| topbar.upload | 上传文件 | Upload file |
| topbar.fromUrl | 从链接导入 | Import from URL |
| rail.title | 文献 | Library |
| rail.search | 搜索标题、文件名或批注 | Search title, file, or notes |
| rail.empty | 还没有文献。导入第一篇 PDF 开始。 | No papers yet. Import your first PDF. |
| rail.foot | 共 {count} 篇 · 已解析 {parsed} | {count} papers · {parsed} parsed |
| status.uploaded | 待解析 | Ready to parse |
| status.parsing | 解析中 | Parsing |
| status.parsed | 已解析 | Parsed |
| status.failed | 解析失败 | Parse failed |
| empty.title | 把第一篇文献放进来 | Bring in your first paper |
| empty.text | PDF、Word、图片或网页都行。MinerU 把它们转成可翻译、可批注的阅读稿。 | PDFs, Word files, images, or pages. MinerU turns them into a readable, annotatable draft. |
| empty.choose | 选择文件 | Choose file |
| empty.hint | 也可以直接把文件拖进这个窗口 | Or drop files anywhere in this window |
| empty.select | 从左侧选一篇文献 | Pick a paper from the library |
| setup.title | 准备解析 | Ready to parse |
| setup.text | MinerU 会识别版式、公式和表格，把文件转成可翻译、可批注的结构化阅读稿。 | MinerU detects layout, formulas, and tables, then turns the file into a structured reading draft. |
| setup.engine | 解析引擎 | Engine |
| setup.engineAuto | 自动（有 Token 用精准解析，否则优先本地） | Auto (precise with a token, local first otherwise) |
| setup.engineStandard | 精准解析 | Precise |
| setup.engineLocal | 本地解析（离线 · 不上传） | Local (offline, no upload) |
| setup.engineLocalUnavailable | 本地解析不可用 | Local parsing unavailable |
| setup.engineLocalWhy | 本地解析不可用：{reason} | Local parsing unavailable: {reason} |
| setup.localReasonDisabled | 已在配置中关闭 | disabled in the configuration |
| setup.localReasonUnavailable | 本机没有可用的本地解析器 | no local parser on this machine |
| setup.localReasonType | 这种文件类型不支持本地解析 | this file type cannot be parsed locally |
| setup.engineAgent | 轻量云端解析（免 Token · 会上传文件） | Lightweight cloud (no token, uploads the file) |
| setup.model | 模型 | Model |
| setup.language | 文档语言 | Document language |
| setup.pageRanges | 页码范围 | Page range |
| setup.pageRangesHint | 留空解析全部，例如 2,4-6 | Leave empty for all, e.g. 2,4-6 |
| setup.formula | 公式识别 | Formula recognition |
| setup.formulaHint | 保留 LaTeX 公式 | Keep LaTeX formulas |
| setup.table | 表格识别 | Table recognition |
| setup.tableHint | 还原表格结构 | Rebuild table structure |
| setup.ocr | OCR | OCR |
| setup.ocrHint | 扫描件建议开启 | Turn on for scanned pages |
| setup.start | 开始解析 | Start parsing |
| setup.note | 精准解析消耗每日解析额度；轻量解析限 10 MB / 20 页。 | Precise parsing uses the daily quota; lightweight parsing is limited to 10 MB / 20 pages. |
| setup.noteLocal | 本地解析只提取文字层，保留段落与页码；公式、表格、图片与扫描件需云端精准解析。文件不会上传。 | Local parsing extracts the text layer and keeps paragraphs and page marks; formulas, tables, figures and scanned pages need precise cloud parsing. The file is not uploaded. |
| setup.tokenWarn | 精准解析需要 MinerU Token。 | Precise parsing needs a MinerU token. |
| setup.tokenWarnLocal | 配置 Token 可解锁 MinerU 精准解析（公式/表格/OCR）。 | A token unlocks MinerU precise parsing (formulas/tables/OCR). |
| setup.tokenWarnPrivacy | 本地解析无需 Token，文件不会上传。 | Local parsing needs no token and never uploads the file. |
| setup.effectiveStandard | 将使用：MinerU 精准解析 | Will use: MinerU precise parsing |
| setup.effectiveLocal | 将使用：本地解析 | Will use: local parsing |
| setup.effectiveAgent | 将使用：轻量云端解析（文件会上传） | Will use: lightweight cloud parsing (the file is uploaded) |
| setup.effectiveBlocked | 将使用：没有可用引擎，请先配置 Token 或启用轻量云端解析 | Will use: no engine available — configure a token or allow lightweight cloud parsing |
| setup.tokenAction | 去设置 | Open settings |
| parsing.text | MinerU 正在解析 · {done} / {total} 页 | MinerU is parsing · {done} / {total} pages |
| parsing.textNoProgress | MinerU 正在解析… | MinerU is parsing… |
| parsing.phaseWaiting | 等待 MinerU 接收文件… | Waiting for MinerU to receive the file… |
| parsing.phaseQueued | MinerU 排队中… | Queued at MinerU… |
| parsing.phaseRunning | MinerU 正在解析… | MinerU is parsing… |
| parsing.phaseConverting | 正在生成解析结果… | Preparing the parsed result… |
| parsing.elapsed | 已用时 {time} | Elapsed {time} |
| parsing.slowHint | pipeline 模型或 OCR 解析较慢（MinerU 侧可能排队数分钟）；完成后会自动进入阅读。 | The pipeline model and OCR are slower on MinerU (queueing can take minutes); the paper opens automatically when done. |
| parsing.cancel | 取消 | Cancel |
| fail.title | 解析没有完成 | Parsing didn't finish |
| fail.retry | 重试 | Retry |
| fail.otherEngine | 换个引擎 | Try another engine |
| fail.localSuggestion | 换用云端解析或配置 Token | Try cloud parsing or configure a token |
| reader.modeOriginal | 原文 | Original |
| reader.modeBilingual | 对照 | Bilingual |
| reader.modeTranslated | 译文 | Translation |
| reader.translateAll | 翻译全文 | Translate all |
| reader.translateBlock | 翻译本段 | Translate this paragraph |
| reader.retryBlock | 重试 | Retry |
| reader.loading | 正在载入解析稿… | Loading the parsed draft… |
| reader.copy | 复制 | Copy |
| reader.more | 更多操作 | More |
| banner.localTitle | 本地解析结果 | Local parse result |
| banner.localText | 本文由本地解析生成：保留文字、段落与页码；公式、表格、图片未还原。 | Parsed locally: text, paragraphs and page marks are kept; formulas, tables and figures are not reconstructed. |
| banner.missingFonts | 个别字体缺失，文字可能有缺字。 | Some fonts were missing; a few characters may be absent. |
| banner.scanned | 几乎没有提取到文字，可能是扫描件。 | Little or no text was extracted; the file may be scanned. |
| banner.upgrade | 配置 Token 解锁精准解析 | Configure a token for precise parsing |
| margin.outline | 大纲 | Outline |
| margin.notes | 批注 | Notes |
| margin.empty | 选中正文后，可以高亮或写下批注。 | Select text to highlight it or leave a note. |
| margin.noteDelete | 删除批注 | Delete note |
| sel.translate | 翻译 | Translate |
| sel.highlight | 高亮 | Highlight |
| sel.note | 批注 | Note |
| sel.copy | 复制 | Copy |
| selcard.label | 划词翻译 | Selection |
| selcard.copy | 复制译文 | Copy translation |
| reader.translating | 翻译中… | Translating… |
| selcard.error | 翻译暂时不可用。 | Translation is unavailable. |
| noteeditor.placeholder | 写点批注… | Add a note… |
| noteeditor.save | 保存 | Save |
| noteeditor.cancel | 取消 | Cancel |
| settings.title | 设置 | Settings |
| settings.sectionToken | MinerU 接入 | MinerU access |
| settings.token | API Token | API token |
| settings.tokenHint | 本地解析无需 Token；配置 Token 可解锁 MinerU 精准解析（公式/表格/OCR）。 | Local parsing needs no token; configure a token to unlock MinerU precise parsing (formulas/tables/OCR). |
| settings.tokenPlaceholder | 粘贴 Token | Paste token |
| settings.tokenSaved | 已配置 · 保存在本机凭据中 | Configured · stored in local credentials |
| settings.tokenMissing | 未配置 | Not configured |
| settings.tokenMissingLocal | 当前默认将使用本地解析（文件不会上传） | Current default: local parsing (the file is not uploaded) |
| settings.save | 保存 | Save |
| settings.clear | 清除 | Clear |
| settings.close | 关闭 | Close |
| settings.sectionLocal | 本地解析 | Local parsing |
| settings.localBuiltin | 内置文字层提取 | Built-in text-layer extraction |
| settings.localPdfTool | 系统 pdftotext | System pdftotext |
| settings.localOffice | Office 转换（office-to-pdf） | Office conversion (office-to-pdf) |
| settings.localRedetect | 重新检测 | Re-detect |
| settings.localAvailable | 可用 | Available |
| settings.localUnavailable | 不可用 | Unavailable |
| settings.localHint | 本地解析不上传文件；扫描件需云端解析或 OCR 侧车。 | Local parsing does not upload files; scanned pages need cloud parsing or an OCR sidecar. |
| settings.sectionRead | 阅读偏好 | Reading |
| settings.targetLang | 目标语言 | Target language |
| settings.provider | 翻译服务 | Translation service |
| settings.providerAuto | 自动 | Auto |
| settings.pageMarks | 显示页面标记 | Show page marks |
| settings.sectionStorage | 存储 | Storage |
| settings.dataDir | 数据目录 | Data directory |
| menu.reparse | 重新解析 | Reparse |
| menu.export | 导出 Markdown | Export Markdown |
| menu.delete | 删除文献 | Delete paper |
| menu.translateAll | 翻译全文 | Translate whole paper |
| reparse.localRepair | 本地解析不支持按页修复；可整篇重新解析，或配置 Token 后整篇用云端解析。 | Page repair is unavailable for local parses; reparse the whole document, or configure a token and reparse in the cloud. |
| confirm.deleteTitle | 删除这篇文献？ | Delete this paper? |
| confirm.deleteText | 原文、解析稿、高亮和批注都会一起删除，无法恢复。 | The source, parsed draft, highlights, and notes are removed permanently. |
| confirm.delete | 删除 | Delete |
| confirm.cancel | 取消 | Cancel |
| toast.uploaded | 已导入「{name}」 | Imported "{name}" |
| toast.parsed | 解析完成：{title} | Parsed: {title} |
| toast.parseFailed | 解析失败：{message} | Parse failed: {message} |
| toast.saved | 已保存 | Saved |
| toast.copied | 已复制 | Copied |
| toast.highlighted | 已高亮 | Highlighted |
| toast.noteSaved | 批注已保存 | Note saved |
| toast.deleted | 已删除 | Deleted |
| toast.exported | 已导出 Markdown | Markdown exported |
| drop.title | 松开即可导入 | Drop to import |
| drop.text | PDF · Word · 图片 · HTML | PDF · Word · images · HTML |
| err.hostUnavailable | 文献服务还没就绪，正在重试… | The library service is not ready yet — retrying… |
| err.network | 网络请求失败，请稍后再试。 | The request failed. Try again. |
| err.tokenMissing | 需要先在设置里填写 MinerU Token。 | Add a MinerU token in settings first. |
| err.fileTooLarge | 文件超过 {limit} MB，无法上传。 | The file exceeds {limit} MB. |
| err.unsupported | 暂不支持这种文件类型。 | This file type is not supported. |
| err.noTranslation | 翻译服务不可用，无法生成译文。 | No translation service is available. |
| err.localUnsupported | 本地解析不支持这种文件；可用轻量云端解析或配置 Token。 | Local parsing does not support this file; use lightweight cloud parsing or configure a token. |
| err.localMissingTool | 本地解析工具不可用；请检查系统工具或改用云端解析。 | The local parsing tool is unavailable; check system tools or use cloud parsing. |
| err.localEmptyText | 没有从文件中提取到文字（可能是扫描件）；请用云端解析或配置 OCR。 | No text was extracted (the file may be scanned); use cloud parsing or configure OCR. |
| err.localEncrypted | PDF 已加密，无法本地解析；请去除密码后重试，或改用云端解析。 | The PDF is encrypted and cannot be parsed locally; remove the password or use cloud parsing. |
| err.localFailed | 本地解析失败：{message} | Local parsing failed: {message} |
| statusbar.engineStandard | MinerU 精准解析 | MinerU precise |
| statusbar.engineAgent | MinerU 轻量解析 | MinerU lightweight |
| statusbar.engineLocal | 本地解析 | Local |
| statusbar.providerBuiltin | 内置 | built-in |
| statusbar.providerOffice | Office 转换 | Office conversion |

Locale fallback: if the harness locale is not `zh` use `en`. Add `locale` namespace id
`dsh-litnotes`.

## 6. Accessibility & quality floor

- Every interactive element is a real `<button>`/`<input>`/`<select>`/`<textarea>`; icon buttons
  carry `aria-label`; the active rail row uses `aria-current="page"`.
- Focus visible: 2px `--mru-accent` ring with 2px offset on all controls.
- Contrast: body ink on paper and margin text meet 4.5:1 in both themes; highlights keep text
  color unchanged and use translucency only.
- Selection toolbar reachable by keyboard (after a keyboard selection it appears and focuses
  itself); Escape closes it.
- `prefers-reduced-motion` disables the paper entry, popover scale, and pulse animations.
- No horizontal scroll on the reading column at 360px width; long URLs/strings break with
  `overflow-wrap:anywhere`; tables scroll horizontally inside `.mru-table-wrap`.
- Dark theme: overrides only the paper tint, highlight inks, hover fills; all other colors come
  from `--dsw-alias-*`.

## 7. Division of work

- **design** owns `ui/styles.css`, `ui/panel-icon.svg`, `ui/empty-art.svg`, `icon.svg`.
  It styles the classes above and nothing else; if client-ui needs a class that is missing, the
  Lead coordinates an addition.
- **client-ui** owns `ui/app.js`: component tree, class names as specified, state, API calls,
  i18n dictionaries, KaTeX loading, diagnostics pings. No CSS (beyond the `CSS` placeholder).
- **client-reader** owns `ui/markdown.js` / `ui/highlight.js` (pure), whose block model is
  rendered by client-ui with the exact classes above.
- Design must also deliver a short `docs/DESIGN-NOTES.md` (concept, tokens, choices, dark-mode
  notes, anything intentionally left out).
