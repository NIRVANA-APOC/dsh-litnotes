# 独立复核：本地富内容还原研究（rich-review）

> 复核人：research-reviewer（未参与本轮研究）· 日期：2026-11-07
> 对象：`docs/LOCAL-RICH-CONTENT.md`（主报告）+ `docs/research/rich-{images,tables,formulas,integration}.md`
> 方法：通读五份文档；**重跑已有脚本**核对关键数字（输出到 `/tmp`，不覆盖证据目录）；读代码核对 §2 契约；
> 用 npm/PyPI/HuggingFace 抽验许可证。仓库当前 HEAD 为 `0cda21a`（文档自称 `b1a68be`，见 P1-1）。

---

## 0. 总体结论

**需修订后可发布（研究/设计交付，不改产品代码这一点属实）。** 复现性很好：我本轮重跑的 4 组脚本
（公式/表格/图片区域/契约 spike）结果与证据目录**逐项一致**，许可证抽验全部成立，扫描件/OCR 边界
未被突破，也没有"已实现"的虚假声明。主要问题集中在一处**范围/阶段自相矛盾**（P0-1）、一处
**结论过度承诺**（P0-2）、以及系统性 **file:line 漂移**与若干笔记间口径不一致（P1/P2）。
修订只改文档表述与计划，不需要推翻研究结论。

---

## 1. 数字可复现性（本轮实测，全部通过）

| 证据 | 重跑结果 | 与文档/证据 |
|---|---|---|
| `rich-formulas/reconstruct.mjs` attention 4–6 + bee 8 | 9 条公式输出与 `score.json` 的 `got` **逐字一致**；Dice = 1.00/0.96/1.00/0.944/0.952/0.955/0.96/0.889/0.886，**均值 0.9496 ≈ 0.95** | ✅ 主报告 §0/§4.1、rich-formulas §2.2 一致 |
| `rich-tables/proto.mjs` | bee 三表 **2×6 / 11×6 / 4×6 全对**，cell F1 = **1.000 / 0.955 / 1.000**（均值 0.985），HTML 与存储证据逐字相同 | ✅ 主报告 §3.1、rich-tables §3 一致 |
| `rich-images/compare-forms.mjs` | truthFigures=26（image 7+chart 16+table 3），hit=**23**（miss 的全是 3 张 table），**中位 IoU 0.88、min 0.35**；hitRate 字段=0.88（=23/26） | ✅ image+chart 23/23 成立；但口径见 P1-4 |
| `rich-images/extract.mjs` | bee 27p/3 occurrences、attention 15p/3、acl 17p/0 | ✅ rich-images §3.1、主报告 §5.1 一致 |
| `rich-integration/contract-spike.mjs` | **273 block**（heading 26/paragraph 231/figure 10/table 3/formula 1/code 2）、outline 26；全量 CL → **页标记 27/27**；只留 text/equation/table/list/title → **[1..25,27] 缺第 26 页**；G: figureBlocks 10 / imageEntries 7 / matched 4；H: 改名后 key 变化；I: translatable 257 / annotatable 260 | ✅ 主报告 §2、integration §3 A–J 全部一致（重跑与 `spike-output.json` 完全相同） |

**许可证抽验（外部来源）**：pix2tex **0.1.4 MIT**（PyPI，46 deps）；Texify **0.2.1 GPL-3.0-or-later**；
Nougat-base 权重 **CC-BY-NC-4.0**（HF）；`@napi-rs/canvas` **1.1.0 MIT**（js 166,133 B）+ 
`@napi-rs/canvas-linux-x64-gnu` **MIT 36,878,158 B ≈ 36.9 MB**；vendored pdfjs `LICENSE`=Apache-2.0；
`@deepseek-ai/libreoffice-kit@0.1.5`=MPL-2.0（本机已装包）；系统 `pdftotext 26.10.0`（poppler，GPL 工具）。
PaddleOCR-VL-1.6 的 Apache-2.0 上一轮已核，本轮未重查。**pix2tex 权重许可**文档已如实标"未验证" ✅。

