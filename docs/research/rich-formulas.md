# 本地解析如何还原公式（rich formulas）

> 快照：2026-11-07。工作仓库 `/home/nirvana/Documents/dsh-mineru`（**研究基线 `b1a68be`**；复核时 main HEAD 已前进到 `0cda21a`，行号可能漂移，以符号名为准；fixtures 来自用户本地库中的公开论文，仅结构/质量评估、不随仓库提交）。
> 实验脚本与产物：`.agents/tmp-research/rich-formulas/`（`reconstruct.mjs`、`dump-runs.mjs`、
> `att-result.json`、`bee-result.json`、`score.json`、`bee-formula-crop-08.png`）。
> 真值 fixtures（只读）：`.agents/tmp-research/lead/rich/`（bee.pdf + bee-content_list.json +
> bee-full.md、attention.pdf、acl.pdf）。方法：用仓库自带的 vendored pdf.js 5.4.449 抽 runs，
> 写启发式 prototype 实测评分 + 用 poppler `pdftoppm` 验证公式图片路线；未安装任何 ML 模型。

---

## 0. 结论摘要

1. **路线 A（纯 Node 启发式）显著可行，应作为 P0**。prototype 在 9 个目标公式上 **平均 Dice
   相似度 0.95**（Attention 6 个：1.00/0.96/1.00/0.94/0.95/0.95；bee equation 3 行：
   0.96/0.89/0.89），可正确还原：上下标（含嵌套）、**堆叠分式 `\frac`、根号 `\sqrt`**、
   希腊字母/数学符号、函数名（softmax/mean/max/sin…）、多行公式（逐行 $$ 块）。
   失败/降级：矩阵/align 环境、上下标语义归属歧义（`W_i^Q` 被挂成 `W_{i^{Q}}`）、
   文本层缺字形（Type3/矢量绘制）、跨栏/跨页公式、公式编号。
2. **路线 B（公式→图片）也验证可行**：用 MinerU 真值 bbox `[345,556,646,634]`（page_idx 7，
   0–1000 归一化坐标）反算 PDF 页面 8 的像素框，`pdftoppm -r 150 -x -y -W -H` 裁出的
   `bee-formula-crop-08.png`（304×117）**正是目标公式**——bbox 映射与裁剪都准确。
   推荐**客户端 pdf.js + canvas** 做 raster（零外部工具），服务端 `pdftoppm` 只作可选回退
   （跨平台不一致）。公式图片视觉保真但丢失 LaTeX/可搜索文本/翻译能力。
3. **路线 C（ML 侧车）里最实际的是 pix2tex/LaTeX-OCR**（代码 MIT、CPU 可跑、体积小），
   但它是「公式图→LaTeX」的第二步，仍依赖路线 B 的公式区域检测；**不能替代路线 A**。
   Nougat 权重 CC-BY-NC-4.0（禁商用）、Texify 代码 GPL-3.0-or-later，许可上需避让；
   PaddleOCR-VL-1.6 质量最高（OmniDocBench 96.34）且权重 Apache-2.0，但 0.9B 侧车重、CPU 未验证。
4. **推荐分层**：P0 启发式 LaTeX（`$$` 块 + equation 契约，inline 保持现状只做符号排版整理）；
   P1 公式图片（客户端 raster，命中失败类型时兜底）；P2 可选 LaTeX-OCR 侧车（用户自行安装）。
   已有本地侧车（MinerU 本地/Docling）的用户优先用其原生 `$$` LaTeX（见 `sidecars.md`）。
5. **最大风险**：① 文本层本身缺字/把公式拆散（本机已见 inline `√d_k` 的根号与 d_k 跨行分裂）；
   ② 启发式错误会以「看起来像 LaTeX 但语义错」的形式呈现，必须加 confidence/降级；
   ③ 新增公式块会改变 block 结构，需检查高亮锚点 reanchor 与翻译分块。

---

## 1. 真值与本地文本层形态

