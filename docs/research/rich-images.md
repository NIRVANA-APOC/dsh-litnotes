# 本地解析如何从 PDF 还原图片（rich images）

> 角色：算法/可行性研究（rich-images）。范围：**只做研究与原型实测**，不改产品代码/测试/其他文档、不 commit。
> 工作仓库：`/home/nirvana/Documents/dsh-mineru`（**研究基线 `b1a68be`**；复核时 main HEAD 已前进到 `0cda21a`，本文行号可能漂移，以符号名为准；fixtures 来自用户本地库中的公开论文，仅用于结构/质量评估，不随仓库提交）。环境：Node v26.13.0，vendored pdfjs **5.4.449**（`vendor/pdfjs/{pdf.mjs,pdf.worker.mjs}`，未 vendor image_decoders/wasm）。
> 真值 fixtures（只读）：`.agents/tmp-research/lead/rich/{bee.pdf,bee-content_list.json,bee-full.md,attention.pdf,acl.pdf}`。
> 实验脚本/产物：`.agents/tmp-research/rich-images/`（`extract.mjs` 727 行原型、`pdfjs-oplist.mjs`、`oplist-summary.mjs`、`compare.mjs`、`compare-forms.mjs`、`render-test.mjs`、`render-bench.mjs`、`captions.mjs`、`out-{bee,attention,acl}/`、`render-bee/`、`render-bee-all/`、`bee-oplist.json`）。
> 并行研究：契约/集成细节以 `docs/research/rich-integration.md` 为准；本文负责**图片还原的算法结论、实测数据与图片专项契约草案**。
> 时间盒 40 分钟（实际 11:49–12:0x），原型为研究级（无单测、异常路径未穷举）。

---

## 0. 结论摘要（TL;DR）

1. **纯 JS 位图对象提取可行、快、零依赖，但对学术 PDF 的整图覆盖率极低**。bee.pdf 26 个 MinerU 图块（7 image + 16 chart + 3 table）中位图命中 **0/26**；attention.pdf 找到 **3 个真实位图**（其中 Figure 1 为整幅 1520×2239）；acl.pdf **0 个**。原因不是解析失败，而是**这些 PDF 的图本来就是矢量**：bee 的图是 pdfTeX 嵌入的 **Form XObject 矢量绘制**（内容流里 `paintImageXObject` 只在第 5 页出现 3 次，且是 Fig. 3 内的 3 个小图标）。
2. **关键发现（正能量）**：纯 JS 可从 `Form XObject` 的 `/BBox` + 内容流 `cm/Do` CTM **精确定位矢量图区域**。bee 170 个 Form 放置 → 按邻近聚类 **22 个区域**，MinerU 的 **23/23 个 image+chart 真值区域全部命中**（IoU≥0.2；中位 IoU **0.88**、最小 0.35），且“有 Form 的 15 页”与“有图真值的 15 页”完全一致；仅 3 个 table（MinerU 也是页面裁剪）不命中——表格本就不应由图片管线产出。**这意味着不需要 ML 版面模型就能定位 LaTeX/PTEX 类论文的图区域**。
3. **pdf.js operator list 路线在 Node 无 canvas 下“可拿到结构、拿不到像素”**：`getOperatorList()` 可用（能拿到 image 的 `objId`+宽高、`paintFormXObjectBegin` 的 `[matrix, bbox]`），但 `page.objs.get('img_p4_1')` 直接抛 `Requesting object that isn't resolved yet img_p4_1.`，`doc.commonObjs` 为 `undefined`，且导入时警告 `Cannot load "@napi-rs/canvas"` / `Cannot polyfill ImageData, Path2D`。→ 想用 pdf.js 自渲染，必须引入 canvas（@napi-rs/canvas 等）。
4. **光栅化已有现成能力且实测成功**：DSH 已安装的 `@deepseek-ai/libreoffice-kit@0.1.5`（wasm 后端 + **pdfium** 光栅引擎）的 `renderImages()` **可以直接 PDF→PNG**：bee 第 5 页 @120dpi → 810×1200、290 KB、**5.4 s（含 wasm 冷启动）**；全 27 页 → 7.70 MB、**8.9 s**。渲染出的 Fig. 3 与来源一致。**但 DSH 的 `officeToPdf` 服务当前只暴露 `convert`/`render`（Office→PDF），没有 PDF→PNG 方法**，插件无法直接调用，需要 DSH 侧新增服务方法（跨仓库改动）。
5. **浏览器端 raster（复用已 vendor 的 pdf.js + 已有 `/api/source` 路由 + canvas 裁剪）零新依赖、平台无关**，是图区光栅化的首选落地方式；服务端 PDFium 扩展作为 headless 对应路线；`@napi-rs/canvas` 需每平台 36.9 MB native 二进制（linux-x64-gnu，MIT），只建议作为 P2。
6. **推荐**：
   - **P0（约 3–4 人日含测试 + 区域定位另 2–3 人日）**：纯 JS「位图原图提取 + Form 区域定位」模块（`node:zlib`，零依赖）。位图原样导出（**无 SMask 的 DCT→.jpg**，Flate→自写 PNG；带 SMask 的 DCT 在无 canvas 条件下记 `image-unavailable:smask`），矢量图先只产出区域元数据（caption 段落保留，不写假图）；本阶段就能给"已有位图的截图类 PDF（不做 OCR）"、非 LaTeX PDF 提供真图。
   - **P1（条件路线，spike 1–2d + 实现 3–5d）**：光栅化矢量图区域。**浏览器端 pdf.js**渲染+裁剪+回传缓存需先 spike（worker/字体/CSP/内存、缺 `standard_fonts/wasm/cmaps` 的渲染质量）并新增客户端组件 + Host 回传/缓存 API；需要 headless（导出/agent 批处理）时再推动 **DSH officeToPdf 增加 PDF→PNG**（底层 libreoffice-kit 已实测可用，但服务未暴露该 API）。
   - **P2**：`@napi-rs/canvas` vendor 到插件（每平台 36.9 MB）；扫描件/OCR（明确不在本次范围）。

