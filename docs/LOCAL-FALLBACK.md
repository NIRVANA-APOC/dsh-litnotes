# 除 MinerU 之外：dsh-litnotes 本地化降级解析方案研究报告

> 快照：2026-11-06 · 对象：`dsh-litnotes`（DSH Web 插件，原 `dsh-mineru`）· 基线：分支 `dsh-41946cb9-4594`（DSH 0.2.2-rc.1）
> 研究问题：**当前插件除了 MinerU 以外，有没有本地化的降级替代方案？用于给不熟悉或无 MinerU Token 的用户准备。**
> 交付：本报告（选型结论 + 实测证据 + 推荐路线 + 分阶段实现计划）。文件级集成设计见
> [docs/research/integration.md](research/integration.md)，纯 Node 栈调研笔记见
> [docs/research/node-extract.md](research/node-extract.md)，重型本地引擎调研见
> [docs/research/sidecars.md](research/sidecars.md)。

---

## 实现状态（2026-11-06）

> 本节由 docs-writer 在 T0/T0.5 落地后追加；下文 §1–§8 仍是**调研时的快照**（含当时的行号与
> "现状：没有本地路径" 的判断），以本节和代码为准。另：§1 写的 `~/.dsh/litnotes/` 为当时笔误，
> 实际默认数据目录是 `~/.dsh/litnotes`（详见 `docs/ARCH.md` §3）。

**结论：P0（T0 内置 pdf.js 本地 PDF + T0.5 `officeToPdf` → PDF → pdf.js）已实现；P1（系统
pdftotext 探测）与 P2（侧车）未实现。**

### 已实现范围

| 计划项 | 状态 | 实现位置 |
|---|---|---|
| T0 内置 pdf.js 文字层解析 | ✅ | `lib/local-pdf.js`（pdfjs-dist 5.4.449 legacy min，懒加载）、`lib/local-synth.js`（`full.md` + 合成 `content_list.json`）、`lib/local-engine.js`（provider/capability/错误映射编排）、`vendor/pdfjs/{pdf.mjs,pdf.worker.mjs,LICENSE}`（≈1.54 MiB，Apache-2.0） |
| T0.5 Office → PDF → 文字层 | ✅（服务可选） | `lib/local-office.js` + `ctx.get('officeToPdf')`；doc/docx/ppt/pptx/xls/xlsx；服务缺失时该能力不可用 |
| 引擎模型 `auto\|standard\|agent\|local` | ✅ | `lib/mineru.js` `normalizeParseOptions`；`lib/config.js` `ENGINES` / `defaultEngine` |
| `auto` 无 Token local-first + 可选云端回退 | ✅ | `lib/mineru.js:722-857`；偏好 `autoAllowAgentFallback`（默认 true） |
| 本地解析能力/状态暴露 | ✅ | `lib/service.js` `getStatus().local`、`getSettings().local`/`defaults.localProvider`；`index.js` 注入 `createLocalEngine` |
| parse-manager 引擎分叉与 local 产物落盘 | ✅ | `lib/parse-manager.js` `executeLocalTask()`（staging 复用、`parse.provider`/`parse.local` 持久化、local 不参与 repair/断点恢复） |
| Client：四引擎选择 / 质量 banner / 本地解析设置区 / 状态栏 / `local-*` 文案 | ✅ | `ui/app.js` + `ui/styles.css`（`lib/client.js` 由构建脚本重建） |
| 配置 `local:{enabled,maxPages,maxPdfBytes,maxTextBytes,minCharsPerPage,maxParagraphChars,keepContentList,timeoutMs,maxOfficePdfBytes}` | ✅ | `lib/config.js` 校验/钳制；默认值与 `lib/local-engine.js` `DEFAULT_LOCAL_CONFIG` 一致 |
| 错误码 `local-unsupported/missing-tool/empty-text/encrypted/failed` + `too-large` | ✅ | `lib/local-engine.js`、`lib/local-office.js`、`lib/local-pdf.js`、`lib/wire.js` `STATUS_BY_CODE` |
| 文档 | ✅ | `docs/ARCH.md`（§1/§2/§3/§4.1/§5.5/§8/§9.3/§10/§11）、`docs/HOST-INTERFACES.md`、`docs/UI-SPEC.md`、`README.md`、本节 |

产物契约与 §5.3 一致：本地解析写 `parsed/full.md` + 合成纯数组 `parsed/content_list.json`
（`{page_idx,type:'text',text,text_level?}`，与 markdown block 1:1，供页码标记对齐），不写
`images/`，不迁移目录、不改 `schemaVersion`；`meta.parse` 增量字段为 `engine:'local'`、
`provider`、`local:{pageCount,textChars,extractMs,toolVersion,provider,warnings}`。

### 测试与门禁

测试与门禁已在工作区落地并通过（2026-11-06，文档更新时本机运行）：

- `node scripts/check.mjs` — **11/11 PASS**，含 `vendor pdf.js assets` 门禁（3 files，pdfjs
  5.4.449；校验 `vendor/pdfjs/{pdf.mjs,pdf.worker.mjs,LICENSE}` 存在且与
  `lib/local-pdf.js` 的 `PDFJS_VERSION` 一致）、client build 校验，以及内嵌的
  `node --test test/`：**301 passed / 0 failed**。
- 覆盖范围：`test/unit/local-{engine,pdf,synth,office}.test.mjs`（synth golden/确定性/页号、
  pdf.js 适配层、engine plan/extract、Office 错误映射）、`test/unit/local-pdf.test.mjs` 的真实
  `loadPdfjs()` vendor smoke + 最小合成 PDF、`test/e2e/local-flow.test.mjs`（真实 Host 栈、
  无 Token `auto` → local 且 mock-MinerU **零请求**、扫描件 `local-empty-text`）、
  `test/reader/local-artifact.test.mjs`（阅读台产物契约）。

测试仍在并行补充，数字以最终 `test/` 与 `scripts/check.mjs` 为准。

### 与 P1/P2 的边界（未实现）

- **P1 `pdftotext` 探测与兜底未实现**：没有 `lib/local-tools.js` / `system:pdftotext`
  provider；设置面板已预留「系统 pdftotext」文案（`settings.localPdfTool`），但 Host 不会探测，
  因此不会出现在 capability 列表里。
- **P2 侧车未实现**：没有 `lib/local-sidecar.js`，没有 MinerU 本地版 / Docling / MarkItDown /
  OCR 探测；扫描件仍只能走云端解析或用户自建 OCR。
