# dsh-litnotes 本地化降级解析：插件集成设计（integration）

> 角色：集成设计者（integration-architect）。范围：只做设计与 `/tmp` 外的可行性 spike，**不改产品代码**。
> 代码基线：worktree `dsh-41946cb9-4594`（DSH 0.2.2-rc.1，Host 纯 Node ESM、零 npm 依赖；Client 由 `ui/*` 构建）。
> P0 提取器定稿（Lead，基于 node-extract 实测）：vendor `pdfjs-dist@5.4.449` legacy **min** 构建（`vendor/pdfjs/pdf.mjs` + `pdf.worker.mjs` + `LICENSE`，≈1.53MB，Apache-2.0），**不手写 PDF 解析器**；`package.json` engines 建议 `>=20.16`。交叉验证笔记：`docs/research/node-extract.md`。
> 本文 spike 证据目录（仓库外、持久）：`/home/nirvana/Documents/dsh-mineru/.agents/tmp-research/integration/`
> （`paper.pdf`、`paper.txt`、`full.md`、`content_list.json`、`spike.mjs`、`spike-output.txt`）。本 spike 只验证**产物契约与阅读台消费**，不作为 P0 提取器（pdfjs）的性能/质量证据——后者以 `docs/research/node-extract.md` 为准。

---

## 0. TL;DR（给决策者的 10 条）

1. **引擎模型**：`engine` 增加显式第 4 值 `local`（`auto|standard|agent|local`），本地能力细分放在 `parse.provider` / `config.local.provider`，**不**把 `local-basic/local-tool/local-sidecar` 做成 engine 枚举值。
2. **auto 默认策略**：`auto` = 有 Token → `standard`；无 Token 且本地可用 → `local`；本地不可用且允许云端上传 → `agent`。即 **local-first（无 Token 时）**，因为免 Token 的 agent API 仍然是把原文件上传到 MinerU 云（`docs/ARCH.md §5.2`），并不满足「离线/隐私」语义。
3. **产物契约**：本地引擎只写 `parsed/full.md` + 合成 `parsed/content_list.json`（纯数组，`{page_idx,type:'text',text,text_level?}`），**不写** `<!-- page: N -->` 之类的 markdown 页码标记——spike 证实 `parseMarkdown` 会把它当普通段落（见 §6.H），页码标记的唯一通道是 `appendPageMarks(model, contentList)`（`ui/markdown.js:1437`）。
4. **缺失产物时现有代码不会崩**：`contentList=null` 时 `appendPageMarks` 原样返回（`ui/markdown.js:1439`）、`pages` 回退 `meta.parse.pages`（`lib/store.js:605`）、`document.markdown` 正常返回。代价：无页码标记、无按页修复入口（`prepareRepair` 需要 content_list，`lib/parse-manager.js:233-235`）。
5. **高亮锚点稳定**：block key = `b<index>:<fnv1a(mdKeyText)>`（`ui/markdown.js:51-63,703`），页标记插入**不改变**原 block 的 index/key（spike E 验证）；同一内容重复解析 key 完全一致（spike E）。本地→云端重解析会重排 block，旧高亮会走现有 `margin.dropped` 降级（`ui/app.js:162`）。
6. **翻译分块可用**：全文翻译按 block 的 `plainText` 逐段调用（`ui/app.js:3573-3610`），单段上限 20000 字符（`lib/service.js:37`）；spike 实测 62 段、最长 3208 字符，无需改动。P0 的合成器必须给段落设置长度上限（建议 4000 字符，硬上限 8000）作为防御。
7. **Host 最小改动集**：新增 `lib/local-engine.js` + `lib/local-synth.js` + `lib/local-pdf.js`（pdfjs 适配层）+ `vendor/pdfjs/`（≈1.53MB）；改 `lib/config.js`、`lib/mineru.js`、`lib/parse-manager.js`、`lib/service.js`、`lib/agent-tool.js`、`index.js`、`package.json`；Client 只改 `ui/app.js`（+ 重建 `lib/client.js`）。
8. **接入点只有一个**：`parse-manager.executeTask()` 在 `readFile(sourcePath)` 之后分叉（`lib/parse-manager.js:356-404`），复用队列/并发/AbortController/`writeStagedParsed`/`finishSuccess`，无需新的任务状态机。
9. **P1 增加 Office 输入**：利用 web profile 已挂载的 `ctx.get('officeToPdf')`（可选服务）把 docx/pptx/xls 等转成本地 PDF 再走同一文字层提取；P1 不新增 npm 依赖。服务缺失时降级为 `local-missing-tool` 并引导云端解析；P2 可选用「自写 OOXML 文本子集」（复用 `lib/unzip.js`，node-extract 已跑 160 行原型，0 新增体积）作为 officeToPdf 缺失时的纯文本回退。
10. **最大风险**：pdfjs 的资源/构建形态（峰值 RSS 112–196MB；非 min 构建仅 import 就 +335MB；worker 需显式 `workerSrc`；Node 版本）+ 扫描件无 OCR 为空 + 版式/公式丢失；缓解=只 vendor min 构建、懒 `import()`、显式 `workerSrc`、`engines >=20.16`、页数/内存/并发上限 + `local-empty-text`/质量 banner/「配置 Token 解锁精准解析」引导；**可见字符**与 pdftotext raw 基线差仅 0.02%–0.42%（pdfjs 的 chars 含空白，勿直接相减）。

---

## 1. 现状与约束（读码结论）

### 1.1 引擎模型现状

| 位置 | 现状 |
|---|---|
| `lib/config.js:48` | `const ENGINES = new Set(['auto', 'standard', 'agent'])`（仅用于偏好校验） |
| `lib/config.js:34` | `DEFAULT_PREFERENCES.defaultEngine = 'auto'`；`defaultModelVersion:'vlm'` |
| `lib/config.js:321-322` | `validatePreference('defaultEngine')` 用 `ENGINES.has(value)`，非法值静默回落 `auto` |
| `lib/mineru.js:710-796` | `normalizeParseOptions()` 是唯一的引擎/参数校验入口：`raw.engine ?? 'auto'`，`:722` `auto = hasToken ? standard : agent`；`:723-729` standard 无 Token 抛 `token-missing`；`:731-747` 扩展名；`:749-770` 大小限制 |
| `lib/service.js:565-590` | `startParse()`：`merge:true` → 按页修复；否则取 token → `normalizeParseOptions` → `manager.start(normalized)` |
| `lib/parse-manager.js:817-824` | `start()` 接受内部归一化的 `{engine:'standard'\|'agent', params}` 形态；`:837-855` 写 `meta.parse` |
| `lib/parse-manager.js:363-404` | `executeTask()` 只有 standard / agent 两个分支 |
| `docs/ARCH.md:172-222` | HTTP API 与 `parse.start` options（`engine: 'auto'\|'standard'\|'agent'`） |
| `lib/agent-tool.js:70-107` | agent tool 的 `parse.engine` JSON Schema `enum: ['auto','standard','agent']` |
| `ui/app.js:1654,1661,1696-1703` | 解析设置面板 engine 下拉（三个 option）、`needsToken` 判定 |
| `ui/app.js:2106-2107` | 状态栏引擎文案：只有 agent→`statusbar.engineAgent`，其余一律 standard |

**结论**：`engine` 是持久化在 `meta.parse.engine`、UI 状态栏/失败面板/重解析/`resume()` 分支（`lib/parse-manager.js:939`）共同消费的**枚举**。新增能力应扩展枚举 + 用 provider 细化，而不是塞进 auto 的内部档位。

### 1.2 产物与消费契约现状

| 位置 | 行为 |
|---|---|
| `docs/ARCH.md:99-112` | `parsed/full.md`、`parsed/content_list.json`（standard only）、`parsed/images/*` |
| `lib/parse-manager.js:539-573` | standard：ZIP 里取 `full.md` / `*_content_list.json` / `images/**`，`writeStagedParsed` 原子替换 |
| `lib/parse-manager.js:646-658` | agent：只写 `full.md`，`hasContentList:false`，`pages` 来自进度 |
| `lib/store.js:568-606` | `readMarkdown`：`content_list.json` 或 `*_content_list.json`，数组或 `{content_list:[]}` 均可；`pages = pagesOf(contentList) ?? meta.parse.pages` |
| `ui/app.js:941-952` | `mruBuildModel`：`parseMarkdown` 后，若 `showPageMarks && contentList` 才 `appendPageMarks` |
| `ui/markdown.js:1437-1490` | 页标记只来自 content_list 的 `page_idx` 跳变；插入 `{kind:'page', key:'page:<n>:<slot>'}`，**保留原 block 的 index/key** |
| `ui/app.js:524-547` | `mruProblemPages` 从 content_list 的 U+FFFD 找可修复页 |
| `lib/parse-manager.js:219-261` | 按页修复前置：必须 `status:'parsed'`、**有 Token**、**有 contentList**，否则 `repair-unavailable`/`token-missing` |
| `lib/parse-manager.js:933-985` | 主机重启恢复：只有 `phase:'polling'` 的 standard/agent 可恢复，其余标记 failed「解析被中断，请重试」 |

### 1.3 约束（设计红线）

- Host 纯 ESM + `node:` 内建，**零 npm 依赖**（`docs/ARCH.md:475-487`）；唯一例外是 P0 原样 vendor 的 `pdfjs-dist@5.4.449` legacy min 构建（`vendor/pdfjs/`，Apache-2.0，≈1.53MB，不进 npm 依赖、不打进 client bundle，懒加载）。文件写作用 `writeStagedParsed` 的原子 staging。
- 不新增服务/iframe；Client 只能 `require('react')`（`docs/ARCH.md:416`）。
- `ui/app.js` 是源码，`lib/client.js` 是生成物，必须 `node scripts/build-client.mjs` 重建（`docs/ARCH.md:460-463`）。
- 配置是**无 schema 的 mapping**（`docs/ARCH.md:348-365`），校验手写在 `lib/config.js:150-180`，新增配置项必须手动 `integerOption`/布尔/枚举校验并给默认值。
- 可选 Host 服务一律 `ctx.get(...)` 可选处理（`index.js:24-27,40-66`）；本设计新增 `ctx.get('officeToPdf')`。
- 数据目录、`meta.json` 只做**增量字段**，不做迁移；旧版本代码忽略未知字段（`store.update` 深合并 `parse`，`docs/HOST-INTERFACES.md:70`）。

---

## 2. 引擎模型设计

### 2.1 取值：显式 `engine:'local'`（而非 auto 内部档位）

**决定：`ENGINES = {auto, standard, agent, local}`**。理由：