---

## 1. 真值分析（bee.pdf，MinerU standard）

### 1.1 真值规模与形态

| 项目 | 数值 | 说明 |
|---|---|---|
| PDF | 27 页，2.3 MB，486×720 pt，pdfTeX/acmart | 单栏；`page_idx` 0-based |
| `bee-content_list.json` | 358 条 | `image` **7**、`chart` **16**、`table` **3**（26 条带 `img_path`）、`equation` 1、`text` 198、header/footer/page_number 等其余 |
| `bee-full.md` | 24 个 `![](images/…)` 引用 | 每张图为独立段落 `![](images/<sha256>.jpg)`，**下一段是 caption 纯文本**（`Fig. 1. …`）；表格是 caption 行 + 单行 `<table>…</table>` |
| 图块字段 | `{type, img_path, image_caption|chart_caption, image_footnote, content:"", bbox, page_idx}` | `bbox=[x0,y0,x1,y1]`，**0–1000 归一化、左上原点** |
| caption 位置 | CL 里只在 `image_caption`/`chart_caption` 数组（**不重复**出 text 条目）；markdown 里是独立文本段落 | 两处都要写，前者给页标记/数据，后者给阅读台/翻译/AI 检索 |

- **bbox 坐标系验证**：用 Form BBox×1000 与真值 bbox 比对，**image+chart 23/23 召回**（table 3/3 不计入）且中位 IoU 0.88 → MinerU CL bbox 确为 **0–1000 归一化（左上原点）**，与 `docs/research/rich-formulas.md` §0（用该 bbox 反算 pdftoppm 裁剪成功）一致。**说明：本对比只统计"真值→区域"召回；区域→真值精度未统计；"零假阳性"仅在页级成立（有 Form 页 = 有图页），不能外推为区域级精度**。
- **表格也是页面裁剪**：3 个 `table` 条目同样带 `img_path`（MinerU 渲染的表格图），但同一位置的表格在 PDF 中无位图；契约上表格仍应由 `<table>` HTML 负责，图片管线**不应**产出表格图（见 §5 降级规则）。

### 1.2 PDF 内部真实构成（决定路线可行性）

用原型扫描对象图（含 xref stream + object stream 展开）统计：

| fixture | 页数 | 大小 | `/Subtype /Image` XObject | 其中 DCT/Flate | 被内容流引用的位图放置 | `/Subtype /Form` XObject | Form 放置次数 | 有 Form 的页 |
|---|---|---|---|---|---|---|---|---|
| bee.pdf | 27 | 2.3 MB | **6** | 3 DCT + 3 Flate | **3**（均 page_idx=4） | 56 | 170 | 15 |
| attention.pdf | 15 | 2.2 MB | **6** | 6 Flate | **3**（page_idx=2,3） | 2565（含嵌套重复计数） | 2565 | 3 |
| acl.pdf | 17 | 688 KB | **0** | — | 0 | 55 | 182 | 17 |

- 三个 fixture **都使用 xref stream + object stream**（bee 10 个 ObjStm、attention 33、acl 8）。顺序扫描 `N 0 obj` 时 bee/acl 的 Page 对象全在压缩对象流里：**朴素扫描 = 0 页**（原型第一版实测），生产实现必须处理 ObjStm，或复用 pdf.js 的解析结果。
- bee 的 6 个位图 XObject = **3 个 DCT + 3 个 Flate（已确认 3 个 Flate 是 DCT 的 `/SMask 54/55/56 0 R`，473×386 DeviceGray）**，全部画在 Fig. 3（page_idx 4）内部作为**小图标**：归一化 bbox 分别约 `511,173,539,188`、`670,170,698,185`、`670,187,698,202`（约 28×15/1000 单位，占页面 <0.1%），473×386 px，JPEG 7.2–7.9 KB。实测解出的 `out-bee/bf2947efdc701e2b.jpg` 是一张**透明底蓝色箭头图标**（带 SMask alpha）；PDFium 渲染页（`render-bee/page-0001.png`）可见 Fig. 3 中的 “Block Reference” 等小图标。→ DCT 直通 `.jpg` 会丢 alpha（预览变黑底），见 §6 风险 4。
- attention 的 3 个位图是真实整图素材（带 SMask alpha）：`1520×2239`（整幅 Figure 1）、`835×1282`、`445×884`；PNG(RGBA) 体积 111.4 KB / 61.0 KB / 18.7 KB。
- acl 的图全部是 PTEX 嵌入的 Form XObject 子页面（`PTEX.FileName (./examples/acl_2024_proceedings/...)`），**零位图**。
- 三个 fixture 中未出现 `/JPXDecode`、`/JBIG2Decode`、`/CCITTFaxDecode`（grep 0 命中）；如遇这些编码，纯 JS 路线直接记录为不支持。

### 1.3 图块类型判定：MinerU 的 image/chart 从哪来

`getOperatorList()` 按页统计（`bee-oplist.json`）：bee 只有 **page 5（1-based，即 page_idx 4）** 有 image 操作（3 次），其余 26 页 imageOps=0；而 chart 页（如 page_idx 12/16/17/19…）pathOps 分别为 145/315/290/463，Form 绘制 1–72 个。→ 结论（推断，与 MinerU pipeline 行为一致）：**MinerU 的 `image`/`chart` 先把 PDF 页面渲染成位图，再按版面/图题裁出区域**；这些区域在原 PDF 里绝大多数是**矢量绘制**，所以“把原图字节抠出来”在原理上就覆盖不了 chart/大多数 image。

---

## 2. 路线对比矩阵