- **Office 只走 `officeToPdf`**：没有自写 OOXML 回退（§6 P2 项），也没有 LibreOffice CLI 直调。
- **与 §5.1 的偏差（以代码为准）**：原计划 `config.local.provider = auto|builtin|system|sidecar`
  未实现；provider 只在单次 `parse.start` 里用 `options.localProvider`
  （`auto|builtin|system:officeToPdf`）覆盖。`autoAllowAgentFallback` 在 Host 与偏好校验中已实现，
  但**设置面板尚无开关**（默认 true，客户端只读取）。
- 回滚开关仍在：`config.local.enabled:false` 恢复纯云端行为，已解析的本地文档保持可读。

> **富内容还原研究（2026-11-07）**：本地引擎如何还原公式/表格/图片已单独研究并给出分阶段方案，见 [LOCAL-RICH-CONTENT.md](LOCAL-RICH-CONTENT.md)（纯 Node 启发式：表格 F1≈0.985、公式 Dice≈0.95、图片需 Form 区域定位 + 条件性客户端光栅化；**尚未实现**，仍属本文 §7 未验证边界）。

## 0. 结论速览

- **现状**：插件**没有**任何本地解析路径。解析只有 MinerU 两个云端引擎——`standard`（需 Token，
  ≤200 MB / ≤200 页，公式/表格/OCR）与 `agent` 轻量档（免 Token，≤10 MB / ≤20 页，仅 Markdown，
  按 IP 限流）；两者都**必须把原文件上传到 `mineru.net`**。因此对「没有 Token 且文件超限」的
  用户、对「离线/隐私」用户，今天没有可用路径。
- **答案：有本地化降级方案，而且不止一条。** 按安装成本与质量分成四档：
  1. **T0 内置零安装**（推荐先做）：随插件 vendor 一个 Apache-2.0 的 PDF 文字层解析器
     `pdfjs-dist`（legacy **min** 构建，2 个文件 + LICENSE，**≈1.53 MiB**），在 Host 进程内把有文本层
     的 PDF 抽成 Markdown。离线、不上传、无 Token、无大小上限。Office 可在 P1 借 DSH 自带的
     `officeToPdf` 服务转 PDF 后走同一提取链；HTML 可选轻量转换。
  2. **T0.5 DSH 内置服务**：web profile 已挂载官方 `office-to-pdf`（LibreOffice WASM/native，本地
     运行、无需用户安装 LibreOffice），可把 doc/docx/ppt/pptx/xls/xlsx 本地转 PDF，弥补自研 OOXML
     解析的版面短板。
  3. **T1 系统工具探测**：`pdftotext`/`pdfinfo`（poppler）、`tesseract`、`soffice` 等本机 CLI，
     检测到就用；增强质量/OCR，但跨平台不一致，只能「有则更好」。
  4. **T2 用户侧车（专家模式）**：MinerU 本地版、Docling、Marker、MarkItDown、GROBID、OCR 工具链。
     质量最高（公式/表格/扫描件），但要用户自己装 Python/Docker 与模型（GB 级）；其中
     **MinerU 本地版 4.x 是最值得优先探测接入的侧车**：质量最高、CPU 可跑、产物接近云端（Markdown + images
     直接可用；`content_list.json` 需从 `middle_json.json` 合成一层适配）。
     （T3 本地 VLM 仅作展望，不建议本阶段做。）
- **推荐落地顺序**：**P0** = T0「本地基础解析」+ 引擎选择 + 自动降级 + 质量提示（约 3 人日）；
  **P1** = T0.5 Office→PDF + T1 `pdftotext` 探测（约 2–3 人日）；**P2** = T2 侧车探测（MinerU 本地版
  优先，其次 Docling / PaddleOCR-VL，MarkItDown 作最轻兜底；约 3–5 人日）。
- **关键结论（实测支撑）**：pdfjs 与 `pdftotext` 的**可见字符**差仅 **0.02%–0.42%**
  （Attention +0.05% / ACL +0.42% / 中文 +0.02%），15 页论文 **337–400 ms**、峰值 RSS **129 MB**
  （RSS/耗时实测来自 4.10.38；5.4.449 只交叉验证了字符数一致）；逐页边界天然精确，页码标记甚至
  比 MinerU 更可靠。公式、表格结构、图片、扫描件文字是主要质量损失；双栏阅读顺序在样本上正确
  但需 P0.5 兜底。
- **不要做**：手写 PDF 解析器（风险/成本 > vendor pdfjs）、随包分发 AGPL 的 npm 版 MuPDF、
  Office 重依赖（officeparser >100 MB、SheetJS npm 版有 CVE）、用 markdown 注释当页码标记
  （实测证伪，见 §4.5）、把「本地解析」宣传成与 MinerU 等质量。

---

## 1. 现状：当前插件的解析链路与缺口

### 1.1 两个云端引擎

| 维度 | `standard` 精准解析 | `agent` 轻量解析 |
|---|---|---|
| Token | 需要（credentials 服务保存） | 不需要 |
| 限制 | ≤200 MB / ≤200 页 | ≤10 MB / ≤20 页，IP 限流 |
| 输出 | `full.md` + `content_list.json` + `images/**` | 仅 `full.md`（图片为远程链接） |
| 能力 | 公式/表格/OCR/页码范围 | 快速 Markdown |
| 网络 | 原文件上传 `mineru.net` | 原文件上传 `mineru.net` |

代码事实：`engine: auto|standard|agent`，`auto = 有 Token ? standard : agent`（`lib/mineru.js:710-796`）；
UI 解析面板三选一（`ui/app.js:1696-1703`），无 Token 时提示「配置 Token」（`needsToken` 判定
`ui/app.js:1661`）。数据目录 `~/.dsh/litnotes/`，产物落在 `documents/<id>/parsed/`。

### 1.2 阅读台对产物契约的要求（决定了降级方案的边界）

- **必需**：`parsed/full.md`（Markdown）——大纲、正文、翻译、高亮、批注都从它来。
- **页码标记**：**只**来自 `content_list.json` 的 `page_idx` 跳变（`ui/markdown.js:1437-1490` 的
  `appendPageMarks`）；不在 markdown 里找页码。缺 content_list ⇒ 无页码标记（不影响正文阅读）。
- **页码数/进度**：`pages = pagesOf(contentList) ?? meta.parse.pages`（`lib/store.js:568-606`）。
- **高亮锚点**：`blockKey = b<index>:<fnv1a(plainText)>`（`ui/markdown.js:51-63,703`）；页标记插入
  不改变原 block 的 index/key，所以**同一份本地产物重复解析不会丢高亮**。
- **按页修复**：需要 `contentList` + Token（`lib/parse-manager.js:219-261`）；本地解析文档应显式
  禁用该入口（整篇重解析即可）。
- **翻译**：按 block 逐段调用，单段上限 20000 字符（`lib/service.js:37`）。

### 1.3 约束（设计红线）

