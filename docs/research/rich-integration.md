# 本地引擎富内容（公式 / 表格 / 图片）契约与插件集成方案

> 角色：集成设计者（integration-architect）。范围：**只做设计与契约 spike**，不改产品代码/测试/其他文档、不 commit。
> 工作仓库：`/home/nirvana/Documents/dsh-mineru`（**研究基线 `b1a68be`**；复核时 main HEAD 已到 `0cda21a`，本文 file:line 采集于 b1a68be、可能漂移——引用以函数/符号名为准；fixtures 来自用户本地库中公开论文）。
> 真值 fixtures（只读）：`.agents/tmp-research/lead/rich/{bee-full.md,bee-content_list.json,bee.pdf,attention.pdf,acl.pdf}`。
> 本 spike 产物：`.agents/tmp-research/rich-integration/{contract-spike.mjs,spike-output.json,spike-output.txt}`。
> 并行研究：图片/表格/公式算法见 `docs/research/rich-images.md` / `rich-tables.md` / `rich-formulas.md`（若已产出，算法结论以其为准；本文负责**契约与集成**）。
> 基线：本地引擎 T0/T0.5（`lib/local-pdf.js` vendored pdfjs-dist 5.4.449 文本层 → `lib/local-synth.js` 只出 heading/paragraph + `type:'text'` content_list；`parse-manager.executeLocalTask` 只写 `full.md` + `content_list.json`）。

---

## 0. TL;DR（10 条）

1. **契约方向正确、无需改阅读台**：MinerU 风格的 `![](images/x.jpg)` figure、`<table>…</table>` HTML 表、`$$…$$` 公式块、以及混排 `content_list.json` 已被现有 `ui/markdown.js`/`ui/app.js` 完整消费（spike 用 BEE 真值验证：273 block、26 大纲、27/27 页标记）。
2. **富条目是页标记的必需品，不是装饰**：BEE 真值全量 CL → 27/27 页标记；只保留 `text/equation/table/list/title` 条目 → 26/27（**丢失第 26 页**）。`type:'image'` 条目按其 `img_path` basename 与 markdown figure 的 `src` 精确匹配，缺了就用「下一个 block」兜底导致页标记错位（spike E）。
3. **本地 synth 应输出的混排 CL 规则**：`text`（含 heading，`text_level`）、`table`（`table_body`+`table_caption`）、`equation`（`text`=LaTeX 去掉 `$$`）、`image`（`img_path`=与 markdown `src` 完全一致的 `images/<name>`+`image_caption`）。**不要**输出 `chart/header/footer/page_number/ref_text` 等 MinerU 内部分类（匹配器无对应分支，只会走兜底）。
4. **markdown 写法（MinerU 同款，阅读台已验证）**：figure = 独立一段 `![alt](images/<sha256>.<ext>)`，下一段是 caption 段落（`Fig. 1. …`）；table = 上一段 caption（`Table 1. …`）+ 独立 `<table>…</table>`；formula = 独立 `$$` 块；inline 公式仍留在文本段落里（`$…$`）。
5. **PageBlock/资源契约**：`local-pdf.extract()` 从 `pages: heading|paragraph[][]` 扩展为支持 `image|table|formula` 的 page-block，并可选返回 `images: [{name, bytes}]`；`local-engine.extract()` 返回 `files: [{rel:'images/<name>', data}]`；`executeLocalTask` 把 files 一并交给 `writeStagedParsed`（复用现有原子 staging，`lib/parse-manager.js:619-637`）。
6. **图片管线安全/确定性**：文件名用**内容 sha256**（`images/<hex>.<ext>`，ext 由 magic 嗅探，白名单 png/jpg/jpeg/webp，禁 svg），天然去重、可幂等重解析；blockKey 对 figure 是 `fnv1a(alt + '|' + src)`，**图片名变了 key 就变**（spike H）——所以必须内容哈希命名，不能用自增/时间戳。
7. **降级原则**：任一富内容失败不得影响文本解析。图片抽取失败 → 该图退化为 caption 段落（`type:'text'`），不写缺文件 figure；表格/公式失败 → 退化为普通段落。`warnings` 记 `image-unavailable/table-skipped/formula-skipped`，UI 质量 banner 展示；`meta.parse.local.rich` 统计数量。
8. **阅读台/AI 现状即影响**：翻译只处理 heading/paragraph/quote/list（`ui/app.js:1737` 的 `mruIsTextBlock`，table/figure/formula 不翻译）；可批注 = 文本块+table（figure/formula 不可批注）；AI 检索索引仅 heading/paragraph/quote/list/table/code（`lib/ai/retrieval.js:28-36`），figure/formula **不进索引**，但 caption 是独立段落会被索引/引用——所以 caption 必须保留为文本段落。
9. **与云端兼容**：契约同构，local↔standard 可互切重解析；本地/云端富块命名不同 → figure/table/formula 的 blockKey 会变，文本块因插入富块导致 `b<index>` 位移 → 但 main 已有 `reanchorAfterParse`（`lib/parse-manager.js:763-770,813,838` + `lib/reanchor.js`）按 quote 重锚，文本批注可修复；富块上的批注不保证保留（现有 dropped/reanchor 语义即可）。
10. **最小改动集**：`lib/local-synth.js`（rich emitter+混排 CL+降级）、`lib/local-pdf.js`（rich 提取接口，由算法研究填充）、`lib/local-engine.js`（images 收集/校验/上限/`files`）、`lib/parse-manager.js`（executeLocalTask 写 files + rich 统计）、`lib/config.js`（`local.rich` 开关/上限）≈ 5 文件；阅读台 0 改动（可选：table 翻译、figure/formula 权重）。客户端 pdf.js canvas crop 属 P2 条件路线。

