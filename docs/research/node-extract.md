# 纯 Node/JS 本地解析降级方案（node-extract 调研笔记）

> 任务：为「没有 MinerU Token / 离线 / 隐私敏感」的用户，评估不依赖 Python、不依赖外部服务、可随插件内置的本地解析栈。
> 实测环境：Linux x86_64，Node **v26.13.0**，npm 12.2.1；系统有 poppler（pdftotext/pdfinfo/pdftoppm）、Ghostscript、xelatex、CJK 字体；**没有** tesseract/libreoffice/pandoc/ImageMagick。
> 全部实验装在工作区 scratch（`<worktree>/tmp/ne/`，已 gitignore；因会话每次 bash 的 `/tmp` 不跨调用保留）。npm cache 用 `tmp/ne/npm-cache`，每个库独立 `package.json`（避免 npm 向上找到插件根 package.json）。
> 设备实测日期：2026-11-06。

---

## 0. 结论摘要（TL;DR）

1. **PDF 纯 Node 可行，且是性价比最高的 P0**：内置 `pdfjs-dist` 的 **legacy min 构建**（`pdf.mjs` + `pdf.worker.mjs` 两个文件）即可在 Host 进程内把 PDF 文本层抽成 Markdown；**1.53–1.83 MB**，Apache-2.0。实测抽取字符数与 `pdftotext` 文本层基线几乎一致（Attention 33,486 vs 33,470 可见字符；ACL 60,859 vs 60,607；中文 42 页维基 PDF 88,933 vs 88,913）。
2. **pdfjs 能给比 pdftotext 更适合阅读台的东西**：逐页边界（页码标记）、每行 `x/y/字号`（标题启发式 + 双栏重排 + 合成 `content_list.json` 的 bbox）、`getOutline()`（Attention 论文有 7 个顶层书签 / 22 个嵌套条目，level 直接映射 Markdown 标题层级；ACL 论文 0 个 → 只能字号启发式）。**这是 pdftotext 给不了的，因此首推 pdfjs 而不是系统 CLI**。
3. **双栏阅读顺序**：pdfjs 的 content-stream 原序在实测两篇双栏/LaTeX 论文上**顺序正确**（章节标题按序出现、Abstract 在正文前、References 在最后）；`pdftotext -layout` 反而会左右交错（与 Lead 实测一致）。但含大图/浮动体的页仍可能错，建议把「栏检测重排」列为 P0.5 增强（pdfjs 有坐标数据可做），不要用「按 y/x 朴素排序」（原型实测会左右交错）。
4. **Office（DOCX/PPTX/XLSX）建议零依赖自己解析 OOXML（落地归属 P2 回退，P0 只做 PDF）**：复用仓库已有 `lib/unzip.js` + 正则/轻量 XML 遍历，~150+60+80 行原型即可用（docx 1,002 字符/2 ms，heading/list/bold/italic/code/超链接/表格都能出；pptx 335 字符/3 ms；xlsx 出 Markdown 表格 200 字符/3 ms）。新增体积 **0**。mammoth（BSD-2，docx 质量好）要拖 ~6 MB 依赖且表格会拍平；officeparser（MIT）依赖 pdfjs6+tesseract.js+native canvas（>100 MB、engines 非常挑）、**直接排除**；SheetJS npm 版 0.18.5 有已知 CVE 且体积 7.2 MB+5.9 MB codepage，**不推荐**。
5. **HTML→Markdown**：turndown（MIT，216 KB）+ domino 运行时代码（676 KB）质量很好（标题/列表/链接/代码/图片/引用都能出），但默认会把表格拍平；最小自写 HTML→文本降级也可接受。HTML 优先级最低（MinerU 轻量 API 本就不支持 html，若用户能联网仍可用 standard）。
6. **放弃 mupdf**：`mupdf@1.28.1` 是 **AGPL-3.0-or-later**，与「随插件内置分发」冲突，且 wasm 包 ~14 MB。**放弃 officeparser**（重型依赖链 + Node engines 卡死在 >=22.23/24.22/26.12）。
7. **版本约束（关键）**：`pdfjs-dist@5.7.284/6.x` 的 `engines.node = ">=22.13.0 || >=24"`；**5.4.449 是 `">=20.16.0 || >=22.3.0"`**（Lead 已交叉验证；本机 npm 查询同）；4.10.38 为 `">=20"`。插件 `engines.node` 目前写 `>=20.11`：要么**把 engines 提到 `>=20.16` 并内置 5.4.449**（推荐，vendor 更小 1.53 MiB），要么**内置 4.10.38**（Node 20.11 也能跑，vendor 1.74 MiB）。两者实测**字符数一致**（未做逐字 diff）。
8. **内存**：务必用 **min 构建**。legacy 非 min 的 `pdf.mjs` 仅 import 就 +335 MB RSS（实测 42→377 MB，gc 不回收）；legacy **min** 构建 import 只 +11 MB，整篇抽取峰值 RSS：Attention(15p) 129 MB / ACL(17p) 112 MB / 中文维基(42p) 196 MB。懒加载（首次本地解析才 `await import()`），不要顶层 import。
9. **扫描件**：本地无 OCR。实测扫描版 PDF 可被打开、`chars=0`、`withTextPages=0` → 用「有文本层页数/每页字符阈值」检测，UI 明确提示「本地不可 OCR，建议用 MinerU 轻量/精准解析」。加密：有用户密码的抛 `PasswordException`（"No password given"）可直接映射；仅 owner 密码的 PDF 在 v4.10.38 抛 `UnknownErrorException: Cannot convert a Symbol value to a string`（**需要单独兜底**）。
10. **质量边界（相对 MinerU standard）**：公式退化为线性文本（最痛，`Attention(Q, K, V ) = softmax( QKT √dk )V` 这类断行/上下标全丢，KaTeX 无法渲染）；表格变普通文本行（除非自己按坐标重建，成本高）；图片不抽（只保留图注文字）；标题层级 arXiv 可靠（outline）、其他靠字号+编号启发式（ACL 实测 30 个候选里水分大，需要再筛）；参考文献作为文本保留但断行噪声大；翻译分块会因段落边界识别不准而变碎。

