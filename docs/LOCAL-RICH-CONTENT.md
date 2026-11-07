# 本地解析引擎如何还原公式、表格与图片

> 快照：2026-11-07 · 工作仓库 `/home/nirvana/Documents/dsh-mineru`（**研究基线 `b1a68be`**；整理/复核时 main HEAD 已前进到 `0cda21a`，代码行为逐项核对过，但文档中的 `file:line` 可能有漂移——以函数/符号名称为准）· 对象：dsh-litnotes 本地解析引擎（T0 内置 pdf.js / T0.5 officeToPdf）
> 研究范围：**文字层 PDF 的公式 / 表格 / 图片还原**。按用户要求，**扫描件/OCR 本次不研究**。
> 方法：用用户文献库中 MinerU standard 解析稿做真值（BEE 27 页：7×image、16×chart、3×table、1×equation），另用 Attention/ACL 真实论文补充；全部原型实验在本机以 **vendored pdfjs-dist 5.4.449** 完成，未新增依赖、未改产品代码。
> 分论文详细证据：[rich-images.md](research/rich-images.md)、[rich-tables.md](research/rich-tables.md)、[rich-formulas.md](research/rich-formulas.md)、[rich-integration.md](research/rich-integration.md)。

---

## 0. 结论速览

**三件都能还原，但成熟度不同：表格和公式可以纯本地、低成本、高质量还原；图片需要分两步——先定位、再光栅化。**

| 内容 | 本地能否还原 | 推荐方案 | 实测质量（MinerU 真值/人工真值） | 纯本地工作量 |
|---|---|---|---|---|
| **表格** | ✅ 可以，P0 即可 | caption 锚定 + 空白 gap 跨行聚类切列 + 行带裁剪（纯 `getTextContent` 坐标） | BEE 单篇 3 表：3/3 检出、行列 3/3 正确、**cell F1 0.985**（Table1/3 与 MinerU HTML 逐字一致）；样本有限 | **1.5–2.5 人日** |
| **公式** | ✅ 常见公式可，复杂公式降级 | 纯 Node 启发式 LaTeX：run 基线聚类 + 上下标/堆叠分式/根号 + Unicode→LaTeX 符号映射 | Attention 6 式 + BEE equation 3 行（9 样本，其中 3 个 rubric=2）：**平均 Dice 0.95**，eq1 完整还原 `Attention(Q,K,V)=softmax(QK^T/\sqrt{d_k})V` | **1.5–2.5 人日** |
| **图片（位图原图）** | ⚠️ 只覆盖"本来就是位图"的 PDF | 自研纯 JS PDF 对象提取（DCT 直通 / Flate→PNG，含 ObjStm/颜色空间/SMask/predictor） | bee 121ms/27p、attention 372ms；但学术 PDF 整图命中 **bee 0/26、acl 0**（图是矢量） | 3–4 人日（生产化） |
| **图片（矢量图/chart）** | ⚠️ 需先定位再光栅化 | P0：Form XObject `/BBox×Matrix×CTM` 区域定位；P1（**条件路线，未实现**）：浏览器端 pdf.js canvas 裁剪——需先做客户端 raster spike（worker/字体/CSP/内存/缺 standard_fonts/wasm/cmaps），并新增客户端渲染组件与 Host 回传/缓存 API | bee **image+chart 召回 23/23**（table 3/3 不计入）、中位 IoU **0.88**、有图页 15=15；**区域级精度未统计**；区域→像素需 P1 | 区域定位 2–3；客户端光栅 **spike 1–2 + 实现 3–5（条件）** |
| 公式（复杂：矩阵/align/缺字形） | ⚠️ 启发式会失败 | P1 公式区域→图片（视觉保真）；P2 可选 pix2tex LaTeX-OCR 侧车 | bbox 定位 6/6+3/3；裁剪验证正确（pdftoppm 实测） | P1 2–3、P2 2–4 人日 |

**总建议**：先做**契约与管线**（1.5–2 人日）→ 再并行做**公式 + 表格**启发式（各 1.5–2.5 人日，合计 3–4 人日，**灰度开启、默认 off，需扩大样本后再评估默认开**）→ 图片**位图提取 + Form 区域定位**（5–7 人日，先只给 caption/位图真图）→ 视 1–2 天客户端 raster spike 结果，再决定是否做浏览器光栅化（3–5 人日 + Host API）。**基础富内容（表格+公式）约 5–6 人日**；**含图片像素化的完整方案约 13–18 人日**（其中客户端光栅/DSH 扩展仍为条件路线）。图片在完成光栅化前保持 `off`（只保留 caption），避免"仍然没有图"的产品落差。