---

## 1. 现有契约与代码事实（file:line）

### 1.1 本地引擎现状（T0/T0.5）

| 位置 | 事实 |
|---|---|
| `lib/local-pdf.js:344-419` | `buildPageBlocks()` 只产出 `{kind:'heading',level,text}` / `{kind:'paragraph',text}`；`extractPdfText()`（`:423-577`）返回 `{pages, pageCount, title, chars, outlineUsed}`，**无 bbox、无图片、无表格/公式结构** |
| `lib/local-synth.js:134-154` | `normalizeBlocks()` 把任何非 heading 归为 paragraph；`synthLocalDocument()`（`:174-260`）只发 `type:'text'` 的 CL 条目（`text_level` 仅 heading） |
| `lib/local-engine.js:281-390` | `extract()` 返回 `{markdown, contentList, pages, provider, title, warnings, stats}`，**无 files/images** |
| `lib/local-engine.js:32-42` | `DEFAULT_LOCAL_CONFIG`：`maxPages/maxPdfBytes/maxTextBytes/minCharsPerPage/maxParagraphChars/keepContentList/timeoutMs/maxOfficePdfBytes`（rich 相关配置尚不存在） |
| `lib/parse-manager.js:393-437` | `executeLocalTask()` 只组装 `full.md` + 可选 `content_list.json` → `writeStagedParsed`；`finishSuccess` 记录 `parse.provider/local` |
| `lib/parse-manager.js:619-637` | `writeStagedParsed(id, files)`：staging 目录逐个 `writeFile`（`resolveWithin` 防路径逃逸）→ `rm(parsed)` → `rename`，**天然支持任意 `rel` 路径（含 `images/`）** |
| `lib/local-engine.js:162-167` | 能力快照里 `capabilities.images:false, html:false`（rich 后应变为按配置/算法能力上报） |

### 1.2 阅读台富内容解析条件（`ui/markdown.js`）

| 富内容 | 触发条件/函数 | 产出的 block（关键字段） | blockKey 文本（`mdKeyText`） |
|---|---|---|---|
| figure | 独立段落匹配 `mdDetectFigure()`（`:1165-1200`）：`![alt](url)`（可被 `<center>/<p>/<div>` 包裹）或独立 `<img>` | `{kind:'figure', src, alt, caption}` | `alt + '|' + src`（`:729`） |
| table | 独立 `<table>…</table>`（`mdTryHtmlTable` `:1049`→`mdParseHtmlTable` `:829`）、GFM pipe 表（`:908`） | `{kind:'table', head, rows, caption, runs, plainText}` | `plainText`（head+rows 空格拼接） |
| formula（块级） | 独立 `$$…$$` / `\[…\]`（`mdTryBlockFormula` `:974-1016`） | `{kind:'formula', latex, display:true}` | `latex` |
| formula（行内） | 段落内 `$…$`（`parseInline`） | paragraph 的 runs（type math） | 段落 plainText |
| code/fence | 三反引号 | `{kind:'code', code, lang}` | — |

- block 落盘时统一 `mdAppendBlock()`（`:699-710`）赋 `index=b<顺序>`、`key=blockKey(index, mdKeyText(block))`；`outline` 仅 heading。
- **重要**：`figure` 的 `plainText` 不是文本（`ui/markdown.js:693` 的 plainText 分支对 figure 返回 `alt|src`）；MinerU 的图 caption 是**独立段落**（BEE 真值同款），所以 caption 可被翻译/检索/引用。

### 1.3 `appendPageMarks` 对 rich content_list 的匹配行为（`:1356-1413`、`:1437-1490`）

| CL `type` | 匹配器行为 | 对本地实现的含义 |
|---|---|---|
| `text`（缺省） | 任意 block kind；用 `entry.text` 归一化前缀匹配 | 现规则可用 |
| `title` | 只匹配 heading | local 的 `text_level:1` 目前发 `type:'text'`，也可继续 |
| `list` / `table` / `equation` | 分别只匹配 list / table / formula（`mdKindAllowsMatch`）；`table` 文本取 `table_body` 去标签，`equation` 去掉 `$$`/`\[\]` | 富条目需按此类型发 |
| `image` | **只匹配 figure**：优先 `img_path` basename === block.src basename，其次 `image_caption` 与 alt 前缀互相匹配；仍失败则回退「窗口内第一个 figure」 | local 图必须 `img_path` 与 markdown `src` 同 basename |
| `chart` / `header` / `footer` / `page_number` / `ref_text` / `page_footnote` 等 | 走 `mdContentEntryText` 默认分支（`entry.text`），image 分支不接管 → 多数 text 为空 → 匹配 `-1`，页跳变时用「lastMatched+1」插入页标记 | local 不要发这些类型；它们只能靠兜底，可能让页标记偏移 |