1. 用户需要手动选择「离线/不上传」；`meta.parse.engine` 要能持久化并驱动状态栏、失败面板「换个引擎」、重解析默认值；
2. agent tool / HTTP API 需要能显式请求本地解析；
3. `resume()`、`cancel()`、`prepareRepair()` 都按 engine 分支，local 是平级第三种执行路径，而不是 cloud 参数；
4. 未来若加「本地 OCR」也是 provider 问题，引擎语义保持稳定。

**本地内部细分放在 `provider`，不进 engine 枚举**：

```ts
// meta.parse（增量字段）
{
  engine: 'local',
  provider: 'builtin' | 'system:pdftotext' | 'system:officeToPdf' | 'sidecar:<id>',
  local: {
    pageCount: number,
    textChars: number,
    extractMs: number,
    toolVersion?: string,       // 'pdftotext 26.10.0' / 'office-to-pdf 0.2.2'
    warnings: string[],         // 'scanned' | 'no-structure' | 'missing-fonts' | 'encrypted-skip' ...
  }
}
```

`config.local.provider = 'auto' | 'builtin' | 'system' | 'sidecar'`；`parse.start.options.localProvider?` 可单次覆盖（agent tool 同步扩展）。
`auto` 的 provider 选择顺序：**system（P1：`pdftotext` 对 PDF / `officeToPdf` 对 Office）→ builtin（P0 纯 Node）→ sidecar（P2，若配置）**。P0 阶段 auto 实际只会命中 builtin / system（若 P1 先落地）。

**不采用** `engine:'local-basic'|'local-tool'|'local-sidecar'`：
- 会让 `ENGINES`、UI、`resume()`、agent tool schema、`meta.parse.engine` 的取值爆炸；
- 同一文档的本地解析结果形态完全一致，不值得按来源拆引擎；
- provider 是「怎么做到」而非「是什么」，更适合配置/状态展示。

### 2.2 无 Token 时 auto 的默认策略（关键）

现状：`auto` 无 Token → `agent`（`lib/mineru.js:722`）。但 agent 是「免 Token 的 MinerU 云端轻量 API」，**仍会上传原文件**（`docs/ARCH.md:272-279`）。对「无 Token / 离线 / 隐私」用户，这恰好是想要避免的。

**新默认（建议）**：

```
auto = hasToken ? 'standard'
     : (local.available(file) ? 'local'
     : (prefs.autoAllowAgentFallback && agent.available(file) ? 'agent' : 报错/引导))
```

- 对 PDF：无 Token 时默认走本地，**不上传**。
- 对本地不支持的输入（图片 OCR、扫描件、Office 且 officeToPdf 不可用）：`auto` 在 `preferences.autoAllowAgentFallback !== false`（默认 true，保持一致体验）时回落 agent；UI 必须在解析面板明示「将使用轻量云端解析（文件会上传）」。
- 隐私用户可把偏好设为 `autoAllowAgentFallback:false`（新增偏好，默认 true），或在设置里把 `defaultEngine` 设为 `local`，此时自动策略只会在 supported 范围内选择，否则早失败并引导。
- 有 Token 时 `auto` 保持 standard（不改变付费用户行为）。

**用户可见文案建议**（zh / en，完整 i18n key 见 §5.4）：
- 自动：`自动（有 Token 用精准解析，否则优先本地）` / `Auto (precise with a token, local first otherwise)`
- 本地：`本地解析（离线 · 不上传）` / `Local (offline, no upload)`
- 轻量：`轻量云端解析（免 Token · 会上传文件）` / `Lightweight cloud (no token, uploads the file)`
- 面板提示：`本地解析只提取文字层，保留段落与页码；公式、表格、图片与扫描件需要云端精准解析。文件不会上传。`

### 2.3 能力矩阵（planning 用）

| 输入 | local builtin (P0) | local system (P1) | local sidecar (P2) | 说明 |
|---|---|---|---|---|
| `.pdf` 文字层 | ✅（vendored pdfjs-dist，P0） | ✅ `pdftotext`（raw，仅 builtin 失败时兜底；`-layout` 双栏交错不用于阅读顺序） | ✅（marker/docling 等） | 扫描件→`local-empty-text` |
| `.pdf` 扫描件 | ❌ | ❌（无 OCR） | ✅（带 OCR 的侧车） | 引导云端/OCR |
| `.docx/.pptx/.xls/.doc/...` | ❌ `local-unsupported` | ✅ `officeToPdf.convert()` → PDF → 文字层 | ✅ | 见 §4.7 |
| 图片 `.png/.jpg/...` | ❌（需 OCR/版面） | ❌ | ✅ | 引导云端 agent/standard |
| `.html/.htm` | ❌（P0，避免解析歧义） | 可选 P1（去标签文本） | ✅ | 引导云端 |

**本地 capabilities 暴露**：`status.local.capabilities = { textLayerPdf: true, office: bool, images: bool, html: bool }`，供 UI 决定 option 是否禁用、`auto` 是否回落。

---

## 3. 产物契约（本地解析的 schema 与最小需求集）

### 3.1 新产物布局（与现状同构，数据目录不迁移）

```
<dataDir>/documents/<docId>/
  source.pdf                       # 原文件，始终保留
  parsed/
    full.md                        # 本地合成 markdown（唯一必需产物）
    content_list.json              # 本地合成（强烈建议写；纯数组，与 MinerU standard 同格式）
    # images/**                    # P0/P1 无；P2 侧车若产出图片可复用 asset 路由（lib/routes.js:226-256）
  annotations.json / translations.json   # 不动
```

`meta.parse` 增量字段（写入后旧代码会忽略；`listDocuments` 会按白名单裁剪，`lib/service.js:470-483`）：

```jsonc
"parse": {
  "engine": "local",
  "provider": "builtin",            // 见 §2.1；builtin = vendored pdfjs-dist 适配层
  "modelVersion": null,             // local 无模型
  "language": "ch",                 // 仅用于翻译/展示，不影响提取
  "options": { "isOcr": false, "enableFormula": false, "enableTable": false, "pageRanges": "" },
  "phase": null, "taskId": null, "batchId": null,
  "startedAt": "…", "finishedAt": "…",
  "pages": 15,
  "progress": { "extracted": 15, "total": 15 },
  "hasContentList": true,
  "local": { "pageCount": 15, "textChars": 39141, "extractMs": 120,
             "toolVersion": "pdfjs-dist/5.4.449", "warnings": ["no-structure"] }
}
```

**不新增必需文件、不改 `meta.schemaVersion`、不迁移目录**：本地产物与云端产物同构 → 阅读台、导出、翻译、高亮、批注全部复用；卸载/回退只需重新解析。`parse.local` 只做诊断与 UI 提示，删除也无影响。

### 3.2 `full.md` 生成规则（`lib/local-synth.js`，纯函数、可 Node 直测）

提取器（builtin/system/sidecar）统一输出 **页面块**，合成器统一转 markdown：

```ts
type PageBlock =
  | { kind: 'title' | 'heading'; level?: 1|2|3; text: string }
  | { kind: 'paragraph' | 'caption' | 'formula' | 'list-item'; text: string }

synthLocalDocument({ pages: PageBlock[][], title?: string, options }): {
  markdown: string,
  contentList: ContentListEntry[],
  pageCount: number,
  textChars: number,
  warnings: string[],            // 'scanned' | 'no-structure' | 'low-text-pages' | 'split-long-paragraph'
}
```

规则（P0）：

1. **页面分隔**：源 PDF 的 `\f`（pdftotext）/ 页对象（builtin）→ `pages[]`；markdown 内**不插入任何页码标记**（spike §6.H 证明 HTML 注释不是页标记机制，且会变成正文段落）。
2. **去噪**：删空行、纯页码行（`^\s*\d{1,3}\s*$`）、每页重复的 running header/footer（同一行在 ≥60% 页面出现即删；P1）、arXiv 页脚噪声（P1 可选启发式）。spike 中 arXiv 首页页脚就是靠噪声表去掉的。
3. **标题**：第一页第一个「短、无句末标点、Title Case 或 CJK」行 → `#`；否则用文件名 stem（与 `lib/parse-manager.js:92-101` 的默认标题一致）。
4. **章节标题**：`^(\d{1,2}(\.\d{1,2}){0,3})[ \t]+[A-Z]…` 且 ≤ 12 词、无句末标点 → `##`；`Abstract/Introduction/Conclusion/References/Acknowledg…` 白名单 → `##`；层级由编号深度决定（1→`##`，1.1→`###`，但阅读台 outline 只依赖 `#` 层级，深度偏差不影响功能）。spike 用这组规则从 15 页识别出 25 个 heading（`#`+24 个 `##`），大纲完整（§6.C）。
5. **段落**：连续行合并（行尾 `-` + 下一行小写 → 去连字符）；空白归一；**段落长度上限 4000 字符**（按句末 `[.!?。！？]` 切分），硬上限 8000；过短（<40 字符）混入相邻段。理由：翻译走 per-block 调 `lib/service.js:37` 的 20000 字符上限、以及 UI 每段一次请求（`ui/app.js:3573`）。
6. **结构损失声明**：文字层提取无法还原公式（LaTeX）/表格结构/图片/图注位置。表格行按普通段落输出；`warnings` 记 `no-structure`，UI banner 展示（§5.2）。公式字符保留为 Unicode 文本（可被翻译服务处理）。
7. **列表**：P0 不重建列表（按段落输出）；P1 可按行首 `^\s*([-•*]|\(?\d+[.)])\s+` 合并为 `- ` / `1. `（`ui/markdown.js` 已支持 list block，收益有限，优先级低）。
8. **页码数量**：`pageCount = pages.length`；`meta.parse.pages = pageCount`。

### 3.3 `content_list.json` 合成规则（推荐的 schema 与最小需求集）

**写纯数组**（与 MinerU standard 的 `*_content_list.json` 同格式，`lib/store.js:586-598` 与 `lib/parse-manager.js:576-589` 都兼容），**不要**包 `{content_list:[…]}` 外壳（虽然兼容，但纯数组对 `page-merge`/外部工具更通用）。

```jsonc
[
  { "type": "text", "text": "Attention Is All You Need", "text_level": 1, "page_idx": 0 },
  { "type": "text", "text": "Ashish Vaswani∗ Noam Shazeer∗ …", "text_level": 0, "page_idx": 0 },
  …
]
```