- Host 半是**零 npm 依赖**的纯 Node ESM（`docs/ARCH.md` §1/§11）；插件以 bundle 目录安装，
  **没有 `npm install` 步骤**——加 `dependencies` 不会在用户机器上生效，因此「加依赖」不可行；
  要做内置能力只能 **vendor**（已有先例：`vendor/katex`，592 KB）。
- Client 半由 `ui/**` 打包生成，不能 import npm 包；数据目录与 `meta.json` 只做增量字段。
- 可选 Host 服务一律 `ctx.get(...)` 可选处理；新增能力不得静默破坏既有云端流程。

**结论：本地化缺口 = 一个「零安装、离线、产物与云端同构」的提取器 + 引擎选择与降级策略。**
产物同构是关键——只要写出 `full.md`（+ 可选 `content_list.json`），阅读台/翻译/批注/导出零改动。

---

## 2. 候选方案全景与甄别

### 2.1 分档框架

| 档位 | 安装成本 | 典型方案 | 质量 | 覆盖 | 适合 |
|---|---|---|---|---|---|
| **T0 内置** | 0（随插件） | vendored pdfjs-dist + 合成器 | 文字层好，结构弱 | 文字层 PDF（含 CJK）；Office 需 P1 | 所有无 Token 用户默认路径 |
| **T0.5 内置服务** | 0（DSH web profile 已带） | `officeToPdf`（LibreOffice WASM） | 版面较好（转 PDF 后提取） | Office 6 类 | web profile 用户 |
| **T1 系统 CLI** | 系统已装 | poppler `pdftotext`、tesseract、soffice | 文本≈pdfjs；结构差 | 取决于系统 | 有工具的用户增强 |
| **T2 侧车** | 用户自装（GB 级） | MinerU 本地版、Docling、Marker、MarkItDown、OCR 链 | 最好（公式/表格/扫描件） | 全部 | 进阶/离线重度用户 |
| **T3 本地模型** | 高（GPU） | Ollama + VLM 页面 OCR | 不确定 | 全部 | 展望，暂不做 |

### 2.2 逐项甄别（含排除理由）

**PDF 文本层**

| 候选 | 结论 | 理由（证据见 §4） |
|---|---|---|
| **pdfjs-dist（legacy min）** | ✅ **P0 首选** | Apache-2.0；最小 vendor 1.53 MiB；Node 进程内；可见字符≈pdftotext（差 0.02%–0.42%）；逐页边界 + 坐标 + outline 三类阅读台需要的信息都有 |
| unpdf | ⚠️ 备选 | MIT；体积仅 2.1 MB（自带 pdfjs），但封装层可控性差；**2.x engines>=24（已核），1.x 无 engines 声明、Node 20/22 未验证**；自己 vendor pdfjs 更透明 |
| pdf-parse | ❌ | 依赖 `@napi-rs/canvas` 原生二进制（21 MB unpacked），封装价值低 |
| mupdf（npm/wasm） | ❌ | **AGPL-3.0-or-later**，与随插件分发冲突；14 MB |
| 手写 PDF 解析器 | ❌ | xref/ToUnicode/CID/xref 流/线性化/加密的覆盖面风险远高于 vendor 一个成熟库（P0 工作量可从 1.5–2.5 人日降到 ~0.5 人日） |
| 系统 `pdftotext` | ⚠️ P1 探测 | 文本层字符≈pdfjs，但**没有标题/页码/坐标**，阅读台体验显著变差；Windows 基本没有；仅作「有则更好」 |

**Office（DOCX/PPTX/XLSX）**

| 候选 | 结论 | 理由 |
|---|---|---|
| **DSH `officeToPdf` 服务** | ✅ **P1 首选** | web profile 已挂载（LibreOffice kit/wasm）；零用户安装；转 PDF 后复用 PDF 提取链；可选服务缺失时降级 |
| 自写 OOXML 子集（复用 `lib/unzip.js`） | ⚠️ P2 回退 | 0 新增体积，原型 ~160 行即可出 docx 标题/列表/表格（HTML）、pptx 要点、xlsx Markdown 表；但 XML 命名空间/健壮性/图片/公式缺口需补 |
| mammoth（仅 docx） | ⚠️ 可选 P2 | BSD-2，质量好；但要 +6.1 MB 依赖、表格拍平、不支持 pptx/xlsx |
| officeparser | ❌ | MIT 但**包本体 35.8 MB / 安装树 >100 MB**（含 tesseract.js-core 44 MB、@napi-rs 36 MB）、依赖 pdfjs6+native canvas；engines 仅三个窄区间（`>=22.23.4 <23 \|\| >=24.22.1 <25 \|\| >=26.12.1`） |
| SheetJS（xlsx npm 版） | ❌ | npm 版停在 2022，CVE-2023-30533 等修复仅在官方 CDN 版；+13 MB |
| LibreOffice CLI | ⚠️ P1 探测 | 有则可用；大多数普通用户没装 |

**HTML / 网页**

| 候选 | 结论 | 理由 |
|---|---|---|
| turndown + domino | ⚠️ 可选（+0.9 MB，MIT） | 实测标题/列表/链接/代码/图片/引用正确；表格需自定义 rule |
| readability + jsdom | ❌ | jsdom 8.4 MB，对插件太重；readability 需要 DOM |
| 自写极简 HTML→文本 | ⚠️ 可选 | ~80 行，对网页文章够用；优先级最低 |

**重型本地引擎（T2）**

