# PDF 表格还原（本地解析引擎）：真值分析、原型与实测

> 任务：研究「本地解析（vendored pdfjs 5.4.449，零 npm 依赖）如何把 PDF 表格还原成阅读台可渲染的 HTML table」，给出算法原型、量化评测、契约与 P0/P1/P2 建议。
> 工作仓库：`/home/nirvana/Documents/dsh-mineru`（**研究基线 b1a68be**；复核时 main HEAD 已前进到 0cda21a，本文行号可能漂移，以符号名为准；fixtures 来自用户本地库中公开论文，只做结构/质量评估）。真值 fixtures（只读）：`.agents/tmp-research/lead/rich/`。实验脚本：`.agents/tmp-research/rich-tables/{probe.mjs,proto.mjs}`，报告 `run.log` / `proto-report.json`。环境 Node v26.13.0，pdfjs **5.4.449**（`vendor/pdfjs/`，经 `lib/local-pdf.js#loadPdfjs()` 加载）。
> 说明：时间盒内完成「真值分析 + 文本几何原型 + 量化评测 + 推荐」；线框路线做了可行性探查但未完成完整实现。

---

## 0. 结论摘要（TL;DR）

1. **可行**：在 bee.pdf 的 3 张 MinerU 真值表上，纯文本几何原型 **检出 3/3**，**行列结构 3/3 完全正确**（2×6、11×6、4×6），**单元格文本 F1 = 1.000 / 0.955 / 1.000**（唯一的 0.955 来自数学斜体字形差异 `|𝑉|` vs 真值 `|V|`、`𝑑𝐺` vs `$d_G$`）。生成的 `<table>` HTML 与 MinerU `table_body` 逐字符几乎一致（Table 1、Table 3 完全一致）。
2. **bee 的 3 张表都是「无竖线、仅横线」的 booktabs 风格**：`getOperatorList()` 在 Node 下可用，但 Table 2 所在页（PDF 第 16 页）只有 **3 条 `constructPath` 水平线（minMax 宽度 280.6pt = 顶/中/底横线）**、0 条竖线；Table 1/3 所在页的 path 全是图/图表内容。→ **不能靠「线框网格」还原 bee 这类表，必须文本几何（x 对齐 + 空白间隔）**；线框路线只适用于真正画了单元格边框的表，作为 P1。
3. **原型算法（caption 锚定 + 空白边界切列）**：
   - 用行首 `^Table\s+\d+[.:\s]` 定位 caption（MinerU full.md 的 caption 就是表格前一行纯文本，天然对齐）；
   - caption 下方（也扫描上方，兼容 caption 在表下的论文）按 baseline 聚行；
   - 对候选行带**逐行求相邻文本 item 的空白 gap**，跨行聚类出「共享列边界」（支持率 ≥70%），列 = 边界切分区间；
   - 逐行把 item 分到列区间 → 单元格文本；裁掉尾部 gap 不匹配的行（正文误入）；
   - 行数≥2、列数≥3 才成表；候选窗口按 `行×列` 打分并做包含去重。
4. **对产品最关键的三个对接点**（见 §4）：① `lib/local-pdf.js` 现在只产 `{kind:'heading'|'paragraph'}`，需要新增 `{kind:'table', caption, rows, bbox, pageIndex}`；② `lib/local-synth.js` 的 `escapeMarkdownText` 会转义 `<`、`|`、`&`，**表格 HTML 必须走特殊 block 跳过转义**（否则 `<table>` 变纯文本）；③ `content_list.json` 写 MinerU 兼容的 `{type:'table', table_body, table_caption, page_idx, bbox}`；阅读台 `ui/markdown.js` 的 `mdTryHtmlTable` 已支持 `colspan/rowspan/th`，HTML 契约成立。
5. **推荐**：**P0 自研轻量启发式（1.5–2.5 人日）**，作为本地引擎的「表格增强」；P1 线框网格（2–3 人日）用于有线框表 + 用横线 y 坐标精确分行；P2 才考虑 Python 侧车/第三方库。**不推荐**为表格引入 npm 依赖（见 §5）。
6. **最大失败类型**：无 caption 或 caption 远离表格、跨页/跨栏长表（attention/acl 中常见）、多行单元格与合并单元格、纯空格对齐但列间无稳定空白（紧贴的数字列）、右对齐数字列（已用空白边界法化解大部分）。**补充样本 attention/acl 上 caption 检出 4/4 与 8/8，但能产出候选表的 caption 页只有 3/4 与 4/6**（未做行/列真值标注，属定性评估）。