**契约代码核对**：`escapeMarkdownText` 确实会转义 `< | & ] )` 等（`lib/local-synth.js:58,31` 的
`ALWAYS_ESCAPE`），富内容必须走特殊 block ✅；`writeStagedParsed`（`lib/parse-manager.js:619`）用
`resolveWithin+mkdir(dirname)` 天然支持 `images/**` ✅；`mdMatchContentEntry` image 分支
（`ui/markdown.js:1369`）按 basename / caption 前缀 / 窗口兜底 ✅；figure key = `alt|src`
（`mdKeyText`，`ui/markdown.js:678-691`）✅；`reanchorAfterParse` 存在且解析成功后调用
（`lib/parse-manager.js:763,813,838`）✅；本地解析禁止按页修复（`:253-262`）✅。

---

## 2. P0（必须修，否则误导产品决策）

### P0-1 客户端光栅化：主报告定为 P1 并计入人日，integration 定为 P2 条件路线且需新 API，rich-images 承认"未实现"
**位置**：主报告 §0 表格"图片（矢量图/chart）… 浏览器端 pdf.js canvas 裁剪（复用已 vendor 的 pdf.js +
canvas，零新依赖）"、§5.1、§6 阶段 C3（3–4 人日，P1）；对照 `rich-integration.md:23,335-340`（"客户端
canvas crop 属 **P2 条件路线**……**明显高于** Host 侧离线提取路线；需**新 API**/状态机/限额/fence/
时序竞态"）、`rich-integration.md:321-324`（"P0/P1 不需要改 `ui/app.js`"）、`rich-images.md:71,157`（"**未
实现**：当前 UI 无任何 pdf.js 代码"）。

**问题**：同一能力在"P1 首选 / P2 条件 / 未实现"三种定位间摇摆；主报告 §0/§8 的"阅读台无需改动、
最小改动集 5 文件、约 12–16 人日"因此与阶段 C 的真实成本（新客户端渲染组件 + 回传缓存 API + 时序/
竞态 + 移动端内存）冲突。另外 §5.1"与阅读台渲染同源"**不成立**：阅读台当前只渲染 markdown，不渲染
PDF 页面；vendored pdfjs 子集只有 `pdf.mjs`+`pdf.worker.mjs`+LICENSE（无 `standard_fonts/`、`wasm/`、
`cmaps/`），对浏览器光栅的字体/JPEG2000/CJK CID 影响**从未实测**。

**建议**：三份文档统一为"P1 **可选**、需先做 1–2 天客户端 raster spike（动态 import、worker、缺
standard_fonts/wasm/cmaps 的渲染质量、CSP、内存）再定档"；主报告 §0/§8 改"Client 仅在 text/table/
formula 阶段零改动；图片像素化需要客户端改动与新 Host API，不计入 5 文件最小集"；删除"与阅读台渲染
同源"，改"与阅读台共享 pdf.js 代码，但渲染路径是新增的、未验证"。

---

## 3. P0-2 结论过度承诺：表格/公式"可发布质量、默认开"的证据只有 BEE 一篇文章
**位置**：主报告 §3.1"已达到可发布质量"、§8"表格…已达到可发布质量"、§0 第 22 行"**表格式/公式类本地
还原覆盖率与质量已足够作为默认开**"；证据面：表格 F1 只来自 **bee 一篇论文的 3 张表**（单栏、booktabs、
有 caption、同一模板/同一真值来源），attention/acl 上仅"caption 页出候选 3/4、4/6"，无行列/单元格真值；
公式 Dice 9 个样本中 **3 个 rubric=2**（`W_{i^{Q}}` 语义错、`V_Q` 嵌套丢失），`score.json` 里 **A3 Dice
1.00 但 rubric=2**（评分令牌集对嵌套括号不敏感）——主报告 §4.3"注定失败类型"未收录这一现实失败模式，
而验收门槛恰是 **Dice≥0.85**，会放过"假 LaTeX"。