---

## 1. 候选矩阵

| 候选 | 用途 | License | 安装体积（unpacked） | Node 兼容（package.json engines） | 能力/备注 |
|---|---|---|---|---|---|
| **pdfjs-dist 4.10.38 legacy** | PDF 文本层 | **Apache-2.0** | 37.3 MB（npm 包）；**最小 vendor 1.83 MB**（见 §4） | `>=20` | 文本+坐标+页码+outline；渲染需 canvas（本项目不用）；min 构建内存友好 |
| **pdfjs-dist 5.4.449 legacy** | 同上 | **Apache-2.0** | 35.5 MB；**最小 vendor ≈1.53 MB**（Lead 实测 min 文件 0.46+1.07 MB） | `>=20.16.0 \|\| >=22.3.0` | 与 4.10.38 实测抽取字符数**完全一致**（Attention 38,804 / ACL 70,504，与 Lead 独立实测吻合）；outline Attention 7 顶层 |
| pdfjs-dist 5.7.284 / 6.x | 同上 | Apache-2.0 | 35.3 MB | **`>=22.13.0 \|\| >=24`** | 本机可跑，但插件声称 Node>=20.11 时不能用；**不选** |
| unpdf 1.4.0 | PDF 封装 | **MIT**（内含 pdfjs Apache-2.0） | **2.1 MB**（`dist/pdfjs.mjs` 1.45 MB + wrapper 10 KB） | package.json **无 engines 字段**（Lead 提示 1.x 实际需 >=22，本机未能在 Node20 验证） | 自带 pdfjs serverless 构建，免 worker 文件管理；`extractText`/`getDocumentProxy`/`extractImages`。Attention 15p 39,628 字符 / 391 ms / RSS 132 MB，**体积和内存都优于自己 vendor**，但版本/许可证/可控性不如直接 vendor pdfjs |
| pdf-parse 2.4.5 | PDF 封装 | Apache-2.0 | 21.3 MB | `>=20.16.0 <21 \|\| >=22.3.0` | 依赖 `pdfjs-dist@5.4.296` + **`@napi-rs/canvas`（native 二进制）**；能力≈pdfjs，封装价值低，**不选** |
| mupdf 1.28.1 (wasm) | PDF 文本层 | **AGPL-3.0-or-later** | 14 MB | 无限制 | 文本抽取快（Attention 47 ms、RSS 100 MB）；**AGPL 与插件分发冲突 → 排除** |
| **系统 pdftotext (poppler)** | PDF 基线/降级 | GPL（poppler 工具） | 0（系统已有） | 取决于系统 | 文本层字符数≈pdfjs；无标题/坐标/页码结构；`-layout` 双栏会交错；Windows 基本没有；作为 P1 探测路径 |
| **自写 OOXML（复用 lib/unzip.js）** | DOCX/PPTX/XLSX | 0 新增 | **0** | 本仓库 Node>=20 | 原型已跑通（§2.2）；docx 富文本/heading/list/表格可用；图片/公式/OMML/批注/页眉需额外工作 |
| mammoth 1.13.0 | DOCX | **BSD-2-Clause** | 1.9 MB + 依赖 ≈6.1 MB（jszip 0.8/underscore 2.6/…) | `>=12` | docx 语义映射最好；但**表格被拍平成段落**（实测），不支持 pptx/xlsx，CJS 包 |
| officeparser 8.6.0 | Office+PDF+OCR | MIT | **>100 MB**（pdfjs-dist 6.2.108 + tesseract.js-core 44 MB + @napi-rs 36 MB） | `>=22.23.4 <23 \|\| >=24.22.1 <25 \|\| >=26.12.1` | 依赖链过重、engines 极挑；docx 实测还报 `NamespaceError`（夹具可能不完美，但风险已足够）→ **排除** |
| xlsx (SheetJS) 0.18.5 | XLSX | Apache-2.0 | 7.2 MB + codepage 5.9 MB + cfb 等 | `>=0.8` | npm 版停在 2022 年，**CVE-2023-30533 等修复只在 cdn.sheetjs.com 的 0.19.3+**；为「表格→Markdown」不值得 |
| turndown 7.2.5 | HTML→MD | **MIT** | 216 KB + `@mixmark-io/domino` 运行时 `lib/` **676 KB**（npm 包 8.7 MB 主要是 test） | `>=18` | 实测输出质量好：heading/列表/链接/代码块/图片/引用正确；**表格默认拍平**，可加自定义 rule 输出 HTML table |
| @mozilla/readability 0.6.0 | 正文抽取 | Apache-2.0 | 188 KB | `>=14` | 需要 DOM：配 jsdom 8.4 MB（engines `^22.22 \|\| ^24.15 \|\| >=26`）或 domino；本地 HTML 文件场景收益有限 |
| jsdom 31.0.0 | DOM | MIT | 8.4 MB | `^22.22.2 \|\| ^24.15 \|\| >=26` | 只为 readability 引入太重，**不选** |
| 官方 `officeToPdf` 服务（DSH web profile） | Office→PDF | — | 0 | DSH 提供 | Lead 提示：可用 `ctx.get('officeToPdf')`（LibreOffice WASM）把 Office 转 PDF 再走 PDF 抽取；但插件零依赖、不能假设该服务存在，只能作 **P1 组合技** |