### 1.1 bee.pdf（MinerU standard 真值）
- `bee-content_list.json`：唯一 equation 项
  `{"type":"equation","text":"$$\n\\begin{array}{l} \\alpha = \\text {density} (Q), \\\\ ... \\end{array}\n$$","text_format":"latex","bbox":[345,556,646,634],"page_idx":7}`；
  `bee-full.md` 第 160–162 行是同一 `$$` 块。
- 坐标核实：**`page_idx` 是 0 基**（对应 PDF 第 8 页）；bbox 是**页面归一化 0–1000 坐标**
  （x 345–646 / y 556–634；页面 486×720 pt）。按 `x*W/1000`、`y*H/1000` 反算并用
  `pdftoppm` 裁剪，得到正确公式图（见 §3）。
- 文本层形态：三行基线 y=308.9 / 293.8 / 272.9；符号保留为 Unicode 数学斜体
  （`𝛼 𝛽 𝛾 𝑄 𝐶 𝑉 𝑢`）、`−`、`∈`、`|`、`/`；**分式是线性 `/`**（不是堆叠），
  上下标是**独立小字号 run**（h=7.3 / 5.5，y 偏移 +1.5/+2.6，基线偏移可判）。

### 1.2 attention.pdf（公式丰富，人工 ground truth）
本地文本层（pdf.js）逐 run 形态（以 eq(1) 为例）：

| 内容 | y | x | h | 说明 |
|---|---|---|---|---|
| `QK` | 318.0 | 355.6 | 10.0 | 分子（在主线之上 6.8pt） |
| `T` | 321.6 | 372.7 | 7.0 | 分子的上标 |
| `√` | 311.5 | 358.1 | 10.0 | 根号字形（大字号、基线居中） |
| 主线 `Attention(Q, K, V ) = softmax(` … `)V` | 311.2 | 220–390 | 10.0 | 主行 |
| `d` | 303.8 | 366.4 | 10.0 | 分母 |
| `k` | 302.3 | 371.6 | 7.0 | 分母下标 |

即：**堆叠分式在文本层里是「上下两行 run + 主行空隙 + 根号字形」**，可被启发式还原；
而 `MultiHead`/`FFN`/`PE` 的上下标是 h=7/5 的小 run，`√d_k` 的 inline 版本则被拆到
不同行（页 4：√ 在 y=400.6、正文在 y=392.8）→ **inline 公式不可靠，本次不做还原**。

---

## 2. 路线 A：启发式 LaTeX 重建（prototype 实测）

### 2.1 算法（`reconstruct.mjs`，约 300 行，可移植进 `lib/local-pdf.js`）
1. **run 抽取**：`page.getTextContent()` → `{str, height, width, transform[4]=x, transform[5]=y}`
   （复用 `lib/local-pdf.js` 的 `loadPdfjs()`；零新依赖）。
2. **基线聚类**：按 y 聚类（tolerance 0.9pt）→ rows；row.h = 最大字号；`h<8.5` 视为
   script run（上下标）。
3. **公式行检测**（P0 规则，实测 6/6 召回、0 误报）：`h≥8.5` 且 文本长度 ≤72 且 含 `=`，
   行尾非句号。避免把正文（含 softmax/公式符号的长句）误判。
4. **上下标**：把主行 run 作为 base atom；邻近（|Δy| ≤ 0.75×字号）的小 run 按 x 邻近挂到
   base atom；**同基线的 script 是 sibling 而非嵌套**；支持递归（`10000^{2i/d_{model}}`
   的 `model` 是 `i/d` 的下标）；按 y 与 base 的相对位置区分 `^{}`/`_{}`。
5. **堆叠分式**：主行上下两侧（Δy∈(3.5, 0.95×字号)）各找全字号、短跨度（<0.35 页宽）、
   x 有重叠的 row 对 → `\frac{分子}{分母}`，填入主行的水平空隙。
6. **根号**：主行中的 `√` 字形若在分式附近，则把分式分母包成 `\sqrt{...}`（Attention eq1 命中）。
7. **符号映射**：Unicode → LaTeX（α→`\alpha`、∑→`\sum`、√→`\sqrt`、∈→`\in`、≤/≥/×/·/→…，
   数学字母 U+1D400–1D7CA 全区间折叠，含希腊）；函数名 softmax/max/min/sin/cos/mean/std/
   density/Concat/Attention/MultiHead/FFN → `\mathrm{}`；清理 `(1)`/`(2)` 公式编号、
   开头的 `where`、`P E`→`PE`、命令后接字母补空格（`\in V`）。