**建议**：把"可发布质量"限定为"BEE 单篇 3 表上的初步证据"；默认策略从"默认开启"改为"灰度 + 人工
rubric 抽检"；验收改为 **Dice≥0.85 且 rubric 均值≥2.5 且逐条 rubric≥2**（rich-formulas §0.1 已经如实
写了这个风险，主报告应引用而不是只留 Dice）；§4.3 增加"上下标语义归属歧义（W_i^Q）"这一失败类型。

---

## 4. P1（发布前应修）

### P1-1 file:line 系统性漂移（根因：文档基线 `b1a68be`，当前 HEAD `0cda21a`）
**位置/真实值**：`rich-integration.md:71` 写 `ui/app.js:1016-1020` `mruImageUrl` → 实际 **1302**；
`:21/:80` 写 `ui/app.js:1737` `mruIsTextBlock` → 实际 **2023**、`:1740` `mruIsAnnotatableBlock` → **2028**；
`:45` 写 `ui/markdown.js:729` figure key → 实际 **691**（`mdKeyText` 678-691）；`:70` 写
`lib/routes.js:234-269` `handleAsset` → 实际 **275** 起；`rich-images.md:157/256/342` 写
`ui/app.js:1015` → **1302**、`:2164` figure 渲染 → **2454-2458**；`rich-tables.md:132` 写
`ui/markdown.js:735-790` `mdTryHtmlTable` → 实际 **1049**（`mdParseHtmlTable` 829）；`rich-images:342`
`:1151 mdCaptionFromAlt` → **1153**；`rich-integration:82` `lib/ai/retrieval.js:28-36` KIND_WEIGHTS →
实际 **30-37**。**核对无误的**：`appendPageMarks:1437`、`mdMatchContentEntry:1365`、`writeStagedParsed:619`、
`local-synth:134/174`、`local-pdf:344/423`、`local-engine:32/281`、`parse-manager:394/619`、
`reanchor:763/813/838`。

**问题**：五份文档头都写 `main b1a68be`，但当前 HEAD 已是 `0cda21a`（其后还有 `a84e859`）；行号漂移
正是"按图索骥"型契约文档最危险的错误（复核对 1 处发现错，其余需逐条重查）。**建议**：文档头改为
"基线 commit + 采集时间"，正文引用改为"符号名（+采集时行号）"，并对全部 file:line 用当前 HEAD 重扫
一遍；或明确声明"行号以 b1a68be 为准"。

### P1-2 rich-images 工作量自相矛盾（三处三套数字）
**位置**：`rich-images.md:21` "P0（**1–1.5 周**）"、§4 "P0 … **1–1.5 人日** + 测试 1–2 人日"、
§7 表格 "P0 **3–4 人日**"；主报告 §0/§6 采用 3–4。**问题**：同一阶段从 1–1.5 人日到 1–1.5 周差 5 倍，
"完整≈8–11 人日"与主报告"12–16 人日"的加总也依赖它。**建议**：统一为 §7 的 3–4 人日（含测试），并把
§4 的"1–1.5 人日"删除；主报告总估算按 1.5–2（契约）+3–4（公式/表）+8–11（图片）= **12.5–17 人日**
重算（当前写 12–16，见 P2-4）。

### P1-3 "阅读台已完整支持/零改动"与真值并非 1:1 的事实未说清
**位置**：主报告 §0"阅读台对 MinerU 风格富内容**已完整支持**"、§2"**1 block ↔ 1 CL entry** 是硬约束"；
对照 spike 实测：**273 markdown block vs 358 CL 条目**（真值本身不 1:1）、**bee-full.md 有 24 个
`![]` 引用但只解析出 10 个 figure block**、7 个 `image` CL 仅 **4 个**按 basename 命中 figure block。
**问题**：这些是"靠兜底仍能工作"的证据，不是"完整支持"的证据；"1:1 硬约束"是**本地 synth 的设计
要求**（integration 表述正确），不应写成 BEE 真值的性质，也没有解释 24↔10 的图引用差异。**建议**：
§2 把约束改写为"本地 synth 必须 1:1；MinerU 真值不满足 1:1，靠 `lastMatched+1` 兜底仍能 27/27，但
这是兜底而非契约基准"；并补一句 24 图引用 vs 10 figure block 的原因（或标注"未解释"）。