**关键前提**：阅读台对 MinerU 风格富内容**已可消费**（图片/HTML 表格/KaTeX 公式/混排 content_list；既有匹配器 + 兜底），本地引擎只需产出同构产物；**Client 半零改动**只适用于契约/表格/公式/内嵌位图路径——图片像素化需要新增客户端渲染与 Host 回传/缓存 API，属条件路线（见 §5、§6）。

---

## 1. 背景与现状

### 1.1 本地引擎当前只产文本

| 模块 | 现状 |
|---|---|
| `lib/local-pdf.js` | vendored pdfjs-dist 5.4.449 取 `getTextContent()` → 视觉行 → 标题启发式 → `PageBlock[][]`，**只有 heading/paragraph，无 bbox** |
| `lib/local-synth.js` | 页面块 → `full.md` + 合成 `content_list.json`，**只发 `type:'text'` 条目** |
| `lib/local-engine.js` | 返回 `{markdown, contentList, pages, provider, warnings, stats}`，**无图片文件** |
| `lib/parse-manager.js` | `executeLocalTask` 只写 `full.md` + `content_list.json`（`writeStagedParsed` 本身支持任意 `images/**`） |
| `lib/routes.js` | `/dsh-litnotes/api/asset?id=…&path=…` 已可服务 `parsed/**`（含 `images/`），`ui/app.js` 的 `mruImageUrl` 已把 figure src 转成该路由 |

### 1.2 阅读台已有能力（无需改）

| 富内容 | 解析/渲染 | 关键契约 |
|---|---|---|
| 图片 | `ui/markdown.js#mdDetectFigure`：独立 `![alt](src)`/`<img>` → `{kind:'figure',src,alt,caption}`；<br>`ui/app.js#mruImageUrl` → asset 路由；`figcaption` 渲染 | `src` 在 `parsed/` 下相对路径；caption 可来自 alt/title，**MinerU 风格是图片独立段 + caption 独立文本段** |
| 表格 | `mdTryHtmlTable`（裸 `<table>`，支持 `th/colspan/rowspan`）与 GFM pipe 表 | `content_list` type `table` 的匹配文本取 `table_body` 去标签后的 plainText |
| 公式 | `mdTryBlockFormula`（`$$…$$`/`\[…\]`）+ 行内 `$…$`/`\(…\)`，KaTeX 本地渲染 | `content_list` type `equation` 匹配时去掉 `$$`/`\[\]` 后与 formula block 的 latex 比对 |

### 1.3 真值方法与坐标系

- 真值 = MinerU **standard** 解析稿（BEE，27 页，单栏 pdfTeX/acmart）：`image` 7、`chart` 16、`table` 3、`equation` 1、`text` 198，其余 header/footer 等；`bee-full.md` + `bee-content_list.json` 提供 markdown 写法、混排条目、bbox 与 caption 真值。
- `page_idx` 为 **0-based**；MinerU bbox 为 **0–1000 归一化、左上原点**（用 Form BBox 反算与 pdftoppm 裁剪双重验证）。注意：MinerU bbox 与 PDF 原始点坐标不是简单仿射，评测 IoU 前需按页拟合映射（本报告只在图片区域对比中使用）。
- 补充样本：Attention（15 页单栏）、ACL 2024（17 页双栏）。

---

## 2. 统一契约（三条线共用的地基）

结论：**只要本地引擎输出与 MinerU 同构的 markdown + content_list，阅读台 0 改动**（表格/公式/内嵌位图；图片像素化除外，见 §5）。用 BEE 真值实测（`rich-integration.md` §3）：