---

## 2. 实测数据

### 2.1 样本

| 样本 | 来源 | 页数 | 大小 | 说明 |
|---|---|---|---|---|
| `attention.pdf` | https://arxiv.org/pdf/1706.03762 | 15 | 2.2 MB | 单栏主流论文，**有 outline** |
| `acl.pdf` | https://aclanthology.org/2024.acl-long.1.pdf | 17 | 0.7 MB | **双栏 LaTeX**（ACL 2024），**无 outline** |
| `zhwiki.pdf` | https://zh.wikipedia.org/api/rest_v1/page/pdf/%E5%8C%97%E4%BA%AC | 42 | 7.25 MB | 中文有文本层（CJK，内嵌字体），8→42 页（pdfinfo 42） |
| `scanned.pdf` | 由 attention 第 1-2 页 `pdftoppm -jpeg` 后自写 PDF 嵌入 JPEG 生成（纯图片、无文本层） | 2 | 0.37 MB | 扫描件检测 |
| `encrypted.pdf` | `gs -sDEVICE=pdfwrite -sOwnerPassword=owner -sUserPassword=user …`（RC4） | 15 | 1.4 MB | 有用户密码 |
| `owner-enc.pdf` | 同上只给 owner 密码（空用户密码） | 15 | — | 可打开但加密/受限 |

> 说明：论文 URL 中的 `1706.03762` 下载到的版本是 v7（2023-08-02），字符数与 Lead 的样本一致（Lead 独立测得 38,804 / 70,504，见 §2.2 交叉核对）。

### 2.2 PDF 文本抽取对比（字符数/顺序/耗时/内存）

**统一定义**：`chars` = 各页 `getTextContent()` 的 `str` 拼接长度（不含行尾换行）；`visible` = 去掉所有空白字符后的 Unicode 码点数（Node `[...str]`）。`peakRSS` = `process.resourceUsage().maxRSS`（含 V8 基础 ~42 MB）。

| 样本 | 方案 | 页 | chars | visible | 相对 pdftotext raw | 耗时 | peak RSS | 顺序检查 | 标题 | 备注 |
|---|---|---|---|---|---|---|---|---|---|---|
| attention | **pdfjs 4.10.38 legacy min vendor（推荐子集）** | 15 | **38,804** | 33,486 | +0.05% | **337 ms** | **129 MB** | ORDER-OK | outline 7 顶层（22 嵌套） | 与 5.4.449 字符数一致（未做逐字 diff） |
| attention | pdfjs 4.10.38 legacy 非 min | 15 | 39,670 | 33,486 | +0.05% | 543 ms | **463 MB** | ORDER-OK | 同上 | 非 min 构建内存坑，见 §4.3 |
| attention | pdftotext raw | 15 | — | **33,470** | 基准 | ~10 ms | — | ORDER-OK | 无 | poppler 基线 |
| attention | pdftotext -layout | 15 | — | 33,486 | +0.05% | ~10 ms | — | ORDER-OK | 无 | 单栏时 -layout 无害但带大量对齐空格（59,599 B vs raw 40,074 B） |
| acl | **pdfjs 4.10.38 legacy min vendor** | 17 | **70,504** | 60,859 | +0.42% | **320 ms** | **112 MB** | ORDER-OK（`1 Introduction`→`2 Related Work`→`3 Quantized Side Tuning`→`4 Evaluation`→`5 Conclusion`→`References` 均单调） | 仅字号启发式（outline 0；30 个候选，噪声大） | 双栏；content-stream 顺序正确 |
| acl | pdftotext raw | 17 | — | **60,607** | 基准 | ~10 ms | — | 章节顺序近似 OK，但个别标题串缺失 | 无 | 无 `1 Introduction` 字符串匹配（PDF 断行/空格导致，需人工看） |
| acl | pdfjs 4.10.38 legacy 非 min | 17 | 72,298 | 60,859 | +0.42% | 488 ms | 434 MB | ORDER-OK | — | — |
| acl | pdftotext -layout | 17 | — | 60,858 | +0.41% | ~10 ms | — | 章节标题顺序偶然单调，但**逐行左右栏交错**（Lead 实测确认） | 无 | 不能作阅读顺序 |
| zhwiki | **pdfjs 4.10.38 legacy min vendor** | 42 | **94,011** | 88,933 | +0.02% | **1,176 ms** | **196 MB** | — | 无 outline，字号候选 85 个 | **CJK 27,160 字**，中文标点/简体全对 |
| zhwiki | pdftotext raw | 42 | — | **88,913** | 基准 | ~30 ms | — | — | 无 | 中文同样正确 |
| zhwiki | pdfjs 4.10.38 legacy 非 min | 42 | 96,608 | 88,933 | +0.02% | 1,237 ms | 531 MB | — | — | — |

**交叉核对（与 Lead 独立实测）**：Lead 用 `pdfjs-dist@5.4.449` legacy 构建测得 Attention **38,804 字符 / ~400 ms**、ACL **70,504 字符 / ~344 ms**、Attention outline **7 个顶层书签**、ACL outline 0；本机用 `4.10.38` min 构建 + 推荐 vendor 子集测得 **38,804 / 70,504 字符、337/320 ms、7 顶层书签** —— **两个大版本字符数完全一致**，说明抽取结果与版本 4/5 无关（5.4 与 4.10 同代行为）。Lead 计数口径即本文 `chars`。