| # | 路线 | 原理 | 依赖 / 许可 / 体积 | 能拿到什么 | 实测覆盖 | 改动量 | 可靠性/限制 |
|---|---|---|---|---|---|---|---|
| **A** | **纯 JS 位图对象提取**（node:zlib） | 顺序扫描对象+ObjStm，页面树→Resources→`/Subtype /Image`，内容流 `Do` 求 CTM/bbox；DCT 原样、Flate inflate→自写 PNG | **0 npm 依赖**；原型 727 行 | **原始位图字节**（保真最高）、页/bbox、Filter/颜色空间 | bee 3（小图标）/attention 3/acl 0；**整图命中 bee 0/26、attention ≈3/5 图题、acl 0/6** | 中（解析器+解码器，已原型） | 高（原图）；不支持 JPX/JBIG2/CCITT/LZW/加密；只对“真有位图”的 PDF 有效 |
| **B** | **Form 区域定位**（纯 JS 或 pdf.js op list） | Form XObject 的 `/BBox` 经 `/Matrix`×CTM 变换 → 页面坐标；邻近聚类 → 图区域 | 0 依赖；~200–300 行 | 矢量图**区域 bbox** + page（无像素） | bee **23/23** image+chart 区域（中位 IoU 0.88）；有 Form 的 15 页 = 有图的 15 页 | 小（若复用 pdf.js op list，见 §3.3） | 高（LaTeX/PTEX 类）；Word/PPT 直绘/扫描无 Form → 失效 |
| **C** | pdf.js render（Node） | `page.render()` + canvas | pdf.js 已 vendor；**需 @napi-rs/canvas**（MIT：js 166 KB + 平台包 36.9 MB linux-x64-gnu；或 `canvas` 需系统库） | 整页/区域 RGBA raster | 未实测（当前环境未装 canvas；pdf.js 导入即警告 `Cannot load @napi-rs/canvas`、`Cannot polyfill ImageData/Path2D`） | 中；每平台 36.9 MB 打包 | 高（pdf.js 渲染与阅读台同源）；插件零依赖约束/多平台体积是硬伤 |
| **D** | **DSH libreoffice-kit + PDFium**（Host 服务） | `renderImages({inputPath, outputDir, pages, dpi})` → 每页 PNG | DSH 已装 `@deepseek-ai/libreoffice-kit@0.1.5`（MPL-2.0，472 KB 入口 + wasm 包 146 MB）+ pdfium wasm 后端 | 整页 PNG（810×1200 @120dpi 等） | **实测可行**：bee 27 页 7.70 MB、8.9 s（含 wasm 初始化）；单页 5.4 s / 290 KB | **需 DSH 扩展**（当前 `officeToPdf` 只有 `convert`/`render`(Office→PDF)，无 PDF→PNG 方法）+ 插件调用 + 裁剪（PNG 解码/裁剪 ~60 行） | 高（PDFium 质量好、离线）；跨团队依赖、wasm 冷启动 5 s、仅整页输出（裁剪要自己做） |
| **E** | **浏览器端 pdf.js canvas 裁剪** | reader 动态 import `/dsh-litnotes/assets/pdfjs/pdf.mjs`（worker 同源），`/api/source` 取源 PDF，render 页面到 canvas，按 bbox crop → blob/URL | 复用 **已 vendor 的 pdf.js（Apache-2.0，1.5 MiB）** + 浏览器 canvas；**0 新依赖** | 图区域 PNG（任意 crop，随阅读台实现） | 未实现（当前 UI 无任何 pdf.js 代码）；方案所需基础设施已具备 | 中（UI 组件 + 渲染/裁剪 + 可选缓存回传 API；3–4 天） | 高（与页渲染一致）；需客户端算力/内存；CSP/worker 同源已满足 |
| **F** | 其他 | canvaskit-wasm / 外部 poppler / 服务端截图 | canvaskit-wasm 0.42.0（BSD-3，26 MB）**无 PDF renderer → 不可行**；poppler/`pdftoppm` 外部二进制跨平台不一致（公式研究已指出） | — | — | — | 不建议 |

**结论**：A 是“位图原图”唯一廉价来源但覆盖低；B 把“矢量图在哪”变成确定性问题且几乎零成本；C/D/E 才能把 B 的区域变成像素。**A+B 是 P0，E（首选）或 D（headless）是 P1。**

---

## 3. 实测数据

### 3.1 纯 JS 位图对象提取（原型 `extract.mjs`，727 行）

实现范围（均为零依赖：`node:zlib` + 自写 PNG encoder）：

- 对象定位：顺序扫描 `N G obj`（带上下文校验）；**Object Stream（ObjStm）展开**（N/First 头表 + body）；不解析 xref/xref stream（顺序扫描足够，实测 3 个 xref-stream PDF 全部成功）。
- 页面树：Catalog→Pages→递归 Kids，`Resources`/`MediaBox` 沿继承链继承；内容流 `/Contents` 支持单引用/数组、FlateDecode。
- 内容流 tokenizer：跳过字符串/十六进制串/注释/BDC 属性字典；`q/Q/cm/Do` 栈式 CTM；**递归 Form XObject**（应用 `/Matrix` 与 form 自身/继承的 Resources）。
- 解码：`/Filter` 支持 `DCTDecode`（字节原样导出 .jpg）、`FlateDecode`（含 **PNG predictor 10–15 / TIFF predictor 2** 反滤波）、`ASCIIHexDecode`；颜色空间 DeviceGray/RGB/CMYK、ICCBased（按 /N）、Indexed（lookup 表）；`BitsPerComponent` 8（1/2/4 位 unpack）；`/SMask` → RGBA alpha；`/Mask` 色键透明；`/ImageMask` stencil；`/Decode` 反色。
- 放置 bbox：位图 = CTM 作用在单位正方形；Form = `/Matrix`×CTM 作用在 `/BBox`；统一转 0–1000 左上归一化坐标。
- 输出：`<sha1-16>.<jpg|png>` + `report.json`（每页 occurrences/forms + 每个图元 filter/尺寸/字节/bbox）。