8. **多行公式**：相邻且都含 `=` 的公式行按 y 间距 ≤2.3×字号判定为同一多行公式
   （可输出 `\begin{array}{l} ... \\ ... \end{array}`；prototype 对 bee 三行暂输出为 3 个
   独立 `$$` 块，接入时改成 array 即可）。

### 2.2 实测输出（`att-result.json` / `bee-result.json`）

| # | 目标 | prototype 输出 LaTeX | Dice | rubric |
|---|---|---|---|---|
| A1 | Attention eq(1) | `\mathrm{Attention}(Q, K, V) = \mathrm{softmax}(\frac{QK^{T}}{\sqrt{d_{k}}})V` | **1.00** | 3 |
| A2 | MultiHead | `\mathrm{MultiHead}(Q, K, V) = \mathrm{Concat}(head_{1}, ...,head_{h})W^{O}` | 0.96 | 3（head 未 \mathrm） |
| A3 | head_i eq(3) | `head_{i}= \mathrm{Attention}(QW_{i^{Q}}, KW_{i^{K}}, V W_{i^{V}})` | 1.00† | 2（`W_i^Q` 归属歧义） |
| A4 | FFN eq(2) | `\mathrm{FFN}(x) = \mathrm{max}(0, xW_{1}+b_{1})W_{2}+b_{2}` | 0.94 | 3 |
| A5 | PE sin | `PE_{(pos,2i)}=\mathrm{sin}(pos/10000^{2i/d_{model}})` | 0.95 | 3 |
| A6 | PE cos | `PE_{(pos,2i+1)}=\mathrm{cos}(pos/10000^{2i/d_{model}})` | 0.95 | 3 |
| B1 | bee α 行 | `\alpha=\mathrm{density}(Q),` | 0.96 | 3 |
| B2 | bee β 行 | `\beta=-\mathrm{mean}(|C(u)|_{u\in V_{Q}})/\mathrm{max}_{u\in V}|C(u)|,` | 0.89 | 2（`V_Q` 的嵌套 Q 丢失） |
| B3 | bee γ 行 | `\gamma=-\mathrm{std}(|C(u)|_{u\in V_{Q}})/\mathrm{max}_{u\in V}|C(u)|,` | 0.89 | 2（同上） |

**平均 Dice 0.95**（Dice = 归一化 token 多重集合的 2|A∩B|/(|A|+|B|)，去 `\mathrm`/空格；
† A3 的 Dice 1.00 是因为评分令牌集对嵌套括号不敏感，人工 rubric 仍记 2）。
Rubric：3=结构正确可渲染；2=可读、局部结构错；1=可读但结构错；0=坏。

**公式行检测**：attention 页 4–6 共 6 个 display 公式全部检出（含 eq 编号行），
正文/表行 0 误报（规则收紧后）；bee 页 8 的 3 行全部检出。

### 2.3 可还原 / 注定失败的公式类型

| 类型 | 结果 | 说明 |
|---|---|---|
| 单行 display（含上下标、分式、根号、希腊字母、函数名） | ✅ 可还原（Dice≈0.9–1.0） | 本 prototype 覆盖 |
| 堆叠分式（分子/分母两行 + 根号字形） | ✅ 可还原 | 几何规则命中 Attention eq1 |
| 多行独立公式（每行有 `=`，如 bee 三行） | ⚠️ 逐行可还原，数组环境需合并步骤 | 输出 3 个 `$$` 块也可读 |
| 上下标语义归属（`W_i^Q` vs `W_i{}^Q`、`d_{model}` 嵌套） | ⚠️ 局部错 | 靠 x 邻接猜，需语义规则 |
| `align`/`cases`/大型矩阵/多行对齐 | ❌ | 无环境/括号结构信息；只能近似或降级为图片 |
| 文本层缺字形（Type3/矢量绘制的公式） | ❌ | run 为空/str 丢失；需路线 B/C |
| 跨栏、跨页、被正文包围的 inline 公式 | ❌（inline 不做） | 本机已见 inline √d_k 分裂到两行 |
| 字体替换/断字/连字 | 部分 | 符号映射兜底，可能产生乱序 |