| 字段 | 必需 | 消费方 | 说明 |
|---|---|---|---|
| `page_idx` | **必须**（0 基整数，单调不减） | `ui/markdown.js:1454`（页标记跳变）、`lib/store.js:555-566`（页数）、`ui/app.js:527`（可修复页）、`lib/page-merge.js:79`（页切分） | 页标记的**唯一**依据 |
| `type` | **必须**写 `"text"` | `ui/markdown.js:1356-1362`（`type==='text'` 时允许匹配任何 block kind） | 后续 P2 可扩展 `image/table/equation/list`（需配 `img_path`/`table_body` 等，且 markdown 必须真的有对应 block 才能匹配） |
| `text` | **必须**（与 markdown block 的 plain text 前缀一致） | `ui/markdown.js:1311-1324,1365-1413` 文本前缀匹配；`lib/page-merge.js:52-71` | 写 block 的**纯文本前缀**即可匹配（规范化前缀最长 48 字符、最短 12 字符；建议写整段纯文本，截断不影响前缀匹配）；**必须**是 markdown 对应 block 的纯文本（不要带 `#`/`**`），否则匹配失败→页标记降级；段落合成上限 4,000 字符（硬 8,000） |
| `text_level` | 可选 | 目前匹配逻辑不读；首页标题/章节写 1 便于未来语义消费 | 可省 |
| `img_path` / `image_caption` | 无图片时省略 | `ui/markdown.js:1369-1380` 只在 `type:'image'` 时消费 | P0 不要输出 `type:'image'` 空条目（匹配失败会 fallback 到下一块，徒增噪声） |

**最小需求集 = `{page_idx:int, type:'text', text:string}`**；`text_level` 可选。只要这三个字段与 markdown block 一一对应，`appendPageMarks` 就能精确对齐（spike §6.D：15 页 15 个页标记、插入位置与预期逐页一致、原 block key 零漂移、重复调用幂等）。

**可选开关**：`config.local.keepContentList`（默认 `true`）。若关闭 → 只写 `full.md`，退化成 agent 形态：无页标记、`pages` 来自 `meta.parse.pages`、`hasContentList:false`。不建议默认关闭（页标记是本地解析相对云端唯一还能保住的版式信息，成本极低）。

### 3.4 缺失 `content_list.json` / `pages=null` 时的现有行为（已读码确认）

| 场景 | 行为 | 依据 |
|---|---|---|
| `contentList = null` | `appendPageMarks(model, null)` 直接返回原 model，无 page block | `ui/markdown.js:1439` |
| `showPageMarks=false` | 完全不调 `appendPageMarks` | `ui/app.js:946` |
| `document.markdown` | 返回 `{markdown, contentList:null, pages:null}`，不报错 | `lib/store.js:568-606` |
| `pages` 回退 | `pagesOf(contentList) ?? meta.parse.pages`（本地解析会写 `meta.parse.pages`） | `lib/store.js:605` |
| 状态栏页数 | `doc.parse.pages \|\| reader.pages` | `ui/app.js:2110` |
| 按页修复 | `token-missing`（无 Token）或 `repair-unavailable`（无 content_list）**拒绝**，不会降级自动整篇 | `lib/parse-manager.js:219-261` |
| `repair` 入口 UI | `problemPages.length===0` 时重解析弹窗不显示「只修复问题页」开关 | `ui/app.js:2645`、`ui/app.js:524-547` |
| 解析失败展示 | `meta.error` 字符串直出 `MruFailPanel` | `lib/parse-manager.js:761-767`、`ui/app.js:1806-1826` |

**对本地引擎的含义**：P0 默认写 content_list ⇒ 页标记、页数、`mruProblemPages`（U+FFFD 检测，文字层通常没有 U+FFFD，所以修复入口基本不出现）都能工作。只有「按页修复」语义不适用：**本地解析的文档应禁止按页修复**（见 §4.5），UI 引导整篇重解析或在配置 Token 后整篇用云端解析。

### 3.5 高亮锚点是否稳定

- block key 只由 `index` + `plainText` 的 fnv1a 决定（`ui/markdown.js:51-63,703`），与 `page` block 无关；`appendPageMarks` 明确保证原 block 的 `index/key/plainText` 不变（`ui/markdown.js:1424-1431`；`test/reader/pagemarks.test.mjs:47-80`）。
- 本地提取对**同一文件、同一工具版本**是确定性的（spike §6.A：同一 PDF 两次 pdftotext 输出逐字节相同；§6.E：两次 `parseMarkdown` key 完全相同）。所以「本地重解析同一文件」不会丢高亮。
- 跨引擎（local→standard/agent 或升级提取器）重解析：block 切分变化 → 旧 key 失配 → 现有 `margin.dropped` 提示收起（`ui/app.js:162`），不报错、不丢数据文件。这是既有行为，不需要为 local 改。
- 建议：本地 `content_list` 的 `text` 必须与 markdown block plain text 同源（由同一个 `Block` 对象生成），防止「页标记匹配错位→不影响 key 但页标记漂移」。

### 3.6 翻译分块是否受影响

- 「翻译全文」= 过滤 `mruIsTextBlock(block) && plainText.trim()!==''`（`ui/app.js:972-978,3573`），按 block 逐段 POST `translate`，并发 4（`ui/app.js:79,3573`）。
- 单次翻译上限 20000 字符（`lib/service.js:37`）；翻译缓存按 block key 持久化（`translations.json`）。
- 本地 markdown 的 block 是 heading/paragraph，完全在现有模型内；spike 实测本地产物 62 个可翻译 block、最长 3208 字符、总计 39141 字符（§6.G），无超限。**唯一防线**是合成器对段落做长度上限（§3.2 规则 5），否则大段落可能 >20000 → `too-large` 失败。
- 翻译质量：文字层里的公式是 Unicode 字符、表格是行文本，翻译服务可处理但语义可能走样；banner 已提示结构损失。

---

## 4. Host 侧设计

### 4.1 模块边界与文件清单

```
lib/
  local-synth.js     (新, 纯函数)  页面块 → full.md + content_list + warnings/统计
  local-pdf.js       (新, P0)      vendored pdfjs 适配层：懒 import、显式 workerSrc、getTextContent→PageBlock、错误/上限映射（§4.2）
  local-tools.js     (新, P1)      系统工具探测：pdftotext/pdfinfo 版本、spawn 包装、officeToPdf 适配
  local-engine.js    (新, facade)  provider 选择、能力探测缓存、参数校验、extract() 编排、错误码映射
  config.js          (改)          ENGINES + local 配置项 + 偏好 defaultEngine/autoAllowAgentFallback
  mineru.js          (改)          normalizeParseOptions 认 local / auto→local 优先级 / local params
  parse-manager.js   (改)          executeTask 分叉、applyLocalResult、resume 处理、repair 守卫
  service.js         (改)          startParse 本地前置校验、status/settings 暴露 local 能力、toolList engine
  agent-tool.js      (改)          parse.engine enum + localProvider + 描述
  index.js           (改)          createLocalEngine({ officeToPdf: ctx.get('officeToPdf') }) 注入
vendor/
  pdfjs/             (新, P0)      pdf.mjs + pdf.worker.mjs + LICENSE（pdfjs-dist@5.4.449 legacy min，≈1.53MB，Apache-2.0）
package.json         (改)          engines.node >=20.16（Files 清单已含 `vendor/**`，无需再加 vendor 专项）
ui/
  app.js             (改)          引擎 option、可用性/推荐、质量 banner、设置面板本地段、i18n、状态栏、错误映射
  （styles.css 可选：banner/可用性 tag 样式）
lib/client.js        (重建)        node scripts/build-client.mjs
docs/                (改)          ARCH/HOST-INTERFACES/README
```

依赖方向（遵守 `docs/HOST-INTERFACES.md:1-6`）：`wire/config` ← `local-synth`/`local-pdf` ← `local-tools` ← `local-engine` ← `parse-manager` ← `service` ← `routes/agent-tool`；`local-engine` **不** import `mineru.js`（避免云/本地耦合），错误用 `WireError`（`lib/wire.js`）。`local-pdf` 通过 `await import('../vendor/pdfjs/pdf.mjs')` 懒加载第三方代码，其余模块不感知 vendor。

### 4.2 `lib/local-engine.js` 接口草案

```js
/**
 * @typedef {object} LocalCapability
 * @property {'builtin'|'system'|'sidecar'} kind
 * @property {string} id            // 'builtin' | 'system:pdftotext' | 'system:officeToPdf' | 'sidecar:marker'
 * @property {boolean} available
 * @property {string=} version
 * @property {string=} reason       // 不可用原因（展示用，i18n 由 client 决定）
 * @property {{textLayerPdf:boolean, office:boolean, images:boolean, html:boolean}} capabilities
 */

/**
 * @typedef {object} LocalExtractResult
 * @property {string} markdown
 * @property {object[]} contentList          // 见 §3.3；[] 表示不写 content_list
 * @property {number} pages
 * @property {string} provider
 * @property {string[]} warnings
 * @property {{textChars:number, extractMs:number, toolVersion?:string}} stats
 */

export function createLocalEngine({ config, logger, officeToPdf, spawnImpl, now } = {})
  // 同步：基于 config 的静态能力（不探测），启动时可调用
  .capabilities(): { enabled, pdf: boolean, office: boolean, images: boolean, html: boolean,
                     providers: LocalCapability[], recommended: string|null }
  // 异步：探测系统工具（缓存 TTL 60s；refresh 强制）
  .detect({ refresh = false } = {}): Promise<LocalCapability[]>
  // 校验 parse options 并给出执行计划；同步、纯函数
  // 抛 WireError: local-unsupported | local-missing-tool | too-large | bad-request
  .plan(meta, options): { provider: string, params: { fileName, pageRanges, language } }
  // 执行（P0: builtin；P1: system; P2: sidecar），内部统一产出 LocalExtractResult
  // opts: { id, meta, sourcePath, params, signal, onProgress({extracted,total}) }
  .extract(opts): Promise<LocalExtractResult>
  // 探测结果快照（status/settings 用），不触发 IO
  .snapshot(): { enabled, providers, capabilities }
