# dsh-litnotes

在 DeepSeek Harness 的 Web 界面里管理本地文献，用 [MinerU](https://mineru.net) 官方 API 把
PDF / Word / 图片 / 网页解析成结构化阅读稿，然后在一个专门为「英文文献阅读」设计的阅读台里
**对照翻译、划词翻译、高亮和写页边批注**。没有 MinerU Token 也能用：内置的本地解析引擎可以
在本机直接把 PDF（以及可选的 Office 文件）的文字层转成阅读稿，不上传文件、不联网。

左栏会出现一个 **LitNotes 文献库** 入口；打开后是三段式阅读台：左边文献列表、中间论文正文、右边页边
（大纲 / 批注）。Agent 也可以通过 `mineru` 工具访问同一个文献库。

## 功能

- **本地文献库** — 文件保存在本机 `~/.dsh/litnotes/`，不会上传到除所选解析/翻译服务以外的任何地方。
- **导入** — 文件选择器、拖拽到窗口、或从 URL 导入；支持 PDF、DOC/DOCX、PPT/PPTX、XLS/XLSX、
  常见图片与 HTML。
- **本地解析（T0/T0.5）** — 免 Token、离线、不上传文件：
  - **PDF**（T0）：内置随包分发的 pdf.js（pdfjs-dist 5.4.449，Apache-2.0）提取文字层，保留
    段落、标题和页码，公式/表格/图片不还原；
  - **Office**（T0.5）：doc/docx/ppt/pptx/xls/xlsx 先在**本机**经 DSH 的 `officeToPdf` 服务转
    成 PDF，再走同一提取链（取决于当前 profile 是否挂载该服务）。
- **MinerU 解析** — 两种官方接口都支持：
  - **精准解析**（需要 API Token）：pipeline / vlm 模型，公式、表格、OCR、页码范围；
  - **轻量云端解析**（免 Token）：10 MB / 20 页以内快速得到 Markdown，会把文件上传到 MinerU。
- **英文文献阅读台** — 衬线英文原文 + 更安静的中文译文；原文 / 对照 / 译文三种阅读模式；
  大纲导航、页码标记、字号调节。
- **翻译** — 整篇批量翻译（逐段缓存）、段落翻译（悬停段落后点「翻译本段」弹出该段译文浮窗，
  已有译文则直接展示）、划词翻译；译文按 Markdown 渲染，公式用 KaTeX 排版。翻译服务优先使用
  Harness 的翻译服务（Google / Bing 等），不可用时回退到默认模型。
- **高亮与批注** — 四种高亮颜色 + 页边批注卡片；点击高亮可编辑 / 删除；重新解析后按文本锚点
  恢复。
- **Agent 工具** — 让 Agent 列出文献、导入 URL、触发解析（含本地引擎）、读取 Markdown、
  查看 / 添加批注、翻译文本；与 UI 共用同一套操作实现。
- **深色模式 / 键盘可达 / 减少动效** — 跟随 Harness 主题与语言（中 / 英）。

## 第一次使用

1. 打开左栏的 **文献库**。
2. 点「导入文献」选择或拖入一篇 PDF。未解析的文献会显示「准备解析」面板。
3. 直接点「开始解析」即可：默认引擎「自动」在**没有 Token 时优先本地解析**——PDF（含文字层）
   在本机解析，文件不会上传；若当前环境没有可用的本地解析器，才会回退到免 Token 的轻量云端解析
   （此时会上传文件）。该回退由偏好 `autoAllowAgentFallback` 控制（默认开启，当前版本通过
   `~/.dsh/litnotes/preferences.json` 关闭；关闭后无 Token 且本地不支持的文件会提示配置 Token）。
4. **推荐配置 Token**（设置 → MinerU 接入）：在 [mineru.net API 管理页](https://mineru.net/apiManage/docs)
   创建一个 Token 并粘贴保存。配置后「自动」会优先使用精准解析（公式 / 表格 / OCR / 200 MB /
   200 页），也就是本地解析与精准解析可以随时切换。
5. 想强制离线时，在解析面板把引擎切到「本地解析（离线 · 不上传）」；本地不支持的格式会置灰并
   说明原因。
6. 选中正文即可翻译 / 高亮 / 批注；右侧页边可以浏览大纲和所有批注。

Token 只保存在 Harness 的本机凭据存储中（`~/.dsh/.credentials.yaml`，由 DSH 凭据服务管理），
不会写入配置文件、不会返回给前端、也不会出现在日志里。

## 本地解析的限制

本地解析只读文件的**文字层**，请按下面的预期使用（不要把它当成 MinerU 精准解析的等价替代）：

- **PDF**：正文、段落、标题和页码可靠；双栏论文的阅读顺序在常见样本上正确。
- **公式**：不还原 LaTeX，只会变成一行线性文本（`x = …` 之类，可能夹杂符号）。
- **表格**：不还原表格结构，只会变成若干行文本。
- **图片 / 图表**：不抽取图片，阅读台里不会出现原图（云端解析才有）。
- **扫描件 / 纯图片 PDF**：没有文字层，会报「没有提取到文字（可能是扫描件）」；请改用云端解析或
  配置 Token（OCR）。
- **Office（T0.5）**：经本机 `officeToPdf` 转成 PDF 后再提取，版面基本保留，但没有原始 OOXML
  的段落/表格结构；当前 profile 未挂载该服务时 Office 不能本地解析。
- **页码范围 / 按页修复**：不适用；页码范围只对云端解析有效，本地文档只能整篇重新解析。
- 默认上限：PDF ≤ 200 MB、≤ 500 页、提取文本 ≤ 32 MiB、超时 120 秒；Office 输入 ≤ 100 MB
  （均可在插件配置的 `local` 块调整）。

## 数据位置

```
~/.dsh/litnotes/
  documents/<id>/meta.json        文献信息与解析状态（含引擎与本地解析统计）
  documents/<id>/source.<ext>     原始文件
  documents/<id>/parsed/          解析稿（full.md、content_list.json、images/）
  documents/<id>/annotations.json 高亮与批注
  documents/<id>/translations.json 段落译文缓存
  preferences.json                阅读偏好
  diagnostics/client.log          前端诊断日志（最多 200 行）
```

本地解析与云端解析写同一套 `parsed/` 产物契约（`full.md`；本地与精准解析还写
`content_list.json`，本地为合成版、用于页码标记），所以阅读、翻译、高亮和批注的用法完全一致；
本地解析不会写 `images/`。

删除文献会删除整个目录。整个数据目录只在本机，可随时备份或迁移。

## Agent 工具 `mineru`

```jsonc
{ "action": "list" }
{ "action": "import_url", "url": "https://arxiv.org/pdf/…", "title": "…" }
{ "action": "parse", "documentId": "…", "parse": { "engine": "local" } }
{ "action": "parse", "documentId": "…", "parse": { "modelVersion": "vlm", "language": "en" } }
{ "action": "read", "documentId": "…", "offset": 0, "maxChars": 12000 }
{ "action": "annotations", "documentId": "…" }
{ "action": "annotate", "documentId": "…", "annotation": { "quote": "…", "note": "…", "color": "sage" } }
{ "action": "translate", "text": "…", "targetLanguage": "zh" }
```

Agent 与 UI 走同一套 Host 操作：UI 通过 `/dsh-litnotes/api/*`，工具直接调用同一个服务对象。

## 隐私与网络

- **本地解析（`local` 引擎）不上传文档、提取阶段不联网**；显式选「本地解析」时永不静默切换到云端。
- 云端解析（`standard` / `agent`）只在**解析阶段**把原文件上传到 MinerU 官方接口，解析结果下载回本机。
- 引擎「自动」的策略：有 Token → 精准解析；无 Token 且文件可本地解析 → 本地解析；
  否则（且未关闭云端回退）→ 轻量云端解析（会上传文件）。不想上传时请显式选「本地解析」。
- Office 文件的本地解析由 DSH 的 `officeToPdf` 服务在**本机**转换（LibreOffice kit/WASM），
  不经过网络。
- 翻译文本会发送到所选的翻译服务（Harness 翻译服务或默认模型）。
- Agent 工具运行在 Harness 进程内；HTTP 路由只接受已认证的本机浏览器会话
  （Host/Origin + Cookie 校验）。

## 故障排查

- **「文献服务还没就绪」** — Host 插件正在加载或不可用；稍等或查看 Harness 日志。
- **解析失败：Token 错误 / 过期** — 重新在设置里保存 Token。
- **文件过大 / 页数超限** — 轻量云端解析限 10 MB / 20 页；本地解析限 200 MB / 500 页
  （Office 输入 100 MB）；改用精准解析（需要 Token）或拆分文件。
- **本地解析不可用（置灰）** — 当前文件类型不支持本地解析，或该 profile 没有可用的本地解析器；
  设置 → 本地解析 里可以查看「内置文字层提取 / Office 转换」的可用状态并点「重新检测」。
- **没有从文件中提取到文字（可能是扫描件）** — 该 PDF 没有文字层；改用云端解析（轻量云端 ≤10 MB
  / 20 页，或配置 Token 用精准解析）做 OCR。
- **PDF 已加密** — 本地解析不支持带密码的 PDF；先去除密码，或改用云端解析。
- **本地解析工具不可用** — 内置 pdf.js 未随包安装或加载失败，或 Office 转换服务未挂载；
  改用云端解析或配置 Token。
- **本地 Office 转换失败 / 超时** — 文件可能损坏或过大；稍后重试或改用云端解析。
- **翻译不可用** — 当前部署没有可用的翻译服务，且默认模型不可用；稍后重试或在设置里更换目标语言。

## 开发

要求 Node >= 20.16（`package.json` 的 `engines`）。

```bash
node scripts/build-client.mjs   # ui/** → lib/client.js
node scripts/check.mjs          # manifest + syntax + build + 全部测试
node --test test/               # 单元 / 解析器 / 端到端（使用本地 MinerU mock）
```

设计/架构文档：`docs/ARCH.md`、`docs/UI-SPEC.md`、`docs/HOST-INTERFACES.md`、`docs/MINERU.md`；
本地解析的选型与实现状态见 `docs/LOCAL-FALLBACK.md`。
KaTeX 运行时随包内置（`vendor/katex`，MIT，见其 LICENSE），解析结果中的公式在本地渲染，不访问外网。
本地 PDF 解析器同样随包内置（`vendor/pdfjs`，pdfjs-dist 5.4.449，Apache-2.0，见其 LICENSE），
Host 首次本地解析时才懒加载，不给 Host 启动增加负担；文本提取路径不需要 canvas 等原生依赖。

插件以 bundle 形式安装到当前 profile（`plugin_manager install_bundle <本目录>`），Host 半为
`index.js`，Client 半为 `lib/client.js`（注册 `sidebar.panellist` 图标与 `main` 面板）。