**中文 CJK / cmaps 必要性数据点（Lead 特别要求）**：
- `zhwiki.pdf`（42 页中文，字体内嵌 + ToUnicode）：只放 **min `pdf.mjs` + `pdf.worker.mjs`（无 `cmaps/`、无 `standard_fonts/`）** 抽取结果 = **94,011 字符 / 27,160 个 CJK 字**；把 `cmaps/`（1.7 MB、169 个文件）整个拷进去后结果**完全相同**（94,011 / 27,160）。→ **本样本不需要 cmaps**。
- 结论：cmaps 只在「PDF 使用未内嵌的 CJK CID 字体（无 ToUnicode）」时才必需；中文论文多为 Word/LaTeX 内嵌字体子集，通常不需要。**建议：cmaps 作为可选 +1.7 MB 的「CJK 保险」，不作为 P0 必需**；若产品要覆盖老式/扫描 ID 字体 PDF，再打包。`standard_fonts/`（0.8 MB）只影响渲染（Base-14 字体轮廓），文本抽取用不到，**不 vendor**。v5 的 `wasm/`（1.5 MB，openjpeg/qcms）也只用于图像渲染，不 vendor。

**阅读顺序方法学说明**：
- 顺序检查 = 已知标题/关键句（如 `Abstract`、`1 Introduction`、`2 Related Work`、`References`）首次出现位置必须单调递增（`ORDER-OK`）；加上 `difflib.SequenceMatcher` 词序列相似度（Attention pdfjs raw vs pdftotext raw = 0.913；ACL 与 zhwiki 因断词/空格差异指标偏低，故以标题单调 + 人工抽读为准）。
- **不要用「按行 y/x 排序」**：自写原型把 ACL 双栏页按 y/x 重排后，输出从 72k 字符膨胀到 127k（左右栏重复/交错），顺序反而更差（ORDER-BAD）。正确做法是 **content-stream 原序 + 栏检测（检测到双栏时左栏整段再右栏）**，或直接信任原序（实测可行）。
- pdfjs 原序的已知弱点：含大图/浮动体的页会先把图内文字按内容流位置输出（Lead 也提到），需要按坐标做块级重排（P0.5）。

### 2.3 特殊 PDF 检测

| 场景 | 实测行为（vendored min 子集） | 建议处理 |
|---|---|---|
| 无文本层扫描件 | 正常打开；`pages=2`、`chars=0`、`withTextPages=0` → `looksScanned:true` | 用「总字符 < 20×页数」或「有文本层页数占比 < 30%」判定；UI 提示「本地解析无法 OCR，可用 MinerU 轻量（≤20 页/10 MB）或精准解析」；也可先给出「无文本层」降级阅读（仅提示） |
| 有用户密码 PDF | `PasswordException: No password given`（可程序识别） | 映射中文错误：「PDF 已加密，需要密码」；提供输入密码重试（pdfjs `getDocument({ password })` 支持） |
| 仅 owner 密码（空用户密码） | **v4.10.38 抛 `UnknownErrorException: Cannot convert a Symbol value to a string`**（pdfjs bug） | 兜底：`try/catch` 后提示「PDF 权限加密，暂不支持」；或用 `5.4.449` 复测是否修复（**未验证**） |
| 破损/非 PDF | `InvalidPDFException` | 映射为「文件不是有效 PDF」 |

### 2.4 DOCX / PPTX / XLSX 实测

测试夹具：本机用 Python 标准库 `zipfile` 手写生成**真实 OOXML**（`tmp/ne/out/make-office.py`）：docx 含 Heading1/2、Title、粗体/斜体/代码/上标、项目符号（numbering.xml）、HTML 表格、超链接（document.xml.rels）；pptx 2 页（标题+要点）；xlsx 2 sheet（sharedStrings + inlineStr + 数字）。

| 文件 | 方案 | 输出字符 | 耗时 | 结果评价 |
|---|---|---|---|---|
| test.docx (2.9 KB) | **自写 OOXML（复用 lib/unzip.js）** | **1,002** | **2 ms** | `#`/`##` 标题、`-` 列表、`**粗**`/`_斜_`/`` `code` ``/链接文字都在；**表格→HTML `<table><tr><th>…`**（与 MinerU content_list 的 `table_body` 约定一致，阅读台可渲染）；丢：上标 `x2`、超链接 URL（只留文字）、图片、OMML 公式、批注/页眉页脚 |
| test.docx | mammoth 1.13.0 | 922 | 71 ms | 标题/粗斜体/列表正确，但**表格被拍平成一行行段落**（`__Approach__` … 三行），文本被 **markdown 转义**（`dsh\-litnotes`、`2\.1`、`\[1\]`，渲染没问题但脏）；链接丢失；不支持 pptx/xlsx |
| test.docx | officeparser 8.6.0 | 失败 | 137 ms | `NamespaceError: prefix is non-null and namespace is null`（最小夹具可能踩到其 DOM 严格性）；依赖链 >100 MB 已足以排除 |
| test.pptx (2.6 KB) | **自写 OOXML** | 335 | 3 ms | `## Slide N: 标题` + `- 要点`，README 场景够用；无备注页/图片/表格 |
| test.xlsx (2.3 KB) | **自写 OOXML** | 200 | 3 ms | 每个 sheet → `### Sheet: 名称` + Markdown 表格；sharedStrings/inlineStr/数字都支持 |
| test.xlsx | SheetJS 0.18.5 | 110 | 113 ms | CSV 输出正确；但要拖 7.2 MB + codepage 5.9 MB，且 npm 版有已知 CVE |