---

## 1. 真值分析（bee.pdf，MinerU standard）

### 1.1 3 张真值表

| # | `page_idx`（0-based） | 实际 PDF 页 | 行列 | caption | `bbox`（MinerU） |
|---|---|---|---|---|---|
| Table 1 | 1 | 2 | **2×6** | `Table 1. The average visits per candidate.` | `[257,372,728,406]` |
| Table 2 | 15 | 16 | **11×6** | `Table 2. Real data graphs with vertex labels.` | `[203,147,783,330]` |
| Table 3 | 21 | 22 | **4×6** | `Table 3. Hit rates (%) of block reference across datasets.` | `[226,337,769,426]` |

- bee.pdf：27 页，页面 486×720 pt，pdfTeX/acmart，**单栏**（正文行宽约 394pt，x 45.8→440.2）。
- **`page_idx` 是 0-based**（与 `docs/MINERU.md` 一致）：真值 page_idx=1 的表实际在 PDF 第 2 页。第一版 probe 按 1-based 找错页，是本次最容易踩的坑。
- 3 张表都是 **booktabs 风格：只有横线（顶线/表头下/底线），没有竖线**；列之间的分隔是靠**空白对齐**。Table 1 是 2 行 6 列（表头 + 数字行），Table 2 是「数据集属性表」（表头 + 10 行），Table 3 是「4 行 × 6 列」的两段式表。
- `full.md` 里表格契约：caption **单独一行纯文本** → 空行 → **单行 `<table><tr><td>…</td>…</tr></table>`**（无 `<thead>`，MinerU 用 `<td>`）。`content_list.json` 的 table 条目再带 `table_body`、`table_caption`、`bbox`。阅读台 `ui/markdown.js#mdTryHtmlTable` 按「行首 `<table` → 读到 `</table>`」解析，支持 `th/colspan/rowspan`，所以 **MinerU 的单行 HTML 契约可直接复用**。

### 1.2 bbox 坐标系陷阱（影响 IoU 评测，需产品注意）

MinerU bbox 不是 PDF point 坐标：对同一页内文本 item 做「pdfjs 行坐标 → 真值 bbox」最小二乘拟合，得到**每页缩放不同且 x/y 不一致**（x 斜率 1.53–2.11，y 斜率 1.20–1.40）。同一页内 caption 在 PDF yTop=254.7，而 Table 1 真值 bbox y0=372 → 不可能用单一仿射与原 PDF 对齐（`/2` 假设也被证伪）。

**结论/建议**：
- **不要**拿 MinerU fixture bbox 与 PDF 点坐标直接比 IoU；若要评测，先按页用正文文本锚点拟合映射（本次原型如此做，但拟合受 header/footer 影响，IoU 仅作参考，见 §3）。
- 本地引擎自产 `content_list.json` 时，**bbox 建议直接写 PDF 点坐标、左上原点（yTop）**，并在文档里写清楚；阅读台目前渲染表格只用 markdown HTML，不依赖 bbox（渲染/高亮定位未用），所以不阻塞功能。

### 1.3 表格结构特征（供启发式设计）

- 表体行距 ≈ 正文行距（bee：表行 ~11pt，正文 9pt 字号 ~12.1pt 行距），**不能靠行距区分表/正文**，必须靠列对齐与 caption。
- 每行内 cell 是独立 text item（pdfjs `getTextContent()` 每 cell 一个或多个 run）；`width` 可用，因此**空白 gap 可精确计算**（gap = 下一 item.x − 上一 item.x − 上一 item.width）。
- 数字列可能右对齐：Table 1 表头 `Wordnet` x=132.2，数字 `92,747` x=136.7（差 4.5pt）→ 只按「列起始 x 聚类」会漏列，**按空白边界切列更稳**（本次两种都实现了，最终用后者）。
- Table 2 表头含数学符号（`|V|`、`|E|`、`d_G`），pdfjs 抽成数学斜体 Unicode（`|𝑉|`、`|𝐸|`、`𝑑𝐺`），与 MinerU 真值的 `|V|`/`$d_G$` 文本不完全一致 → 影响 cell F1 与后续替换显示，需要 **Unicode 数学字母规范化（`𝑚𝑎𝑡ℎ italic` 字母 → ASCII）** 或接受差异。