数据（`node extract.mjs <pdf> out-<name>`）：

| fixture | 位图放置 | 唯一图 | 类型/字节 | 尺寸 | 提取耗时 | 与 MinerU 图块命中（IoU≥0.2） |
|---|---|---|---|---|---|---|
| bee.pdf | 3 | 3 | DCT JPEG 7.2/7.9/7.7 KB（均带 SMask，直通 .jpg **未合成 alpha**） | 473×386 | **121 ms**（27 页） | **0/26**（3 个是 Fig.3 内小图标，bbox 与任何整图真值无交集） |
| attention.pdf | 3 | 3 | Flate→PNG RGBA 111.4/61.0/18.7 KB | 1520×2239、835×1282、445×884 | 372 ms（15 页） | 无真值文件；文本层约 5–6 个图题，位图覆盖 Figure 1（page_idx 2）及 page_idx 3 两图，≈3/5 图题 |
| acl.pdf | 0 | 0 | — | — | 162 ms（17 页） | 无真值文件；约 6–7 个图题，**0** |

失败原因分类（bee 的 26 个真值）：

| 原因 | 数量 | 证据 |
|---|---|---|
| 该图在 PDF 中是 Form XObject 矢量绘制（内容流无位图） | 20/23 非表图块所在页 imageOps=0，且 Form 区域与真值 bbox 精确重合 | `bee-oplist.json` + §3.2 |
| 图内嵌位图只是小图标，不是整图 | 3 个 DCT（仅 Fig.3） | 放置 bbox 归一化宽约 28/1000 |
| MinerU table 的页面裁剪，本地不产表格图 | 3 | §1.1、§5 降级规则 |
| 不支持编码（JPX/JBIG2/CCITT/LZW） | 0（三 fixture 均未出现） | 原始字节 grep |

**与 pdf.js operator list 的对照**（Node 无 canvas）：`getOperatorList()` 对 bee 报告只有第 5 页（1-based）有 3 次 `paintImageXObject`（args `["img_p4_1",473,386]`），与纯 JS 的 3 个位图放置一致 → 两条路线的“结构发现”可互相验证。

### 3.2 Form 区域定位（纯 JS，`compare-forms.mjs`）

| 指标 | 数值 |
|---|---|
| Form XObject 放置（bee，含嵌套计数） | 170 |
| 聚类后区域（bbox 扩张 2% 后重叠合并） | **22 个**，分布在 15 页 |
| 有 Form 的页 vs 有图真值的页 | **完全一致（15 = 15）**，无“有 Form 但无图”的页 |
| MinerU 真值 image+chart 命中 | **23/23**（IoU≥0.2）；中位 IoU **0.88**、最小 **0.35** |
| 表格真值命中（应不命中） | 0/3（表格在 PDF 中非 Form/位图） |

为什么能这么准：pdfTeX 的 `\includegraphics` 把每张图作为 **Form XObject** 画入页面，`/BBox` 就是图的精确边界；**`/Matrix`×当前 CTM** 给出页面坐标。Fig. 3 由 2 个左右并排的 Form 组成 → 2% 扩张聚类后合并为 1 个区域（IoU 0.35 的最差项即此类拆分图）。**注意**：Form 放置不是天然一一对应图（含嵌套计数、也可能有非图 Form），生产实现必须做邻近聚类 + caption 关联 + 非图过滤。

### 3.3 pdf.js operator list 路线（Node，无 canvas）

- 可用部分：`page.getOperatorList()` 正常返回；`OPS.paintImageXObject` args `[objId, width, height]`；`OPS.paintFormXObjectBegin` args `[matrix, bbox]`（实测 bee 第 5 页第 1 个 Form：`[null, {"0":18.4926,"1":340.643,"2":724.133,"3":850.651}]`，与纯 JS 解析的 form `/BBox` 一致）。→ **“区域定位”可以复用 pdf.js，无需自写 PDF 解析器**（追踪 `OPS.transform`/save/restore + form begin/end 的 bbox 即可）。
- 不可用部分（拿不到像素）：

```text
Warning: Cannot load "@napi-rs/canvas" package: "Error: Cannot find module '@napi-rs/canvas' ...
Warning: Cannot polyfill `ImageData`, rendering may be broken.
Warning: Cannot polyfill `Path2D`, rendering may be broken.

page.objs.get('img_p4_1')  THROW: Requesting object that isn't resolved yet img_p4_1.
doc.commonObjs             === undefined
```

原因：pdf.js 在 `getOperatorList` 阶段只登记图像对象 id；像素数据要等渲染器（canvas）真正执行 `paintImageXObject` 时才由内部 `PDFImage` 解码，而 `PDFImage.createImageData()` 依赖 `ImageData`/canvas，Node 下需要 `@napi-rs/canvas`（pdf.js 5.x legacy build 会尝试加载它）。结论：**pdf.js 渲染必须配 canvas（路线 C）**；纯 JS 拿原始字节走路线 A 更直接。

### 3.4 矢量光栅化实测：DSH `@deepseek-ai/libreoffice-kit`（PDFium）

DSH 全局已安装（`~/.local/share/pnpm/global/v11/…/.pnpm/@deepseek-ai+libreoffice-kit@0.1.5` 与 `libreoffice-kit-wasm@0.1.5`）：入口 472 KB、wasm 包 **146 MB**、`license: MPL-2.0`。公开类型见 `lib/types/image-operations.d.ts`：`IMAGE_FORMATS` 含 `"pdf"`；`renderImages()` 支持 `pages:'all'|[n…]`、`dpi`(24–600)、`maxPages/maxPixels/maxDimension`，结果 `rasterEngine: 'libreoffice' | 'pdfium'`。