- `parseMarkdown(bee-full.md)` → 273 block：heading 26 / paragraph 231 / **figure 10 / table 3 / formula 1** / code 2；大纲 26。
- 加上全量 358 条 content_list 跑 `appendPageMarks` → **页标记 27/27 完整**；**若只保留 text/equation/table/list/title 条目 → 26/27，丢失第 26 页** ⇒ 富条目不是装饰，是页标记完整性的必要条件（`image` 条目按 `img_path` basename 与 figure `src` 匹配）。
- **1 markdown block ↔ 1 content_list entry、顺序一致、`page_idx` 单调** 是本地 synth 的硬约束（设计目标）。**注意 MinerU 真值本身并不满足 1:1**：bee-full.md 273 个 block vs 358 条 CL；24 个图片引用只解析出 10 个 figure block；7 个 image 条目仅 4 个按 basename 命中 figure，其余靠 `lastMatched+1` 窗口兜底。阅读台因此"能工作"，但本地 synth 不能复制真值的非 1:1 行为，否则页标记/锚点会漂移。
- 本地 synth 应输出条目类型：`text`（含 heading 的 `text_level`）、`table`（`table_body`+`table_caption`）、`equation`（`text`=LaTeX）、`image`（`img_path`+`image_caption`）；**不要**输出 `chart/header/footer/page_number/ref_text` 等 MinerU 内部类型（匹配器无对应分支，会走兜底导致页标记偏移）。
- markdown 写法：figure = 独立段 `![alt](images/<sha256>.<ext>)` + caption 独立段；table = caption 独立段 + 空行 + 单行 `<table>…</table>`；formula = 独立 `$$` 块；它们**必须绕过 `escapeMarkdownText`**（否则 `<`/`|`/`&`/`]`/`)` 被转义成纯文本）。
- **图片命名必须用内容 sha256**：figure blockKey = `fnv1a(alt|src)`，改名即换 key，会让批注重锚失效；内容哈希同时天然去重、保证幂等重解析。
- 图片写入管线（Host）：`parsed/images/<sha256>.<ext>`，ext 由 magic 嗅探，白名单 png/jpg/jpeg/webp（**禁 svg**），单张 8 MiB / 总量 64 MiB / 200 张上限，经 `writeStagedParsed` 与 md/CL 同批原子替换；超限/失败 → 降级为 caption 段落 + warning。
- 富 block 插入会改变后续 block 的 `b<index>`：文本批注由 main 已有的 `reanchorAfterParse` 按 quote 重锚兜底；figure/formula 不可批注（现状），table 可批注。
- 消费方现状：翻译只处理 heading/paragraph/quote/list（`mruIsTextBlock`）；AI 检索索引 heading/paragraph/quote/list/table/code，figure/formula 不进索引 ⇒ **caption 必须保持独立文本段**（可翻译、可检索、可引用）。
- 配置：`local.rich = { images: off|embedded|crop, tables: off|heuristic, formulas: off|heuristic, maxImageBytes, maxTotalImageBytes, maxImages }`；能力快照 `capabilities.images/tables/formulas` 按实际可用性上报。

最小改动集（Host 5 文件）：`lib/local-synth.js`（富 emitter + 混排 CL + 降级）、`lib/local-engine.js`（images 收集/校验/上限 + `files` + rich 配置）、`lib/local-pdf.js`（rich 提取 hook）、`lib/parse-manager.js`（写 `files` + rich 统计）、`lib/config.js`（`local.rich` 校验）。**这 5 文件对应表格/公式/内嵌位图，阅读台零改动；图片像素化需要额外的客户端组件 + Host 回传/缓存 API（条件路线，不计入最小改动集）**。

---

## 3. 表格还原

### 3.1 结论

**纯 Node 文本几何法在真实论文表上质量很高**：BEE 3 张表（booktabs 风格、无竖线）**3/3 检出、行列 3/3 完全正确**（2×6、11×6、4×6），**单元格文本 F1 = 1.000 / 0.955 / 1.000（均值 0.985）**，生成的 HTML 与 MinerU `table_body` 几乎逐字一致（Table 1、3 完全一致）。差异仅数学斜体 Unicode（`|𝑉|` vs `|V|`、`𝑑𝐺` vs `$d_G$`），需做字形规范化。

### 3.2 算法（P0，caption 锚定 + 空白边界切列）

1. **caption 锚定**：行首匹配 `^Table\s+\d+[.:\s]`；同时扫描 caption 下方/上方（兼容 caption 在表下）。
2. **行带**：从 caption 相邻行收集视觉行，直到垂直间距 > `max(行距×2.4, 40pt)`。
3. **共享列边界（核心）**：逐行计算相邻 item 的空白 gap 中心 `(prevEnd+nextStart)/2`，跨行聚类（容差 5pt），保留支持率 ≥70% 的边界 → 列区间。**比按列起始 x 聚类更抗右对齐/合并空白**。
4. **成表判定**：列≥3、行≥2；裁掉尾部与共享边界匹配度低的行（正文误入）；窗口按「行×列」打分并做包含去重。
5. 输出 `<table>` + caption；`content_list` 条目 `{type:'table', table_body, table_caption, page_idx, bbox}`。

### 3.3 边界与失败类型（实测）