---

## 2. 算法与原型

脚本：`.agents/tmp-research/rich-tables/proto.mjs`（~350 行，仅研究用，未接产品代码）。

### 2.1 文本几何路线（P0，已实现+评测）

流程：

1. **取页数据**（复用 `lib/local-pdf.js#loadPdfjs()`，Node 下 fake worker 正常）：`getTextContent()` → 每个 item `{str, x=transform[4], yTop=viewport.height−transform[5], width, size}`；按 baseline 聚成视觉行（容差 `max(1.5, size*0.4)`）。
2. **caption 锚定**：行首文本匹配 `^Table\s+\d+\s*[.:\s]`。MinerU 的 caption 在表格上方一行；本原型同时扫描 caption **下方**与**上方**（兼容 caption 在表下方）。
3. **候选行带**：从 caption 下一行开始收集视觉行，直到与上一行垂直间距 > `max(lead×2.4, 40pt)`（`lead` = 页内行距下三分位）；上方方向同理。
4. **共享列边界（gap 法）**：对行带内每行，计算相邻 item 间的水平空白中心 `(prevEnd+nextStart)/2`（gap∈[2,80]pt）；跨行聚类（tol 5pt），保留支持率 ≥70% 的边界；边界切分出的区间即列。**该步是表格列检测的核心**，比「按 x0 聚类」更抗右对齐/合并空白。
5. **成表判定**：列数 ≥3、行数 ≥2；裁掉尾部「行内 gap 与共享边界匹配数 < 0.6×边界数」的行（正文误入）；候选窗口按「行数×列数」打分，做包含去重（同一表的多尺度窗口只留最大）。
6. **网格填充**：每行 item 按中心 x 落入列区间，同列拼接（gap > 0.22×size 补空格）→ `rows: string[][]`；`bbox` = 行带内 item 并集（PDF 点、左上原点）；输出 `<table><tr><td>…` + caption 文本。

关键代码（节选，完整见脚本）：

```js
// 1) 共享列边界：空白 gap 跨行聚类
function columnsFromGaps(rows, minGap = 2.0, tol = 5) {
  const gapPts = []
  for (const r of rows) for (let i = 1; i < r.items.length; i++) {
    const prevEnd = r.items[i-1].x + (r.items[i-1].width ?? 0)
    const gap = r.items[i].x - prevEnd
    if (gap >= minGap && gap <= 80) gapPts.push((prevEnd + r.items[i].x) / 2)
  }
  // cluster gapPts (tol) → keep clusters whose x is present in >=70% rows → bounds
}
// 2) caption 锚定 + 行带窗口扫描（略），3) 边界切区间填单元格（略）
```

### 2.2 线框路线（探索结论）

- `page.getOperatorList()` 在 Node 下**可用**（`pdfjs 5.4.449`）：bee p2/p16/p22 的 op 总数 1490/701/1037，`constructPath` 119/3/151 条；每条 `constructPath` args 形如 `[opCount, Float32Array(路径点/矩阵), minMax]`，**`minMax` 能直接拿到每条 path 的轴对齐包围盒**（例：Table 2 三条横线 `[0,0,280.6,0]`；另有图像/裁剪区大盒 `[0,0,1417.3,540]`）。
- 但 `Float32Array` 的路径点编码 + CTM 变换需要自行解码（本次未完成），且 **bee 的表没有竖线**，完整「线框网格」对这类表无收益。
- **可作为 P1 增强**：用横线（宽而扁的 minMax）的 y 坐标**精确切分表头/表体行**，并用于「表格区域上下边界」判定；对真正画边框的表（Excel/Word 导出、部分期刊）再走完整网格。
- 另一个低成本思路：pdfjs 对 **Tagged PDF** 有结构树（`page.getStructTree()`），但 `bee.pdf: Tagged: no`，且真实 PDF 多数无 tag，不作为 P0。

### 2.3 混合策略（推荐形态）

**线框优先做区域/行定位，文本几何做列与单元格**：先用横线/矩形把「表格候选区域」框出来（精度高），区域内再用 gap 法切列填充；无规则线时纯文本几何。caption 锚定作为最终判定/命名依据。