- 页标记只依赖 `page_idx` 跳变 + 每个新页第一条能匹配的 entry 位置；**CL entry 与 markdown block 1:1、顺序一致**是本地实现的最强约束（spike D/E）。

### 1.4 资源路由 / 数据目录

| 位置 | 事实 |
|---|---|
| `lib/routes.js:234-269` | `GET /dsh-litnotes/api/asset?id=<docId>&path=<rel>`：`resolveWithin(store.parsedDir(id), rel)`（防 `..`）、只服务 `parsed/**`、`mimeForPath`（`lib/mime.js:109`）、`Cache-Control: private, max-age=86400`、`x-content-type-options: nosniff` |
| `ui/app.js:1016-1020` | `mruImageUrl(docId, imagePath)`：相对路径 → `dsh-litnotes/api/asset?id=…&path=…`（`document.baseURI` 解析，前缀安全）；`http(s)/data:` 直接放行 |
| `ui/app.js:2159-2172` | figure 渲染 `<img loading=lazy src=imageUrl alt=…>` + `<figcaption>`；table 渲染 thead/tbody + caption；formula 走 KaTeX |
| `docs/ARCH.md:99-112` | 解析产物目录约定：`parsed/full.md`、`parsed/content_list.json`、`parsed/images/*` |
| `docs/LOCAL-FALLBACK.md:57-70`、`:352-371` | 本地降级现状与「本地产物契约」；富内容被明确列为**未实现边界**（图片/表格/公式） |

### 1.5 富 block 的消费方（翻译 / 高亮 / AI / 导出）

| 消费方 | 代码 | 对 figure/table/formula 的行为 |
|---|---|---|
| 译文全文 | `ui/app.js:1737` `mruIsTextBlock()`（heading/paragraph/quote/list）+ `translateAllBlocks`（`ui/app.js:3573` 附近） | figure/formula/table **都不翻译**；表格内容不翻译（P2 可选增强） |
| 划词高亮/批注 | `ui/app.js:1740` `mruIsAnnotatableBlock()` = 文本块 + table；`ui/markdown.js` table 有 `data-block-key`；`ui/app.js:2172-2200` 表格按 cell 偏移映射批注 | table 可高亮/批注（plainText 偏移）；figure/formula 不可批注 |
| AI 检索 | `lib/ai/retrieval.js:28-36` KIND_WEIGHTS 只含 heading/paragraph/quote/list/table/code；`:230-310` 用 `parseMarkdown`+`appendPageMarks` 建索引；figure/formula **被跳过** | 图/公式不作为证据；其 caption（独立段落）作为 paragraph 进入索引、可被引用 |
| AI 引用校验 | `lib/ai/chat.js:241-310,366-460`（`verifiedKeys` 需 blockKey 存在且 quote 能在 plainText 中定位） | 只能引用文本/表格 blockKey；figure/formula 无稳定可引用文本（figure plainText=alt\|src） |
| 批注重锚 | `lib/reanchor.js:93-140` `buildAnchorBlocks()`（所有 block plainText）+ `parse-manager.js:763-770,813,838` `reanchorAfterParse` 在解析完成后调用 | 重解析后按 quote 文本重锚，可部分抵消富块插入导致的 index 位移 |
| 导出 Markdown | 菜单导出原始 `full.md`（`ui/app.js` menu.export） | `![](images/<hash>.jpg)` 相对路径在导出后不可用（P2：zip/base64） |
| agent tool read | `lib/service.js toolRead()` 读原始 markdown | 富内容以 markdown 形式可见（`![](images/...)`、`<table>`、`$$`），token 成本上升但可用 |

---

## 2. rich 契约草案

### 2.1 PageBlock schema（`lib/local-pdf.js` 提取接口 → `lib/local-synth.js`）

保持向后兼容：现有 `heading/paragraph` 完全不变；新增 4 类（全部可选，缺省即降级）：

```ts
type BBox = [number, number, number, number]         // PDF user space: x0,y0,x1,y1（顺序可自定，文档内一致即可）
type PageBlock =
  | { kind: 'heading';   level: 1|2|3|4; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'figure';    image: Ref | CropImage; caption?: string; alt?: string; bbox?: BBox }
  | { kind: 'table';     head?: string[][]; rows: string[][]; caption?: string; bbox?: BBox }
  | { kind: 'formula';   latex: string; display: true; bbox?: BBox }

type Ref       = { ref: string }                     // 引用已提取图片资源（images 数组里的 name）
type CropImage = { bytes: Uint8Array; format: 'png'|'jpg'|'jpeg'|'webp'; sha256?: string; bbox: BBox }
```