实测（`node render-test.mjs` / `render-bench.mjs`，bee.pdf）：

| 项目 | 结果 |
|---|---|
| Runtime | `discoverRuntime()` → `{backend:"wasm"}`；`createConverter()` 77–82 ms |
| 单页渲染 | page 5 @120dpi → `page-0001.png` **810×1200**，**289,813 B**，`rasterEngine:"pdfium"`，`pageCount:27`，**5.41 s**（含 wasm 冷启动） |
| 全 27 页 | **27 张**、**7,700,764 B**、**8.9 s**、每页 810×1200（278–309 KB） |
| 质量 | 渲染页与来源视觉一致（`render-bee/page-0001.png` 中 Fig. 3 完整、含矢量文字/箭头/小图标） |

限制：① 只能输出**整页** PNG（没有 bbox crop 参数，`range` 仅 Calc），按图区域裁剪需额外做 PNG 解码/裁剪（node:zlib 自写 ~60 行，或浏览器 canvas）；② **当前 DSH `officeToPdf` 服务不暴露 PDF→PNG**（其类型只有 `convert`、`render`(Office→PDF)、`getGeneration`），插件侧无法直接调用；③ wasm 冷启动 ~5 s，适合 worker/后台任务，不适合每个请求新建 converter。

### 3.5 浏览器端渲染可行性（未实现，基础设施已具备）

- 静态资源：`lib/routes.js:354 assetsHandler` 将 `vendor/*` 挂在 `/dsh-litnotes/assets/**`（`VENDOR_DIR` 在 `lib/routes.js` 头部），`vendor/pdfjs/pdf.mjs`、`pdf.worker.mjs` 可直接 `import()`/worker 加载。
- 源 PDF：`lib/routes.js:307 handleSource` 提供 `/dsh-litnotes/api/source?id=<docId>`（同源、带 fence 校验）。
- 读者 UI：`ui/app.js:1015 mruImageUrl` 只接受 `src` 直接拼 `/dsh-litnotes/api/asset?…`，当前 UI **没有任何 pdf.js 渲染代码**（grep 无 `getDocument`/`pdf.mjs`）→ 需要新增客户端渲染组件（pdf.js 无 canvas 依赖问题：浏览器有原生 canvas）。
- 方案：figure block 增加可选 `pdf: {page, bbox}` 元数据；客户端懒加载源 PDF → render 目标页（固定 scale，例如让区域宽 ≤1600 px）→ `drawImage` 裁剪 → `canvas.toBlob`/objectURL 显示；可选上传回 `parsed/images/` 做持久化缓存（需新增一个受 fence 保护的小 POST 路由）。

---

## 4. 推荐（P0 / P1 / P2）

### P0（必须）：纯 JS 位图原图提取 + Form 区域定位（同一模块，**位图提取 3–4 人日含测试 + 区域定位 2–3 人日**；与 §7 统一口径）

- 位图：**无 SMask 的** DCT 原样 `.jpg`（保真）、Flate/其他支持项 → PNG；带 SMask 的 DCT 无 canvas 时记 `image-unavailable:smask`，不支持项记 warning 不阻塞。
- 矢量：只产**区域元数据**（page+bbox）与 caption 关联，不生成假图。
- 价值：screenshot/非 LaTeX PDF 立即有真图（attention 3 个位图已实测）；LaTeX PDF 先把图区域定位准（bee 23/23），caption 段落保留为文本，P1 再补像素。
- 伪代码（生产版建议：区域定位复用 pdf.js op list，位图字节走自写对象扫描；两者共用 caption/bttl 逻辑）：

```js
// lib/local-pdf-images.js（新模块；沿用 lib/local-pdf.js 的 pdfjs 实例）
export async function extractPdfFigures({ data, pdfDoc, maxImages, maxImageBytes, signal }) {
  const raw = scanPdfObjects(data)                 // 顺序扫描 N G obj + ObjStm 展开（含 xref-stream PDF）
  const figures = []
  for (let i = 0; i < pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i + 1)
    const ops = await page.getOperatorList()       // 复用 pdf.js：不需要自写内容流解析器
    const regions = collectDrawRegions(ops)        // 跟踪 transform/save/restore + paintFormXObjectBegin[matrix,bbox]
    for (const region of clusterAdjacent(regions, /*gap=*/0.02)) {
      const caption = matchCaption(await page.getTextContent(), region.bbox) // /^(Fig\.?|Figure|Chart)\s*[0-9IVX]/
      figures.push({ kind: 'region', pageIndex: i, bbox: region.bbox, caption })
    }
    for (const img of collectImageXObjects(ops, raw)) {   // ops 提供 objId/宽高；raw 用 objId 关联到原始流
      const file = decodeImage(img)                       // DCT→bytes; Flate→inflate(+predictor)→pngEncode()
      figures.push({ kind: 'bitmap', pageIndex: i, bbox: img.bbox, bytes: file, ext: file.ext, caption })
    }
  }
  return figures   // caption 文本块仍由 local-synth 作为普通段落输出
}

// pngEncode(rgba|gray|rgb, w, h)：自写 IHDR/IDAT/IEND + crc32 + zlib.deflateSync（~80 行）
```

### P1（强烈建议）：矢量图区域光栅化

- **首选：浏览器端 pdf.js 裁剪**（0 新依赖、跨平台、与页渲染同源）：
  - reader 渲染图区域，`<img>` 直接用 blob/objectURL 或回传缓存到 `parsed/images/`；
  - 固定渲染上限（如区域宽 ≤1600 px、`maxPixels` 16M），失败降级为“caption + 无图”。
  - 工作量 3–4 人日（组件 + 懒加载 + 缓存路由 + 降级 + 测试）。