---

## 3. 路线 B：公式区域 → 图片（rasterize）

### 3.1 实测：bbox 映射与裁剪（已成功）
- MinerU bbox（0–1000 归一化）→ PDF 页面像素：`x*W/1000`、`y*H/1000`；
  bee page_idx 7 = PDF 第 8 页；150 dpi 下 `pdftoppm -f 8 -l 8 -r 150 -png
  -x 349 -y 834 -W 304 -H 117 bee.pdf bee-formula-crop` → **304×117 PNG，内容正是目标公式**
  （人工查看确认；文件 `bee-formula-crop-08.png`）。
- 同法可裁剪 attention 的 6 个公式（bbox 可由路线 A 的 run 簇外接框 + 2–4 px padding 得到；
  bee 已验证 MinerU bbox 与启发式框可互校）。

### 3.2 公式区域检测策略（服务端可算 bbox）
1. 用路线 A 的公式行检测拿到 baseline 簇、x 范围；
2. 向外扩到相邻上下标 run 的外接框（含√/分式分子分母）；
3. 按 0–1000 归一化输出 bbox（与 MinerU 契约一致），同时留出 padding；
4. **检测率**：attention 6/6、bee 3/3（与 A 共用规则）；多栏 PDF 需先按列切分（acl.pdf 双栏
   未做实测，列为未验证项）。

### 3.3 rasterize 路径对比

| 路径 | 可行性 | 说明 |
|---|---|---|
| **客户端 pdf.js + canvas（推荐 P1）** | 高（需把 pdfjs 引入 client bundle，或复用 host 抽好的 run/bbox + 浏览器渲染同一 PDF 页） | 前端已有 `vendor/pdfjs`（1.5 MiB，Apache-2.0）；浏览器 canvas 裁 bbox → PNG dataURL/Blob → 上传为 asset。离线、零外部依赖；代价是 client bundle 变大、需处理 DPR/缩放 |
| 服务端 `pdftoppm`（poppler） | 中（本机可用，跨平台不一致） | Linux/macOS 常见，Windows 需 poppler 包；`-x -y -W -H` 精确裁剪（已验证）；但依赖系统命令，与「零安装」冲突，只能作可选回退 |
| DSH libreoffice-kit / PDFium | **实测可用**（引用 `rich-images.md` §0.4） | `libreoffice-kit` 的 `renderImages()` 可 PDF→PNG（PDFium wasm；bee 27 页 8.9 s / 7.7 MB @120dpi）；但 DSH `officeToPdf` 服务当前未暴露 PDF→PNG，需跨仓库扩展；作为 headless/导出条件路线，不作默认 |
| 侧车（pdfium/render 服务） | 低 | 引入新依赖，不推荐 |

### 3.4 图片公式的代价
- **收益**：复杂公式（矩阵/align）视觉保真，不会出现「假 LaTeX」误导。
- **代价**：不可搜索、不可复制、不被 AI 检索/翻译（翻译会跳过图片；agent `read` 读到的是
  markdown 图片引用）；需要新资源文件与 asset 路由（`parsed/images/formula-*.png`）；
  图片块会改变 block 结构（影响高亮锚点，见 §6）。
- **建议**：只在「检测到公式但路线 A confidence 低」或「矩阵/align 类型」时用图片；
  alt text 写入线性文本（如 `alt="Attention(Q,K,V)=softmax(QK^T/sqrt(d_k))V"`）以便搜索/翻译
  兜底。

---

## 4. 路线 C：本地 ML 模型（P2 侧车，旁路而非纯本地引擎）

> 共同前提：这些模型都是「**公式图片 → LaTeX**」，必须先有路线 B 的区域检测与裁剪；
> 安装 = Python/PyTorch 环境 + 数百 MB~GB 权重，属于「用户自装侧车」。