提取器返回扩展：

```ts
extractPdfText(...) → {
  pages: PageBlock[][], pageCount: number, title: string, chars: number, outlineUsed: boolean,
  images?: Array<{ name: string; bytes: Uint8Array }>,   // 已按内容哈希命名、去重、MIME 白名单在 engine 侧校验
  richStats?: { images: number; tables: number; formulas: number; skipped: number },
}
```

> 算法接口边界：表格识别（表头/合并单元格）、公式识别（LaTeX）、图片抽取（内嵌 XObject 解码 / 页面区域 crop）由并行研究给出，本文只定义它们必须落成的产物形状。**P0 提取器可以继续只返回 text**，契约与 synth/pipeline 先行。

### 2.2 `local-synth` 渲染规则（MinerU 同款，阅读台已验证）

| PageBlock | full.md 写法 | content_list entry |
|---|---|---|
| heading | `#{level} {escaped text}` | `{type:'text', text, text_level:level, page_idx}` |
| paragraph | `{escaped text}`（保持现有转义） | `{type:'text', text, text_level:0, page_idx}` |
| figure | `![{alt}]({images/<sha256>.<ext>})` + 空行 + `{caption}`（独立段落） | `{type:'image', img_path:'images/<sha256>.<ext>', image_caption:[caption], page_idx}`；无 caption 时 image_caption 省略 |
| table | `{caption}`（独立段落，可省）+ 空行 + `<table><thead>…<tbody>…</table>`（单元格文本 HTML 转义） | `{type:'table', table_body:'<table>…</table>', table_caption:[caption], page_idx}` |
| formula | `$$` + `{latex}` + `$$` | `{type:'equation', text:'$$'+latex+'$$', text_format:'latex', page_idx}`（MinerU 同形态；匹配器会去 `$$`，只存 latex 也可运行，但建议照抄真值） |

**硬约束**（决定页标记是否对齐）：
1. **一个 markdown block ↔ 一个 CL entry，顺序与 `page_idx` 单调一致**（spike D/E 证明）。
2. `image.img_path` 与 markdown `src` 必须逐字相同（basename 匹配；路径统一 `images/`）。
3. `equation.text` 与 `latex` 内容一致（匹配器会去 `$$` 后归一化）。
4. `table.table_body` 用与 markdown table **相同**的 HTML（匹配器去标签后按 plainText 前缀匹配）。
5. 文本继续走 `escapeMarkdownText()`（`lib/local-synth.js:58-85`）；富内容**不转义**结构字符（`![`、`<table>`、`$$` 必须原样）。
6. 标题/页标记/`text_level` 规则不变；`keepContentList:false` 时退化为纯文本（无页标记，可接受）。

**图片缺失降级**：若某图 bytes 未产出，则该图**不写 figure block**，把 caption（或 `alt`）作为 `{type:'text'}` 段落写入 markdown/CL（保持 1:1），并 `warnings.push('image-unavailable')`。同理 table 识别失败 → 该表降级为普通段落（caption 仍保留）。

### 2.3 图片写入管线（Host）

```ts
// lib/local-engine.js extract() 侧（在 synth 之前校验/去重）
files: Array<{ rel: string, data: Buffer }>
// rel 约束：'images/<sha256hex>.(png|jpg|jpeg|webp)'；其它 rel 仅 'full.md' / 'content_list.json'
```

- **命名**：`sha256(bytes).slice(0,32)`（或全长 64，推荐 32 hex 足够）；ext 由 magic bytes 嗅探（`\x89PNG`/`\xFF\xD8\xFF`/`RIFF....WEBP`）；同哈希多处引用 → 只写一份（去重）。
- **MIME 白名单**：仅 png/jpg/jpeg/webp；**禁止 svg**（同源 asset 无 CSP，svg 可带脚本）；`mimeForPath` 已有这些类型（`lib/mime.js:53-85`）。
- **上限**：`local.rich.maxImageBytes`（默认 8MiB/张）、`maxTotalImageBytes`（默认 64MiB/文档）、`maxImages`（默认 200 张）；超限 → 跳过该图 + `warnings:'image-skipped'`，不影响全文。
- **路径安全**：`rel` 只允许 `images/<hex>.<ext>` 正则（`/^images\/[0-9a-f]{16,64}\.(png|jpe?g|webp)$/`），最终仍经 `writeStagedParsed` 的 `resolveWithin`（`lib/parse-manager.js:619-637`）二次校验。
- **原子性**：与 markdown/CL 同一 staging 批次写入 → `rm(parsed)+rename` 原子替换（旧图不会残留）。
- **幂等性**：内容哈希命名 + 去重 ⇒ 同一 PDF 重解析产出一致，figure blockKey 稳定（spike H 的反面）。
- **不落原始裁剪图之外的中间物**：crop 内存字节直接进 files；如侧车返回文件，读入后删除 staging 临时。