- **headless 对应：DSH `officeToPdf` 服务扩展 PDF→PNG**（底层 `renderImages` 已验证：27 页/8.9 s/7.7 MB @120dpi；单页 5.4 s 含冷启动）。需要 DSH 仓库加服务方法 + 插件调用 + 按 bbox 裁剪（PNG 解码裁剪 ~60 行 / 或在浏览器侧裁剪）。跨团队，1–2 人日 DSH + 1 人日插件。
- 选择规则（建议）：有 reader 前端时用 E（无 DSH 依赖）；需要导出/agent 侧独立产物时补 D（可选能力，`local.rich.vectorRaster='auto'|'browser'|'host'`）。

### P2（可选/后续）

- `@napi-rs/canvas`（MIT；`@napi-rs/canvas@1.1.0` js 166 KB + `@napi-rs/canvas-linux-x64-gnu` **36.9 MB**/平台）vendor 进插件，仅当必须“Node 内无人值守 raster 且不能改 DSH”时考虑；多平台打包成本高。
- 扫描件/OCR：明确不在本次范围（本地引擎对无文字层 PDF 已 fail `local-empty-text`）。
- 图片增强：颜色配置（ICC 引擎）、去白边、DPI 自适应、图内文字 OCR（P2 后再说）。

---

## 5. 契约草案（与 `docs/research/rich-integration.md` 对齐）

### 5.1 产物与命名

- `parsed/images/<sha256>.<ext>`：文件名 = **文件内容 sha256**（位图为解码后字节；光栅裁剪为最终 PNG 字节），`ext` 按 magic 嗅探，白名单 `png/jpg/jpeg`（契约同 integration：禁 svg/webp 可选）。
- 天然去重（同一 XObject 多页复用只写一次）；确定性利于幂等重解析；**不要**用自增/时间戳（figure blockKey = `fnv1a(alt|src)`，改名=改 key）。
- 光栅裁剪建议命名 `<sha256>.png`（内容哈希同样成立）；若担心跨客户端 DPR 差异导致字节不同，可固定渲染参数（固定 scale、固定 crop 像素取整）后再哈希。

### 5.2 markdown（`full.md`，MinerU 同款，阅读台已验证）

```markdown
![](images/<sha256>.jpg)

Fig. 3. The overview of BEE method.
```

- 图 = 独立段落；caption = **独立文本段落**（MinerU 同款）——保留给翻译/AI 检索/引用，不要塞进 alt 代替段落（可同时把 caption 放 alt 以便 `mdCaptionFromAlt` 显示 figcaption，二者不冲突）。
- 本地纯文本 `escapeMarkdownText` 会转义 `]`/`)`/`<` 等：图片行必须作为特殊 block **跳过转义**（同 rich-tables 的 `<table>` 处理）。

### 5.3 `content_list.json`（MinerU 兼容；`page_idx` 0-based，`bbox` 0–1000 左上归一化）

```json
{"type":"image","img_path":"images/<sha256>.png","image_caption":["Fig. 3. The overview of BEE method."],
 "image_footnote":[],"content":"","page_idx":4,"bbox":[195,120,802,270]}
```

- 不输出 `chart/header/footer/page_number`（integration 结论：匹配器无对应分支）。
- caption 只在 `image_caption`，**不重复**成 text 条目；caption 文本段落在 markdown 中独立存在（同 MinerU）。
- 阅读顺序：图片条目按 bbox 顺序插入到该页文本条目之间；`appendPageMarks` 的 image 分支按 `img_path` basename 匹配 `figure.src`，因此两边文件名必须**完全一致**。

### 5.4 引擎/管线接口（最小改动，复用 staging 原子写）

| 位置 | 现状 | 改动 |
|---|---|---|
| `lib/local-pdf.js:423-577` | `extractPdfText()` → `{pages,pageCount,title,chars,outlineUsed}` | 增加图元扫描产物（`figures`：bitmap/region + page/bbox/caption；或独立 `lib/local-pdf-images.js`） |
| `lib/local-synth.js:174-260` | 只发 `type:'text'` | 新增 image 条目 + 图区域降级为 caption 文本；`markdown` 输出图片段落（跳过转义） |
| `lib/local-engine.js:281-390` | `extract()` → `{markdown,contentList,pages,provider,title,warnings,stats}` | 增加 `files: [{rel:'images/<sha>.<ext>', data}]`；上限/降级/warnings（`image-unavailable`、`image-too-large`…） |
| `lib/parse-manager.js:393-437` | `executeLocalTask` 只写 full.md/content_list | 把 `files` 并入写入列表 → `writeStagedParsed`（`:619-637` 已 `mkdir -p dirname`，天然支持 `images/`） |
| `lib/config.js` / `DEFAULT_LOCAL_CONFIG`（`lib/local-engine.js:32-42`） | 无图片配置 | `local.images: true/false`、`maxImages`(默认 **200**)、`maxImageBytes`(默认 8 MiB)、`maxTotalImageBytes`(默认 64 MiB)、`maxImagePixels`(默认 16M)、`minImagePixels`(过滤 <64×64 装饰图)；白名单统一为 png/jpg/jpeg/webp（与 integration 一致） |
| 阅读台 | — | **0 改动**（见下） |

阅读台已具备的消费能力（无需修改）：

- `ui/markdown.js:1165 mdDetectFigure`：独立 `![alt](src)` 或 `<img>` → `{kind:'figure',src,alt,caption}`；caption 来自 alt（`:1151 mdCaptionFromAlt`）。
- `ui/app.js:1015 mruImageUrl(docId, src)` → `/dsh-litnotes/api/asset?id=…&path=<src>`；`ui/app.js:2164` figure 渲染 `<img>`+`figcaption`。
- `lib/routes.js:234 handleAsset`：只服务 `parsed/**`（`resolveWithin` 防逃逸）；`lib/mime.js:37 IMAGE_EXTENSIONS` / `:109 mimeForPath` 已含 png/jpg/jpeg → **`images/xxx.png` 直接可显示**。
- `ui/markdown.js:1437 appendPageMarks` + `:1365 mdMatchContentEntry`：image 条目按 basename/alt-caption 匹配 figure block，页标记可用。
- `lib/mime.js` 文件头注释明确 “Extracted parse assets (images) use the wider IMAGE_EXTENSIONS”。