**自写 OOXML 原型工作量与缺口**（`tmp/ne/out/ooxml-own.mjs`，约 160 行含 3 种格式）：
- 已覆盖：docx 段落/heading/列表/粗斜体/code/表格/超链接文字 → Markdown；pptx 按 `presentation.xml` rels 排序的页标题+要点；xlsx sharedStrings/inlineStr/数字 → Markdown 表。
- 缺口（做 P0 需补齐，估算）：docx 图片（`word/media/*` 抽到 `images/` 并用 rels 重写 `![](images/…)`，~30 行）、`gridSpan/vMerge` 合并单元格、`numbering.xml` 多级编号（目前一律 `-`）、脚注/批注/页眉页脚（可先跳过）、OMML 公式（转 LaTeX 成本高，可先降级为文本）、`.doc`/`.ppt`/`.xls` 旧二进制格式（**不支持，直接提示走 MinerU**）。
- 健壮性：正则解析 XML 对命名空间前缀（`w:`/`w14:`/`mc:AlternateContent`）、转义、`<w:sdt>` 包装敏感。**建议：P0 先上线 docx/pptx/xlsx 的「文本+标题+列表+表格」子集，并把解析失败映射成明确错误**；若日后质量不达标再考虑 vendor mammoth（+6.1 MB，BSD-2，仅 docx）。

### 2.5 HTML→Markdown 实测

样本：自写含 nav/article/footer 的 HTML（`tmp/ne/out/sample.html`）。

| 方案 | 体积 | 实测输出 |
|---|---|---|
| **turndown 7.2.5**（+domino） | 216 KB + 676 KB | 标题 `#/##`、`**粗**`、`_斜_`、`` `code` ``、`[link](url)`、`-`/`1.` 列表、`> 引用`、``` 代码块```、`![alt](src)`、表格 → **拍平成文本行**（需自定义 rule 输出 HTML table，或用手写解析）；`#` 编号被转义为 `1\.`（Markdown 合法） |
| readability 0.6.0 + jsdom + turndown | 188 KB + 8.4 MB + 216 KB | 正文抽取正确（去掉 nav/footer，524 字），图片相对路径会按页面 URL 解析为绝对 URL；但 8.4 MB jsdom 对插件太重，**不建议 vendor** |

推荐：若做本地 HTML 导入，**turndown + domino/lib 约 0.9 MB** 即可（MIT），并加自定义 table rule 输出 `<table>` HTML（与 MinerU content_list 的 table_body 一致）。或者更省：只做「去 script/style + 保留标题/段落/列表/链接」的自写极简转换（~80 行），质量对网页文章够用。

---

## 3. 三档推荐

### P0（纯内置、默认路径，0 外部依赖）

> **修订注记（spike 后定稿，2026-11-06）**：以下 §3 P0 清单中关于「markdown 页码标记」与
> 「content_list 可选」的两处是早期设想，**已被 spike 证伪/推翻**：页码标记**只能**靠合成
> `content_list.json`（`ui/markdown.js:1437` `appendPageMarks`），在 markdown 里插
> `<!-- page: n -->` 会被当普通段落（见 `docs/research/integration.md` §6.H）；`content_list.json`
> 因此是**必需产物**（否则无页码标记）。另外 Office（DOCX/PPTX/XLSX）解析已从 P0 移出，延后为
> **P2 回退**（P1 优先用 `officeToPdf` 转 PDF）。以 `docs/LOCAL-FALLBACK.md` 与
> `docs/research/integration.md` 的定稿为准。

**PDF**：vendor `pdfjs-dist` legacy min 构建（**首选 5.4.449，1.53 MiB；若坚持 engines `>=20.11` 则用 4.10.38，1.74 MiB**），Host 进程内懒加载：
- `full.md`：逐页取 `getTextContent()` → 按行合并（同 baseline 合并）→ 段落启发式（行距/缩进/句末标点）→ Markdown；页边界按页记录，**页码只写进合成 `content_list.json`，markdown 不插任何页码标记**。
- 标题：优先 `doc.getOutline()`（arXiv 类论文完美，7 顶层/22 嵌套 → `#`/`##`/`###`）；无 outline 时用「字号 ≥ 中位数×1.12 + 短行 + 章节编号正则（`^\d+(\.\d+)*\s`）」组合（ACL 实测字号单指标噪声大，必须是组合规则）。
- 合成 **`content_list.json`（必需产物；页码标记依赖它）**：每页行块 → `{type:"text"|"title", text, page_idx, bbox:[x0,y0,x1,y1]}`，`bbox` 用 pdfjs viewport 坐标（PDF 原点左下，需按页高翻转成 MinerU 的左上原点）；标题用启发式 `text_level`。图片不产出（阅读台按可选字段缺失降级）。
- 扫描件检测：`chars/page < 阈值` → 不生成解析稿，返回结构化错误 + 建议 MinerU。
- 错误映射：`PasswordException` → 加密；`InvalidPDFException` → 损坏；owner-only 加密走兜底文案；单文件页数/大小上限（如 500 页 / 200 MB）防内存。

**DOCX/PPTX/XLSX（已移出 P0 → P2 回退）**：复用 `lib/unzip.js` + 自写 OOXML 子集解析（§2.4），0 新增体积。xlsx→Markdown 表；docx→标题/段落/列表/表格（HTML）/图片（`word/media`→`parsed/images/`，需补）；pptx→分页标题+要点。`.doc/.ppt/.xls` 旧格式提示不支持。
**HTML**：可选 turndown（+0.9 MB）或自写极简转换。