```

**provider 编排（auto）**：

1. `.pdf`：`builtin`（pdfjs，默认）→ `system:pdftotext`（仅 builtin 不可用/失败时兜底，raw 模式）→ `sidecar`（若配置）→ 否则 `local-missing-tool`；
2. `.doc/.docx/.ppt/.pptx/.xls/.xlsx`：`officeToPdf`（若 `ctx.get('officeToPdf') && convert`）→ 得到 PDF bytes → 用 PDF 提取链；否则 `local-missing-tool`（报「Office 本地解析需要 office-to-pdf 服务；可用云端解析替代」）；
3. 图片/`.html`：`sidecar`（若配置且声明支持）→ 否则 `local-unsupported`。

**P0 PDF 提取 = vendored pdfjs-dist 适配层（`lib/local-pdf.js`），不手写解析器**（Lead 定稿）：

- **vendor**：`pdfjs-dist@5.4.449` legacy **min** 构建 → `vendor/pdfjs/pdf.mjs` + `pdf.worker.mjs` + `LICENSE`（≈1.53MB，Apache-2.0，保留 LICENSE）。**只 vendor min 构建**：非 min 构建仅 `import` 就 +335MB 峰值 RSS。
- **懒加载**：`const pdfjs = await import(new URL('../vendor/pdfjs/pdf.mjs', import.meta.url).href)` 放在首次 local 解析；插件启动不付体积/内存成本。
- **worker**：Node 下必须显式 `pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href`（或把 min 文件直接改名为 `pdf.mjs`/`pdf.worker.mjs`，让默认解析命中）。
- **取文本**：`getDocument({ data })` → 逐页 `page.getTextContent()`（items `{str, transform, width, height, fontName}`）→ 按 `transform[5]`（y）分组成行、按 `transform[4]`（x）排序 → 行/段落启发式 → `PageBlock[][]` 交给 `lib/local-synth.js`（§3.2）。
- **标题**：优先 `doc.getOutline()`（带层级，质量最好）；无大纲时回退字号（`height`）+ 编号正则（§3.2 规则 4）。
- **错误映射**：`PasswordException` → `local-encrypted`（owner-only 权限类 `UnknownErrorException` 同归此类）；`InvalidPDFException`（损坏/非法 PDF）→ `local-failed`；`MissingPDFException`/ENOENT → `local-failed`；其余 → `local-failed`（message 脱敏、不含内容）。
- **上限**：`local.maxPages`（默认 500）、输入 `local.maxPdfBytes`（默认 `min(maxUploadBytes, 200MB)`）、输出 `local.maxTextBytes`（默认 32MiB）、`localTimeoutMs`（默认 120s）；每页检查 `signal`，取消/失败也必须 `loadingTask.destroy()`（finally）。
- **内存**：实测峰值 RSS Attention 15p 129MB / ACL 17p 112MB / 中文维基 42p 196MB → 配合 `local.maxConcurrent`（默认 2）与 `maxConcurrentParses` 限流。
- **cmaps 可选**：pdfjs `cmaps/`（+1.7MB）对中文样本实测**非必需**（中文维基 42p 文本正常）；默认不 vendor，团队测试集出现 CID 缺字再补。
- **实测基线（node-extract 交叉验证）**：Attention 15p 38,804 chars / 33,486 可见字符 / 337ms / RSS 129MB；ACL 17p 70,504 chars / 60,859 可见 / 320ms / RSS 112MB；中文维基 42p 94,011 chars / 88,933 可见 / 1.18s / RSS 196MB；**可见字符**与 pdftotext **raw** 基线差 **0.02%–0.42%**（+0.05% / +0.42% / +0.02%；勿用 `-layout` 作基线，双栏会交错；pdfjs 的 chars 含空白，不能直接相减）。扫描件仍为 0 文本 → `local-empty-text`。
- **Node 版本**：`pdfjs-dist@5.4.449` 要求 Node >= 20.16（建议 `package.json engines.node = ">=20.16"`；DSH 本体实际要求 >=24.9）；若必须支持 >=20.11，改用 `pdfjs-dist@4.10.38`（≈1.74MB，node-extract 实测结果一致）。
- **页码**：pdfjs 的页号只用于合成 `content_list.page_idx`（§3.3）；**不**在 markdown 中插页码标记（spike §6.H 已证伪 HTML 注释方案）。

**失败处理**：适配层不可用/失败时明确 `local-missing-tool` / `local-failed` / `local-encrypted` / `local-empty-text`，不得静默产出空文档。

### 4.3 `parse-manager` 接入点（唯一分叉点）

```js
export function createParseManager({ store, config, logger, getToken, fetchImpl, localEngine } = {})
```

`executeTask()`（`lib/parse-manager.js:356-404`）在 standard 分支之前插入：

```js
if (task.engine === 'local') {
  const meta = store.get(task.id)
  await persistPhase(task, { phase: 'extracting' })          // 复用 phase 字段：'extracting' 表示本地抽取
  const result = await localEngine.extract({
    id: task.id, meta, sourcePath,
    params: task.params,
    signal: task.controller.signal,
    onProgress: (p) => persistProgress(task, p),               // 页级进度，节流 2s（复用 lib/parse-manager.js:196-217）
  })
  checkAborted(task)
  const files = [{ rel: 'full.md', data: Buffer.from(result.markdown, 'utf8') }]
  if (result.contentList.length > 0) {
    files.push({ rel: 'content_list.json', data: Buffer.from(JSON.stringify(result.contentList, null, 2), 'utf8') })
  }
  await writeStagedParsed(task.id, files)                      // 复用原子 staging（lib/parse-manager.js:519-537）
  await finishSuccess(task, {
    hasContentList: result.contentList.length > 0,
    pages: result.pages,
    title: firstHeading(result.markdown),
    progress: { extracted: result.pages, total: result.pages },
    local: { provider: result.provider, ...result.stats, warnings: result.warnings },
  })
  return
}
```

其他改动点：

| 位置 | 改动 | 说明 |
|---|---|---|
| `lib/parse-manager.js:160` | 工厂参数加 `localEngine` | 可选；未注入时任何 local 请求立刻 `local-missing-tool` |
| `:277-295` `createTask` | 不变 | `task.engine` 已通用 |
| `:817-824` `start()` | 接受 `{engine:'local', params}` 内部形态 | 与 standard/agent 平级 |
| `:837-855` `parseState` | `modelVersion:null`；`hasContentList:false`；`engine:'local'` | 完成后由 `finishSuccess` 覆盖 |
| `:660-714` `finishSuccess` | 增加 `local` 字段写入 `parse.local`（provider/stats/warnings）；成功时 `provider` 写入 `parse.provider` | store 的 `update` 深合并 `parse`（`docs/HOST-INTERFACES.md:70`） |
| `:717-771` `finishFailure` | 不变（`describeMineruError` 对 `WireError` 直接取 message，`lib/mineru.js:814`） | 取消仍回 `status:'uploaded'` |
| `:933-985` `resume()` | local 任务**不可恢复**：进入既有「非 polling → failed」分支；显式跳过 local 的 engine 判定（当前 `:939` 只认 standard/agent，local 自然落入 failed） | 建议消息加「本地解析被中断，请重试」，不涉及数据损坏（staging 未完成不会替换 parsed） |
| `:219-261` `prepareRepair` | 增加本地守卫：`meta.parse.engine === 'local'` → `WireError('repair-unavailable', '本地解析不支持按页修复；请整篇重新解析，或配置 Token 后整篇用云端解析', 409)`，**放在 token 检查之后/之前均可，但消息必须区分** | P0 禁用；P1 评估「本地 CL + 云端 pageRanges 修复」（页面切分匹配见 `lib/page-merge.js:110-150`，spike 的合成 CL 前缀匹配可行，但需集成测试） |
| `:869-924` `cancel()` | 不变 | `AbortController` 贯穿 builtin/system/officeToPdf（`convert(req, signal)`） |
| `:1012-1015` timeout | 新增 `localTimeoutMs` 的 `timeoutError` 等价物（复用 `MineruError('timeout', …)` 或 `WireError`），在 `localEngine.extract` 外层 `Promise.race` + signal | 避免 system 子进程/office wasm 卡死 |

**并发/资源**：本地任务与云端任务共用 `maxConcurrentParses`（`lib/parse-manager.js:170,298-341`）。建议 P1 增加 `config.local.maxConcurrent`（默认 2）与 worker 化（builtin 的 zip inflate 是同步 CPU，必要时用 `node:worker_threads`，仍零依赖）；P0 用 `maxPages`/`maxTextBytes`/时间上限兜底。

### 4.4 取消 / 超时 / 错误码

| 错误码（`WireError`） | HTTP | 触发 | 用户文案（zh / en） |
|---|---|---|---|
| `local-unsupported` | 415/422 | 图片、html（无侧车）、加密 PDF、本地能力全不可用但用户显式选 local | `本地解析不支持这种文件；可用轻量云端解析或配置 Token。` / `Local parsing does not support this file; use lightweight cloud parsing or configure a token.` |
| `local-missing-tool` | 503 | 选了 `system`/`sidecar` 但工具不存在；Office 但 `officeToPdf` 服务缺失；profile 无本地能力 | `本地解析工具不可用；请检查系统工具或改用云端解析。` / `The local parsing tool is unavailable; check system tools or use cloud parsing.` |
| `local-empty-text` | 422 | 提取文字过少（`textChars < max(200, minCharsPerPage*pageCount)`，默认 30 字/页） | `没有从文件中提取到文字（可能是扫描件）；请用云端解析或配置 OCR。` / `No text extracted (the file may be scanned); use cloud parsing or configure OCR.` |
| `local-encrypted` | 422 | PDF 加密 | `文件已加密，无法本地解析。` / `The file is encrypted and cannot be parsed locally.` |
| `local-failed` | 500 | 提取器崩溃/输出畸形（非上述分类） | `本地解析失败：{message}` / `Local parsing failed: {message}` |
| `too-large` / `timeout` / `bad-request` | 既有 | 复用 `lib/mineru.js:753,1012-1015` 语义 | 同现有 |

- 预检（同步、`service.startParse` 内）抛 `local-*`，让任务**不会已启动后异步失败**；运行期失败走 `finishFailure` → `meta.error` → `MruFailPanel`（`ui/app.js:1806-1826`），`describeMineruError` 对 `WireError` 返回 message（`lib/mineru.js:814`）。
- Client `mruErrorText` 增加新 code → i18n（`ui/app.js:680-700`）。

### 4.5 系统工具 / 侧车探测（安全约束）

```js
// lib/local-tools.js
export function createToolProbe({ spawnImpl = spawn, logger } = {})
  .detectPdfTools({ timeoutMs = 3000 }): Promise<{ available: boolean, pdftotext?: {path,version}, pdfinfo?: {path,version} }>
  .runPdftotext({ sourcePath, pageRanges, signal, timeoutMs, maxBytes }): Promise<{ text: string, stderr: string }>