### 5.5 降级规则（富内容失败不影响文本解析）

- 位图解码失败/不支持的 Filter（JPX/JBIG2/CCITT/LZW）→ 不写图片、该图降级为 caption 文本（若捕获到 caption）；记 warning。
- 矢量图（P0 阶段）→ 只输出 caption 段落，不写假图；`meta.parse.local.rich.images` 记录 `embedded/regions` 计数供 UI 提示“图片待光栅化”或用 P1 补齐。
- 光栅化失败（浏览器渲染异常/DSH 服务不可用）→ 同上降级，读者仍看到 caption 与页标记。
- 表格区域**禁止**走图片管线（rich-tables 负责 HTML 表；MinerU 的 table img 是页面裁剪，不要模仿）。
- **小图标过滤（bee 实例教训）**：无 caption 且**放置面积 < 页面积 1.5%** 的位图（如 bee Fig.3 内 3 个箭头图标，放置约 28×15/1000）应作为装饰丢弃，避免“图内图标被当成 3 张独立图”；带 caption 或面积达标的位图才输出。建议配置 `minPlacementAreaRatio`（默认 0.015）与 `minImagePixels`（默认 4096）双重过滤。

---

## 6. 风险

1. **覆盖率风险（最大）**：纯 JS 位图提取对“矢量图 PDF”接近 0（bee 0/26、acl 0）。若不实现 P1 光栅化，成品在学术 PDF 上会被用户视为“仍然没有图”。必须把“图区域定位（P0）”与“光栅化（P1）”绑定规划。
2. **区域检测的适用范围**：Form BBox 法只对 **以 Form XObject 嵌图**的 PDF（pdfTeX/PTEX、部分 Word 导出）有效；Word/PPT 直绘、扫描件、网页打印 PDF 的图没有 Form 边界 → 需要 fallback（整页渲染 + 启发式裁切/ML 版面，均超本次范围）。docx/pptx 本地路径先经 officeToPdf → PDF，其图多为直绘位图（A 路线可覆盖位图；无 Form 区域时 P0.5 失效）。
3. **表格/公式误判为图**：MinerU 真值里 table 也是页面裁剪位图；本地若把 Form 区域一律当图，会把表/公式渲染成图片，损害可检索性。需 caption/结构排除（表格由 rich-tables 处理，公式由 rich-formulas 处理）。
4. **颜色/透明（实测已踩到）**：bee 的 3 个 DCT 位图**都带 `/SMask` 透明通道**（透明底图标），JPG 本身不支持 alpha → 直通导出会丢透明、深色主题/非白底上出现黑底（`out-bee/*.jpg` 实测黑底）。生产选择：① 无 SMask 的 DCT 直通 jpg；② 带 SMask 的 DCT 需解码 JPEG 后合成 PNG（纯 JS JPEG 解码器 ~500+ 行或复用 pdf.js/canvas，P2），或先输出 jpg 并接受丢 alpha（图标类通常被过滤掉，见下条）；③ Flate 路径已支持 SMask→RGBA。其他：CMYK DCT（Adobe APP14 反相）、Indexed 调色板、`/Decode` 反色、ImageMask stencil；原型覆盖常见项，但 CMYK→RGB 近似、ICC 未做色彩管理（视觉可能偏色）。
5. **重复图/超大图**：同一 XObject 多页复用（hash 去重已解决）；单页渲染 810×1200×4B ≈ 3.9 MB RGBA，高 DPI 4× 会超 16M px，必须设 `maxPixels/maxDimension/maxTotalImageBytes`，防止 Host 内存峰值。
6. **页标记/AI 检索**：image 条目 `text:''`；`appendPageMarks` 已兼容（image 分支），但**顺序**必须按阅读顺序；AI 检索（`lib/ai/retrieval.js`）不索引 figure，caption 必须是独立文本段才可被检索/翻译。
7. **版权/隐私**：图片来自用户本地 PDF，不上传；hash 文件名不含语义；但导出/分享 parsed 资产会包含原图（与 MinerU 行为一致，需产品说明）。
8. **重解析稳定性**：位图命名基于内容 hash 稳定；光栅裁剪若随客户端 DPR/DPI 变化会改文件名 → 固定渲染参数，或按 `source sha + page + bbox` 命名（需与 integration 的 blockKey 稳定性要求对齐）。
9. **浏览器渲染体验**：需动态 import pdf.js（1.5 MiB）+ worker；大页渲染 100–500 ms/页，懒加载/取消/并发限制必需；内存（canvas + 页面位图）在低端设备可能紧张；渲染失败必须静默降级。
10. **跨仓库依赖（DSH 服务）**：路线 D 需要 DSH 仓库改动（officeToPdf 增加 PDF→PNG，底层 kit 已具备）；版本协调/发布节奏不受本插件控制。

---

## 7. 工作量估算

| 阶段 | 内容 | 人日 |
|---|---|---|
| **P0** | 纯 JS 位图对象提取（对象/ObjStm/页面树/内容流 Filter/颜色/predictor/PNG encoder/上限）+ 单测 + 集成（local-pdf/synth/engine/parse-manager/config/openapi 文档） | 3–4（原型 727 行已验证核心；生产化 + 异常路径 + 测试约 2–3 倍） |
| **P0.5** | 区域定位（pdf.js op list 追踪 form begin/end+transform，或复用原型的 Form BBox 法）+ 邻近聚类 + caption 关联 + 表格/公式排除 | 2–3 |
| **P1a** | 浏览器端 pdf.js 渲染 + bbox 裁剪 + 降级 + 懒加载/缓存（可选回传 API） | 3–4 |
| **P1b** | DSH officeToPdf 扩展 PDF→PNG（kit renderImages + crop/PNG 解码）+ 插件可选调用 | DSH 1–2 + 插件 1 |
| **P2** | @napi-rs/canvas vendor（多平台打包/CI）+ 或扫描件 OCR | 2+（不建议近期） |