### P1-4 "有 Form 的 15 页 = 有图的 15 页，零假阳性"超出脚本能证明的范围
**位置**：主报告 §5.1、rich-images §3.2。`compare-forms.mjs` 只做"真值→区域"的单向匹配
（truth 26 → hit 23，miss 全是 table），**未统计"区域→真值"的精度**，22 个聚类区域 vs 23 个真值
（Fig.3 相邻 Form 合并成一个区域）；因此 23/23 是**召回**（image+chart 口径），"零假阳性"最多只能
说"**页级**没有'有 Form 无图'的页"。另 output 里的 `hitRate:0.88` 是 23/26（含 table 分母），与"23/23"
读数容易混淆。**建议**：写明"23/23 = image+chart 召回（table 不计入）；区域级精度未测；'零假阳性'
仅指页级"；验收 §6 的"命中率 ≥90%（IoU≥0.2）"同时给出分母口径与"中位 IoU≥0.8"更稳。

### P1-5 带 SMask 的 DCT 位图在 P0 到底怎么处理，表述不完整
**位置**：主报告 §5.2"透明通道陷阱"、风险 #5。实测 BEE **3 个 DCT 全部带 `/SMask`**（透明底图标，
直通 jpg 会黑底），attention 位图是 Flate→PNG RGBA（无此问题）。主报告给出的策略是"无 SMask 直通
jpg、带 SMask 合成 PNG（成本高，可用 canvas/pdf.js 或在 P0 先过滤小图标）"——但没有明确"**大图且带
SMask 的 DCT 在 P0 不可用**（要么丢、要么等 canvas）"。**建议**：在 §5.2/阶段 C1 明确该限制并计入
warning（`image-unavailable:smask`），避免用户以为 P0 能覆盖所有位图。

### P1-6 笔记之间对 DSH PDF→PNG 能力和 table CL 匹配的描述互相矛盾
**位置**：`rich-formulas.md:151`"DSH libreoffice-kit / PDFium | **未验证** | 未见 PDF 页面渲染 API；
**不作为路径**" vs `rich-images.md:17,70,138-151` 实测可行（`renderImages`、PDFium、27 页 8.9 s）与主
报告 §5.1 的引用；`rich-tables.md:134`"table 条目**没有 text 字段** → `mdMatchContentEntry` 会**跳过
匹配**" vs 代码实际：table 条目用 `table_body` 去标签文本参与前缀匹配（`ui/markdown.js:1317-1324`），
integration §1.3 描述正确。**建议**：以 rich-images 的实测/主报告为准，回改 rich-formulas §3.3；
rich-tables §4.1 那句改为"table 用 `table_body` 参与匹配；若只给 bbox 不给 table_body 才会走兜底"。

### P1-7 用户库真值内容的使用边界需要一句声明
**位置**：主报告开头"用**用户文献库中 MinerU standard 解析稿**做真值（BEE…）"，五份文档含 BEE 的标题、
caption、表格数据（`Wordnet/HPRD/…`、`92,747`）与公式片段。**问题**：BEE 是公开论文的概率很高，但报告
没有说明"真值来源可公开、fixtures 不入库（在 `.agents/` 未提交）、文档仅引用必要片段"；若论文非公开
或数据敏感，需要脱敏。**建议**：加一行来源与再分发声明，并确认 `.agents/tmp-research/**` 不随仓库/
发布物提交（当前 git status 中只有 docs 未跟踪，符合）。