| 引擎 | 许可证（代码 / 权重） | 安装 / 硬件门槛 | 输出契约 | 结论 |
|---|---|---|---|---|
| **MinerU 本地版 4.x** | 代码自 3.1.0 起 **Apache-2.0 + 附加条款**（MAU>1 亿或月收入>$2000 万需商业许可；在线服务须署名）；新 VLM/`MinerU-4_models_torch` 权重 Apache-2.0，**旧 MinerU2.5-2509 权重仍 AGPL**（按版本区分） | `uv tool install --python 3.12 "mineru>=4.0,<5"`；basic 档模型 ~0.8 GB / 内存 2 GB，standard 档 ~2 GB / 内存 8 GB（CPU 可跑，≥12 逻辑核才自动 standard）；磁盘 ~2–3 GB | `markdown.md`+`images/`+`middle_json.json`；**content_list 需适配**（Node 从 middle_json 合成，或 Python render API） | **T2 首选**：质量最高、CPU 可跑、产物接近云端 |
| **Docling**（IBM） | MIT（代码）；模型 CDLA-Permissive-2.0 / Apache-2.0 | `uv tool install docling`；纯 CPU 可跑；磁盘 2–3 GB；有 docling-serve REST | `--to md/json`（含 pages/bbox），可合成 content_list | T2 次选：许可干净、表格强 |
| **Marker**（datalab） | 代码 Apache-2.0；**权重 modified AI Pubs OpenRAIL-M**（研究/个人/<$5M 融资或收入免费，商用需授权） | PyTorch + GPU 建议（balanced 需 vLLM）；依赖重 | Markdown/JSON | T2 备选；GPU/权重许可门槛 |
| **MarkItDown**（微软） | MIT | `uv tool install "markitdown[pdf,docx,pptx,xlsx]"`；几十 MB、无模型 | 仅 Markdown（无页码/图片） | 最轻兜底（文本层 PDF/Office/HTML） |
| **PaddleOCR-VL / PP-StructureV3** | Apache-2.0（代码与权重） | paddlepaddle Linux wheel 186 MB + 0.9B 权重；CPU/GPU 速度待验证 | Markdown/JSON（带坐标） | 质量天花板候选（OmniDocBench 96.34，> MinerU2.5-Pro 95.75），P2 值得单独 spike |
| **OCR 链**：OCRmyPDF+Tesseract / RapidOCR | OCRmyPDF MPL-2.0；Tesseract Apache-2.0（⚠️ 依赖 Ghostscript **AGPL**）；RapidOCR Apache-2.0 | 纯 CPU；RapidOCR ~50 MB；OCRmyPDF 需系统包（Windows 仅 WSL） | 带文字层 PDF / 文字框+文本，再走文本提取 | 扫描件覆盖 |
| **GROBID** | Apache-2.0（Java/Docker） | Docker + Java；纯 CPU | TEI XML（header/参考文献） | 学术元数据/参考文献专用，非 Markdown |
| Unstructured | Apache-2.0（依赖/模型许可混杂） | 114+ 依赖、GB 级 | elements JSON | 不推荐（依赖/许可复杂） |
| 本地 VLM（Ollama + Qwen3-VL 等） | Ollama MIT；模型 Apache-2.0 | 7–8B 需 ~6 GB 显存；CPU 1–5 分钟/页 | 逐页文本，无结构 | T3 展望 |

> 侧车的安装命令/版本/探测命令/质量证据/避坑清单见 [sidecars.md](research/sidecars.md)。
> 关键避坑：Marker/Surya 权重 OpenRAIL-M（$5M 门槛）+ GPU；PyMuPDF 双许可 AGPL；OCRmyPDF 依赖
> Ghostscript(AGPL)；Unstructured 114 依赖；GROBID 只出 TEI。**普通用户侧车门槛 = Python 环境 +
> 2–3 GB 模型下载**，插件只做「复制命令 + 重新检测」，不代跑安装。

---

## 3. 设计目标

1. **零安装可用**：无 Token 用户导入有文本层的 PDF，默认就能读——不装 Python、不配 Token、不上传。
2. **隐私可解释（不上传文件）**：`local` 引擎**不把文档上传到云端**，提取阶段不联网；但 P2 侧车
   首次运行可能需要联网下载模型（0.8–3 GB）——UI 必须提前披露，并提供离线预下载/进度/取消；
   不要承诺「永不联网」。
3. **产物同构**：本地解析与 MinerU 产物同一目录/同一 schema；阅读台、翻译、批注、导出零改动；
   随时可整篇重解析回云端。
4. **可回退**：配置级开关关闭 local；已解析文档仍可读；数据目录不迁移。
5. **分档演进**：P0 内置 → P1 系统服务/工具 → P2 侧车，每档独立发布、独立回滚。
6. **安全**：子进程只允许固定命令 + 参数数组（`shell:false`）、路径只来自 store、超时/输出上限；
   侧车命令只来自运维配置，绝不接受客户端输入。

---

## 4. 实测证据（本机，2026-11-06）

> 环境：Linux x86_64，Node v26.13.0，npm 12.2.1；系统有 poppler（pdftotext/pdfinfo/pdftoppm）与
> Ghostscript，**没有** tesseract/libreoffice/pandoc/mineru。实验产物在仓库外 scratch。
> 样本：Attention（arXiv 1706.03762，15 页单栏，有 outline）、ACL 2024 论文（17 页双栏，无 outline）、
> 中文维基「北京」（42 页 CJK，内嵌字体）、自造扫描件（纯图片 PDF）、自造加密 PDF。

### 4.1 PDF 文本层抽取对比

| 样本 | 方案 | 页 | 字符数（含空白） | 可见字符（去空白） | 耗时 | 峰值 RSS | 顺序/标题 |
|---|---|---|---|---|---|---|---|
| Attention | **pdfjs 4.10.38 legacy min vendor** | 15 | 38,804 | **33,486** | **337 ms** | **129 MB** | 顺序 OK；outline 7 顶层/22 嵌套 |
| Attention | pdfjs 5.4.449 legacy min（Lead 独立实测） | 15 | 38,804 | — | ~400 ms | — | 字符数一致（未做逐字 diff） |
| Attention | pdftotext raw 基线 | 15 | — | **33,470** | ~10 ms | — | 顺序 OK；无标题结构 |
| ACL | **pdfjs 4.10.38 legacy min vendor** | 17 | 70,504 | **60,859** | **320 ms** | **112 MB** | 章节顺序单调 OK；outline 0 → 字号启发式 |
| ACL | pdftotext raw 基线 | 17 | — | **60,607** | ~10 ms | — | 章节顺序近似；无标题结构 |
| 中文维基 | **pdfjs 4.10.38 legacy min vendor** | 42 | 94,011（27,160 CJK） | **88,933** | **1.18 s** | **196 MB** | CJK/标点全对 |
| 中文维基 | pdftotext raw 基线 | 42 | — | **88,913** | ~30 ms | — | 同样正确 |

- **可见字符差仅 +0.05% / +0.42% / +0.02%（0.02%–0.42%）**：本地提取的正文在字符层面几乎无损。
  注意：pdfjs 的 `chars` 含空白字符（38,804 / 70,504 / 94,011），**不能**与 pdftotext 的可见字符
  直接相减；对比必须用「可见字符」口径（33,486 / 60,859 / 88,933 vs 33,470 / 60,607 / 88,913）。
- **双栏阅读顺序**：pdfjs 的 **content-stream 原序**在两篇论文上顺序正确（Abstract→正文→References
  单调）；`pdftotext -layout` 对双栏会**逐行左右交错**（不可用）；自写「按 y/x 排序」实测更糟
  （字数膨胀、左右栏重复）——正确做法是 content-stream 原序 + 可选「栏检测重排」。
- **pdfjs 独有收益**：逐页边界（页码标记天然精确）、每行 x/y/字号（标题启发式与 bbox）、
  `getOutline()`（对 arXiv 类论文可直接映射标题层级）——这些 `pdftotext` 给不了，因此**首推 pdfjs
  而不是系统 CLI**。
