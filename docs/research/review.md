# 独立复核：dsh-litnotes 本地化降级解析四件套

> 复核人：research-reviewer（独立复核，未参与研究/写作）· 日期：2026-11-06
> 复核对象：`docs/LOCAL-FALLBACK.md`、`docs/research/node-extract.md`、`docs/research/sidecars.md`、
> `docs/research/integration.md`（基线 worktree `dsh-41946cb9-4594`，DSH 0.2.2-rc.1）。
> 方法：不重跑重型实验；通读四份文档 + 核对仓库代码/文档 + `node scripts/check.mjs` +
> npm/PyPI/HuggingFace/GitHub raw 抽验许可证。严重度定义：**P0=会误导决策/产出错误实现，必须修**；
> **P1=发布前应修的事实或一致性错误**；**P2=建议修正的口径/格式/完善项**。

---

## 0. 总体结论

**需修订后再发布。** 技术选型（vendored `pdfjs-dist` legacy min + 合成 `content_list.json` +
`engine:'local'` + `officeToPdf` 可选服务 + 侧车分档）成立，四件套在核心契约上基本自洽；
但有 **2 个 P0**（主报告核心量化结论口径混用、node-extract 仍保留已被证伪的页码标记方案）、
**6 个 P1**（pdftotext 优先级自相矛盾、工作量明细不自洽、"永不联网"隐私过度承诺、OOXML 阶段归属
P0/P1/P2 三处打架、T2 推荐顺序不一致、officeparser 体积/engines 数字矛盾）需在发布前修订。
修订成本低（改文档，不动研究结论），**不建议带 P0/P1 直接发布**。

---

## 1. 已独立核实无误（给决策者的信心锚点）

### 1.1 许可证（逐项外部取证，全部与文档一致）
- **MinerU**：`LICENSE.md` 为 "Apache License 2.0 + additional terms"（MAU>1 亿或月收入>$2000 万需
  商业许可；在线服务须署名），与 main §2.2、sidecars §2.5 一致；HF `MinerU2.5-Pro-2605-1.2B`=
  `apache-2.0`、旧 `MinerU2.5-2509-1.2B`=`agpl-3.0`，与"新旧权重按版本区分"一致；PyPI 4.1.7
  `LicenseRef-MinerU-Open-Source-License`；官方 changelog 确认 **3.1.0（2026/04/18）许可从 AGPLv3
  切换**。
- **Marker**：GitHub `LICENSE`=Apache-2.0，README 徽章=Model License OpenRAIL-M（"modified AI Pubs
  Open Rail-M，研究/个人/<$5M 免费"），PyPI `marker-pdf 2.1.0` license=Apache-2.0 —— 与 sidecars §3
  一致。
- **mupdf**：npm `mupdf@1.28.1` license=`AGPL-3.0-or-later` —— 排除理由成立。
- **OCRmyPDF** `17.13.0`=`MPL-2.0`、**MarkItDown** `0.1.9`=`MIT`、**Docling** `2.148.0`=`MIT`、
  **PaddleOCR-VL-1.6** HF=`apache-2.0` —— 与 sidecars 一致。
- **pdfjs-dist**：npm `5.4.449` license=Apache-2.0，engines=`>=20.16.0 || >=22.3.0`（与 node-extract
  §0-7 完全一致；最新 6.5.438 为 `>=22.13.0 || >=24`，"5.7/6.x 不可用"的取舍判断成立）。

### 1.2 代码 / 仓库事实（抽查全部命中）
- `content_list` 是页码标记唯一来源：`ui/markdown.js:1437` `appendPageMarks`，`:1439` 对
  `contentList=null` 原样返回；不读 markdown 注释。✔
- `blockKey = b<index>:<fnv1a(plainText)>`：`ui/markdown.js:51-63`、`:703`；页标记不改变原 block
  index/key。✔
- `pages = pagesOf(contentList) ?? meta.parse.pages`：`lib/store.js:555,605`。✔
- 按页修复需 `parsed` + Token + contentList：`lib/parse-manager.js:220-243`（`repair-unavailable`/
  `token-missing`）。✔