```

安全规则（全部必须）：

1. `spawn(command, args, { shell: false, windowsHide: true, env: process.env, cwd: docDir })`，**禁止 `shell:true`**、禁止字符串拼接命令；
2. 命令名/路径来自 `config.local.pdftotextPath`（管理员配置）或固定候选 `pdftotext`；文件路径只来自 `store.sourcePath(docId)`（UUID 校验，`lib/wire.js requireUuid`），**绝不接受 client 传路径**；
3. 探测：`spawn('pdftotext', ['-v'])` 读 stderr 版本（poppler 把版本写 stderr），3s 超时，ENOENT ⇒ 不可用；结果缓存 60s + `local.detect` 强制刷新；
4. 输出上限：stdout `maxTextBytes`（默认 32 MiB）、stderr 256 KiB；超限 kill；
5. 超时/取消：`signal` → `child.kill('SIGKILL')`（先 SIGTERM 后 500ms SIGKILL）；整体 `localTimeoutMs` 默认 120s；
6. `pageRanges` 支持：转成 `-f/-l` 或 `-f N -l M` 多次调用（`local.maxPages` 内）；解析复用现有 `normalizePageRanges` 语法（`lib/mineru.js:648-672`）但页数上限用 local 自己的；
7. 子进程输出按 UTF-8 解码；非法字节保留（`-enc UTF-8`）；日志只记命令名/版本/耗时/大小，不记文件内容。

**侧车（P2）**：`config.local.sidecar = { id, command, args: ['{input}','{output}'], versionArgs, timeoutMs, capabilities }`；command 仅来自配置（运维可信）；`{input}` 由 Host 替换为 `sourcePath`，`{output}` 替换为 staging 目录下文件名；禁止 client 控制；每次运行后校验输出目录（`resolveWithin`）与大小上限。

### 4.6 配置项与默认值（无 schema，手写校验）

```yaml
# cordis.patch.yml 的 config 增量（全部可选）
local:
  enabled: true                 # false → UI 隐藏 local，engine:'local' 报 local-missing-tool
  provider: auto                # auto | builtin | system | sidecar
  pdftotextPath: ''             # 空 = 在 PATH 找 pdftotext
  timeoutMs: 120000             # 单文档提取总超时
  maxPages: 500                 # 本地 PDF 最大页数
  maxPdfBytes: 209715200        # 本地 PDF 输入上限（≤ maxUploadBytes）
  maxTextBytes: 33554432        # 32 MiB 文本输出上限
  minCharsPerPage: 30           # 低于此值判定 scanned / local-empty-text
  maxParagraphChars: 4000       # 合成段落上限（硬上限 8000）
  keepContentList: true         # 是否合成 content_list.json（页标记依赖）
  maxConcurrent: 2              # P1；本地任务并发（与 maxConcurrentParses 取 min）
  sidecar:                      # P2
    id: ''
    command: ''
    args: []
    capabilities: []
```

校验（`lib/config.js:150-180` 风格）：`enabled` 必须 boolean；`provider` ∈ 枚举；`timeoutMs/maxPages/maxTextBytes/minCharsPerPage/maxParagraphChars/maxConcurrent` 用 `integerOption` 夹取；`sidecar` 只接受对象且 `command` 为字符串（不允许来自客户端）。**偏好增量**（`lib/config.js:29-41` + `:321-322`）：`defaultEngine` 允许 `'local'`；新增 `autoAllowAgentFallback: true`（bool）、`localProvider: 'auto'`（枚举）。

### 4.7 Office 输入 → officeToPdf（P1，Lead 已核实 web profile 挂载）

**背景**：当前 web profile 已挂载 DSH 官方 `office-to-pdf` 服务（dsh-web-app bundle，id `office-to-pdf`，底层 `@deepseek-ai/libreoffice-kit`/wasm，本地运行、无需用户安装 LibreOffice）。Host 通过 `ctx.get('officeToPdf')` 可选获取。类型（`@deepseek-ai/dsh-office-to-pdf@0.2.2-rc.1`）：

```ts
convert(
  { extension: 'doc'|'docx'|'xls'|'xlsx'|'ppt'|'pptx',
    priority: 'foreground'|'background',
    source: { key: OfficeSourceKey, version: string, bytes?: number,
              read(signal, maxBytes): Promise<{ bytes: Uint8Array, version: string }> } },
  signal?: AbortSignal,
): Promise<{ pdf: Uint8Array, missingFonts: string[], cacheKey: OfficeToPdfKey, generation: OfficeToPdfGeneration }>
```

**适配器草案（`lib/local-tools.js`）**：

```js
export async function officeToPdfBytes({ officeToPdf, meta, sourcePath, signal, logger }) {
  if (!officeToPdf || typeof officeToPdf.convert !== 'function') return null   // 无服务：调用方降级 local-missing-tool
  const version = String(meta.sha256 ?? meta.updatedAt ?? '')                 // 源版本：变了 provider 会拒绝
  const result = await officeToPdf.convert({
    extension: meta.ext.slice(1),                                             // '.docx' → 'docx'
    priority: 'foreground',
    source: {
      key: String(meta.id),                                                   // OfficeSourceKey 是 brand<string>，透传稳定 id
      version,
      bytes: meta.size,
      read: async (readSignal, maxBytes) => {
        const bytes = await readFileCapped(sourcePath, Math.min(maxBytes, Number(meta.size) || maxBytes))
        return { bytes, version }
      },
    },
  }, signal)
  return { pdf: Buffer.from(result.pdf), missingFonts: result.missingFonts }
}
```

要点：

- **不 import 该 npm 包**（保持零依赖约定），只用 `ctx.get` 的服务对象 + JSDoc 类型描述；`OfficeSourceKey` 运行时是字符串 brand，传稳定字符串即可（若 Host 校验 brand 由服务侧负责，集成测试验证）。
- `read()` 必须延迟到 admission 后（读本插件 `docDir` 里的 original bytes），不要提前缓冲；`version` 用 `meta.sha256`（`store.createFromFile` 已算，`docs/ARCH.md:127`），源文件被替换时 provider 会拒绝（`source-changed`）→ 我们重试一次或直接失败。
- 结果 PDF bytes 直接交给 PDF 提取链（system/builtin），**不落盘**（或落 staging 临时文件后删除，避免数据目录出现重复 PDF；推荐内存传递，PDF 上限 `local.maxOfficePdfBytes` 默认 100 MiB）。
- `missingFonts.length > 0` → `warnings.push('missing-fonts')` + 质量 banner（字体替换可能导致文字层缺字/乱码）。
- 错误映射（`OfficeToPdfError.code`）：`input-too-large/output-too-large`→`too-large`；`invalid-document/unsupported-format/invalid-output`→`local-unsupported`；`timeout`→`timeout`；`unavailable/busy`→`local-missing-tool`（文案「Office 转换服务暂不可用，请稍后重试或改用云端解析」）；`failed`→`local-failed`；`source-changed`→`local-failed`（提示重新导入）。
- **可选服务缺失处理**：`ctx.get('officeToPdf')` 在非 web profile 可能为 undefined → capabilities.office=false → UI 把 Office 文件的 local 选项标注「不可用（需要 office-to-pdf 服务）」；`auto` 回落 agent（若允许）或早失败。
- **与「直接解析 OOXML」的取舍**：
  - officeToPdf 路线：复用官方已装载的本地转换（无新依赖、本地执行、保留页面/排版信息→文字提取质量更好），代价是可选服务依赖 + wasm 转换耗时/内存 + 字体缺失风险；
  - 自写 OOXML 文本子集（P2 回退）路线：复用现有 `lib/unzip.js`（已能解 ZIP/Deflate，MinerU 归档同款），只抽 `word/document.xml`、`ppt/slides/slideN.xml`、`xl/sharedStrings.xml` 的文本节点——node-extract 已跑 160 行原型：**docx 1002 字符/2ms、pptx 335 字符/3ms、xlsx 200 字符/3ms，0 新增体积**；缺点是无版面/表格/图注，只适合「能读到字」的兜底；
  - 结论：**P1 仍优先 officeToPdf**（版面/表格/图注更好、与 PDF 链统一）；P2 再把「OOXML 文本子集」作为 officeToPdf 服务缺失（非 web profile）时的本地回退（`local-missing-tool` → OOXML-lite → 仍失败才引导云端）。不引入 mammoth 等 npm 包。

### 4.8 HTTP API / agent tool / settings / status 增量

| API | 增量 |
|---|---|
| `parse.start` options | `engine` 增加 `'local'`；新增 `localProvider?: 'auto'\|'builtin'\|'system'\|'sidecar'`（可选）；`modelVersion/isOcr/enableFormula/enableTable` 对 local 忽略 |
| `parse.cancel` / `document.markdown` / 其他 | 不变 |
| `status`（`lib/service.js:429-462`） | 增 `local: { enabled, available, recommended, providers:[{id,available,version?,reason?}], capabilities:{textLayerPdf,office,images,html} }`；`configured` 增 `local` |
| `settings.get`（`lib/service.js:680-710`） | 增 `local` 能力快照 + `defaults.localProvider`；providers 数组含不可用项（UI 置灰/说明） |
| 新增 `local.detect`（P1，可选） | `{ refresh?:true }` → `{ local: … }`；权限同其他方法（fence 已在 `lib/routes.js:131-141`），仅触发探测，无参数 |
| `agent-tool parse`（`lib/agent-tool.js:70-107`） | `engine.enum` 加 `'local'`，描述改「local = 本机文本层解析，无需 Token、不上传」；加 `localProvider` |
| `toolList`（`lib/service.js:733-745`） | 已返回 `engine`，local 自动可见；`status` 渲染文案（`lib/agent-tool.js:210` 附近）加本地能力一句 |

### 4.9 `settings.get` / `status` 返回示例

```jsonc
{
  "tokenConfigured": false,
  "local": {
    "enabled": true,
    "available": true,
    "recommended": "system:pdftotext",
    "providers": [
      { "id": "builtin", "available": true, "version": "1" },
      { "id": "system:pdftotext", "available": true, "version": "26.10.0" },
      { "id": "system:officeToPdf", "available": true, "version": "0.2.2-rc.1" },
      { "id": "sidecar:marker", "available": false, "reason": "not-configured" }
    ],
    "capabilities": { "textLayerPdf": true, "office": true, "images": false, "html": false }
  }
}
```

### 4.10 数据目录兼容 & 回滚

- **不迁移**：无新目录/必需文件；本地解析产物落在既有 `parsed/`；`meta.parse.engine='local'` + 可选 `parse.local` 为增量字段。
- 回滚（关掉功能）：`config.local.enabled:false` → UI 隐藏 local、`engine:'auto'` 恢复 standard/agent 旧行为；已解析的 local 文档仍可读（`full.md`+`content_list.json` 是通用格式），重新解析即回云端。
- 云端覆盖本地/本地覆盖云端：`writeStagedParsed` 先写 staging 再 `rm(parsed)`+`rename`（`lib/parse-manager.js:519-537`），原子；高亮/翻译文件不动，key 失配走现有 dropped 机制。
- `parse.local` 清理：云端成功时 `finishSuccess` 的 patch 显式 `local: null`（`store.update` 合并覆盖），避免 UI 把云端结果误标本地。

---

## 5. Client 侧设计（`ui/app.js`，改后需重建 `lib/client.js`）

### 5.1 解析设置面板（`MruSetupPanel`，`ui/app.js:1652-1741`）

改动点：

1. **引擎下拉**（`:1696-1703`）：
   - 选项顺序：`auto`（默认）、`standard`、`local`、`agent`；
   - `local` 标签带能力/推荐标记：`本地解析（离线 · 不上传）`，不可用时 `disabled` + 文案「不可用」+ reason；
   - token 缺失时不再默认把用户推向 agent：`auto` 的说明改为「有 Token 用精准解析，否则优先本地」。
2. **`needsToken` 判定**（`:1661`）：local 不触发 token 警告；仅 `standard`（或 auto 且 token 缺失且 local 不可用/文件类型本地不支持和回调 agent）时提示。提示文案改两行：主文案「配置 Token 可解锁 MinerU 精准解析（公式/表格/OCR）」，副文案「本地解析无需 Token，文件不会上传」，按钮仍是「去设置」。
3. **条件字段**：
   - `modelVersion`（`:1704-1713`）在 `agent` 与 `local` 下禁用；
   - 语言/公式/表格/OCR 开关对 local 隐藏或禁用（文字层提取不消费）；`pageRanges` 保留（builtin/system 支持页范围）；
   - 面板底部 `setup.note`（`:121`）按引擎切换文案（`setup.noteLocal`）。
4. **能力探测数据**：`status`/`settings.get` 的 `local` 字段随 `loadStatus`/`loadSettings` 一起返回；解析面板从 `status.local` 读可用性，无需新请求（P1 的 `local.detect` 只在设置面板手动刷新时调）。
5. **auto 将使用哪个引擎的提示**：面板内计算 `effectiveEngine = auto ? (tokenConfigured ? 'standard' : localAvailable ? 'local' : 'agent') : engine`，在「开始解析」旁显示小字「将使用：本地解析 / 轻量云端解析（会上传）」；隐私用户至少有知情权。

### 5.2 本地解析质量提示 banner

位置：`MruPaper`/阅读区顶部（`ui/app.js:1790-1797` 的 `reader.phase==='ready'` 分支），或解析完成后的 main 区。触发条件：`doc.parse.engine === 'local' || doc.parse.local`。

内容（banner 可关闭，本会话内记住——不落 localStorage 以外的状态也可，现有 Client 允许极小 UI 标记，`docs/ARCH.md:483-484`）：
- 普通：`本文由本地解析生成：保留文字、段落与页码；公式、表格、图片未还原。` + 按钮「配置 Token 解锁精准解析」（打开设置）；
- `warnings` 含 `missing-fonts`：追加「字体替换可能导致个别字符缺失」；
- `warnings` 含 `scanned` / `local-empty-text` 失败面板：显示「可能是扫描件，建议云端解析」；
- 重解析入口：banner 内「重新解析」直接打开现有 `MruReparseModal`（`ui/app.js:2638-2690`）。

### 5.3 重解析 / 修复入口

- `MruReparseModal`：当 `doc.parse.engine==='local'` 时隐藏「只修复有问题的页面」开关（`:2645-2672`），显示 `reparse.localRepair` 提示；提交整篇时默认引擎可预选 local（用户也可改）。
- `MruFailPanel` 的「换个引擎」（`:1759-1766`、`:4377-4381`）：当前只 standard↔agent 轮换；改为在可用引擎集合中轮换/弹出选择（local → agent → standard），并把 `local-*` 错误码映射为具体引导。
- `onOtherEngine` / `mruDefaultParseOptions`（`:2704-2714`、`:4373-4381`）：`mruDefaultParseOptions` 保持不传 `localProvider`（用 host 默认）；重解析时以 `doc.parse.engine` 预选。

### 5.4 状态栏（`MruStatusbar`，`ui/app.js:2100-2135`）

- `:2106-2107` 按 engine 映射：`agent→statusbar.engineAgent`、`local→statusbar.engineLocal`、其余 `standard`；local 再显示 provider 短标签（如 `builtin`/`pdftotext`/`office`）；
- 页数/词数/翻译进度逻辑不变（`pages` 来自 `doc.parse.pages || reader.pages`）。

### 5.5 设置面板（`MruSettingsModal`，`ui/app.js:2452-2571`）

新增「本地解析」section（P1 起）：

```
本地解析
  内置文字层提取        可用 · v1
  系统 pdftotext        可用 · 26.10.0        [重新检测]
  Office 转换（office-to-pdf）  可用 · 0.2.2-rc.1
  说明：本地解析不上传文件；扫描件需云端或 OCR 侧车。