- **已知弱点**：含大图/浮动体的页可能先出图内文字；标题启发式仅靠字号噪声大（ACL 30 个候选），
  需「字号 + 编号正则 + 短行」组合。这两点列为 P0.5。

### 4.2 打包与运行时（决定成本）

- **最小 vendor 子集**：`pdf.mjs` + `pdf.worker.mjs` + `LICENSE`（Apache-2.0）：
  - `pdfjs-dist@5.4.449` legacy min ≈ **1.53 MiB**（实测 483,425 + 1,123,767 = **1,607,192 B**）；
  - `pdfjs-dist@4.10.38` legacy min ≈ 1.74 MiB，Node≥20 即可；两者**抽取字符数一致**（未做逐字 diff）。
  - 下文体积单位均为 MiB（1 MiB = 1,048,576 B）。
  - 不打包：`standard_fonts/`（0.8 MB，仅渲染）、`wasm/`（1.5 MB，图像解码）、
    `image_decoders/`、`web/`、source map。
  - 可选：`cmaps/`（169 文件 1.7 MB）——中文维基样本加/不加**输出完全相同**；仅「未内嵌且无
    ToUnicode 的 CJK CID 字体」才可能需要 → 作为可选「CJK 保险」，不默认打包。
- **两个实测坑**：
  1. 非 min 的 legacy `pdf.mjs` **仅 import 就 +335 MB RSS**（42→377 MB，gc 不回收）；min 构建只 +11 MB。
     → vendor 目录只放 min，且**懒加载**（首次本地解析才 `await import()`）。
  2. Node 下不设 `GlobalWorkerOptions.workerSrc` 时，pdfjs 会按同目录 **`pdf.worker.mjs`** 名字 import
（即使文件名是 min）→ 要么把 worker 的 min 文件重命名为 `pdf.worker.mjs`，要么显式设置
     `GlobalWorkerOptions.workerSrc`（两者均实测可用；不 vendor worker 会报 fake worker 加载失败）。
- **Node 版本**：5.4.449 的 engines 是 `>=20.16 || >=22.3`；5.7/6.x 要求 `>=22.13 || >=24`；
  **DSH 本体要求 Node ≥24.9（0.2.2-rc.1）**，因此 5.4/5.5 在 DSH 内均安全。插件目前自称
  `>=20.11`：建议顺手把 engines 提到 **`>=20.16`**（用 5.4.449），否则退回 4.10.38（1.74 MiB，
  抽取结果一致）。
- **许可证**：pdfjs-dist 为 Apache-2.0，vendor 时保留 `LICENSE` 并在 README/第三方声明注明。
- **内存量级**：15–42 页文档峰值 112–196 MB；200 页大 PDF 可能到数百 MB → Host 侧需页数/大小上限 +
  复用现有解析队列（`maxConcurrentParses`）。

### 4.3 特殊 PDF

| 场景 | 实测行为 | 处理 |
|---|---|---|
| 扫描件（纯图片） | 正常打开，`chars=0`、有文本层页数为 0 | 判定 `local-empty-text` + `warnings.scanned`；UI 引导 MinerU 轻量/精准或 OCR 侧车 |
| 有用户密码 | `PasswordException: No password given` | 映射「PDF 已加密」；可提供密码重试（pdfjs 支持 password 参数） |
| 仅 owner 密码（空用户密码） | 4.10.38 抛 `UnknownErrorException`（Symbol bug）；5.4.449 未复测 | try/catch 兜底为「权限加密暂不支持」 |
| 破损/非 PDF | `InvalidPDFException` | 映射「文件不是有效 PDF」 |

### 4.4 Office / HTML 原型

- **自写 OOXML（复用 `lib/unzip.js`）原型 ~160 行**：docx 1,002 字符/2 ms（标题/列表/粗斜体/代码/
  链接/表格→HTML 均出，丢上标/图片/OMML/页眉）；pptx 335 字符/3 ms（`## Slide N` + 要点）；
  xlsx 200 字符/3 ms（多 sheet → Markdown 表）。**新增体积 0**。缺口：图片抽取、合并单元格、
  多级编号、`.doc/.ppt/.xls` 旧二进制格式、命名空间健壮性。
- **HTML**：turndown（216 KB）+ domino（676 KB）输出质量好（标题/列表/链接/代码/图片/引用；
  表格拍平）；readability+jsdom（8.4 MB）过重，不推荐。
- **DSH `officeToPdf` 服务**（web profile 已挂载，id `office-to-pdf`，底层 LibreOffice kit/wasm）：
  Host 可 `ctx.get('officeToPdf')` 调用 `convert({extension, priority, source:{key,version,read}}, signal)`
  → `{pdf, missingFonts, ...}`；零用户安装、本地执行、无新 npm 依赖。**可选服务**，profile 差异需
  降级处理；`missingFonts` 应转为质量提示。

### 4.5 产物契约 spike（决定本地产物怎么造）

用真实 PDF 提取文本 + 启发式合成 `full.md`/`content_list.json`，再用仓库自己的阅读器纯函数验证：

- 合成 `full.md`：39 KB / 62 block / 25 个大纲项；`parseMarkdown` 大纲完整可导航。
- 合成 `content_list.json`（每 block 一条 `{page_idx,type:'text',text}`）：页码标记 1–15 **逐页落位
  正确**（`aligned:true`）、原 block 的 index/key **零漂移**、重复调用**幂等**。
- block key 稳定性：同一 markdown 两次解析 key 完全一致 → **本地重解析同一文件不会丢高亮**。
- 翻译分块：62 个可翻译 block、最长 3,208 字符（< 20,000 上限）→ 现有逐段翻译直接可用；
  合成器仍需段落长度上限（建议 4,000/硬 8,000）兜底。
- **重要证伪**：在 markdown 里插 `<!-- page: N -->` **不是**页码标记机制——会被当成普通段落，
  页码标记**只能**来自 `content_list.json`。本地引擎必须合成 content_list。
- 空提取（扫描件/乱码）会产出空 markdown → Host 必须在写盘前判 `local-empty-text`，否则用户只
  看到空阅读态。

---

## 5. 推荐方案

### 5.1 引擎模型

- 在现有 `auto|standard|agent` 之外显式增加第 4 个值 **`local`**（而不是塞进 auto 内部档位）：
  用户需要手动选择「离线/不上传」，`meta.parse.engine` 也驱动状态栏、失败重试、重解析默认值。
- 本地内部细分放 **`parse.provider`**：`builtin`（vendored pdfjs）| `system:pdftotext` |
  `system:officeToPdf` | `sidecar:<id>`；`config.local.provider = auto|builtin|system|sidecar`。