- 引擎枚举 `auto|standard|agent`、`auto=hasToken?standard:agent`：`lib/mineru.js` `normalizeParseOptions`
  （约 710-796 行）；`STANDARD_LIMITS=200MB/200页`、`AGENT_LIMITS=10MB/20页`（`lib/mineru.js:20-22`）。✔
- 零 npm 依赖：`package.json` 无 `dependencies`；`docs/ARCH.md:475-487` "no npm imports"；vendor 先例
  `vendor/katex` 实测 592 KB。✔
- **officeToPdf 已挂载**：`@deepseek-ai/dsh-web-app` bundle 的 `cordis.patch.yml:283-284` 含
  `id: office-to-pdf`；web profile `package.json` bundles 含 `@deepseek-ai/dsh-web-app`；
  `@deepseek-ai/dsh-office-to-pdf@0.2.2-rc.1` license=MIT、服务名 `officeToPdf`；
  `@deepseek-ai/libreoffice-kit@0.1.5` license=MPL-2.0、optionalDependencies 仅
  darwin-arm64/darwin-x64/win32-x64/win32-arm64/wasm（**无 Linux 原生包**）—— sidecars §9.1 与
  integration §4.7 的描述准确。
- **磁盘体积**：pdfjs 5.4.449 legacy min 两文件实测 483,425 + 1,123,767 = **1,607,192 B ≈ 1.53 MiB**
  （注意单位，见 P2-3）。
- **DSH 本体**：`@deepseek-ai/dsh@0.2.2-rc.1` engines=`node >=24.9.0` —— 报告"DSH 实际要求 ≥24.9"正确。
- **仓库门禁**：`node scripts/check.mjs` 10/10 PASS，`node --test test/` 229 passed —— 复核期间未改
  代码，门禁绿。

### 1.3 四份文档一致的关键决策（无问题）
页码标记不写 markdown、`content_list` 必须合成（spike 证伪后）、P0 提取器 vendor pdfjs 不手写、
`contentList=null` 优雅降级、MinerU 本地产物需 `middle_json → content_list` 适配（main §0/§2.2、
sidecars §0.3、P2 计划三处一致）、officeToPdf 只作可选服务。以上无需修订。

---

## 2. P0（必须修，否则误导决策/实现）

### P0-1 主报告核心量化结论与自己的表格数字不自洽（口径混用）
**位置**：`docs/LOCAL-FALLBACK.md:36-37, 173-183`（§4.1 表 + "文本量差 ±0.05–0.4%"）；
`docs/research/integration.md:22, 347`（同样写 ±0.05–0.4%，且 L347 写成 "vs `pdftotext -layout` 基线"）。

**问题**：表把 pdfjs 的 **`chars`（含空白字符）** 38,804 / 70,504 / 94,011 与 pdftotext 的
**`visible`（去空白可见字符）** 33,470 / 60,607 / 88,913 并列，随后称"文本量差 ±0.05–0.4%"。
读者按表内数字复算得到 **+15.9% / +16.3% / +5.7%**，与结论差两个数量级。正确口径在
`node-extract.md:64-78` 定义清楚：pdfjs 的 `visible` 为 33,486 / 60,859 / 88,933，对 pdftotext raw
可见字符为 **+0.05% / +0.42% / +0.02%**。另：基线是 `pdftotext` **raw**（`-layout` 在 ACL 上左右
交错，恰是报告明确说不能用的），integration L347 的 "-layout" 标签错误。

**建议修正**：主报告 §4.1 表增加 `visible` 列（或另列"可见字符对比"小表），并在表注写明
"chars 含空白，勿与 pdftotext 可见字符直接相减"；结论改为 **0.02%–0.42%**；integration L22/L347
同步改口径，L347 基线改 "pdftotext raw 可见字符"。