### 2.4 配置开关（`local.rich`，无 schema 配置需手写校验，参考 `lib/config.js resolveConfig` / `lib/local-engine.js:62-85`）

```yaml
local:
  rich:
    images: off            # off | embedded（PDF 内嵌 XObject 抽取）| crop（页面区域，P2/客户端）
    tables: heuristic      # off | heuristic
    formulas: heuristic    # off | heuristic
    maxImageBytes: 8388608
    maxTotalImageBytes: 67108864
    maxImages: 200
```

- `images:off`（默认）→ 图只留 caption 段落；`tables/formulas:heuristic` 依赖算法研究就绪后默认开启（先灰度）。
- 能力快照 `capabilities.images/tables/formulas` 按配置+算法实际可用性上报，UI 展示「本地解析支持：文字 ✓ 表格 ✓ 公式 ✓ 图片 ✗」。

---

## 3. 真值契约 spike 证据（BEE / MinerU standard 27 页）

命令：`node .agents/tmp-research/rich-integration/contract-spike.mjs`（导入 main 的 `ui/markdown.js`，与宿主 AI/客户端同一解析器）。
完整输出：`.agents/tmp-research/rich-integration/spike-output.{json,txt}`。

### A. markdown model（`bee-full.md`）

```json
{"markdownChars":138367,"blocks":273,
 "kinds":{"heading":26,"paragraph":231,"figure":10,"table":3,"formula":1,"code":2},
 "outline":26,"outlineFirst":["h1 BEE: …","h2 ACM Reference Format:","h2 1 Introduction","h2 1.1 Background"]}
```

### B. content_list（`bee-content_list.json`）

```json
{"entries":358,"pages":27,
 "types":{"text":198,"footer":27,"header":38,"page_number":14,"ref_text":50,"chart":16,
          "image":7,"table":3,"equation":1,"code":1,"page_footnote":3}}
```

`chart` 条目字段为 `{type,img_path,content,chart_caption,chart_footnote,bbox,page_idx}`；`image` 为 `{type,img_path,image_caption,…}`；`equation` 为 `{type,text:"$$…$$",text_format,bbox,page_idx}`。

### C. rich blocks（解析器从 MinerU markdown 得到）

- figure 10 / table 3 / formula 1；sample：`{"kind":"figure","key":"b10:693e30af","src":"images/a1b3…jpg"}`、`{"kind":"table","key":"b13:b7969824","rows":2}`。
- formula block：`{kind:'formula', latex, display:true}`；table 的 `plainText` = 表头+单元格空格拼接（可批注/检索）。

### D. 页标记（全量 CL）

```json
{"count":27,"numbers":[1,…,27],"expectedPages":27,"complete":true,"monotonic":true}
```

### E. 富条目对页标记的必要性（关键）

```
full:        [1..27]            （27 个，完整）
textEqTable: [1..25, 27]        （缺第 26 页）
textOnly:    [1..25, 27]        （缺第 26 页）
fullEqualsFiltered: false
```

→ 第 26 页的首条 CL 是 `header/chart` 之类**无文本富条目**；它们靠「页跳变兜底」帮助页标记落位。本地 synth 若每页都保证至少一条可匹配的 text entry（或正确 image/table/equation），可避免同类问题；这也是「每页首块建议发 text」的设计理由。

### F. 富 block 的 key 稳定性

```json
{"sameKeysOnReparse":true,"keysPreservedUnderPageMarks":true,"sameIndexOnPageMarks":true,"idempotent":true,
 "richKeysSample":["b10:693e30af","b13:b7969824","b18:150bad6a","b39:6c1e9b97"]}
```

→ 页标记插入不改 index/key（同早前结论），富 block 也成立；同内容重复解析 key 稳定。

### G. figure `src` ↔ CL `img_path` 对齐

```
figureBlocks: 10, imageEntries: 7, matched(basename): 4
samples: {src:"images/a1b3….jpg", clImgPath:"images/a1b3….jpg", caption:"Fig. 1. A running example…"}
chartEntries: 16（不在 image 分支，走兜底）
```

→ MinerU 真值里 md 有 10 个 figure 但 CL 只有 7 个 `image`（其余来自 chart/其他），其中 4 个按 basename 精确匹配；证明「figure.src 与 image.img_path 同 basename」是首选对齐通道，本地 synth 必须遵守。**本地应把 chart 也发 `type:'image'`**（不要发 `chart`），才能命中 image 分支。

### H. 图片文件改名 → figure blockKey 变化（确定性命名要求）

```json
{"originalKey":"b10:693e30af","renamedKey":"b10:e31c26dd","changed":true}
```

→ 图片名必须由**内容哈希**决定（而非自增/时间戳/随机），否则重解析后图上的批注/引用锚点必丢。

### I. 消费方资格（与 `ui/app.js`/`lib/ai` 行为一致）