| 工具 | 代码许可 | 权重许可 | 安装/体积（[估]） | CPU | 公式质量/证据 | 备注 |
|---|---|---|---|---|---|---|
| **pix2tex / LaTeX-OCR** | **MIT**（PyPI `pix2tex` 0.1.4、GitHub `lukas-blecher/LaTeX-OCR` LICENSE 实测 MIT） | 未单独标注（随仓库发布；**未验证**，按 MIT 预期但需确认） | `pip install pix2tex`（46 deps，含 torch）+ 权重 ~50–300 MB | 可行（小 ViT，单公式 ~0.1–1 s [估]） | 公式识别专用、社区验证充分 | **P2 首选**：轻、MIT、CPU 快；但依赖路线 B 裁图 |
| Texify | **GPL-3.0-or-later**（PyPI `texify` 0.2.1 license 字段实测） | 未核实 | torch + 模型（~1 GB 级） | 可行但慢 | 比 pix2tex 新、效果相近 | GPL 传染性需法务确认（独立进程运行可降低风险） |
| Nougat | MIT（GitHub LICENSE 实测） | **CC-BY-NC-4.0**（HF `facebook/nougat-base` 模型卡实测） | 1.4 GB（base 250M） | 慢（建议 GPU） | 整页学术 PDF→Markdown（含公式） | **权重禁商用**，排除商用路径 |
| UniMERNet | Apache-2.0（GitHub LICENSE 实测） | 未标注（HF 模型卡为空，**未验证**） | ~1 GB 级 | 慢 | 公式识别强 | 许可待确认 |
| **PaddleOCR-VL-1.6** | **Apache-2.0** | **Apache-2.0**（HF 模型卡实测） | paddlepaddle 186 MB + 0.9B 权重（~2 GB） | **未验证**（官方示例多用 GPU） | OmniDocBench 96.34，FormulaCDM 97.5（官方 README/榜单） | 质量天花板，但侧车重；接入成本高于 pix2tex |
| **MinerU 本地 4.x** | Apache-2.0 + 附加条款 | MinerU2.5-Pro-2605-1.2B / models_torch Apache-2.0（旧 2.5 权重 AGPL） | 模型 ~2 GB + Python env（详见 `sidecars.md`） | 官方称 standard 档 ONNX+llama.cpp CPU 可跑（8 GB 内存） | OmniDocBench 95.75、FormulaCDM 97.45 | 已有侧车用户直接用它出 `$$` LaTeX，**无需路线 A/C** |
| Docling + granite-docling-258M | MIT（Docling）/ Apache-2.0（granite-docling-258M，HF 实测） | 同上 | Docling 2–3 GB 安装；258M 权重 ~0.5 GB [估] | 可 CPU | 公式能力中等 | 适合已有 Docling 的用户 |
| Ollama VLM（qwen3-vl:8b 等） | Ollama MIT | qwen3-vl / qwen2.5-vl / minicpm-v-4.5 均 Apache-2.0（HF 实测） | 5.5–6.2 GB/模型 | CPU 很慢（分钟/页） | 通用 VLM，公式弱于专用（OmniDocBench 85–90 档） | 仅 T3 兜底，不建议 |

**结论**：路线 C 不能替代 A（是 A 的「后处理」或「已有侧车复用」）；若做，选 **pix2tex**
（MIT、轻、CPU）；PaddleOCR-VL/MinerU 本地属于「已有重侧车则复用其 LaTeX 输出」。

---

## 5. 推荐策略与工作量

### P0 — 纯 Node 启发式 LaTeX（建议先做，1.5–2.5 人日）
- 在新模块（如 `lib/local-formula.js`，纯函数，Node 直测）实现 §2.1 的 run 聚类/公式行检测/
  上下标/分式/根号/符号映射/清理；
- `lib/local-pdf.js` 改为保留 run 级数据（当前 `buildLines` 只留行级；需返回 runs 或新增
  `extractPdfRuns`），`lib/local-synth.js` 增加 equation 输出路径；