- **默认策略（建议）**：
  ```
  auto = 有 Token → standard
       无 Token → 本地可用 → local
                  → （可选，默认开）允许云端上传 → agent
                  → 否则明确报错并引导
  ```
  无 Token 时**本地优先**的理由：免 Token 的 `agent` 仍会上传文件，不满足「离线/隐私」语义。
  新增偏好 `autoAllowAgentFallback`（默认 true）给隐私用户关闭；解析面板必须提前显示
  「将使用：本地解析 / 轻量云端解析（文件会上传）」。
- 本地不支持的输入（扫描件、图片、无 `officeToPdf` 时的 Office）：按上述回落规则处理，
  并给出可操作引导；显式选 `local` 时**永不静默回落**。

### 5.2 分层能力矩阵

| 输入 | P0 builtin | P1 system | P2 sidecar |
|---|---|---|---|
| PDF 文字层 | ✅ vendored pdfjs | ✅ pdftotext（可选增强） | ✅ |
| PDF 扫描件 | ❌（检测 + 引导） | ❌（无 OCR） | ✅（OCR/版面引擎） |
| Office 6 类 | ❌ | ✅ 经 `officeToPdf` → PDF → 文字层 | ✅ |
| 图片 | ❌ | ❌ | ✅ |
| HTML | ❌（可选 turndown） | 可选 | ✅ |

### 5.3 产物契约（本地）

```
<dataDir>/documents/<id>/
  source.<ext>                       # 原文件保留
  parsed/
    full.md                          # 本地合成（唯一必需产物）
    content_list.json                # 合成，纯数组：[{page_idx:int, type:'text', text, text_level?}]
  annotations.json / translations.json  # 不动
```

- `meta.parse` 只加增量字段：`engine:'local'`、`provider`、`local:{pageCount,textChars,extractMs,
  toolVersion,warnings}`；`pages`、`hasContentList`、`completedAt` 等沿用既有字段。**不迁移目录、
  不改 schemaVersion**；旧版本代码忽略未知字段。
- `content_list` 的 `text` 必须与 markdown 对应 block 的纯文本**同源**（阅读台按规范化文本前缀匹配，
  最短匹配前缀 12–48 字符；建议写整段纯文本，截断也不影响前缀匹配）。**不要**在 CL 里写带
  `#`/`**` 的 Markdown 语法文本。段落合成上限：建议 ≤4,000 字符（硬上限 8,000），以适配翻译
  单段 20,000 字符上限。
- **不写 markdown 页码标记**（证伪）；不伪造 `type:'image'` 空条目。

### 5.4 UX（面向「不熟悉 / 无 Token」用户）

| 场景 | 设计 |
|---|---|
| 解析面板 | 引擎四选一：自动 / 精准（需 Token）/ **本地（离线·不上传）** / 轻量云端（会上传）；`local` 不可用时置灰并说明原因；底部小字「将使用：本地解析」 |
| Token 提示 | 从「配置 Token 才能用」改为「配置 Token 可解锁公式/表格/OCR 精准解析；本地解析无需 Token、不上传」 |
| 解析完成 | 质量 banner：「本文由本地解析生成：保留文字、段落与页码；公式、表格、图片未还原。」+ 「配置 Token 解锁精准解析」按钮 |
| 扫描件 | 明确失败原因：「未提取到文字，可能是扫描件；可用轻量云端解析（≤10 MB/≤20 页）或配置 Token」 |
| 状态栏 | 「本地解析 · builtin」/「本地解析 · pdftotext」等 |
| 设置面板 | 「本地解析能力」区：内置提取可用 / pdftotext 可用（版本）/ Office 转换可用；「重新检测」 |
| 重解析 | 本地文档隐藏「按页修复」，改为整篇重解析引导；`local-*` 错误码给具体引导 |
| 隐私 | **本地引擎不上传文档**、提取阶段不联网；`auto` 回落云端前明示「会上传文件」；显式 `local` 永不回落；P2 侧车首次下载模型需提前披露（支持离线预下载/进度/取消） |

### 5.5 安全与工程约束

- 子进程：`spawn(command, args, {shell:false, windowsHide:true})`，参数数组、路径仅来自 store 的
  UUID 校验路径、超时 SIGKILL、stdout/stderr 上限、只记命令名/版本/耗时，不记内容。
- 侧车命令仅来自配置（运维可信），输出目录做 `resolveWithin` 校验与大小上限。
- 本地能力探测懒执行 + TTL 缓存，不阻塞 Host 启动。

---

## 6. 分阶段实现计划（与 integration.md §7 对应，已按 pdfjs 决定修正）

### P0 —— 内置基础本地解析（约 3 人日）

**范围**：PDF 文字层 → `full.md` + 合成 `content_list.json` + 大纲/页码/质量提示；引擎模型与
UI 选择；零网络。

| 文件 | 改动 |
|---|---|
| `vendor/pdfjs/{pdf.mjs,pdf.worker.mjs,LICENSE}`（新） | vendor pdfjs-dist@5.4.449 legacy **min**（≈1.53 MiB，实测 1,607,192 B，Apache-2.0）；worker 重命名或显式 workerSrc |
| `lib/local-pdf.js`（新） | pdfjs 适配层：懒加载、`getTextContent()` → 页面块、`getOutline()`、字号+编号标题启发式、页数/大小上限、加密/损坏/扫描件分类 |
| `lib/local-synth.js`（新） | 页面块 → `full.md` + `content_list.json` + warnings/统计；去噪、标题、段落合并、长度上限；纯函数 |
| `lib/local-engine.js`（新） | capabilities/plan/extract 编排；`local-*` 错误码映射；provider 选择 |
| `lib/config.js` | `ENGINES` 加 `local`；local 配置块默认值/校验；偏好 `defaultEngine:local`、`autoAllowAgentFallback` |
| `lib/mineru.js` | `normalizeParseOptions`：engine 枚举、auto 无 Token → local、local 分支校验 |
| `lib/parse-manager.js` | 注入 localEngine；`executeTask` 唯一分叉点；复用 staging/队列/AbortController；`finishSuccess` 写 `parse.provider/local`；local 不可恢复、repair 守卫 |
| `lib/service.js`、`lib/agent-tool.js`、`index.js` | `status/settings` 暴露 local 能力；agent tool `parse.engine` 加 `local`；注入 localEngine |
| `ui/app.js` + `styles.css`（+ `lib/client.js` 重建） | 引擎选择/可用性/推荐、Token 文案、质量 banner、状态栏、错误映射、i18n（~25 条 zh/en） |
| `docs/*` | ARCH/HOST-INTERFACES/README 增量 |