**体积（P0）**：PDF 1.53–1.74 MiB + LICENSE 10 KB；cmaps +1.7 MiB（可选「CJK 保险」）；HTML 0.9 MB 可选；**总计约 1.6–2.5 MiB**（对比现有 `vendor/katex` 592 KB 的量级，可接受；不打包 cmaps/standard_fonts/wasm）。Office 自写解析为 P2，0 新增体积。

### P1（系统 CLI / 系统服务，能力探测）
- 探测 `pdftotext`（`execFile('pdftotext', ['-v'])` 一次性探测 + 缓存）：有则作为「快速兜底」或与 pdfjs 结果互校；无则纯 P0。质量：字符层≈pdfjs，但**没有标题/页码结构/坐标**，阅读台会明显变差，因此只作降级不是首选。
- 组合技：DSH web profile 的 `ctx.get('officeToPdf')`（LibreOffice WASM）存在时，把 DOCX/PPTX/XLSX 先转 PDF 再走同一个 PDF 本地抽取器 → 版面/表格质量通常优于自写 OOXML；**必须 optional 探测**，服务缺失时降级为 P2 的自写 OOXML 文本子集回退。
- 扫描件：本机无 tesseract，P1 不做 OCR；仅提示用户走 MinerU（轻量支持 pdf，≤10 MB/20 页，免 Token）。

### P2（可选重库，仅当 P0 质量被用户投诉）
- docx 质量不足 → vendor **mammoth 1.13.0**（BSD-2，包 1.9 MB + 依赖 6.1 MB；表格会拍平，需接受）。
- html 体验不足 → vendor **turndown**（MIT，216 KB + domino 676 KB）或加 **readability**（Apache-2.0，188 KB）+ 一个轻量 DOM（不建议 jsdom 8.4 MB）。
- **不选**：officeparser（>100 MB、engines 卡死）、SheetJS npm 版（CVE + 12 MB）、mupdf（AGPL）、pdf-parse（native canvas + pdfjs5）、jsdom（8.4 MB）。
- 任何 P2 都必须显式展示「体积/许可证/质量」权衡，且默认关闭。

---

## 4. 打包与接线方案

### 4.1 vendor 文件清单（pdfjs-dist@4.10.38 实测）

```
vendor/pdfjs/
  pdf.mjs                                  398,237 B   (legacy/build/pdf.min.mjs 改名)
  pdf.worker.mjs                         1,417,586 B   (legacy/build/pdf.worker.min.mjs 改名)
  LICENSE                                   10,174 B   (Apache-2.0)
  # 可选：cmaps/  169 files, 1.7 MB（仅非内嵌 CJK CID 字体需要；实测中文维基样本不需要）
# 合计 base = 1,825,997 B ≈ 1.74 MiB（5.4.449 的 min 文件更小：0.46+1.07 MB ≈ 1.53 MiB）
```

**不要打包**：`build/`（非 legacy 的 14 MB）、`pdf.mjs.map`（source map）、`standard_fonts/`（0.8 MB，渲染用）、`wasm/`（1.5 MB，图像解码用）、`image_decoders/`（1.8 MB）、`web/`（1.2 MB）、`types/`。

### 4.2 最小接线（10 行级别，Node ESM）

```js
// lib/pdf-local.js — 懒加载 vendored pdf.js（首次本地解析才执行）
let pdfjsPromise = null
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = (async () => {
    const pdfjs = await import('../vendor/pdfjs/pdf.mjs')          // → legacy min 构建
    pdfjs.GlobalWorkerOptions.workerSrc =                          // 显式指定 worker；省掉这一行也行，
      new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href // 但两个文件必须同名配套（见坑）
    return pdfjs
  })()
  return pdfjsPromise
}

export async function extractPdf(bytes) {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({
    data: bytes, isEvalSupported: false, useSystemFonts: true, verbosity: 0,
  }).promise                                                    // PasswordException / InvalidPDFException 在这里抛
  const pages = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const text = await page.getTextContent()                     // items: {str, transform[4]=x, transform[5]=y, width, height, fontName, hasEOL}
    pages.push({ pageIdx: i - 1, lines: groupLines(text.items) }) // 自行按 hasEOL/同 baseline 合并行
  }
  const outline = await doc.getOutline()                          // 标题层级；可能为 null
  return { pages, outline, metadata: await doc.getMetadata().catch(() => null) }
}
```

### 4.3 关键坑（都实测过）

1. **worker 文件名**：Node 下不设 `workerSrc` 时，pdfjs 会按 `pdf.mjs` 同目录 import **`pdf.worker.mjs`**（即使你用的是 `pdf.min.mjs`/`pdf.worker.min.mjs` 的名字）。
   - 方案 (a)：把 min 文件**改名**为 `pdf.mjs` + `pdf.worker.mjs` 放同目录（本机实测 OK；`warn` 里 `Cannot load "@napi-rs/canvas"` 只是渲染依赖缺失的警告，不影响文本抽取）；
   - 方案 (b)：显式 `GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href`（Lead 实测 OK）。
   - 不 vendor worker 会报 `Setting up fake worker failed: Cannot find module .../pdf.worker.mjs`。