### P0-2 node-extract.md 仍推荐已被证伪的"markdown 页码标记 + content_list 可选"
**位置**：`docs/research/node-extract.md:135`（"页面之间插入 `<!-- page: n -->` 或阅读台既有页码标记
格式"）、`:137`（"合成 content_list.json（**可选产物**）"）；对照 `LOCAL-FALLBACK.md:248-249, 302`、
`integration.md:199, 224-230, 717-726`（spike 已证伪）。

**问题**：四件套一起交付时，实现者若按 node-extract 的 P0 清单实施，会得到"页码标记写进 markdown
（实测会被当普通段落）"+"content_list 可选"的错误契约，与主报告/integration 的定稿决定正面冲突；
且方案 A（写注释）与方案 B（合成 CL）在阅读台效果上是互斥的。

**建议修正**：在 node-extract §3 P0 顶部加"**已按 spike 修订**"批注：页码标记**只能**靠
`content_list.json`，markdown 不插任何页码标记；把 `content_list` 从"可选产物"改为"必需产物
（否则无页码）"。`:135/:137` 两行直接改写。这样 node-extract 就能作为历史实测笔记保留而不误导。

---

## 3. P1（发布前应修）

### P1-1 P0 工作量明细相加是 3.0 人日，与声称的 2–2.5 人日不符
**位置**：`integration.md:798`（"2–2.5 人日（pdfjs vendor+适配层 0.5d；合成器 0.5d；Host 接线 0.75d；
Client 0.5d；测试 0.75d）"）；`LOCAL-FALLBACK.md:33, 328` 同步写 2–2.5 人日。
**问题**：明细相加 = 0.5+0.5+0.75+0.5+0.75 = **3.0 人日**，与区间上限 2.5 差 20%，下限差 50%；
且 P0 范围还含 8 个新测试文件、~25 条 i18n、banner/状态栏/错误映射/文档更新，2–2.5 明显偏乐观。
**建议修正**：改为 **3–3.5 人日**，或在计划中把 P0 范围压缩（如 i18n/banner 留到 P0.5、测试按现有
框架增量），并在主报告 §6 同步。

### P1-2 pdftotext 的定位在三份文档中互相矛盾，按 integration 实施会降低质量
**位置**：`integration.md:100`（auto provider 顺序 **system→builtin→sidecar**）、`:134`（system 标
"✅ `pdftotext -layout`"）、`:332`、`:804`、`:823`（探针"auto 优先 system，PDF 解析质量优于 P0
（标题/段落/页码更准）"）；对照 `LOCAL-FALLBACK.md:109`（"pdftotext 没有标题/页码/坐标，阅读台体验
显著变差；仅作有则更好"）、`:280`（P1=可选增强）、`node-extract.md:147`（同样只作兜底）。

**问题**：这是同一能力的两种相反结论。node-extract 实测 `-layout` 双栏逐行左右交错（不可作阅读
顺序），raw 也给不出标题/坐标/outline；把 system 放在 `auto` 首选会让默认解析质量**回退**，并与
主报告"首推 pdfjs 而不是系统 CLI"的结论冲突。
**建议修正**：三处统一为"**builtin（pdfjs）为主，pdftotext 仅在 builtin 不可用/失败时兜底**"，且
兜底用 raw 不用 `-layout`；P1 验收改为"系统工具只作兜底/互校，不改变默认识别结果"。

### P1-3 "local 引擎永不联网"是过度承诺，与 P2 侧车首次下载模型冲突
**位置**：`LOCAL-FALLBACK.md:154`（设计目标 2："`local` 引擎永不联网"）；对照同文 `:369`
（"首次运行模型下载（0.8–3 GB）必须有进度/超时/取消，且不静默下载"）、sidecars §2.7。
**问题**：P2 的 MinerU/Docling 侧车归入 `engine:'local'`，其首次运行必然联网下载模型；工程上无法
承诺"永不联网"，只能承诺"不上传文档、提取阶段不联网"。对隐私敏感用户，这是会被抓住的语义漏洞。
**建议修正**：改为"**本地引擎不把文件上传到云端**；P2 侧车首次运行可能联网下载模型，UI 必须提前
披露并支持离线预下载/进度/取消"，并在 §5.4 隐私行、README 隐私说明里同步。