**测试**：合成器 golden/确定性/页段落上限；pdfjs 适配层（最小合成 PDF fixture + 扫描件/加密/损坏/
outline）；**vendor smoke test（真实 `await import('../vendor/pdfjs/pdf.mjs')` + 最小合成 PDF，覆盖
懒加载/worker 路径/三文件存在，并把 vendor 文件存在性纳入 `scripts/check.mjs`）**；引擎与
parse-manager 分支（fake localEngine：成功/进度/取消/失败/并发）；reader 契约（大纲、页码 1..N
对齐、key 稳定、幂等）；e2e 零网络断言；`scripts/check.mjs` 全绿。

**验收**：无 Token profile 导入 15 页文字层 PDF，`auto` 默认本地、2–3 s 内完成、零 MinerU 请求；
阅读台大纲/页码/高亮/翻译可用；扫描件/图片/加密给出明确错误与引导；有 Token 时 auto 仍 standard。

### P1 —— 系统能力（约 2–3 人日）

- `lib/local-tools.js`：探测 `pdftotext`（poppler，作为可选增强/兜底）+ `officeToPdf` 适配。
- Office 6 类：`ctx.get('officeToPdf')`（web profile 已挂载）本地转 PDF → 复用 P0 提取链；
  `missingFonts` → warning + banner；服务缺失 → `local-missing-tool` 引导云端。
- 设置面板「本地解析能力」+ 重新检测。
- 测试：spawn 安全（ENOENT/超时/kill/输出上限/路径注入）、officeToPdf 各错误码、e2e 降级。
- **不做**：P1 不手写 OOXML（统一放 P2 回退）；pdftotext 仅作 builtin 不可用/失败时的兜底（raw 模式，
  不用 `-layout` 做阅读顺序）。

### P2 —— 侧车（约 3–5 人日）

- `lib/local-sidecar.js`：配置驱动的「输入文件 → 输出 `full.md`+`content_list.json`」目录协议；
  探测命令/版本、超时上限、输出校验。
- 优先级（质量优先）：**MinerU 本地版 4.x**（质量最高；产物接近云端，需 `middle_json`→`content_list`
  适配）→ Docling（MIT）→ PaddleOCR-VL（质量天花板候选）→ MarkItDown（最轻兜底）；扫描件走
  MinerU/PaddleOCR/RapidOCR/OCR 链；默认关闭、能力探测驱动 UI。成本优先的路径则是 MarkItDown 最先。
- Office 回退：`officeToPdf` 服务缺失时，P2 可用「自写 OOXML 文本子集」（复用 `lib/unzip.js`，
  0 新增体积）提取 docx/pptx/xlsx 的纯文本（无版面/表格结构）。
- 探测与版本：按大版本分流（MinerU 4.1 的 `/v1/tasks` 与 2.x/3.x 输出 flag 不同），锁
  `>=4.0,<5`；探测命令/缓存/超时见 [sidecars.md](research/sidecars.md) §10.2。
- 首次运行模型下载（0.8–3 GB）必须有进度/超时/取消，且**不静默下载**；插件只提供「复制命令 +
  重新检测」，不代跑安装。
- 测试：fake sidecar 脚本全链路；安全（注入/路径逃逸/输出超限）；失败不影响 P0/P1。

**阶段依赖**：P0 → P1 → P2，每阶段产物契约不变、可独立发布/回滚（`config.local.enabled:false`
即恢复旧行为；已解析的本地文档仍可读）。

---

## 7. 风险与未决问题

| # | 风险 | 缓解 |
|---|---|---|
| 1 | 质量损失：公式退化为线性文本、表格变文本行、图片不可见、公式页翻译偏差 | 质量 banner 明示；「配置 Token 解锁精准解析」CTA；本地结果可整篇云端重解析 |
| 2 | 扫描件/纯图片无 OCR → 空结果 | `local-empty-text` 前置判定 + 明确错误 + MinerU/OCR 引导 |
| 3 | 双栏/浮动体阅读顺序 | 实测 content-stream 原序可用；P0.5 栏检测兜底；上线前扩样本（5–10 篇不同模板） |
| 4 | 标题启发式噪声（ACL 30 候选） | outline 优先；组合规则（字号+编号+行长）；低置信度标题不入大纲 |
| 5 | 行为变化：无 Token 默认从 agent 改为 local | `autoAllowAgentFallback` 可关；面板提前显示「将会话/上传」；release note |
| 6 | pdfjs 版本/内存/worker 坑 | 只 vendor min + 懒加载；页数/大小上限；显式 workerSrc；engines 提到 ≥20.16 |
| 7 | Office 依赖可选服务/字体缺失 | `ctx.get` 可选 + capabilities 驱动 UI；错误码降级；`missingFonts` 提示 |
| 8 | 侧车安全（任意命令执行） | 仅运维配置；固定 argv 模板；路径/输出校验；默认关闭 |
| 9 | 跨引擎重解析导致高亮漂移 | 现有 `margin.dropped` 降级；同引擎确定性可保证稳定（已实测） |
| 10 | 长段落超翻译上限 | 合成器段落上限 4,000/硬 8,000 + 测试断言 |
| 11 | 侧车门槛与漂移：Python 环境 + 2–3 GB 模型下载；MinerU 4.1 CLI/API 有 breaking 变动（`/v1/tasks` 取代旧接口）、本地产物需 content_list 适配；旧版本输出 flag 不同；普通用户装不上/装错版本、接错契约 | 插件只给「复制命令 + 重新检测」不代跑安装；锁 `mineru>=4.0,<5` + 按大版本分流探测 + golden test；首次下载要有进度/超时/取消；`content_list` 缺失时退化为无页码（现有阅读器已支持） |
| 12 | vendor 保活：pdfjs 固定 5.4.449 的后续安全更新/升级缺失，长期漏洞/兼容风险 | 记录版本来源与升级流程；维护 PDF 回归样本集，升级前跑 golden 对比 |
| 13 | 侧车首次下载失败/离线（无网/代理）时 auto 回落路径不明确，用户卡住 | 明确错误与离线预下载指引；auto 在侧车不可用时按既有规则回落（builtin → 云端时明示上传） |

**未验证/待补**：Node 20/22 真机（本机仅 26）、Windows/macOS 行为、超大 PDF（>100 MB）、更多
出版社模板的双栏顺序、owner-only 加密在 5.4.449 的行为、无 ToUnicode 的 CJK CID 字体场景、
`officeToPdf` 在非 web profile 的降级、真实用户安装侧车的 UX、侧车耗时/质量数字（多数为官方口径
或 [估]，未在本机实测）、MinerU 本地 4.x 与云端 standard 的结果差异（未实证）、**5.4.449 的
RSS/耗时/owner-only 加密需验收前补测**（本次 RSS/耗时实测来自 4.10.38，5.4.449 只交叉验证字符数）。