---

## 3. 实测对比

评测口径：**命中** = 在真值表所在 PDF 页上检出候选表；**行列正确** = 预测 `rows×cols` 与真值 HTML 一致；**cell F1** = 单元格文本（去标签、空白归一、小写）多重集 P/R/F1；**bbox IoU** = 预测 bbox 经页内文本锚点拟合映射后与真值 bbox 的 IoU（§1.2 已说明该映射不可靠，仅参考）。候选选择：同页多个候选取 `rows×cols` 最大者。

| 样本 | 真值 | 检出 | 预测 rows×cols | cell P | cell R | **cell F1** | bbox IoU* | 失败/差异原因 |
|---|---|---|---|---|---|---|---|---|
| bee Table 1（PDF p2） | 2×6 | ✅ | **2×6** | 1.000 | 1.000 | **1.000** | 0（映射失真） | 无（HTML 与真值完全一致） |
| bee Table 2（PDF p16） | 11×6 | ✅ | **11×6** | 0.955 | 0.955 | **0.955** | **0.744** | 3 个数学字形 cell：`|𝑉|`/`|𝐸|`/`𝑑𝐺` vs 真值 `|V|`/`|E|`/`$d_G$` |
| bee Table 3（PDF p22） | 4×6 | ✅ | **4×6** | 1.000 | 1.000 | **1.000** | 0.411（映射失真） | 无（HTML 与真值完全一致） |
| attention 4 个 caption | — | 3/4 caption 页产出候选（p6/p9/p10；p8 缺失） | 2–12 行、3–5 列（多窗口未合并） | — | — | — | — | caption 与表跨页/表在 caption 上方；多候选未做 NMS |
| acl 8 个 caption | — | 4/6 caption 页产出候选（p6/p7/p8/p13；p12 缺；p8 三张表混在重叠窗口） | 2–12 行、3–12 列 | — | — | — | — | 宽表/跨栏、紧贴列、相邻表连成一片 |

- **bee 总体**：检出率 **3/3（100%）**；行列正确 **3/3（100%）**；cell F1 平均 **0.985**；每页候选数最终 1 个（未误检正文）。
- **IoU 说明**：Table 2 的 0.744 说明区域定位本身合理；Table 1/3 的低 IoU 主要来自 §1.2 的坐标映射不可比（预测 bbox 在 PDF 点坐标系里是正确的，Table 1 预测 `[130.2,276.1,351.3,300.4]` 正好覆盖 PDF 第 2 页真实表体 y 278.1–289.4 + 上下留白）。
- **补充样本（attention/acl）**：没有人工标注真值，做定性结论：**caption 锚点能可靠找到（4/4、8/8）**，但「caption 与表体关系」是主要失败源（attention Table 1/2 的 caption 在 PDF 页顶而表体在上一页底部/下一页；ACL 宽表列多、无稳定空白间隔）。这两类需要 P0.5 的「跨页表拼接 + 列数自适应 + NMS」才能上量。
- **误报**：bee 三页候选数均为 1、无正文误报；caption 锚定把正文误报压到很低（正文不会以 `Table N.` 开头成行）。

---

## 4. 契约草案（与现有产品代码对接）

### 4.1 `full.md`

MinerU 格式（真值实测）：`caption` 单独一行纯文本 → 空行 → 单行 `<table>`：

```markdown
Table 2. Real data graphs with vertex labels.

<table><tr><td>Dataset</td><td>|V|</td><td>|E|</td><td>d_G</td><td>Core Number</td><td>Type</td></tr><tr><td>Figeys</td><td>2,239</td><td>6,432</td><td>5.7</td><td>10</td><td>Protein</td></tr>…</table>
```