```

- 数据来源 `settings.local`（§4.9）；`[重新检测]` 调 `local.detect`（P1）；
- token section 文案改：`settings.tokenHint` → `本地解析无需 Token；配置 Token 可解锁 MinerU 精准解析（公式/表格/OCR）。`；未配置状态 `settings.tokenMissing` 旁增加「当前默认：本地解析」小字；
- 阅读偏好 section 可加「默认引擎」选择（当前 `defaultEngine` 只在首次解析使用，设置面板暴露更直观；可选 P0/P1）。

### 5.6 i18n 字典（`ui/app.js` ZH `:81-264` / EN `:266-449`）

新增 key 与建议文案（必须同时进两本字典；`ui/app.js:452-456` 的 `mruTranslate` 回退 ZH）：

| key | zh | en |
|---|---|---|
| `setup.engineAuto` | 自动（有 Token 用精准解析，否则优先本地） | Auto (precise with a token, local first otherwise) |
| `setup.engineLocal` | 本地解析（离线 · 不上传） | Local (offline, no upload) |
| `setup.engineLocalUnavailable` | 本地解析不可用 | Local parsing unavailable |
| `setup.engineAgent` | 轻量云端解析（免 Token · 会上传文件） | Lightweight cloud (no token, uploads the file) |
| `setup.noteLocal` | 本地解析只提取文字层，保留段落与页码；公式、表格、图片与扫描件需云端精准解析。文件不会上传。 | Local parsing extracts the text layer and keeps paragraphs and page marks; formulas, tables, figures and scanned pages need precise cloud parsing. The file is not uploaded. |
| `setup.effectiveLocal` | 将使用：本地解析 | Will use: local parsing |
| `setup.effectiveAgent` | 将使用：轻量云端解析（文件会上传） | Will use: lightweight cloud parsing (the file is uploaded) |
| `setup.effectiveStandard` | 将使用：MinerU 精准解析 | Will use: MinerU precise parsing |
| `setup.tokenWarnLocal` | 配置 Token 可解锁公式/表格/OCR 精准解析；本地解析无需 Token。 | A token unlocks precise formulas/tables/OCR; local parsing needs no token. |
| `settings.sectionLocal` | 本地解析 | Local parsing |
| `settings.localBuiltin` | 内置文字层提取 | Built-in text-layer extraction |
| `settings.localPdfTool` | 系统 pdftotext | System pdftotext |
| `settings.localOffice` | Office 转换（office-to-pdf） | Office conversion (office-to-pdf) |
| `settings.localRedetect` | 重新检测 | Re-detect |
| `settings.localAvailable` | 可用 | Available |
| `settings.localUnavailable` | 不可用 | Unavailable |
| `settings.localHint` | 本地解析不上传文件；扫描件需云端或 OCR 侧车。 | Local parsing does not upload files; scanned pages need cloud parsing or an OCR sidecar. |
| `settings.tokenHint`（改写） | 本地解析无需 Token；配置 Token 可解锁 MinerU 精准解析（公式/表格/OCR）。 | Local parsing needs no token; configure a token to unlock MinerU precise parsing (formulas/tables/OCR). |
| `banner.localTitle` | 本地解析结果 | Local parse result |
| `banner.localText` | 本文由本地解析生成：保留文字、段落与页码；公式、表格、图片未还原。 | Parsed locally: text, paragraphs and page marks are kept; formulas, tables and figures are not reconstructed. |
| `banner.missingFonts` | 个别字体缺失，文字可能有缺字。 | Some fonts were missing; a few characters may be absent. |
| `banner.scanned` | 几乎没有提取到文字，可能是扫描件。 | Little or no text was extracted; the file may be scanned. |
| `banner.upgrade` | 配置 Token 解锁精准解析 | Configure a token for precise parsing |
| `statusbar.engineLocal` | 本地解析 | Local |
| `err.localUnsupported` | 本地解析不支持这种文件；可用轻量云端解析或配置 Token。 | Local parsing does not support this file; use lightweight cloud parsing or configure a token. |
| `err.localMissingTool` | 本地解析工具不可用；请检查系统工具或改用云端解析。 | The local parsing tool is unavailable; check system tools or use cloud parsing. |
| `err.localEmptyText` | 没有从文件中提取到文字（可能是扫描件）；请用云端解析或配置 OCR。 | No text was extracted (the file may be scanned); use cloud parsing or configure OCR. |
| `err.localFailed` | 本地解析失败：{message} | Local parsing failed: {message} |
| `reparse.localRepair` | 本地解析不支持按页修复；可整篇重新解析，或配置 Token 后整篇用云端解析。 | Page repair is unavailable for local parses; reparse the whole document, or configure a token and reparse in the cloud. |
| `fail.localSuggestion` | 换用云端解析或配置 Token | Try cloud parsing or configure a token |

错误映射（`ui/app.js:680-700` 的 `mruErrorText`）新增分支：`local-unsupported→err.localUnsupported`、`local-missing-tool→err.localMissingTool`、`local-empty-text→err.localEmptyText`、`local-* / local-failed→err.localFailed`（带 `{message}`）。

---

## 6. 可行性 spike（真实 PDF：**产物契约验证**，`pdftotext` + 仓库阅读器纯函数）

> 完整产物与输出：`/home/nirvana/Documents/dsh-mineru/.agents/tmp-research/integration/{full.md,content_list.json,spike.mjs,spike-output.txt,paper.txt}`。
> 方法：`pdftotext -layout -enc UTF-8` 抽取 arXiv 1706.03762（15 页），用启发式合成本地 `full.md` + `content_list.json`，再用**仓库自己的** `test/reader/helpers.mjs`（与 `scripts/build-client.mjs` 相同的作用域方式加载 `ui/markdown.js`+`ui/highlight.js`）执行 `parseMarkdown` / `appendPageMarks` 验证。
> 定位：本 spike 是**产物契约验证**（合成器输出 → `ui/markdown.js` 消费），**不是** P0 提取器验证。P0 提取器已定稿为 vendored pdfjs-dist，性能/质量以 `docs/research/node-extract.md` 为准（Attention 15p 38,804 chars/33,486 可见字符/337ms/RSS 129MB；ACL 17p 70,504/60,859/320ms；中文维基 42p 94,011/88,933/1.18s；可见字符与 pdftotext raw 基线差 0.02%–0.42%）。下方用系统 `pdftotext` 只是为快速生成一段「类 MinerU 文本」来验证契约。

### A. 提取（`pdftotext -layout`）

```json
{"extractMs":120,"chars":59444,"deterministicBytes":true,"hasFormFeed":true}
```

### B. 合成产物

```json
{"pages":15,"blocks":62,"byPage":{"0":4,"1":6,"2":5,"3":5,"4":7,"5":5,"6":11,"7":6,"8":3,"9":5,"10":1,"11":1,"12":1,"13":1,"14":1},
 "mdChars":39339,"contentListEntries":62,
 "mdHead":"# Attention Is All You Need\n\nAshish Vaswani∗ Noam Shazeer∗ Niki Parmar∗ Jakob Uszkoreit∗ Google Brain Google Brain Google Research Google Research avaswani@goog"}