---

## 5. P2（建议修正）

1. **图片上限/白名单口径不一致**：`rich-images.md:250` `maxImages` 默认 **~100** vs 主报告 §2/
   integration §2.3 **200**；rich-images §5.1 白名单 `png/jpg/jpeg`（webp 可选）vs 主报告/integration
   含 **webp**。统一为一套（建议 200 + png/jpg/jpeg/webp）。
2. **equation 契约细节不一致**：`rich-integration.md:129` CL 写 `{type:'equation', text:latex}`，
   `rich-formulas.md:194/226` 写 `text:'$$...$$'`（MinerU 真值也是带 `$$`，`text_format:'latex'`）；
   匹配器会去 `$$`，两种都能用，但建议照抄 MinerU 形态并写明 `text_format` 可选。
3. **DCT 直通口径**：`rich-images.md:166` 说"DCT 原样 `.jpg`（保真）"未提 SMask（§6 风险 4 才提）；
   建议在 P0 描述处就加"仅无 SMask 的 DCT 直通"。
4. **总人日加总偏低**：1.5–2 + 3–4 + 8–11 = **12.5–17**，主报告写 12–16（且未含公式图片 P1 的 2–3
   人日与 DSH 跨仓库 2–3，后者已声明不含）；建议写 13–17 或逐项列清楚包含关系。
5. **`rich-tables.md:132` 行号 735-790 错**（`mdTryHtmlTable` 实际 1049）；该处同时属 P1-1。
6. **`rich-formulas.md:13` "不做 inline" 与主报告一致 ✅**，但双栏 PDF 的公式检测（acl）未实测，
   报告应把"双栏公式"列入未验证项（目前只在 rich-formulas §2.3/§7 提到，主报告 §4.3 未列）。
7. **"零新依赖"的表述**：浏览器 raster 确实零 npm 依赖，但会新增 Host 上传/缓存 API 与 client
   bundle 体积（动态 import 1.5 MiB + worker）；建议在收益/代价里写明，避免被读成"零改动"。

---

## 6. 其它核对结论（无问题）

- **扫描件/OCR 边界**：主报告开头、§8 与 rich-images §4/P2 均声明不研究 OCR；`local-empty-text`
  仍是本地无文字层 PDF 的兜底 ✅。仅建议把 rich-images "screenshot/扫描图层"措辞改为"已有位图
  的截图类 PDF（不做 OCR）"，避免被误读为支持扫描件。
- **未声称已实现**：五份文档均为研究/设计；当前 `lib/local-pdf.js` 仍只产 heading/paragraph
  （无 bbox、rich 能力 `capabilities.images:false`，`lib/local-engine.js:162-167`），`executeLocalTask`
  仍只写 full.md/content_list（`lib/parse-manager.js:394` 起）——与主报告 §1.1 的现状描述一致。
- **风险覆盖**：假 LaTeX、跨页/双栏表、SMask、客户端渲染、批注 index 位移、导出图片、隐私/版权
  均已列入主报告 §7；补充建议见 P0-2/P1-5。
- **阶段依赖**：A→B→C 顺序自洽；C3 与 D 的先后建议按 P0-1 统一后补一张依赖图。

---

## 7. 最终意见

**需修订后可发布。** 研究对象（BEE 真值 + 三篇真实论文）与四组脚本的证据链**可复现、可审计**，
契约方向（同构 markdown+content_list、内容哈希命名、富条目类型、富内容跳过转义、caption 独立段、
reanchor 兜底）经代码核对**成立**，许可证抽验**无问题**。发布前必须处理：**P0-1（客户端光栅化
的阶段/零改动/人日矛盾）**、**P0-2（表格/公式"可发布质量、默认开"的证据范围与 Dice 门槛）**，
以及 P1-1（行号漂移，改为符号引用）与 P1-2/P1-4/P1-6 的口径统一。P2 可随文档例行维护修。
修订不改变"富内容可本地还原、分阶段推进"的核心结论。