| 场景 | 结果 |
|---|---|
| BEE booktabs（无竖线） | ✅ 3/3；线框法对此类**不适用**（PDF 里只有 3 条横线，无竖线） |
| 有线框表（Excel/Word 导出、部分期刊） | P1 线框网格可增强（pdfjs operator list 能拿 `constructPath`/`minMax`；需解码点集+CTM），P1 2–3 人日 |
| caption 远离/跨页（Attention Table 1/2） | P0 不承诺；attention 补充样本 3/4 caption 页产出候选 |
| 双栏宽表/紧贴列/相邻表粘连（ACL） | P0 不承诺；ACL 4/6 caption 页出候选、需 NMS/跨栏处理 |
| 合并/多行单元格 | P0 不做（P0.5 用相邻行空白+边界重复启发式） |

### 3.4 替代方案与推荐

不推荐引入 npm 表格库（pdf-table-extractor 停止维护、绑定旧 pdfjs；tabula 需 JVM）。Python `pdfplumber`/camelot 质量最好但属 P2 侧车。**推荐 P0 自研（1.5–2.5 人日）+ P0.5 补强（~1 人日：caption 在下方/跨页、Unicode 规范化、`<th>`、NMS）+ P1 线框（2–3 人日）**。

---

## 4. 公式还原

### 4.1 结论

**纯 Node 启发式 LaTeX 初步可行（9 个手工真值样本，样本有限）**：在 Attention 6 个公式 + BEE equation 3 行上 **平均 Dice 0.95**（1.00 / 0.96 / 1.00 / 0.94 / 0.95 / 0.95；0.96 / 0.89 / 0.89），典型输出：

```latex
\mathrm{Attention}(Q, K, V) = \mathrm{softmax}\left(\frac{QK^{T}}{\sqrt{d_{k}}}\right)V
```

可还原：单行 display 公式、嵌套上下标、**堆叠分式 `\frac`**、根号 `\sqrt`、希腊字母/数学符号、函数名 `\mathrm{}`、多行独立公式（逐行 `$$`）。公式行检测在 attention 页 4–6 **6/6 召回、0 误报**。

### 4.2 算法（P0）

1. 复用 `page.getTextContent()` 的 run 级数据（`str/height/transform[4]=x/transform[5]=y`）。
2. 基线聚类成 row；`height < 8.5` 视为 script run（上下标）。
3. **公式行检测**：主行 `h≥8.5`、长度≤72、含 `=`、行尾非句号（避免正文误判）。
4. **上下标**：小字号 run 按 |Δy|≤0.75×字号 挂到邻近 base atom，按 y 相对位置决定 `^{}`/`_{}`，支持递归；同基线 script 作为 sibling。
5. **堆叠分式**：主行上下 3.5–0.95×字号 范围内找全字号、短跨度（<0.35 页宽）、x 有重叠的行对 → `\frac{分子}{分母}` 填入主行空隙。
6. **根号**：主行 `√` 字形 + 邻近分式 → `\sqrt{…}`。
7. **符号映射**：Unicode 数学字母/希腊字母/运算符 → LaTeX；函数名 → `\mathrm{}`；清理公式编号/`where`。
8. 只在 KaTeX 支持的命令范围内生成；生成后可用 KaTeX 渲染校验，失败退回线性文本。

### 4.3 注定失败的公式类型

矩阵/`align`/`cases`/大型多行对齐（无环境结构信息）、文本层缺字形（Type3/矢量绘制）、inline 公式（本机实测 `√d_k` 会被拆到不同行）、**上下标语义归属歧义**（`W_i^Q` 可能被挂成 `W_{i^{Q}}`；实测 A3 案例 Dice=1.00 但 rubric=2，因为 Dice 令牌集对嵌套括号不敏感）→ **inline 公式保持线性文本不动**（避免破坏 content_list↔block 1:1 与翻译分块）；失败时保留线性文本并加 confidence/降级，不输出"假 LaTeX"。**Dice 不能单独当验收门槛，必须叠加人工 rubric**。

### 4.4 公式图片（P1）与侧车（P2）

- **公式区域→图片已验证**：MinerU bbox（0–1000 归一化）反算页面像素，`pdftoppm -r 150 -x -y -W -H` 裁出的 bee 公式图正是目标公式；启发式检测率 6/6 + 3/3，bbox 可自产。
- **光栅化路径**：客户端 pdf.js + canvas 是**条件候选（未实现）**——零新增 npm 依赖但需要新增客户端渲染组件 + Host 回传/缓存 API，且需先 spike 验证当前 vendored 子集（缺 `standard_fonts/wasm/cmaps`）的渲染质量/CSP/内存；服务端 `pdftoppm` 仅作可选回退（跨平台不一致）；DSH `libreoffice-kit` 的 PDFium renderImages 实测可 PDF→PNG（见第 5 节），但 `officeToPdf` 服务未暴露该 API，需跨仓库扩展。
- **代价**：图片公式视觉保真但不可搜索/翻译/AI 检索；建议只在低置信/矩阵/align 类公式使用，alt 写线性文本兜底。
- **侧车（P2）**：pix2tex/LaTeX-OCR（**代码 MIT**，CPU 可跑，权重许可未单独标注）是首选；Texify **GPL-3.0**、Nougat **权重 CC-BY-NC-4.0** 应避让；PaddleOCR-VL-1.6 **Apache-2.0**（质量最高但侧车重、CPU 未验证）；已有 MinerU 本地/Docling 的用户直接复用其 `$$` LaTeX。