### P1-4 自写 OOXML 的阶段归属在四件套里出现 P0/P1/P2 三种说法
**位置**：`LOCAL-FALLBACK.md:116`（§2.2 "⚠️ P2 回退"）vs `:358`（§6 P1 "可选 OOXML 轻量回退"）；
`integration.md:21, 513`（P2）；`node-extract.md:141`（§3 **P0** "DOCX/PPTX/XLSX 复用 lib/unzip.js"）。
**问题**：同一能力三个阶段归属；主报告自身 §2.2 与 §6 P1 也不一致。易导致 P0/P1 排期争议。
**建议修正**：统一为 **P2 回退**（P1 只做 officeToPdf，服务缺失时引导云端）；node-extract §3 加
"Office 已从 P0 移出、延后至 P2"的修订说明；主报告 §6 P1 文件清单删除该条或注明"P2 预留"。

### P1-5 T2 推荐顺序两份文档不一致
**位置**：`sidecars.md:423-424`（引擎树 "MinerU 本地版 4.x > **Docling > PaddleOCR(PP-StructureV3) >
MarkItDown**"）vs `LOCAL-FALLBACK.md:365-366`（P2 优先级 "MinerU → Docling → **MarkItDown →
PaddleOCR/RapidOCR**"）。
**问题**：MarkItDown 与 PaddleOCR 的先后次序相反（sidecars 里 PaddleOCR 是"质量天花板候选"，
MarkItDown 是"最轻兜底"；主报告把最轻兜底排在质量候选前）。对产品落地排序有直接影响。
**建议修正**：明确排序维度（质量优先 = MinerU>Docling>PaddleOCR>MarkItDown；成本优先 =
MarkItDown 最先），主报告 P2 采用与 sidecars 一致的顺序或写清"按用户画像分两条路径"。

### P1-6 officeparser 的体积与 engines 数字自相矛盾/不准确
**位置**：`LOCAL-FALLBACK.md:40`（"officeparser >100 MB"）vs `:118`（"unpacked 35.8 MB"）；
`node-extract.md:38`（>100 MB，pdfjs6+tesseract.js-core 44 MB+@napi-rs 36 MB）。
**问题**：同一份主报告两处给出差 3 倍的体积；且 engines 实际是
`>=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1`（三个窄区间），主报告写成"卡死在 Node 26.12+ 窄区间"
会让人误以为只支持 26.12 以上。排除结论不变，但证据表述不严谨。
**建议修正**：统一为"包本体 35.8 MB / 安装树 >100 MB（含 tesseract.js-core 44 MB、@napi-rs 36 MB）"，
engines 照抄三区间。

---

## 4. P2（建议修正）

1. **unpdf 的 Node 断言把"未验证"写成了事实**：`LOCAL-FALLBACK.md:105` "1.x 需 Node≥22、2.x 需 ≥24"
   —— node-extract `:32` 明确写 "package.json 无 engines 字段（Lead 提示…本机未能在 Node20 验证）"；
   我查 npm：`unpdf@1.4.0` 无 engines 字段、`2.0.0` engines=`>=24`。"1.x 需 ≥22" 无来源。建议改为
   "2.x engines>=24（已核）；1.x 无 engines 声明，Node 20/22 未验证"。
2. **"两版本逐字一致"只被字符数一致支持**：`LOCAL-FALLBACK.md:176`"两版本逐字一致"、
   `node-extract.md:68` 同。交叉核对记录只有"字符数完全一致（38,804 / 70,504）"，未展示逐字 diff
   证据。建议改"字符数完全一致"。
3. **MB/MiB 混用**：`LOCAL-FALLBACK.md:196-197` 中 5.4.449 用 "0.46+1.07 MB"（实为 MiB），
   4.10.38 用 "0.40+1.42 MB"（实为十进制 MB），两行单位不同却都写 MB；实测 5.4.449 两文件
   **1,607,192 B**（=1.53 MiB=1.61 MB）。建议统一为 MiB 或写字节数。