---

## 8. 结论

**「有没有本地化降级替代方案？」——有，且当前插件从 0 到 1 的成本可控。**

- 对「不熟悉 / 没有 MinerU Token」的普通用户：**P0 内置 pdfjs + 合成 content_list** 就能提供
  「导入即有可读正文 + 大纲 + 页码 + 翻译/高亮」的离线体验，vendor 体积仅 ≈1.53 MiB（已有 KaTeX
  先例），无新依赖、无安装步骤、无上传。
- 对「离线/隐私」用户：显式 `local` 引擎 + `auto` 本地优先 + 可关闭云端回落，语义干净。
- 对「要公式/表格/OCR/扫描件」的用户：保留 MinerU（配置 Token 或免 Token 轻量档），并把
  **MinerU 本地版 4.x** 作为 T2 首选侧车——质量最高、CPU 可跑，产物接近云端（`content_list`
  需从 `middle_json` 合成一层适配）；不建议引入 AGPL/重依赖/带 CVE 的库；不建议手写 PDF 解析器；
  不建议把页码标记写进 markdown。

**建议决策**：① P0 采用 vendored `pdfjs-dist@5.4.449` legacy min，并把 `package.json` engines
提到 `>=20.16`（DSH 实际要求 ≥24.9）；② 无 Token 时 `auto` 默认 local，新增
`autoAllowAgentFallback` 开关；③ 先做 P0 发布，再按用户反馈推进 P1/P2。

---

## 附录 A：候选矩阵（速查）

| 候选 | 类型 | 许可证 | 体积（新增） | Node/运行 | 定位 |
|---|---|---|---|---|---|
| pdfjs-dist 5.4.449 legacy min | PDF | Apache-2.0 | 1.53 MiB | Node≥20.16 | **P0 首选** |
| pdfjs-dist 4.10.38 legacy min | PDF | Apache-2.0 | 1.74 MiB | Node≥20 | P0 备选（保持 20.11 兼容） |
| unpdf | PDF 封装 | MIT | 2.1 MB | Node≥22/24（版本相关） | 备选 |
| pdftotext（poppler） | 系统 CLI | GPL（工具） | 0 | 系统装 | P1 探测增强 |
| DSH officeToPdf | Office→PDF | DSH 服务 | 0 | web profile | P1 首选 |
| 自写 OOXML 子集 | Office | 自有代码 | 0 | Node | P2 回退 |
| mammoth | docx | BSD-2 | +6.1 MB 依赖 | Node≥12 | 可选 P2 |
| turndown + domino | HTML | MIT | 0.9 MB | Node≥18 | 可选 |
| MinerU 本地版 4.x | 侧车 | Apache-2.0+附加条款（旧 2.5 权重 AGPL） | 磁盘 2–3 GB（模型 0.8–3 GB） | Python/CPU 可跑/GPU 可选 | **P2 首选** |
| Docling | 侧车 | MIT（权重逐个核） | 数百 MB | Python/CPU | P2 次选 |
| Marker | 侧车 | 代码 Apache-2.0；权重 OpenRAIL-M | GB 级 | Python/GPU 建议 | P2 备选 |
| MarkItDown | 侧车 | MIT | 轻 | Python | P2 轻量 |
| GROBID | 服务 | Apache-2.0 | Java/Docker | Java | 学术结构化 |
| OCRmyPDF/Tesseract、PaddleOCR/RapidOCR | OCR | MPL-2.0/Apache-2.0 | 中 | 系统/Python | 扫描件 |
| mupdf（npm） | PDF | AGPL-3.0-or-later | 14 MB | wasm | ❌ 排除 |
| officeparser / pdf-parse / SheetJS npm | 通用 | MIT/Apache-2.0/Apache-2.0 | >20 MB 或有 CVE | 窄 | ❌ 排除 |

## 附录 B：复现命令（摘要）

```bash
# 1) 独立项目目录安装 pdfjs（注意：不要在上层含 package.json 的目录直接 npm install）
mkdir -p /path/scratch/proj && cd /path/scratch/proj && npm init -y && npm i pdfjs-dist@5.4.449
# 2) vendor 子集：legacy min 两个文件 + LICENSE（worker 改名或显式 workerSrc）
cp node_modules/pdfjs-dist/legacy/build/pdf.min.mjs        ../vendor/pdfjs/pdf.mjs
cp node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs ../vendor/pdfjs/pdf.worker.mjs
cp node_modules/pdfjs-dist/LICENSE                         ../vendor/pdfjs/LICENSE
# 3) 抽取（Node ESM）
#    import { getDocument, GlobalWorkerOptions } from '../vendor/pdfjs/pdf.mjs'
#    GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href
#    doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise
#    for p in 1..doc.numPages: page.getTextContent() → items(str, transform, hasEOL)
#    doc.getOutline() → 标题层级
# 4) 基线对比
pdftotext sample.pdf - | wc -c          # raw 基线
pdftotext -layout sample.pdf - | wc -c  # 注意：双栏会交错
```

## 附录 C：证据与来源

- 本仓库代码/文档：`lib/mineru.js`、`lib/parse-manager.js`、`lib/store.js`、`ui/markdown.js`、
  `ui/app.js`、`docs/ARCH.md`、`docs/MINERU.md`（行号见各节引用与 integration.md）。
- 实测笔记：[node-extract.md](research/node-extract.md)（纯 Node 栈，含复现命令与脚本路径）；
  [integration.md](research/integration.md)（插件文件级集成设计 + 产物契约 spike）；
  [sidecars.md](research/sidecars.md)（重型本地引擎取证）。
- 外部来源：pdfjs-dist（npm，Apache-2.0）；MinerU `LICENSE.md`（Apache-2.0 + 附加条款）；
  Marker README/`LICENSE`（代码 Apache-2.0、权重 OpenRAIL-M）；Docling/MarkItDown `LICENSE`（MIT）；
  PyPI JSON metadata（2026-11-06）；DSH `@deepseek-ai/dsh-office-to-pdf` README/types
  （web profile 已挂载；`ctx.get('officeToPdf')`）。
- 数据目录/环境：本机 Linux、Node 26.13、poppler 可用；`/tmp` 每次命令隔离，实验产物在
  `.agents/tmp-research/`（仓库外）。

## 附录 D：术语

- **文字层**：PDF 内可选择的文本对象（非扫描图片）；决定本地能否「零 OCR」提取。
- **content_list**：MinerU 的结构化内容列表（`page_idx/type/text/bbox`），阅读台页码标记的唯一来源。
- **侧车（sidecar）**：用户另行安装的本地解析服务/CLI，插件只探测与调度。
- **provider**：本地引擎内部的具体实现（builtin/system/sidecar），与 `engine` 正交。