- full.md：每个 display 公式输出一个 `$$...$$` 块（多行可选 array）；
  content_list：`{type:'equation', text:'$$...$$', text_format:'latex', page_idx, bbox?}`
  （bbox 用 0–1000 归一化，与 MinerU 契约一致）；
- inline：**保持段落纯文本不动**（避免破坏 text↔block 1:1 与翻译分块）；可选低风险整理
  （Unicode 符号保留、`−`→`-` 等不做 LaTeX）。
- 验收：fixtures 上 Dice ≥0.85、人工 rubric 平均 ≥2.5；标记 `local-formula-partial` 质量提示。

### P1 — 公式图片（客户端 raster，2–3 人日）
- 复用 P0 的公式区域 bbox；客户端 pdf.js 渲染页面 → canvas 裁剪 → PNG；
- 图片存 `parsed/images/formula-<page>-<n>.png`，markdown `![](images/...)` + alt 线性文本；
- 仅在 P0 confidence 低/类型不支持时使用（矩阵、align、文本层缺字）；
- 验收：bee 已知 bbox 裁剪一致；图片可渲染、不阻塞翻译（跳过图片）。

### P2 — 可选 LaTeX-OCR 侧车（2–4 人日 + 安装 UX）
- 配置项 `formulaOcr: {id:'pix2tex', command, args…}`（与 `integration.md` §4.5 sidecar 配置
  同构，命令仅来自可信配置）；对 P0/P1 都失败的公式图 → LaTeX；用户自行安装，未装不提示。
- 不推荐把 Nougat（NC 权重）/Texify（GPL）做进默认路径。

### 工作量与收益小结
| 级别 | 改动 | 质量 | 成本 |
|---|---|---|---|
| P0 | 新增纯函数 + local-pdf/synth 接线 + 测试 | 常见单行公式 Dice 0.95，矩阵/缺字降级 | 1.5–2.5 人日 |
| P1 | client raster + asset + 降级逻辑 | 复杂公式视觉保真，无 LaTeX/检索 | 2–3 人日 |
| P2 | 可选侧车探测/调用 | 兜底最高，依赖用户安装 | 2–4 人日 + 文档 |

---

## 6. 契约与实现细节

1. **full.md**：display 公式独占块 `$$...$$`（MinerU 同款；阅读器 `ui/markdown.js` 支持
   `$$` / `\[`）；单行公式不要与段落同行；多行公式可用
   `\begin{array}{l} ... \\ ... \end{array}`（KaTeX 支持 array；注意 `\\` 转义）。
2. **content_list**：`{type:'equation', text:'$$...$$', text_format:'latex', page_idx, bbox}`
   （纯数组，与 MinerU standard 同格式；bbox 0–1000 归一化，可选）；图片公式用
   `{type:'image', img_path:'images/formula-*.png', page_idx, bbox, image_caption:[线性文本]}`。
3. **一致性**：`content_list` 的 `text` 必须与 full.md 中该块的文本**同源生成**（同一个
   `Block` 对象），否则页标记与 block 匹配会漂移（`integration.md` §3.3 已强调）。
4. **页标记/页码**：公式块的 `page_idx` 用 PDF 页序（0 基）；跨页公式取起始页。
5. **高亮/批注锚点**：新增公式块会改变 block 序列 → 旧锚点文本仍在（公式块文本是新增），
   但**同段落内把公式抽走会改变段落文本**；建议：段落文本保持原样（不删除线性公式），
   仅把「整行 display 公式」从段落中独立成块；并在 reanchor（`lib/reanchor.js`）中验证。
6. **翻译**：`$$...$$` 不应送翻译器；翻译分块时把数学块当作不可译块；图片公式跳过。
7. **段落内文本**：inline 公式保持线性（本引擎现状），可做符号排版整理但不生成 `$...$`；
   否则 content_list text 与 markdown 不一致。
8. **失败降级**：公式检测命中但 reconstruction confidence 低 → 保留线性文本，不产出错误
   LaTeX；前端可显示「公式无法还原，可安装本地 LaTeX-OCR（专家模式）」。