2. **必须用 min 构建**：legacy 非 min 的 `pdf.mjs`（802 KB）**仅 import 就 +335 MB RSS**（42→377 MB，`gc()` 不回收；原因未完全定位，与 V8 对该大模块的解析/代码空间有关）；min 构建（398 KB）import 只 +11 MB。抽取峰值 RSS 112–196 MB（15–42 页文档）。
3. **懒加载**：不要顶层 `import`；Host 是常驻进程，用 `let pdfjsPromise` 单例。
4. **`useSystemFonts: true`**：Node 无字体系统，pdfjs 会打印 `Cannot load "@napi-rs/canvas"`/`Cannot polyfill DOMMatrix` 等 warning 到 stderr；对**文本抽取无影响**，但会给 Host 日志添噪（可在解析调用期间临时降噪或忽略）。
5. **不用 worker 线程也占主线程**：Node 的 fake worker 在同一线程执行，15 页 ~0.3–0.6 s，42 页中文 ~1.2 s；200 页大 PDF 可能数秒，需放到异步任务队列（现有 `parse-manager.js` 队列模式可复用）。
6. **坐标翻转**：pdfjs 的 y 原点在页面**左下**（viewport 转换后）；若合成 `content_list.json` 的 `bbox` 对齐 MinerU（左上原点），需要 `y' = pageHeight - y` 并处理行高。

### 4.4 「vendor vs npm 依赖 vs 系统 CLI」结论

- **插件以 bundle 目录安装（`plugin_manager install_bundle`），没有 `npm install` 步骤**，且 Host 半明确「零 npm 依赖」（ARCH §1）。→ **加 `dependencies` 不会在用户机器上被安装**，不可行（除非改造安装流程/预打包 node_modules，比 vendor 更复杂）。
- **系统 CLI**：Windows 用户基本没有 poppler；且质量/结构差，只能作 P1 探测，不能作为主路径。
- **结论：PDF 走 vendor（pdfjs legacy min，1.53–1.74 MB）；Office 走零依赖自写 OOXML（复用 lib/unzip.js）；HTML 可选 vendor turndown。** 与现有 `vendor/katex` 的做法一致。

---

## 5. 质量边界（相对 MinerU standard）

| 内容类型 | 本地 P0 结果 | 退化程度 | 对阅读台影响 |
|---|---|---|---|
| 正文段落 | 文本层**可见字符**几乎等量（差 0.02%–0.42%；chars 含空白不可直接比） | 轻 | 可读；段落边界靠启发式，可能出现整页一段或一句一行 |
| 章节标题 | arXiv 类：outline 完美；其他：字号+编号启发式（ACL 30 候选噪声大） | 中 | 大纲树可能缺项/多脏项；需 UI 容错（仅展示高置信标题） |
| 公式 | 线性文本，上下标/根号/求和丢失（实测 `Attention(Q, K, V ) = softmax( QKT √dk )V`） | **重** | 公式块无法 KaTeX 渲染；翻译按行切碎；建议公式段落标记「原稿缺失」 |
| 表格 | 文本行（列顺序按内容流，可能错）；自写 OOXML 生成的表格可保留 HTML | 中重 | 阅读台表格显示为纯文本，可读性差 |
| 图片/图注 | 不抽取图片；图注文字保留 | 中 | 只有图注没有图，需在 UI 说明；`content_list` 无 image 项 |
| 参考文献 | 文本保留，断行/编号噪声大 | 轻中 | 可读但难点击；可后续按正则重排 |
| 双栏阅读顺序 | 实测两篇论文 content-stream 顺序正确；大图/浮动体页有风险 | 轻（有风险） | 默认可用；建议 P0.5 加栏检测 |
| 页码标记 | **强项**：逐页处理天然精确 | 无退化 | 页码标记会比 MinerU 更可靠 |
| 高亮锚点 | 文本稳定（同一 parser 版本内）；换版本重解析会漂移 | 中 | 与 MinerU 重解析同理；建议锚点按「文本+页+段落序」容错恢复 |
| 翻译分块 | 段落识别不准 → 分块过碎/过大；公式/表格行混入 | 中 | 对照翻译仍可用，但需要按「行合并阈值」调优 |
| 扫描件 | **不可用**（无 OCR） | 完全丢失 | 必须检测并引导 MinerU |
| 加密 PDF | 可提示密码/降级 | — | 需错误文案 |

---

## 6. 风险与未决问题

1. **pdfjs 版本/engines 二选一**：`5.4.449`（Node>=20.16，vendor 1.53 MB，Lead 实测基准）vs `4.10.38`（Node>=20，vendor 1.74 MB）。DSH 本体要求 Node>=24.9，实际部署无碍；但插件 `package.json` 目前自称 `>=20.11`，**需要 Lead 决定是否顺手把 engines 提到 `>=20.16`**（推荐，直接用 5.4.449 并复测 5.4.449 的 owner-only 加密行为）。
2. **owner-only 加密 PDF 在 4.10.38 抛 `UnknownErrorException`**（"Cannot convert a Symbol value to a string"）；5.4.449 是否修复未验证，需补测/兜底。
3. **内存**：min 构建整篇抽取峰值 112–196 MB（17–42 页）；200 页大 PDF 可能到数百 MB，需在 Host 侧做页数/文件大小上限 + 队列；非 min 构建的 335 MB import 坑必须避免（vendor 目录里只放 min 文件）。
4. **双栏/浮动体**：建议 P0.5 用 pdfjs 的 x/y 做栏检测与块排序；当前「信任 content-stream 顺序」在两篇样本上正确，但样本量小（2 篇 + 1 篇中文），上线前建议再抽 5–10 篇不同出版社模板验证。
5. **标题启发式**：仅字号阈值噪声大（ACL 30 个候选）；需要组合「字号 + 加粗（fontName 含 Bold？pdfjs 不直接给 bold，可用 fontName → 字体对象名启发）+ 编号正则 + 行长度 + 上下文」，或先只把 outline 映射为大标题、正文不强行分级。
6. **OOXML 自写解析器**：正则解析 XML 的健壮性风险（命名空间、AlternateContent、Word 的 `w:sdt` 包装）；建议至少用「轻量 tokenizer（按 `<` `>` 扫描）」替代纯正则，并补 docx 图片抽取 + rels 重写；`.doc/.ppt/.xls` 二进制格式不支持。
7. **CJK 完整性未穷尽**：中文维基样本内嵌字体 → 不需要 cmaps；**未验证**「无 ToUnicode 的 CJK CID 字体」场景（需另找样本或构造）。若产品要覆盖老中文 PDF，建议带 cmaps（+1.7 MB）。
8. **合成 `content_list.json` 的 bbox 约定**：MinerU 的 bbox 坐标系（左上原点？）需对照 `test/fixtures/content_list.json`（其 bbox 值是 [72,96,523,131] 之类的 PDF point 坐标，明显左上原点、页面 595×842）确认，翻转/缩放后再写入；坐标不精确会影响「点击高亮定位到页面位置」类功能（若阅读台用 bbox 做浮动层）。
9. **许可证合规**：vendored pdfjs 为 Apache-2.0，需保留 `LICENSE`（含 NOTICE 若有）并在 README/第三方声明中注明；mupdf AGPL 已排除；mammoth BSD-2、turndown MIT、readability Apache-2.0 若引入同样要保留版权声明。
10. **未实测**：Node 20/22 真机（本机只有 Node 26）；Windows/macOS；超大 PDF（>100 MB）；HTML 表格自定义 rule 输出；PPTX 备注/图片；DOCX 公式（OMML）。这些是上线前需要补的验证清单。