```json
{"translatable":257（文本块）,"annotatable":260（文本+3 tables）,
 "tablePlainTextSample":"Wordnet HPRD Stanford DBLP Figeys Human 92,747 …",
 "stats":{"blocks":273,"headings":26,"chars":90173,"words":14037}}
```

→ figure/formula/table 均**不参与翻译**；table 可批注；caption 作为 paragraph 参与翻译/检索。

### J. 本地合成变体 round-trip（契约闭环）

用本地 synth 将产出的形状手写为最小 rich 文档：

```md
# Local Rich Paper

## 1 Introduction

Paragraph with inline $E=mc^2$ formula.

$$
a^2 + b^2 = c^2
$$

![Fig. 1. Local figure](images/fig-<sha256>.png)

Table 1. Local table

<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
```

`parseMarkdown` 得到 heading/paragraph/formula/figure/table 共 7 个 block，`appendPageMarks` 生成 1 个页标记，页面无错位；figure src 与 `image.img_path` basename 精确匹配（见 `spike-output.json.J_localVariant`）。**该最小变体可直接作为 P0 单元测试 fixture**（合成文本，不用 BEE 原文）。

### Spike 结论

1. 富内容契约**不改阅读台即可工作**（解析/页标记/渲染/批注/检索均走现有路径）。
2. 混排 CL 的**1:1 与类型正确**是页标记正确性的核心；富条目（尤其 image）是页标记完整性的一部分。
3. figure key 依赖图片文件名 ⇒ **内容哈希命名**是硬要求。
4. 降级必须保留 caption 为文本段落，否则翻译/AI/引用丢信息。

---

## 4. 阅读台与 AI 行为影响（结论 + 是否需要改）

| 项 | 现状 | rich 后是否需要改 |
|---|---|---|
| 渲染（图/表/公式） | 已支持（`ui/app.js:2159-2200`） | 否 |
| 页标记 | 依赖 CL 混排（spike 通过） | 否（本地 synth 保证 1:1） |
| 翻译 | 只翻译文本块 | 表格/公式/图不翻译（与云端一致）；可选 P2：table 翻译（把 plainText 拼成批量文本） |
| 高亮/批注 | 文本+table；figure/formula 不可批注 | 与云端一致，无需改；富块上批注丢失由 reanchor/dropped 处理 |
| AI 检索/引用 | figure/formula 不进索引；table 权重 0.9；caption 段落进索引 | 无需改；**caption 必须作为独立段落**；可选 P2 给 figure 的 caption 单独索引（已天然满足） |
| 批注重锚 | `reanchorAfterParse` 在解析成功后按 quote 重锚 | 无需改；local↔cloud 富块变化时保证文本批注可修复 |
| 导出 | 原始 markdown（图片相对路径失效） | P2：导出 zip（full.md+images）或 data URL 内联；不阻塞 P0/P1 |
| 按页修复 | 本地解析已禁止按页修复（`parse-manager.js:254-261`） | 不变 |

---

## 5. Host / Client 改动清单（最小改动集）

### 5.1 Host（P0 契约先行）

| 文件 | 改动点 | 说明 |
|---|---|---|
| `lib/local-synth.js` | `normalizeBlocks()` 保留 rich kind；`emit()` 按 §2.2 输出 markdown；CL 混排 type;图片缺失降级；`warnings` 增 rich 统计 | 纯函数，单测友好 |
| `lib/local-engine.js` | `extract()` 接收 `extracted.images`；校验命名/MIME/大小/张数/去重；返回 `files`；`stats.rich`；`warnings`；`capabilities.images/tables/formulas` | 由 `config.local.rich` 控制 |
| `lib/local-pdf.js` | `buildPageBlocks()` 增加 rich 识别 hook（`extractTables()/extractFormulas()/extractImages()` 由算法研究填充）；返回 `images` | P0 可先留 no-op（`rich.images/tables/formulas: off`） |
| `lib/parse-manager.js` | `executeLocalTask()` 把 `result.files` 合并进 `files`（校验 rel 前缀/去重）；`finishSuccess` 记录 `parse.local.rich` | `writeStagedParsed` 无需改 |
| `lib/config.js` | `local.rich` 子配置校验/默认值（整数夹取/枚举） | 与 `local-engine.js` 默认值保持一致 |
| `index.js` | 透传配置（已通过 config 对象，无需改） | — |
| `lib/routes.js` | 无需改（asset 路由已支持 `parsed/images/**`） | 可选：asset 对非白名单扩展仍按 mimeForPath 返回；本地图已白名单 |
| `scripts/check.mjs` | 新增 vendor/rich 相关存在性（若 P0 加 fixture） | P0 测试门禁 |
| `docs/ARCH.md`、`docs/LOCAL-FALLBACK.md`、`README.md` | 产物契约、能力矩阵、配置说明更新 | P0 收尾 |

### 5.2 Client（P0 零改动；P2 才可能需要）

- 现有渲染/翻译/高亮/AI 已覆盖 rich block（§4），**P0/P1 不需要改 `ui/app.js`**。
- P2 候选：table 翻译、导出 zip、figure/formula 的 AI 引用支持、`local.rich` 能力展示（若 Host 暴露到 status）。