9. **KaTeX 兼容**：只使用 KaTeX 支持的命令（`\frac \sqrt \mathrm \text \sum \in \le \ge
   \times \cdot \to \infty \alpha…\omega \begin{array}` 等）；生成后可用 KaTeX 渲染校验，
   渲染失败则退回线性文本。

---

## 7. 风险与未决问题

- **文本层不可靠**：Type3 字体/矢量绘制公式没有可读 run；inline 公式跨行分裂（本机已见
  `√` 与 `d_k` 分离）；这类只能走 P1/P2。
- **“假 LaTeX”风险**：启发式可能输出结构错但语法合法的 LaTeX（如 `W_{i^{Q}}`）；需要
  confidence 与人工 rubric 回归测试（fixtures + acl.pdf 双栏）。
- **误检**：正文含 `=` 的短句可能被当公式（当前规则在 attention 页 0 误报，但其他论文需
  扩大采样验证）；建议加「行首为变量/函数名」「行内字距/居中」等辅助特征。
- **坐标契约**：本次确认 MinerU bbox 为 0–1000 归一化（page_idx 0 基）；接入时需自己产出
  同样坐标系，否则与云端产物不一致。
- **多栏 PDF**：acl.pdf 双栏未实测（时间盒原因）；跨栏公式顺序/bbox 需专项验证。
- **性能**：run 级处理比行级多约 2–5× 内存/CPU；对 200 页 PDF 需上限与流式处理。
- **未验证项**：PaddleOCR-VL CPU 速度；pix2tex 权重许可细则；UniMERNet/Texify 权重许可；
  client 侧 pdf.js raster 的 bundle 增量与 DPR 处理；DSH 是否有可用的服务端 PDF 渲染。
- **契约扩展**：`text_format:'latex'` 字段 MinerU 有、现有 store 读取是否忽略未知字段需确认
  （`lib/store.js` 读 `content_list.json` 的解析逻辑）；建议保持向后兼容（纯数组 + 未知字段）。

---

## 附录：可复现命令与证据

```bash
cd /home/nirvana/Documents/dsh-mineru
# 1) 抽 runs（pdf.js 5.4.449，仓库 vendored）
node .agents/tmp-research/rich-formulas/dump-runs.mjs .agents/tmp-research/lead/rich/bee.pdf 8 out.json
# 2) 启发式重建（attention 页 4–6，bee 页 8）
node .agents/tmp-research/rich-formulas/reconstruct.mjs .agents/tmp-research/lead/rich/attention.pdf 4,5,6 att-result.json
node .agents/tmp-research/rich-formulas/reconstruct.mjs .agents/tmp-research/lead/rich/bee.pdf 8 bee-result.json
# 3) 公式图片：bbox[345,556,646,634]（0–1000，page_idx7 → PDF p8）→ 150dpi 裁剪
pdftoppm -f 8 -l 8 -r 150 -png -x 349 -y 834 -W 304 -H 117 \
  .agents/tmp-research/lead/rich/bee.pdf .agents/tmp-research/rich-formulas/bee-formula-crop
```
- 评分数据：`.agents/tmp-research/rich-formulas/score.json`（avg Dice 0.95）。
- 证据 URL：MinerU Output Formats（equation/content_list 契约）
  <https://opendatalab.github.io/MinerU/reference/output_files/>；
  OmniDocBench（公式 CDM：MinerU2.5-Pro 97.45、PaddleOCR-VL-1.6 97.53）
  <https://github.com/opendatalab/OmniDocBench>；
  pix2tex <https://github.com/lukas-blecher/LaTeX-OCR>（MIT）；
  Texify <https://pypi.org/project/texify/>（GPL-3.0-or-later）；
  Nougat <https://huggingface.co/facebook/nougat-base>（权重 CC-BY-NC-4.0）；
  UniMERNet <https://github.com/opendatalab/UniMERNet>（Apache-2.0）；
  PaddleOCR-VL-1.6 <https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6>（Apache-2.0）；
  pdf.js <https://github.com/mozilla/pdf.js>（Apache-2.0，vendored 5.4.449）。