**推荐**：P0 启发式（1.5–2.5 人日）→ P1 公式图片（2–3 人日，依赖光栅化条件路线）→ P2 可选 pix2tex 侧车（2–4 人日）。验收：fixtures **Dice≥0.85 且逐条 rubric≥2、均值≥2.5** + golden test 防"假 LaTeX"（Dice 单独会放过语义错）。

---

## 5. 图片还原（分两步：定位 → 光栅化）

### 5.1 结论

学术 PDF（尤其 LaTeX/pdfTeX）的插图**绝大多数是矢量 Form XObject，不是位图**：BEE 的 26 个 MinerU 图块在 PDF 里只有 3 个位图（且是 Fig.3 内的三个小图标），其余是 Form 矢量绘制；ACL 论文 0 个位图。因此：

1. **纯 JS 位图提取**（DCT 直通 + Flate→自写 PNG，含 ObjStm/颜色空间/predictor/SMask/上限）**可行且快**（bee 121ms/27 页、attention 372ms、acl 162ms），但**整图覆盖率极低**（bee 0/26、acl 0；attention 3 个真图，含 1520×2239 整幅）——只能覆盖"本来就是位图"的 PDF（部分 Word/PPT 导出、扫描图层）。
2. **关键正向发现：Form 区域定位**。纯 JS 用 Form XObject 的 `/BBox × /Matrix × CTM` 可精确定位矢量图区域：BEE 170 次 Form 放置 → 邻近聚类 **22 个区域**，MinerU 的 **image+chart 召回 23/23**（table 3/3 不计入；中位 IoU **0.88**、最小 0.35），**"有 Form 的 15 页"与"有图的 15 页"完全一致（页级）**；**区域级精度未统计、"零假阳性"不能外推**。这意味着**不需要 ML 版面模型就能定位 LaTeX 论文的图区域**。
3. **区域→像素需要光栅化**：
   - Node 下 pdf.js operator list 可用（能拿到 image objId/宽高、`paintFormXObjectBegin` 的 `[matrix, bbox]`），但 `page.objs.get()` 抛 "not resolved yet"、`commonObjs` 缺失、`ImageData/Path2D` 无法 polyfill ⇒ **渲染必须引入 canvas**（`@napi-rs/canvas` MIT，36.9 MB/平台，P2）。
   - **浏览器端 pdf.js + canvas 裁剪是 P1 条件候选（未实现）**：复用已 vendor 的 pdf.js（Apache-2.0，1.5 MiB）+ `/api/source` + canvas 按 bbox 裁剪 → PNG；零新增 npm 依赖、平台无关，但与阅读台只是"共享同一份 pdf.js 代码"——阅读台并不渲染 PDF 页面，这条渲染路径是新代码。必须先做 1–2 天 spike：动态 import/worker、当前 vendored 子集缺 `standard_fonts/wasm/cmaps` 对字体/JPEG2000/CJK CID 渲染质量的影响、CSP、移动端内存、100–500ms/页、取消/并发；并新增客户端渲染组件 + Host 回传/缓存 API（上传与写盘限额、时序）。
   - **DSH `libreoffice-kit`（PDFium wasm）实测可 PDF→PNG**：bee 27 页 @120dpi 8.9s / 7.7 MB（单页 5.4s 含冷启动），但当前 `officeToPdf` 服务只暴露 Office→PDF，**无 PDF→PNG API，需 DSH 跨仓库扩展**（作为 headless/导出场景补充）。
   - `pdftoppm`（poppler）仅可选回退（跨平台不一致）。

### 5.2 图片契约与降级