### 5.3 与云端 MinerU 的兼容 / 重解析

- **契约同构**：`full.md` + 混排 `content_list.json` + `images/**` 与 standard 产物完全同构 ⇒ `document.markdown`/asset/阅读台/AI 零差异对待；local↔standard 可任意重解析。
- **key 变化**：富块插入会影响后续 block 的 `b<index>`；figure key 依赖 src 文件名；table key 依赖 HTML 文本。→ 文本批注由 `reanchorAfterParse`（`lib/parse-manager.js:763-770`，解析成功后调用）按 quote 重锚，可保留大部分；无法重锚的走 `margin.dropped`（错误提示）与 `origin/ai` 语义。
- **同一文档 local→standard**：MinerU 的 figure 文件名是它自己的内容哈希，与本地不同 → figure/table/formula 上的批注大概率无法重锚；这是可接受的产品语义（文档换引擎=换解析稿），UI 已提示 dropped 数量。
- **不要**在 local 与 cloud 产物间做增量合并（page-merge 只用于 cloud 修复，且要求 CL 对齐）。

---

## 6. 客户端 canvas 渲染路线评估（P2，条件路线）

- **现状**：`/dsh-litnotes/assets` 只服务 `vendor/**` 静态文件（`lib/routes.js:353-385`），浏览器加载的是插件预构建 bundle；**没有**「客户端解析 PDF / 上传图片」的 API 与任务状态。
- **候选方案**：client 经 assets 动态 import vendored **browser** pdf.js（≈1–2MB JS + worker + wasm?）+ `canvas` 渲染页面/公式/表格区域 → `canvas.toBlob()` → 新增 Host API（如 `parse.localAsset`：带 docId/figId 的 multipart/raw POST）→ 写入 `parsed/images/`。
- **复杂度/风险**：新 API（上传、限额、fence、并发写 parsed 目录与解析任务竞态）、解析完成与图片生成的时序（阅读台「解析完成即可读」会被打破，需要占位/惰性渲染）、取消/重载/多标签页一致性、移动端内存、断点续传。**明显高于“算法在 Host 侧离线提取”的路线。**
- **结论**：P2 条件触发，不作为 P0/P1。若图片研究证明「Host 侧无法可靠抽取内嵌图片」且产品必须有图，优先「按需渲染」：阅读台对 `images:off` 的图显示「渲染此图」按钮 → 客户端 canvas crop → 上传缓存；只有用户点击才付费，且失败不影响正文。

---

## 7. 分阶段计划

### P0 — 契约与管线（不依赖算法研究，约 1.5–2 人日）

**目标**：把 rich 契约、混排 CL、图片写盘管线、降级、能力上报、测试全部做出来；提取器仍只产文本（视觉无变化，但基础设施就绪、用合成 rich fixture 验证闭环）。