4. **两个 markdown 表格会被渲染坏**：`LOCAL-FALLBACK.md:392` 风险表第 11 行有 **4 个单元格**而表头
   3 列（`# | 风险 | 缓解`）；`integration.md:37,39,240,519` 的单元格内含未转义 `|`
   （`{engine:'standard'|'agent'}`、`'auto'|'builtin'|'system'|'sidecar'`、`doc.parse.pages || reader.pages`），
   GFM 会错列。建议转义 `\|` 或改用顿号/`\|\|`。
5. **content_list 的 `text` 长度口径两处不同**：`LOCAL-FALLBACK.md:301` "每段 ≤4,000 字符（硬上限
   8,000）" vs `integration.md:224` "建议写完整段落文本（≤2000 字符截断）"。另外代码匹配只看
   **规范化前缀 48/24/12 字符**（`ui/markdown.js` `mdMatchContentEntry`，约 1365-1413 行），并不要求
   全文逐字相同。建议统一为："CL 的 text 写 block 纯文本前缀（≥48 字符即可匹配；建议全文同源），
   段落合成上限 4,000/硬 8,000"。
6. **MinerU "移除 AGPL 模型"的版本表述错位**：`sidecars.md:163-168` 写"自 3.1.0 起…；**同一版本起**
   官方完全移除了 2 个 AGPLv3 模型…（changelog 3.0.0）"。实查 changelog：模型移除发生在
   **3.0.0（2026/03/29）**，许可切换发生在 **3.1.0（2026/04/18）**，不是同一版本。建议改为
   "3.0.0 移除 AGPL/CC-BY-NC 模型，3.1.0 切换许可"，并补链接。
7. **P0 测试缺口：真实 vendored pdfjs 的加载路径没有端到端覆盖**：integration §7 的 e2e 用
   "fake localEngine"，unit `local-pdf.test.mjs` 若也 mock 掉 pdfjs，则 worker 命名/懒加载/真实
   vendor 目录缺失这类最易翻车的点无测试。建议加一条 **真实 `await import('../vendor/pdfjs/pdf.mjs')`
   + 最小合成 PDF** 的 smoke test，并把 `vendor/pdfjs/{pdf.mjs,pdf.worker.mjs,LICENSE}` 存在性纳入
   `scripts/check.mjs`（当前 `files` 的 `vendor/**` 已覆盖打包，只需加门禁断言）。
8. **integration §4.1 的 package.json 改动项有一半是冗余**：现 `package.json` 的 `files` 已含
   `vendor/**`（`docs/ARCH.md:83`），不必再加 `vendor/pdfjs` 专项；真正要改的只有 engines。
   建议删掉"files/dsh 清单包含 vendor/pdfjs"以免实施者重复改。

---

## 5. 可执行性评估

- **P0 计划可落地**：文件清单（local-synth/local-pdf/local-engine + config/mineru/parse-manager/
  service/agent-tool/index + ui + vendor）与唯一分叉点（`executeTask`）设计合理；测试点覆盖
  合成器 golden/页码对齐/key 稳定/空文本/加密/损坏/取消/并发/e2e 零网络，关键路径齐全；
  验收标准可验证（0.3–0.5s/15p、p95≤3s/50p 的 pdfjs 数字来自 4.10.38 实测，见 P2-2/P2-3 提醒——
  建议补一条"推荐版本 5.4.449 只交叉验证了字符数，RSS/耗时/owner-加密需在验收前补测"）。
- **工作量**：P0 被低估（P1-1），P1/P2 区间（2–3、3–5 人日）与文件/测试量匹配。
- **风险清单**：覆盖质量损失、扫描件、双栏、标题启发式、行为变化、隐私、安全、内存、跨引擎高亮
  漂移、翻译上限，基本完整；建议补两条：①vendor 保活（pdfjs 5.4.449 固定版本的安全更新/升级
  流程与回归样本集）；②侧车首次下载失败/离线场景的降级路径（当前只有进度/超时/取消，未写
  "下载失败后 auto 如何回落"）。**未验证清单**（§7）态度诚实，保留。