```

### C. `parseMarkdown(full.md)`：大纲可识别

```json
{"stats":{"blocks":62,"headings":25,"chars":39141,"words":6087},"outlineCount":25,
 "outline":["# Attention Is All You Need","## Abstract","## 1 Introduction","## 2 Background","## 3 Model Architecture",
            "## 3.1 Encoder and Decoder Stacks","## 3.2 Attention","## 3.2.1 Scaled Dot-Product Attention","## 3.2.2 Multi-Head Attention",
            "## 3.2.3 Applications of Attention in our Model","## 3.3 Position-wise Feed-Forward Networks","## 3.4 Embeddings and Softmax",
            "## 3.5 Positional Encoding","## 4 Why Self-Attention"]}
```

### D. 页码标记（合成 content_list 与 markdown 精确对齐）

```json
{"pageMarks":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],"aligned":true,"keysPreserved":true,"idempotent":true,
 "expectedFirstBlockPerPage":[0,4,10,15,20,27,32,43,49,52,57,58,59,60,61],
 "actualBefore":[0,4,10,15,20,27,32,43,49,52,57,58,59,60,61]}
```

（`aligned:true` = 每页页标记都落在该页第一个 block 之前；`keysPreserved:true` = 原 block 的 index/key/plainText 逐一对齐；`idempotent:true` = 重复调用不重复插页。）

### E. block key 稳定性

```json
{"totalBlocks":62,"unique":62,"formatOk":true,"sameKeysOnReparse":true,"sameKeysWithPageMarks":true,
 "sample":["b0:f38605ad","b1:3265763a","b2:6b230e93"]}
```

### F. `contentList=null` / `[]` 降级

```json
{"nullReturnsSameModel":true,"emptyReturnsSameModel":true,"pageBlocksWhenNoList":0,
 "pagesFromSynthList":15,"pagesFromNullList":null}
```

→ 与 §3.4 读码结论一致：无 content_list 时无页标记、页数只能靠 `meta.parse.pages`；本地引擎应默认写 content_list。

### G. 翻译分块

```json
{"translatableBlocks":62,"totalChars":39141,"maxBlockChars":3208,"p95BlockChars":1904,
 "medianBlockChars":391,"blocksOver20kLimit":[],"perBlockCalls":62,"callsIfSplitAt1500":74}
```

→ 现有 per-block「翻译全文」（`ui/app.js:3573`）可直接用；**最长 3208 < 20000 上限**。注意这是 15 页论文；更密的 PDF 需要合成器 4000/8000 字符段落上限兜底。

### H. `<!-- page: N -->` 不是页码标记机制（重要）

```json
{"blocks":[{"kind":"paragraph","text":"Alpha paragraph."},
           {"kind":"paragraph","text":"<!-- page: 2 -->"},
           {"kind":"paragraph","text":"Beta paragraph."}],
 "pageBlocks":0}
```

→ `parseMarkdown` 把 HTML 注释当普通段落，`appendPageMarks` 只认 content_list 的 `page_idx`。**本地引擎必须合成 content_list.json，不能往 markdown 里插页码标记**。

### I. 空/退化提取

```json
{"emptyBlocks":0,"whitespaceBlocks":0,"emptyStats":{"blocks":0,"headings":0,"chars":0,"words":0}}
```

→ 扫描件/乱码 PDF 会产出空 markdown；Host 必须在写盘前判定 `local-empty-text`（否则用户在阅读台只看到空状态 `reader.emptyDoc`，`ui/app.js:151`）。

### J. `document.markdown` 响应与质量启发式

```json
{"responseShape":{"markdownChars":39339,"contentList":"object[]","pages":15},
 "quality":{"headings":24,"paragraphs":37,"shortParagraphs":0,"missingGlyphEntries":0,"avgParaChars":1043}}