| 文件 | 改动 |
|---|---|
| `lib/local-synth.js` | rich emitter + 混排 CL + 图片缺失降级 + rich warnings |
| `lib/local-engine.js` | images 收集/去重/上限/命名校验、`files` 返回、`rich` 配置、capabilities |
| `lib/parse-manager.js` | executeLocalTask 写 `files`、rich 统计入 `parse.local` |
| `lib/config.js` | `local.rich` 默认值/校验 |
| `lib/local-pdf.js` | rich hook 空实现（off）+ 返回 `images:[]` |
| `test/reader/rich-artifact.test.mjs`（新） | 用 §3.J 合成 fixture：figure/table/formula 解析、页标记 1..N 对齐、1:1 断言、key 稳定、caption 段落 |
| `test/unit/local-synth.test.mjs`（改/新） | 混排 markdown golden、CL 类型/page_idx、图片缺失→caption 降级、内容哈希命名幂等 |
| `test/unit/local-engine.test.mjs`（改） | fake extractor 返回 images → files 校验（白名单/上限/重复去重/非法命名拒绝）；rich off 不变 |
| `test/unit/parse-manager.test.mjs`（改） | executeLocalTask 写 images/**；`parse.local.rich` 统计；图片超限降级不失败 |
| `test/e2e/local-flow.test.mjs`（改） | fake extractor rich → upload→parse→document.markdown→reader（复用 reader 测试辅助） |
| `scripts/check.mjs` | 新 fixture/文件门禁 |
| `docs/ARCH.md` / `LOCAL-FALLBACK.md` / `README` | 契约/能力/配置 |

**验收**：合成 rich fixture 全链路（synth→写盘→`document.markdown`→parseMarkdown→appendPageMarks）通过；图片命名/去重/上限/白名单单测通过；text-only 回归不变；富内容失败不影响文本解析。

**风险**：契约细节（HTML table 转义、`image_caption` 类型）与真实 MinerU 有个体差异 → 用 BEE 真值做只读契约断言（不把原文入库）。

### P1 — 富提取（依赖并行算法研究，约 3–5 人日）

**目标**：从 pdfjs 文本层/资源层真正产出 table/formula/image。

| 改动 | 内容 |
|---|---|
| `lib/local-pdf.js` | `extractTables()`（行/列/bbox 启发式或 XObject 表）、`extractFormulas()`（文本层公式启发式/块区域）、`extractImages()`（PDF 内嵌 image XObject 解码，png/jpg；无 canvas 路线）|
| 算法研究落地 | 按 `rich-tables.md`/`rich-formulas.md`/`rich-images.md` 的结论实现；失败路径必须保留降级 |
| 配置默认 | `tables:heuristic`、`formulas:heuristic` 灰度开启；`images:off` 直到 embedded 方案实测稳定 |
| 测试 | `test/unit/local-pdf-rich.test.mjs`（真实样本：BEE 27p/Attention/ACL 的 rich 数量与质量下限断言）；reader 回归；e2e |
| 文档 | 能力矩阵/质量 banner 文案/限制说明 |

**验收**：BEE 27p 本地解析产出 ≥ 真值 80% 的 table/formula 数量（比例可按研究结论调整），页标记完整、阅读台渲染正确、批注/检索可用；提取失败自动降级；性能增量 ≤ +50%（以文本层基线为参照）。

**风险**：表格/公式启发式误检（把普通段落识别成表/公式）→ 置信度阈值 + 数量上限 + 质量 banner；图片解码内存 → 上限/并发；pdfjs 无 canvas 导致的图片抽取限制 → 见 §6 条件路线。

### P2 — 客户端 crop / 导出 / 增强（约 3–5 人日）

- 客户端 pdf.js canvas 按需渲染上传（§6 条件路线，需新 API/状态机/限额/fence）；
- 导出 zip（`full.md` + `images/`）；table 翻译；figure/formula 的 AI 引用增强；
- 验收：图片按需生成不影响正文首屏；导出 zip 可在第三方 markdown 阅读器显示；
- 风险：安全（上传写盘）、时序/多标签页竞态、移动端内存；回滚开关 `local.rich.images:'off'`。

---

## 8. 风险与待决问题

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | 富块插入改变后续 block index → 既有批注锚点位移 | 批注丢失/错位 | 现有 `reanchorAfterParse` 按 quote 重锚 + `margin.dropped` 提示；富块自身批注接受失配 |
| 2 | 图片命名不确定（时间戳/随机/顺序） | 重解析后 figure key 变、图片重复 | 强制内容 sha256 命名 + 去重（§2.3）；单测断言幂等 |
| 3 | 图片管线的安全/DoS（超大图、svg、路径逃逸、zip bomb 类） | 磁盘/内存/XSS | 白名单 png/jpg/webp、每张/总量/张数上限、`resolveWithin` 双校验、staging 原子替换 |
| 4 | 表格/公式启发式误检或质量差 | 阅读体验下降、页标记错位 | 置信度阈值、每页数量上限、`warnings`、质量 banner、可关闭 `local.rich.tables/formulas:off` |
| 5 | CL 富条目与 markdown 1:1 被破坏（caption 合并/降级） | 页标记漂移 | synth 内统一 emit + reader 测试断言 1:1 与页标记完整；降级也保留 text 占位 |
| 6 | pdfjs 无 canvas 时图片抽取不可行 | P1 图片不可用 | 先做 `images:off`；P2 客户端 crop 或侧车；不影响文本/表格/公式 |
| 7 | local↔cloud 重解析富块 key 全变 | 富块批注丢失 | §5.3 语义说明 + reanchor/dropped；UI 提示 |
| 8 | HTML table 转义/合并单元格与 MinerU 输出细节不一致 | 解析器渲染差异/匹配失败 | 用 BEE 真值 + 最小变体做契约测试；单元格文本 HTML 转义 |
| 9 | 性能/内存：rich 提取叠加 pdfjs 峰值 | 解析变慢/OOM | 上限/并发/超时；rich 失败降级不阻塞；P1 实测后调参 |

**待决问题**：
1. 图片默认策略：`embedded`（Host 解码 PDF 内嵌图）是否足以满足产品需求，还是必须 P2 客户端 crop？（依赖 `rich-images.md`）
2. 表格识别的质量门槛/数量上限（依赖 `rich-tables.md` 的实测指标）。
3. 公式识别的输出形态：块级 LaTeX vs 行内保留文本；是否引入 `formulas:'off'` 默认。
4. table 是否纳入翻译（现为不翻译；P2 可选）。
5. 导出是否必须支持图片（zip）才能发布 P1。

---

## 附录：证据文件

```
.agents/tmp-research/rich-integration/
  contract-spike.mjs      # 真值契约 spike 脚本（导入 main 的 ui/markdown.js）
  spike-output.json       # 完整结构化证据（A–J）
  spike-output.txt        # 同上文本
.agents/tmp-research/lead/rich/
  bee-full.md bee-content_list.json bee.pdf attention.pdf acl.pdf   # 只读真值 fixtures
```