---

## 8. 修订记录（Lead 已处理，2026-11-07）

复核提出的 **P0×2 + P1×7 + 可快速修的 P2 项**已全部处理（只改文档表述/口径，不改研究结论、不改产品代码）：

| 复核项 | 处理 |
|---|---|
| P0-1 客户端光栅化定位矛盾 | 主报告统一为**条件路线（P1 conditional）**：先 1–2 天 spike（worker/字体/CSP/内存、缺 `standard_fonts/wasm/cmaps` 渲染质量）→ 实现 3–5 人日，并明确**需要新增客户端渲染组件 + Host 回传/缓存 API**，不计入「5 文件最小集」；删除「与阅读台渲染同源」，改「共享同一份 pdf.js 代码、渲染路径未验证」；人日重算：基础富内容 5–6 人日、含图片像素化 13–18 人日（部分为条件项） |
| P0-2 质量过度承诺 | 「可发布质量/默认开」改为「BEE 单篇 3 表的初步证据、灰度开启（默认 off）、扩样本后再评估」；公式补充上下标语义歧义失败模式（A3 Dice 1.0 但 rubric 2）；验收改为 **Dice≥0.85 且逐条 rubric≥2、均值≥2.5**，并明确 Dice 单独会放行假 LaTeX |
| P1-1 行号漂移 | 五份文档统一声明「研究基线 b1a68be / 复核时 HEAD 0cda21a；引用以函数/符号名为准」；报告附录增加行号说明；笔记错误行号按符号名修正（如 `mdTryHtmlTable:1049`） |
| P1-2 图片工作量口径 | rich-images 统一为：位图提取 3–4 人日（含测试）+ 区域定位 2–3 人日；P1 客户端 1–2d spike + 3–5d 实现（条件） |
| P1-3 「完整支持/1:1」 | 主报告 §2 增加「MinerU 真值本身非 1:1（273 block vs 358 CL、24 图引用 vs 10 figure block、7 image 仅 4 basename 命中）」说明；「1:1」明确为本地 synth 的设计约束，不是真值性质；「阅读台 0 改动」限定为契约/表格/公式/内嵌位图路径 |
| P1-4 「零假阳性/23/23」 | 改为「image+chart **召回** 23/23（table 3/3 不计入）、中位 IoU 0.88；**区域级精度未统计**；零假阳性仅页级成立」；验收给出分母口径 + 中位 IoU≥0.8 |
| P1-5 SMask DCT | 明确 P0 边界：仅无 SMask 的 DCT/Flate 位图可安全导出；带 SMask 的 DCT（尤其大图）记 `image-unavailable:smask` 降级 caption |
| P1-6 笔记口径冲突 | rich-formulas §3.3 的 DSH PDFium 结论改为引用 rich-images 实测（renderImages 可用、服务未暴露、需跨仓库扩展）；rich-tables §4.1 改为「table 按 `table_body` 去标签文本参与匹配，只给 bbox 才走兜底」 |
| P1-7 用户库真值边界 | 各文档/附录增加来源声明：真值来自用户本地库中公开论文（BEE/Attention/ACL），fixtures 不入库不随发布物提交，仅引用必要片段；敏感则删除引用 |
| P2 项 | 图片上限统一 200 张、白名单 png/jpg/jpeg/webp；equation 契约统一为 `text:'$$…$$', text_format:'latex'`；DCT 直通处补「仅无 SMask」；总人日重新加总并列出包含关系；报告补「双栏公式未验证」「客户端渲染会新增 Host API/客户端体积」；删除可能被读成「零改动」的表述 |
| 保留 | 「富内容可本地还原、分阶段推进」核心结论不变；数字复现全部一致（公式 Dice 0.9496、表格 F1 1/0.955/1、图片 23/23 召回中位 IoU 0.88、契约 273 block/27 页标记）；许可证抽验无问题 |