- 文件：`parsed/images/<sha256>.<ext>`（内容哈希、去重、幂等）；白名单 png/jpg/jpeg/webp，禁 svg；上限单张 8 MiB / 总量 64 MiB / 200 张。
- markdown：独立 `![](images/<sha256>.<ext>)` + caption 独立文本段（保留翻译/AI 检索）；`content_list`：`{type:'image', img_path, image_caption, page_idx, bbox}`（不重复 caption 为 text 条目）。
- 降级：位图解码失败/不支持 Filter（JPX/JBIG2/CCITT/LZW）/矢量图未光栅化 → 不写假图，仅保留 caption 文本段 + `warnings`（`image-unavailable` 等）。**表格区域禁止走图片管线**（表格由 HTML 表负责）。
- **小图标过滤**：无 caption 且放置面积 < 页面积 1.5% 的位图（如 BEE Fig.3 内箭头图标）作为装饰丢弃，避免图内图标被当成多张图。
- **透明通道陷阱（实测）**：BEE 的 3 个 DCT 位图都带 `/SMask` alpha，JPG 不支持透明 → 直通导出会黑底；生产策略：无 SMask 的 DCT 直通 jpg，带 SMask 的需合成 PNG（纯 JS JPEG 解码成本高，可用 canvas/pdf.js）。**P0 能力边界要写清：带 SMask 的 DCT（尤其大图）在无 canvas 条件下不可用 → 记 `image-unavailable:smask` 降级为 caption；P0 只安全覆盖无 SMask 的 DCT 与 Flate 位图**，否则会被误以为 P0 能覆盖所有位图。

### 5.3 推荐路线

| 阶段 | 内容 | 人日 |
|---|---|---|
| **P0** | 纯 JS 位图对象提取（对象/ObjStm/页面树/内容流 Filter/颜色空间/predictor/PNG encoder/上限 + 单测 + 集成；**无 SMask DCT 与 Flate 位图**） | 3–4 |
| **P0.5** | Form 区域定位（可复用 pdf.js op list 的 form begin/end 或纯 JS Form 解析）+ 邻近聚类 + caption 关联 + 表格/公式排除 | 2–3 |
| **P1（条件）** | 先 spike（1–2d：worker/字体/CSP/内存/渲染质量）→ 浏览器端 pdf.js 渲染 + bbox 裁剪 + 懒加载/缓存/降级 + **新增 Host 回传/缓存 API**；headless 导出场景再推动 DSH PDF→PNG 服务（跨仓库 2–3d） | 实现 3–5（+ Host API） |
| **P2** | `@napi-rs/canvas` vendor（36.9 MB/平台）或其它光栅方案 | 按需 |

> **最大风险**：不做 P1 光栅化，学术 PDF 会"仍然没有图"（Form 区域只能定位、不能显示）；必须把「区域定位 P0」与「光栅化 P1」绑定规划，中间态只显示 caption。

---

## 6. 分期实现计划（统一）

### 阶段 A —— 契约与管线（1.5–2 人日，不依赖算法）
`local-synth` 富 emitter + 混排 content_list + 图片缺失降级；`local-engine` 收集/校验 images 与 `files`、`local.rich` 配置与能力上报；`parse-manager` 写 `files` + rich 统计；`config` 校验；**用合成 rich fixture 打通 synth→写盘→`document.markdown`→parseMarkdown→appendPageMarks**（含 1:1、页标记 1..N、key 稳定、caption 段落）；text-only 回归不变。提取器可先 no-op（`off`）。

### 阶段 B —— 公式 + 表格启发式（3–4 人日，可并行）
- 公式：`lib/local-formula.js`（纯函数）+ `local-pdf` 保留 run 级数据 + `synth` equation 输出 + golden/评分测试；`formulas:'heuristic'` 灰度开启。
- 表格：`lib/local-table.js`（caption 锚定 + gap 列 + 行带裁剪 + NMS）+ `synth` table 输出（HTML 不转义）+ `<th>`/Unicode 规范化；`tables:'heuristic'` 灰度开启。
- 验收：BEE fixtures 公式 Dice ≥0.85、表格 cell F1 ≥0.95、页标记完整、阅读台渲染/翻译/检索正常、误检率可控（每页数量上限 + 置信度 + banner）。

### 阶段 C —— 图片（位图+区域定位 5–7 人日；像素化为条件路线，另计）
1. C1 位图原图提取（3–4d）：先覆盖"有位图"的 PDF（Word/PPT/部分图表）；`images:'embedded'` 灰度；**P0 只安全覆盖无 SMask DCT 与 Flate 位图，带 SMask 大图记 `image-unavailable:smask`**。
2. C2 Form 区域定位（2–3d）：为每个图区域产 caption/bbox；光栅化前仅显示 caption + `warnings`；**只承诺 image+chart 召回（table 不计入），区域级精度需在本阶段补测**。
3. C3 客户端光栅化（**条件路线**：1–2d spike 先行，验证通过后 3–5d 实现）：动态 import `/dsh-litnotes/assets/pdfjs/pdf.mjs` + `/api/source` + canvas crop → 通过**新增 Host 回传/缓存 API** 写入 `parsed/images/<sha>.png`；实现"解析完成先显示 caption，图生成后替换"；spike 必须覆盖：当前 vendored 子集缺 `standard_fonts/wasm/cmaps` 的渲染质量（字体/CJK CID/JPEG2000）、worker/CSP、移动端内存、取消/并发/时序。spike 不通过则回落 D/侧车。
4. 可选 D（headless/导出）：推动 DSH `officeToPdf` 增加 PDF→PNG（底层 PDFium 已实测可用），2–3d + 跨仓库协调。