- 建议表头用 `<th>`（阅读台 `mdTryHtmlTable` 支持 `th`/`colspan`/`rowspan`；行号基线 b1a68be：`mdTryHtmlTable` 在 `ui/markdown.js:1049`、`mdParseHtmlTable` 在 `:829`），比 MinerU 全 `<td>` 语义更好；为保持与 MinerU 真值逐字一致也可全用 `<td>`——**两者阅读台都能渲染**。
- **必须绕过 `lib/local-synth.js#escapeMarkdownText`**（它会转义 `<`、`|`、`&`、`]`、`)` 等）：新增 block kind `table`，synthesizer 对 table 输出「caption 行（转义普通文本）+ 空行 + 原样 HTML」。否则 `<table>` 会变成 `\<table\>` 纯文本。
- **与页码标记的相互影响**：`appendPageMarks`（`ui/markdown.js:1437`）按 `content_list` 条目顺序匹配 markdown block 的 plainText 前缀来插页码标记。table 条目按 `table_body` 去标签后的纯文本参与前缀匹配（`mdKindAllowsMatch` 只允许匹配 table block；若只给 bbox 不给 `table_body` 才会走兜底）→ 页码功能不受损；但**表格 block 的 plainText 建议置为「caption + 单元格文本拼接」**，方便其它按文本锚定的功能（高亮/翻译）使用。

### 4.2 `content_list.json`

```jsonc
{
  "type": "table",
  "table_body": "<table><tr><th>…</th></tr><tr><td>…</td></tr></table>", // 单行 HTML，单元格内文本尽量保留 PDF 原文（数学符号可做 Unicode 规范化）
  "table_caption": ["Table 2. Real data graphs with vertex labels."],
  "page_idx": 15,        // 0-based，与 MinerU 一致
  "bbox": [104.1, 116.9, 377.4, 244.4]  // 建议：PDF point、左上原点；文档注明与 MinerU 的差异
}
```

- 合并单元格：`<td colspan=… rowspan=…>`（阅读台支持解析）；**P0 先不做**，P0.5 用「空单元格 + 边界重复」推断。
- 跨页表：P0 不处理（两页各出一表/或丢弃），在 UI/文档标注；P1 做 caption+列数一致的跨页合并。
- 公式单元格：保持文本（`𝑑𝐺`→规范化 `d_G`），不尝试 LaTeX（公式还原是独立课题，见 rich-formulas 笔记）。

### 4.3 与 `lib/local-pdf.js` / `lib/local-synth.js` 的改动面（预估）

- `local-pdf.js`：在 `buildPageBlocks` 后跑 table detector（需要保留每行 items 的 x/width，目前 `extractPdfText` 内部有行结构，表格检测最好插在「行已生成、段落合并前」）；新增 block kind `table`。**新增代码约 150–250 行**。
- `local-synth.js`：处理 `{kind:'table'}`（caption 行 + HTML 不转义）；`content_list` 增加 table 条目。**约 40–60 行**。
- 测试：`test/unit/local-*.test` 增加 bee 三表的快照测试（fixture 已在 lead 目录，可拷/引用）。**约 1–2 小时**。

---

## 5. 替代方案对比与推荐

| 方案 | License/体积 | 现状 | 结论 |
|---|---|---|---|
| **自研文本几何（本原型）** | 0 新增依赖 | 已验证 bee 3/3、F1≈0.985 | **P0 推荐**（1.5–2.5 人日） |
| 自研线框网格（pdfjs operator list） | 0 新增依赖 | 可行但需解码 constructPath/CTM；只对有边框表有效 | **P1**（2–3 人日，和 P0 混合） |
| `pdf-table-extractor`（npm，包装旧 pdfjs） | MIT，约数百 KB | 2017 年后无维护、基于 pdfjs 1.x，与本项目 5.4.449 冲突 | 不推荐 |
| `tabula-js` / tabula | MIT/AGPL?（Java 版，需 JVM） | 外部依赖，违背「纯 Node」目标 | P2 侧车 |
| Python `pdfplumber` / `camelot` | MIT，需 Python + 依赖（camelot 还要 ghostscript/opencv） | 表格抽取质量业界最好，但 = 新增 Python 侧车 | **P2**（与现有 sidecar 结论一致） |
| MinerU 本地/云端 | 已有 | standard 已含 table_body；本地模型数百 MB～GB | 云端已覆盖；本地非「轻量降级」 |
| `officeToPdf` + 本方案 | DSH 服务 | docx 转 PDF 后表格通常有横线，可走线框+文本混合 | P1 组合（可选服务，不能假设存在） |

> 第三方库为静态调研结论（时间盒内未逐个安装实测，体积/许可如需精确值需补测）。