- **安全设计**：`shell:false`+argv 数组+路径仅来自 store+输出上限+超时 SIGKILL+侧车仅运维配置，
  可执行且检查点齐全。

---

## 6. 最终意见

**需修订（P0 2 项 + P1 6 项），修订后可发布。** 最小修订清单：

1. 主报告 §4.1 改为可见字符口径、结论改 0.02%–0.42%（P0-1）；
2. node-extract §3 P0 改为"仅合成 content_list、不写 markdown 页码标记"并加修订注记（P0-2）；
3. integration P0 工作量改 3–3.5 人日（P1-1）；
4. 统一 pdftotext 为兜底、非 auto 首选（P1-2）；
5. 隐私承诺限定为"不上传文件"（P1-3）；
6. OOXML 统一 P2、T2 顺序统一、officeparser 数字统一（P1-4/5/6）；
7. P2 项可在发布后随文档例行维护修，但表格转义/unpdf 断言/MiB 单位建议一并改掉。

修订只改表述与少量数字，不动"vendor pdfjs + 合成 content_list + 引擎枚举 + officeToPdf"的技术
结论，因此风险很低；完成后本方案可以交产品评审。

---

## 7. 修订记录（Lead，2026-11-06）

复核提出的 P0/P1 已全部处理，P2 中可快速修正的项一并处理（均为文档表述/口径修订，未改研究结论、
未改产品代码）：

| 复核项 | 处理 |
|---|---|
| P0-1 口径混用 | 主报告 §4.1 改为「字符数（含空白）/ 可见字符」双列；结论改为 **0.02%–0.42%**；integration 基线改为 `pdftotext raw`，注明 chars 不可与可见字符直接相减 |
| P0-2 node-extract 页码方案冲突 | node-extract §3 P0 顶部加「修订注记」：markdown 不插页码标记、`content_list` 改为必需产物；Office 移出 P0 |
| P1-1 工作量 | P0 统一为 **约 3 人日**（明细 0.5+0.5+0.75+0.5+0.75 = 3.0d），主报告与 integration 同步 |
| P1-2 pdftotext 优先级 | integration 改为 **builtin（pdfjs）默认 → pdftotext 仅失败兜底（raw）**；能力矩阵/P1 验收同步；主报告与本复核的「仅兜底」结论一致 |
| P1-3 隐私过度承诺 | 改为「本地引擎不上传文档、提取阶段不联网」；P2 侧车首次下载模型需 UI 披露并支持离线预下载/进度/取消（不再承诺「永不联网」） |
| P1-4 OOXML 阶段归属 | 统一为 **P2 回退**（P1 只做 officeToPdf；主报告 §6 P1 删除该条，node-extract 加注） |
| P1-5 T2 推荐顺序 | 主报告 P2 明确「质量优先：MinerU→Docling→PaddleOCR-VL→MarkItDown；成本优先则 MarkItDown 最先」，与 sidecars 引擎树一致 |
| P1-6 officeparser | 统一为「包本体 35.8 MB / 安装树 >100 MB」并照抄 engines 三窄区间 |
| P2 各项 | unpdf 断言改为「2.x engines>=24 已核；1.x 无 engines 声明未验证」；「逐字一致」改「字符数一致」；pdfjs 体积统一 MiB（1,607,192 B）；表格转义/列数修正；CL `text` 匹配口径统一；sidecars 3.0.0/3.1.0 版本表述修正；integration 增加 **vendor 真实 import smoke test + check.mjs vendor 断言**；package.json 冗余改动删除；主报告/integration 风险清单各补「vendor 保活」「侧车离线回落」两条 |

复核中的「未验证/待补」清单（§7）原样保留，并在主报告「未验证/待补」中补充：5.4.449 的 RSS/耗时/
owner-only 加密需验收前补测（本次 RSS/耗时实测来自 4.10.38）。