### 阶段 E —— 可选侧车（按需）
pix2tex（公式 LaTeX 兜底，MIT）、已有 MinerU 本地/Docling 的 `$$` 复用；仅在用户自行安装时启用，不默认。

### 验收与质量门槛（建议写进 PR 验收）
- 契约：混排 CL ↔ block 1:1、页标记 1..N 完整、figure src/CL img_path 一致、key 确定性、caption 独立段、失败降级不丢文本。
- 质量：BEE fixtures 上表格 cell F1 ≥0.95（**样本仅 3 表，需扩到 ≥10 张多模板表再谈默认开**）；公式 **Dice≥0.85 且逐条 rubric≥2、均值≥2.5**（Dice 单独会放行"假 LaTeX"，如 `W_{i^{Q}}`）；图片 **image+chart 召回 ≥90%（IoU≥0.2）+ 中位 IoU≥0.8**（明确分母不含 table；区域级精度需另测）；attention/acl 上人工抽检误检率。
- 性能：rich 提取使本地解析耗时增量 ≤50%、内存峰值 ≤+50%；图片有上限/超时/并发控制。
- 回归：`node scripts/check.mjs` 全绿；text-only 解析产物与现状一致。

---

## 7. 风险与未决问题

| # | 风险 | 缓解 |
|---|---|---|
| 1 | **"假 LaTeX"**：语法合法但语义错 | confidence + rubric/golden test + 低置信降级为线性文本/图片；UI 标注"公式可能不完整" |
| 2 | 表格/公式误检（正文被误判） | caption 锚定 + 数量上限 + 置信度 + 每页 rich 上限 + banner + 可关闭开关 |
| 3 | 图片光栅化依赖（客户端/DSH）**且客户端渲染路径未验证** | P0 只做位图+区域定位；crop 作为显式配置；先 1–2d spike（缺 standard_fonts/wasm/cmaps 的渲染质量、worker/CSP/内存）；降级 caption；headless 走 DSH 扩展 |
| 4 | 富 block 插入导致批注 index 位移 | 已有 `reanchorAfterParse` 按 quote 重锚 + dropped 提示；新增 golden 测试 |
| 5 | 图片透明/颜色空间/编码缺失（SMask 黑底、JPX/JBIG2/CCITT；**带 SMask 的 DCT 在 P0 不可用**） | 过滤小图标 + 无 SMask DCT/Flate 直通 + 其余降级 caption + `image-unavailable:smask` warning |
| 6 | caption 依赖（跨页/远离/双栏宽表） | P0 明确不承诺；P1 跨页/跨栏增强；UI 提示 |
| 7 | 坐标契约不一致（MinerU bbox 0–1000 vs 本地 PDF 点） | 本地 bbox 统一用 PDF 点（左上原点）并文档化；阅读台不依赖 bbox；MinerU 对比时按页拟合 |
| 8 | 性能/内存（run 级处理、page render、大图） | 上限/超时/取消/并发；rich 失败不影响文本；懒渲染 |
| 9 | 隐私/版权 | 全部本机处理；客户端裁剪不上传原文件（仅上传派生 PNG 到本机 Host）；图片资产随导出包含原图需产品说明 |
| 10 | 跨仓库依赖（DSH PDF→PNG） | 不阻塞 P0/P1；作为条件增强 |
| 11 | 样本代表性不足：表格真值仅 BEE 一篇 3 表、公式仅 9 个手工样本、图片仅 3 篇 PDF | 验收前扩样本（≥10 表/≥20 公式/不同模板 PDF）+ 人工 rubric；默认 off/灰度，样本达标再开 |
| 12 | MinerU 真值非 1:1（273 block vs 358 CL、24 图引用 vs 10 figure block） | 本地 synth 自建严格 1:1；不要用真值的非 1:1 行为作为契约基准 |

**未决问题**：① 图片默认策略（embedded 位图 + 条件性客户端 crop 是否满足"有图"预期；客户端 raster spike 是否通过）；② 是否把表格纳入翻译（现不翻译）；③ 公式/表格启发式灰度策略（建议默认 off，样本达标后再开）；④ 双栏/跨页表格与公式的 P1 优先级；⑤ 导出 zip（full.md + images）是否必须。