> MVP（P0+P0.5：位图真图 + 矢量区域元数据/caption 保留）≈ **5–7 人日**；完整（P0+P0.5+P1a）≈ **8–11 人日**。

---

## 8. 证据附录（本机命令/输出）

```bash
cd /home/nirvana/Documents/dsh-mineru/.agents/tmp-research/rich-images
F=/home/nirvana/Documents/dsh-mineru/.agents/tmp-research/lead/rich

# 1) 纯 JS 位图提取（727 行原型，零 npm 依赖）
node extract.mjs $F/bee.pdf       ./out-bee       --clean
# → {"pages":27,"occurrences":3,"uniqueImages":3,"unsupported":0,"encrypted":false}   (121 ms)
node extract.mjs $F/attention.pdf ./out-attention --clean
# → {"pages":15,"occurrences":3,"uniqueImages":3,...}   (372 ms; 3×PNG RGBA 111/61/19 KB)
node extract.mjs $F/acl.pdf       ./out-acl       --clean
# → {"pages":17,"occurrences":0,"uniqueImages":0,...}   (162 ms)

# 2) 与 MinerU 真值对比（位图放置，IoU≥0.2）
node compare.mjs $F/bee-content_list.json out-bee/report.json bee
# → {"truthFigures":26,"truthByType":{"image":7,"table":3,"chart":16},"extractedOccurrences":3,"hit":0,"miss":26,"hitRate":0}

# 3) Form XObject 区域定位 vs 真值
node compare-forms.mjs
# → {"truthFigures":26,"hit":23,"miss":3,"hitRate":0.88}（miss 全为 table；image+chart 23/23，中位 IoU 0.88、最小 0.35）

# 4) pdf.js operator list（Node 无 canvas）
node pdfjs-oplist.mjs $F/bee.pdf   # 仅第 5 页 3×paintImageXObject；objs.get → "isn't resolved yet"
node oplist-summary.mjs $F/bee.pdf bee-oplist.json   # 每页 pathOps/imageOps/forms（chart 页 imageOps=0）

# 5) DSH libreoffice-kit / PDFium 光栅化实测
node render-test.mjs   # 单页 → 810×1200 / 289,813 B / 5.41 s；rasterEngine:"pdfium"
node render-bench.mjs  # 全 27 页 → 7,700,764 B / 8.9 s / 每页 810×1200 @120dpi
#   入口：~/.local/share/pnpm/global/v11/.../.pnpm/@deepseek-ai+libreoffice-kit@0.1.5
#   类型：lib/types/image-operations.d.ts（IMAGE_FORMATS 含 "pdf"；renderImages pages/dpi/maxPixels）

# 6) 包体积/许可（npm metadata）
#   @napi-rs/canvas 1.1.0 MIT  unpackedSize=166,133
#   @napi-rs/canvas-linux-x64-gnu 1.1.0 MIT  unpackedSize=36,878,158
#   canvaskit-wasm 0.42.0 BSD-3  unpackedSize=26,053,495（无 PDF renderer）
#   canvas 3.2.3 MIT（安装时需系统库；包体 402,510 不含预编译产物）
```

关键代码/论文事实引用：

- 本地引擎现状：`lib/local-pdf.js`（vendored pdfjs 5.4.449，仅文本层）、`lib/local-synth.js:174-260`（只发 `type:'text'`）、`lib/local-engine.js:281-390`（`extract()` 返回 markdown/contentList/pages/provider/title/warnings/stats）、`lib/parse-manager.js:393-437`（executeLocalTask 只写 full.md/content_list.json）、`:619-637`（writeStagedParsed 支持任意 rel 路径）。
- 阅读台：`ui/markdown.js:1165`（mdDetectFigure）、`:1151`（mdCaptionFromAlt）、`:1365`（mdMatchContentEntry image 分支）、`:1437`（appendPageMarks）；`ui/app.js:1015`（mruImageUrl）、`:2164`（figure 渲染）；`lib/routes.js:234`（handleAsset，parsed/**）、`:307`（handleSource，源 PDF）、`:354`（assetsHandler，vendor/**）；`lib/mime.js:37/:109`（图片扩展名与 content-type 已支持）。
- vendored pdf.js 路线的 Node 限制来自 pdf.js 自身：`pdf.mjs` 导入时 `Cannot load "@napi-rs/canvas"` 警告 + `ImageData/Path2D` polyfill 缺失（`lib/local-pdf.js` 也为此只装了 DOM stubs，见其模块注释）。

### 未决问题（交给集成/Lead 决策）

1. **光栅化在哪一端**：浏览器（无依赖、需客户端渲染）vs DSH PDFium 服务（headless、需跨仓库改动）——建议先 E 后 D。
2. **图区域与 caption 关联规则**：目前只做到“区域 + 最近 Fig./Figure caption”启发式；跨栏/多图并排（bee page 17/19 各 3 图）如何一对一，需要在 P0.5 用 caption 行 bbox 与区域 bbox 的空间关系细化并出测试。
3. **位图口径**：bee 中 Fig.3 内含 3 个小图标位图——是否作为独立图输出（建议 `minImagePixels` 过滤掉，让其作为整图区域的光栅化一部分）。
4. **CL 类型**：本地统一用 `type:'image'`（integration 建议，匹配器只认 image）还是对矢量图用 `type:'chart'`（MinerU 语义更像）——建议统一 image 以免页标记/匹配回退。