**推荐排序**：
- **P0（必须做，1.5–2.5 人日）**：caption 锚定 + gap 列检测 + 行带裁剪 + 窗口去重（NMS）+ 契约接入。目标：单页、单栏、无合并单元格、有 caption 的表；bee 类论文表 3/3、F1≥0.95。
- **P0.5（1 人日）**：多候选 NMS、caption 在表下方/跨页、数学 Unicode 规范化、首行 `<th>`、表格与页标记/高亮锚点的 plainText 约定、CJK 宽字符宽度修正（size*0.5 近似）。
- **P1（2–3 人日）**：线框网格（constructPath 解码 + CTM + 横竖线归类 + 单元格判定），线框表优先、无框回退文本；用横线 y 坐标精确分行；合并单元格 colspan/rowspan。
- **P2（按需）**：Python 侧车（pdfplumber）或 MinerU 本地；仅当用户对复杂表格质量有强需求时。

---

## 6. 风险与未决问题

1. **caption 是唯一强锚点**：无 caption（表头即 caption）、caption 距表远（attention Table 1）、caption 在表下（部分期刊）会漏检/错配。建议 P0 同时保留「无 caption 的列对齐检测」作为低置信候选，UI 上标「可能表格」或仅在 caption 命中时自动转换。
2. **跨页/跨栏表**：attention 的 Table 1/2 跨页或表体在 caption 上一页，ACL 宽表有多列 + 紧贴文本。P0 明确不承诺；需要在 UI 说明或降级为文本。
3. **合并单元格/多行单元格**：当前会把多行单元格拆成多行，或把合并列的空位当空 cell；影响行列正确率。P0.5 用「相邻行同列空白 + 边界重复」做启发式。
4. **右对齐/CJK/数学字形**：已用 gap 法化解右对齐；CJK 宽度估算（`size*0.5`）需要用真实中文 PDF 验证；数学斜体 Unicode 需规范化表（`𝑑`→`d`、`𝑉`→`V` 等），否则 F1/显示与真值有差。
5. **与现有流水线冲突**：`escapeMarkdownText` 必须为 table 开特例；`local-pdf.js` 当前在段落合并后丢弃了行级坐标，表格检测须前移；`content_list` 增加 table 类型后要确认 `appendPageMarks`/`mdMatchContentEntry`、翻译分块、高亮锚点都不因新 block 崩溃（需要补测试）。
6. **性能**：表格检测只复用已有 `getTextContent` 结果（+ms 级）；若走线框路线，`getOperatorList()` 每页额外 ~10–40ms，且需注意大图页 path 数量（bee p22 有 151 条）。
7. **bbox 契约**：MinerU bbox 与其渲染尺寸绑定（§1.2），本地自产 bbox 用 PDF 点会与 MinerU 产物不一致；当前阅读台不依赖 bbox，建议在 `full.md`/文档中显式声明本地引擎 bbox 语义。
8. **待补真值**：attention/acl 未做行/列/单元格人工标注，本笔记只给定性结论；建议后续用 `pdftotext -layout` 或人工 5 张表标注做补充评测。

---

## 7. 复现命令

```bash
cd /home/nirvana/Documents/dsh-mineru
# 1) 观察真值表在 PDF 页上的 text 坐标（第 2/16/22 页 = page_idx+1）
node .agents/tmp-research/rich-tables/probe.mjs
# 2) 运行表格原型 + 评测（输出 run.log / proto-report.json）
node .agents/tmp-research/rich-tables/proto.mjs
# 关键产物：3 张 bee 表的预测 HTML、rows×cols、cell F1、bbox 映射 IoU、attention/acl caption 与候选页
```

证据文件：`.agents/tmp-research/rich-tables/run.log`（最终指标 JSON）、`proto-report.json`（含预测 HTML、逐表细节）、`page-{1,15,21}.json`（早期 probe 的原始行/线段，注意该批是 1-based 页，已被 +1 结论修正）。

---

## 8. 一句话给 Lead

**P0 自研 caption 锚定 + 空白边界切列（1.5–2.5 人日）**：bee 3/3 检出、行列 3/3 正确、cell F1 0.985，HTML 与 MinerU 几乎逐字一致；**bee 表是无竖线 booktabs 表，线框路线不适用**（P1 仅作有线框表与横线分行）；最大失败类型是 caption 跨页/远离表 + 跨栏宽表（attention/acl 补充样本 3/4、4/6 caption 页出候选），契约接入要注意 `escapeMarkdownText` 特例与 `content_list` table 条目。