---

## 8. 结论

**「本地解析能不能还原公式、表格、图片？」——能，且不需要引入任何 npm 依赖：**

- **表格**：文本几何法在 BEE 单篇 3 张表上初步可用（3/3、F1 0.985），是**性价比最高**的一项（1.5–2.5 人日）；但样本只有一篇单栏 booktabs 论文，需扩样本后再谈默认开；
- **公式**：启发式 LaTeX 覆盖常见单行/上下标/分式/根号（9 样本 Dice 0.95，其中 3 个 rubric=2，存在上下标语义错），复杂公式用公式图片兜底；**不建议把侧车作为默认路径，也不建议以 Dice 单独作为验收门槛**；
- **图片**：学术 PDF 图多为矢量，必须「Form 区域定位（image+chart 召回 23/23、中位 IoU 0.88）+ 光栅化」；纯位图提取只能覆盖一部分 PDF（bee 0/26、acl 0，attention 3 个真图）；**光栅化首选客户端 pdf.js 是条件路线——需先 spike 并新增客户端渲染组件 + Host 回传 API，尚未实现/未验证**；
- 落地建议按「契约管线 → 公式/表格（灰度） → 图片位图+区域定位 → （条件）像素化 → 可选侧车」推进：**基础富内容（表格+公式）约 5–6 人日；含图片像素化的完整方案约 13–18 人日**（其中客户端光栅与 DSH 跨仓库扩展为条件项）；阅读台零改动仅适用于契约/表格/公式/内嵌位图路径。

**建议下一步**：先立项阶段 A（契约/管线，1.5–2 人日）+ 阶段 B（公式/表格启发式，3–4 人日，可并行）——完成即可让无 Token 用户的本地解析稿具备**表格与公式**；图片按阶段 C 单独排期（其中 P1 浏览器 crop 需产品确认是否接受"首屏后渐进补图"的体验）。扫描件/OCR 按用户要求暂不纳入。

---

## 附录：证据与复现

- 真值 fixtures（仓库外，**不入库/不随发布物提交**）：`/home/nirvana/Documents/dsh-mineru/.agents/tmp-research/lead/rich/{bee.pdf,bee-content_list.json,bee-full.md,attention.pdf,acl.pdf}`。来源：用户本地文献库中已用 MinerU standard 解析的公开论文（BEE, SIGMOD 2025）与公开论文 Attention/ACL 2024；仅用于结构/质量评估，文档只引用必要的标题/caption/表格/公式片段，未复制正文；如论文/数据敏感，请删除对应引用。
- 行号说明：研究笔记的行号采集于 `b1a68be`；当前 main HEAD 已前进（`0cda21a` 及之后），`file:line` 可能漂移，正文契约以函数/符号名称为准（复核见 [rich-review.md](research/rich-review.md)）。
- 研究笔记与脚本：
  - [rich-images.md](research/rich-images.md)：`.agents/tmp-research/rich-images/{extract.mjs,compare-forms.mjs,render-bench.mjs,out-*/,render-bee-all/}`
  - [rich-tables.md](research/rich-tables.md)：`.agents/tmp-research/rich-tables/{probe.mjs,proto.mjs,proto-report.json}`
  - [rich-formulas.md](research/rich-formulas.md)：`.agents/tmp-research/rich-formulas/{reconstruct.mjs,dump-runs.mjs,att-result.json,bee-result.json,score.json}`
  - [rich-integration.md](research/rich-integration.md)：`.agents/tmp-research/rich-integration/{contract-spike.mjs,spike-output.json}`
- 代码事实：`lib/local-pdf.js`、`lib/local-synth.js`、`lib/local-engine.js`、`lib/parse-manager.js`、`ui/markdown.js`（`mdMatchContentEntry`/`appendPageMarks`）、`ui/app.js`（`mruImageUrl`/`mruIsTextBlock`）、`lib/ai/retrieval.js`、`lib/routes.js`。
- 外部依据：MinerU Output Formats <https://opendatalab.github.io/MinerU/reference/output_files/>；pdf.js <https://github.com/mozilla/pdf.js>（Apache-2.0）；pix2tex <https://github.com/lukas-blecher/LaTeX-OCR>（MIT）；Texify <https://pypi.org/project/texify/>（GPL-3.0）；Nougat <https://huggingface.co/facebook/nougat-base>（权重 CC-BY-NC-4.0）；PaddleOCR-VL <https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6>（Apache-2.0）；libreoffice-kit（MPL-2.0）。