```

### Spike 结论

1. **产物契约成立**：本地合成的 `full.md` 与 `content_list.json` 能被现有阅读器完整消费——大纲、页码标记、block key、翻译分块全部可用，无需改 `ui/markdown.js`/`ui/highlight.js`。
2. **页码标记必须靠 content_list**，markdown 注释无效（H）。
3. **确定性**：同一 PDF 两次提取逐字节一致（A），同一 markdown 重复解析 key 一致（E）→ 本地重解析不会丢高亮。
4. **风险点**：提取质量（公式/表格/图片丢失、扫描件空文本、双栏顺序、字体缺失）是产品级风险，不是契约风险；用 warnings + banner + `local-empty-text` + 「配置 Token 解锁精准解析」引导覆盖。
5. **spike 局限**：本 spike 只验证产物层（合成器/阅读台消费）；提取器质量/性能以 `docs/research/node-extract.md` 的 pdfjs 实测为准。P0 仍需为 pdfjs 适配层补 PDF 样本回归（加密、损坏、扫描件、中文/多字体、确定性）。

---

## 7. 分阶段实现计划

### P0 — 内置基础本地 PDF 文字层解析 + 引擎选择 + 基础测试

**目标**：无 Token profile 导入 PDF → `auto` 默认本地解析 → 阅读台有正文/大纲/页码范围 → 全流程不触网。

**文件清单**：

| 文件 | 改动 |
|---|---|
| `lib/local-synth.js`（新） | 页面块 → `full.md` + `content_list` + warnings；段落上限/去噪/标题启发式；纯函数 |
| `lib/local-pdf.js`（新） | vendored pdfjs 适配层（§4.2 定稿）：懒 `import()`、显式 `workerSrc`、`getTextContent()`→`PageBlock[][]`、`getOutline()`、扫描/加密/损坏分类、页数与内存上限 |
| `vendor/pdfjs/{pdf.mjs,pdf.worker.mjs,LICENSE}`（新） | pdfjs-dist@5.4.449 legacy **min**（≈1.53MB，Apache-2.0，保留 LICENSE） |
| `lib/local-engine.js`（新） | capabilities/plan/extract 编排；P0 只有 builtin + `local-unsupported/missing-tool/empty-text/failed` 错误映射 |
| `lib/config.js` | `ENGINES` 加 `local`；`local` 配置块（§4.6）；偏好 `autoAllowAgentFallback`、`defaultEngine` 允许 local |
| `lib/mineru.js` | `normalizeParseOptions`：engine 枚举、auto 无 Token→local（`ctxInfo.localAvailable`）、local 分支参数/文件类型/大小/`local-unsupported` |
| `lib/parse-manager.js` | 工厂注入 `localEngine`；`executeTask` local 分支；`finishSuccess` 写 `parse.provider/local`；`resume` local 不可恢复；`prepareRepair` 本地守卫；`localTimeoutMs` 超时 |
| `lib/service.js` | `startParse` 传 localAvailable；`getStatus`/`getSettings` 暴露 local；`listDocuments` 保留 engine（已保留） |
| `lib/agent-tool.js` | `parse.engine` enum + `localProvider` + 描述；`list`/`status` 文案 |
| `index.js` | `createLocalEngine({ config: resolved, logger })` 注入 manager/service |
| `ui/app.js`（+ styles 可选） | 引擎 option/可用性/推荐、needsToken/auto 提示、local 质量 banner、状态栏、错误映射、reparse 守卫、i18n（§5） |
| `lib/client.js` | `node scripts/build-client.mjs` 重建 |
| `docs/*` | ARCH（§2 文件表、§4.1 options、§5 新 local 节、§8 config、§9.3）、HOST-INTERFACES（local-engine 签名）、README（用户说明：本地解析能力/限制） |

**测试点**：

| 类型 | 用例 |
|---|---|
| unit `test/unit/local-synth.test.mjs`（新） | 页面块→ markdown golden；heading/outline 数量；`content_list` page_idx 单调、entry↔block 对齐；段落长度上限（≤4000/硬 8000）；扫描件→`local-empty-text`；空输入；确定性（两次输出相同） |
| unit `test/unit/local-pdf.test.mjs`（新） | pdfjs 适配层：最小合成 PDF fixture 文本/页数；`getOutline()`→标题层级；扫描件（0 字符）→`local-empty-text`；有用户密码→`local-encrypted`；损坏→`local-failed`；owner-only 加密兜底；页数/内存上限；确定性（两次提取一致） |
| unit `test/unit/vendor-pdfjs.test.mjs`（新，smoke） | **真实 `await import('../vendor/pdfjs/pdf.mjs')` + 最小合成 PDF**：懒加载可用、worker 路径可加载、`vendor/pdfjs` 三文件存在；并在 `scripts/check.mjs` 增加 vendor 文件存在性/许可证断言（防止只 mock 掉 pdfjs 导致命名/目录类问题漏测） |
| unit `test/unit/local-engine.test.mjs`（新） | provider 选择（builtin/system/office）、不可用→`local-missing-tool`、图片→`local-unsupported`、超时/取消、capabilities 形状 |
| unit `test/unit/parse-manager.test.mjs`（改） | 注入 fake localEngine：成功写 `full.md`+`content_list.json`+`meta.parse`；进度；取消→`uploaded`；异常→`failed`；重启→failed；并发 cap |
| unit `test/unit/service.test.mjs`（改） | token 缺失 `auto→local`；显式 local 无 provider→错误码；`status.local`/`settings.local` 形状；agent tool enum |
| reader `test/reader/local-artifact.test.mjs`（新） | 用 spike 同款合成 fixture（**合成文本，不用 arXiv 原文**）断言：outline 非空、页标记 1..N 且位置正确、原 block key 不变、幂等 |
| e2e `test/e2e/local-flow.test.mjs`（新） | harness 注入假 localEngine + `fetchImpl` 断言零网络：upload→`parse.start {engine:'local'}`→parsed→`document.markdown`→page marks；无 Token `auto` → local；`parse.cancel` |
| 门禁 | `node scripts/check.mjs`（含 `node --test test/`）、`node scripts/build-client.mjs --check` |

**验收标准**：

1. 无 Token、`config.local.enabled:true` 的 profile：导入 15 页文字层 PDF，`auto` 默认 local，解析完成约 0.3–0.5s（pdfjs 4.10.38 实测 337ms/15p；以 p95 ≤ 3s/50 页为上限；**5.4.449 的 RSS/耗时需验收前补测**），全程无 MinerU 网络请求（e2e 断言）。
2. `document.markdown` 返回 `{markdown, contentList, pages}`；阅读台大纲可导航、页码标记正确、划词高亮/翻译/「翻译全文」可用；状态栏显示「本地解析 + provider」。
3. 有 Token：`auto` 仍 standard（回归）；显式 `engine:'local'` 可用；`parse.start` 早失败错误码可区分（`local-unsupported/missing-tool/empty-text`）。
4. 扫描件/图片/加密 PDF 给出明确错误与引导，不产生空解析文档。
5. 全部单测/reader/e2e 通过，`scripts/check.mjs` 绿。

**工作量估计**：**约 3 人日**（pdfjs vendor + 适配层 0.5d；合成器 0.5d；Host 接线 0.75d；Client 0.5d；测试（含 vendor smoke/e2e）0.75d ⇒ 合计 3.0d）。

**风险与回滚**：pdfjs 版本/构建形态（只用 min、懒加载、worker 文件名坑、Node≥20.16）、内存（15–42p 峰值 112–196MB）、加密/扫描件边界 → 页数/内存上限 + `local-*` 分类错误 + 引导云端；P0 若个别 PDF 不达标，可把 P1 的 `pdftotext` 探测提前作兜底（engine 模型不变）。回滚：`config.local.enabled:false`，UI 隐藏 local，auto 恢复旧行为；已解析文档仍可读。

### P1 — 系统 CLI 探测（pdftotext/pdfinfo）+ Office 经 `officeToPdf`

**目标**：本地解析优先用更稳的系统 `pdftotext -layout`；Office 文件可本地解析（经官方 office-to-pdf 服务转 PDF）；设置面板显示能力并可重新检测。

**文件清单**：

| 文件 | 改动 |
|---|---|
| `lib/local-tools.js`（新） | 工具探测（pdftotext/pdfinfo 版本、TTL 缓存）、安全 spawn 包装、officeToPdf 适配（§4.7） |
| `lib/local-engine.js`（改） | provider auto 顺序 system→builtin→sidecar；office 链路；office 错误码映射；capabilities 更新 |
| `lib/config.js` | `local.pdftotextPath/maxOfficePdfBytes/local.maxConcurrent` 等 |
| `lib/service.js` | `local.detect` 方法（可选）、settings.local 实时快照 |
| `lib/routes.js` | dispatch 增 `local.detect`（若做） |
| `index.js` | `officeToPdf: ctx.get('officeToPdf')` 注入 |
| `ui/app.js`（+styles） | 设置面板「本地解析」section、重新检测按钮、office 能力标记、office 错误文案 |
| `docs/*` | 能力矩阵/office 说明/配置项 |

**测试点**：unit 探测（注入 fake `spawnImpl`：ENOENT/版本解析/超时/kill）；officeToPdf 适配（fake service：成功 bytes、missingFonts、各错误码、服务缺失）；parse-manager 走 system/office 分支（fake 工具/服务）；e2e 注入 fake officeToPdf（无则断言降级）；安全用例（路径注入、shell:false、输出超限）。

**验收标准**：

1. 系统有 `pdftotext` 时**仅作 builtin 不可用/失败时的兜底（raw 模式）**，不改变默认解析结果；其文本层无标题/坐标/页码结构，不能优于 pdfjs；P1 验收 = 兜底可用、失败可回落、不劣化默认质量。
2. docx/pptx/xls/xlsx 在 web profile（officeToPdf 可用）走「转 PDF → 文字层」；非 web profile 明确 `local-missing-tool` → 引导云端；`missingFonts` 进 warning + banner。
3. 探测不阻塞启动（懒探测/TTL），设置面板可见版本/不可用原因；无新增 npm 依赖。
4. 单测/e2e/check 全绿。

**工作量估计**：2–3 人日。

**风险与回滚**：poppler 许可/系统差异（Linux/macOS/Windows）→ 只作为可选外部工具，不随插件分发；officeToPdf 为可选服务，profile 差异 → `ctx.get` 可选 + capabilities 驱动 UI；wasm 转换耗时/内存 → `localTimeoutMs`/`maxOfficePdfBytes`/并发限制。回滚：`local.provider:'builtin'` 或 `enabled:false`。

### P2 — 可选侧车引擎检测/接入

**目标**：检测并接入用户自行安装的重型本地引擎（如 OCR/版面：marker、docling、mineru 本地版等），覆盖扫描件/公式/表格；配置驱动、默认关闭。

**文件清单**：`lib/local-sidecar.js`（新：配置、探测 `--version`、argv 模板、输出目录校验、超时/上限、错误映射）；`lib/local-engine.js`（provider sidecar、capabilities）；`lib/config.js`（sidecar 配置）；`lib/service.js`（capabilities/检测）；`ui/app.js`（侧车状态/选择/引导文案）；`docs/*`。

**测试点**：unit 侧车探测/命令模板/输出校验/超时/取消；unit provider 选择；e2e 用 fake sidecar 脚本（`node -e` 写 fixture 文件）验证「命令→产物→阅读台」全链路；安全（配置注入、路径逃逸、输出超限、子进程超时 kill）。

**验收标准**：配置 `local.sidecar.command` 后，扫描件 PDF 能产出带 content_list 的本地解析；未配置时不影响 P0/P1；错误可分类；无 npm 依赖（侧车由用户自装，插件只调度）。

**工作量估计**：3–5 人日（取决于侧车协议；建议统一为「输入文件 → 输出 `full.md`+`content_list.json`」目录协议，复用本地合成/校验）。

**风险与回滚**：安全（任意命令执行，仅限运维可信配置）、侧车输出契约漂移 → 强制产物校验（markdown 非空、CL schema、路径限制）、启动/内存开销 → 默认关闭 + 探测超时。回滚：`local.provider:'auto'`（跳过 sidecar）或删除配置。

### 阶段依赖与建议顺序

```
P0（内置 PDF + 引擎选择 + 产物契约 + 测试）
  └─ P1（pdftotext 探测 → Office/officeToPdf）   ← 若个别 PDF 的 pdfjs 提取不达标，可先上 P1 的 pdftotext 兜底
        └─ P2（侧车，扫描件/OCR/版面）
```

每个阶段的产物契约不变（`full.md` + `content_list.json` + `meta.parse`），因此三阶段可以独立发布、独立回滚，且 P1/P2 的提取器直接复用 P0 的合成器与阅读台。

---

## 8. 风险清单（按严重度）

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | pdfjs 适配层边界：加密/owner-only、扫描件、损坏文件、超大 PDF 内存（112–196MB/15–42p）、Node 版本 | 解析失败/空文档/内存峰值 | 只 vendor min + 懒加载 + 显式 workerSrc；`local-*` 分类错误 + 引导云端；上限（页数/字节/内存）；PDF 样本回归（多字体/多语言/扫描/加密/损坏）；`pdftotext` 探测提前作兜底 |
| 2 | 扫描件/图片无 OCR → 空结果 | 用户以为插件坏了 | 写盘前 `local-empty-text`；`warnings.scanned`；UI banner + 「云端解析/OCR 侧车」引导 |
| 3 | 提取质量：公式/表格/图片/双栏顺序丢失 | 阅读体验下降、翻译语义偏差 | 质量 banner（结构性损失声明）；「配置 Token 解锁精准解析」CTA；本地结果仍可整篇用云端重解析 |
| 4 | 无 Token 默认从 agent 改为 local（行为变化） | 老用户预期变化；图片等本地不支持类型 | `autoAllowAgentFallback` 默认 true（可关）；解析面板明示「将使用哪个引擎/是否上传」；release note |
| 5 | `auto` 静默回落 agent（会上传）与隐私预期冲突 | 隐私投诉 | fallback 可关；UI 明确告知；`engine:'local'` 显式选择永不回落；`auto` 选择结果展示 |
| 6 | Office 转换依赖可选服务/缺失字体/wasm 成本 | 非 web profile 不可用；转换慢/内存高；文字缺字 | `ctx.get` 可选 + capabilities 驱动 UI；`missingFonts` warning；`localTimeoutMs`/`maxOfficePdfBytes`/并发限制；错误码 `local-missing-tool` 引导 |
| 7 | spawn 安全（命令/参数/路径/输出） | 命令注入/资源耗尽 | 固定参数数组、`shell:false`、路径仅来自 store、超时 + SIGKILL、stdout/stderr 上限、命令仅来自配置 |
| 8 | 本地解析后的按页修复不可用 | 用户困惑（按钮消失/报错） | `prepareRepair` 显式本地守卫 + 专属文案；重解析默认整篇 |
| 9 | 翻译/高亮锚点跨引擎漂移 | 重解析后旧批注「找不到位置」 | 现有 `margin.dropped` 降级 + 提示；本地确定性（spike E）保证同引擎重解析稳定；不建议跨引擎保留锚点 |
| 10 | 长段落 > 20000 字符翻译上限 | 全文翻译部分段落失败 | 合成器段落上限 4000（硬 8000）+ 测试断言；必要时 UI 侧再切分 |
| 11 | 数据目录/旧版本兼容 | 升级/降级（回滚） | 只加增量字段、不改必需文件；旧代码忽略 `parse.local`；`parsed/` 产物同构 |
| 12 | 并发/CPU：本地任务与云端任务抢 slot；pdfjs fake worker 在主线程解析（15–42p 约 0.3–1.2s） | 解析变慢/其他请求卡顿 | 复用 `maxConcurrentParses`；P1 `local.maxConcurrent`；页数/字节上限；必要时 `node:worker_threads`（P1+） |
| 13 | vendor 保活：pdfjs 固定版本的安全更新/升级流程缺失 | 长期漏洞/兼容风险 | 记录 vendor 版本来源 + 升级 checklist；维护 PDF 回归样本集（多模板/中文/扫描/加密），升级前跑 golden 对比 |
| 14 | 侧车首次下载失败/离线（无网/代理）时 auto 回落路径不明确 | 用户卡住 | 明确错误与离线预下载指引；auto 在侧车不可用时按规则回落（builtin → 云端时明示上传） |

---

## 9. 待确认问题（交 Lead / 集成评审）

1. **auto 无 Token 的默认**：确认采用 `standard → local → agent`（local-first）；`autoAllowAgentFallback` 默认 true 是否可接受（隐私 vs 兼容）。
2. **P0 内置解析器范围（已定稿）**：采用 vendored `pdfjs-dist@5.4.449` legacy min（不手写解析器），P0 估算约 3 人日；接受「内置只覆盖常见文字层 PDF + 失败时引导」，上线前用团队 PDF 样本集做黑盒回归（node-extract 已交叉验证 3 份样本）。
3. **Office 范围**：P1 是否必须覆盖全部 6 种 Office 扩展名，还是仅 docx/pptx/xlsx（doc/xls 二进制格式 LibreOffice 兼容性较差）。
4. **按页修复**：是否 P1 就做「本地 CL + 云端 pageRanges」的实验（风险：两套 page_idx 语义/CL 类型混排），还是 P0/P1 一律整篇重解析。
5. **配置暴露**：`local.detect` 是否值得新增一个 HTTP 方法（否则设置面板只能刷新 `settings.get` 时被动探测）。
6. **i18n 文案**以 §5.6 为准还是由 design/Lead 统一定稿（本文件只给提案）。