---

## 7. 复现实测命令（本机证据）

```bash
# 安装（独立 package.json，避免 npm 向上找插件根；/tmp 不跨调用保留，用工作区 scratch）
S=$(pwd)/tmp/ne && mkdir -p "$S"/{samples,out,logs,npm-cache} && export npm_config_cache="$S/npm-cache"
mkdir -p "$S/p5" && cd "$S/p5" && npm init -y >/dev/null && npm i pdfjs-dist@5   # 5.7.284（engines>=22.13）
mkdir -p "$S/p4" && cd "$S/p4" && npm init -y >/dev/null && npm i pdfjs-dist@4   # 4.10.38（engines>=20）

# 样本
curl -sL -o "$S/samples/attention.pdf" https://arxiv.org/pdf/1706.03762
curl -sL -o "$S/samples/acl.pdf"       https://aclanthology.org/2024.acl-long.1.pdf
curl -sL -o "$S/samples/zhwiki.pdf"    "https://zh.wikipedia.org/api/rest_v1/page/pdf/%E5%8C%97%E4%BA%AC"

# 文本基线
pdftotext "$S/samples/attention.pdf" - > "$S/out/attention.raw.txt"
pdftotext -layout "$S/samples/attention.pdf" - > "$S/out/attention.layout.txt"

# 推荐 vendor 子集（min 改名 + worker）
mkdir -p "$S/vendormin" && cp p4/node_modules/pdfjs-dist/legacy/build/pdf.min.mjs "$S/vendormin/pdf.mjs" \
  && cp p4/node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs "$S/vendormin/pdf.worker.mjs" \
  && cp p4/node_modules/pdfjs-dist/LICENSE "$S/vendormin/LICENSE"
# 抽取（本仓库 tmp/ne/out/extract-pdfjs.mjs 与 vendormin/extract.mjs 为实测脚本）
node "$S/out/extract-pdfjs.mjs" "$S/p4" "$S/samples/acl.pdf" "$S/out/acl.p4"

# Office 夹具（Python 标准库手写 zip，无 python-docx）
python3 "$S/out/make-office.py" "$S/samples"
node "$S/out/ooxml-own.mjs" "$S/samples/test.docx"   # 自写零依赖解析器
node "$S/out/test-office.mjs" "$S/samples/test.docx" # mammoth / officeparser 对比

# HTML
cd "$S/html" && node test-html.mjs                   # turndown / readability

# 扫描件 / 加密样本
pdftoppm -f 1 -l 2 -r 110 -jpeg attention.pdf scanjpg
python3 /tmp/mkscan.py scanned.pdf scanjpg-01.jpg scanjpg-02.jpg   # 自写 PDF，把 JPEG 塞进 /DCTDecode
gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -sOwnerPassword=owner -sUserPassword=user -sOutputFile=encrypted.pdf attention.pdf
gs -q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -sOwnerPassword=owner -sOutputFile=owner-enc.pdf attention.pdf
```

实测 JSON 汇总（`tmp/ne/out/*.json`）与日志（`tmp/ne/logs/install.log`、`pdfjs.log`、`unpdf14.log`）保留在 scratch 中；脚本：`extract-pdfjs.mjs`（文本+标题+双栏度量）、`ooxml-own.mjs`（零依赖 OOXML 原型）、`test-office.mjs`、`make-office.py`、`test-html.mjs`。

---

## 8. 一句话给 Lead

**P0 推荐：vendor pdfjs-dist@5.4.449 legacy min（pdf.mjs+pdf.worker.mjs+LICENSE，1.53 MB；若保持 engines>=20.11 则用 4.10.38 1.74 MB）+ 复用 lib/unzip.js 自写 OOXML 解析（0 体积）**；放弃 mupdf（AGPL）、officeparser（>100 MB 依赖链）、pdf-parse（native canvas）、SheetJS npm 版（CVE）；扫描件本地无 OCR 只能检测+引导 MinerU；双栏 content-stream 顺序实测正确但需 P0.5 栏检测兜底；公式/表格/图片是主要质量损失点。
