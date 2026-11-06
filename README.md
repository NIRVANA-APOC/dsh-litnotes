# dsh-litnotes

在 DeepSeek Harness 的 Web 界面里管理本地文献，用 [MinerU](https://mineru.net) 官方 API 把
PDF / Word / 图片 / 网页解析成结构化阅读稿，然后在一个专门为「英文文献阅读」设计的阅读台里
**对照翻译、划词翻译、高亮和写页边批注**。

左栏会出现一个 **LitNotes 文献库** 入口；打开后是三段式阅读台：左边文献列表、中间论文正文、右边页边
（大纲 / 批注）。Agent 也可以通过 `mineru` 工具访问同一个文献库。

## 功能

- **本地文献库** — 文件保存在本机 `~/.dsh/mineru/`，不上传到除 MinerU 解析接口以外的任何地方。
- **导入** — 文件选择器、拖拽到窗口、或从 URL 导入；支持 PDF、DOC/DOCX、PPT/PPTX、XLS/XLSX、
  常见图片与 HTML。
- **MinerU 解析** — 两种官方接口都支持：
  - **精准解析**（需要 API Token）：pipeline / vlm 模型，公式、表格、OCR、页码范围；
  - **轻量解析**（免 Token）：10 MB / 20 页以内快速得到 Markdown。
- **英文文献阅读台** — 衬线英文原文 + 更安静的中文译文；原文 / 对照 / 译文三种阅读模式；
  大纲导航、页码标记、字号调节。
- **翻译** — 整篇批量翻译（逐段缓存）、段落翻译（悬停段落后点「翻译本段」弹出该段译文浮窗，
  已有译文则直接展示）、划词翻译；译文按 Markdown 渲染，公式用 KaTeX 排版。翻译服务优先使用
  Harness 的翻译服务（Google / Bing 等），不可用时回退到默认模型。
- **高亮与批注** — 四种高亮颜色 + 页边批注卡片；点击高亮可编辑 / 删除；重新解析后按文本锚点
  恢复。
- **Agent 工具** — 让 Agent 列出文献、导入 URL、触发解析、读取 Markdown、查看 / 添加批注、
  翻译文本；与 UI 共用同一套操作实现。
- **深色模式 / 键盘可达 / 减少动效** — 跟随 Harness 主题与语言（中 / 英）。

## 第一次使用

1. 打开左栏的 **文献库**。
2. 点「导入文献」选择或拖入一篇 PDF。未解析的文献会显示「准备解析」面板。
3. **推荐配置 Token**（设置 → MinerU 接入）：在 [mineru.net API 管理页](https://mineru.net/apiManage/docs)
   创建一个 Token 并粘贴保存。保存后即可使用精准解析（公式 / 表格 / OCR / 200 MB / 200 页）。
   没有 Token 时默认使用轻量解析（10 MB / 20 页以内，仅输出 Markdown）。
4. 选择解析参数并点「开始解析」。解析在后台进行，进度会实时刷新；完成后自动进入阅读。
5. 选中正文即可翻译 / 高亮 / 批注；右侧页边可以浏览大纲和所有批注。

Token 只保存在 Harness 的本机凭据存储中（`~/.dsh/.credentials.yaml`，由 DSH 凭据服务管理），
不会写入配置文件、不会返回给前端、也不会出现在日志里。

## 数据位置

```
~/.dsh/mineru/
  documents/<id>/meta.json        文献信息与解析状态
  documents/<id>/source.<ext>     原始文件
  documents/<id>/parsed/          MinerU 解析稿（full.md、content_list.json、images/）
  documents/<id>/annotations.json 高亮与批注
  documents/<id>/translations.json 段落译文缓存
  preferences.json                阅读偏好
  diagnostics/client.log          前端诊断日志（最多 200 行）
```

删除文献会删除整个目录。整个数据目录只在本机，可随时备份或迁移。

## Agent 工具 `mineru`

```jsonc
{ "action": "list" }
{ "action": "import_url", "url": "https://arxiv.org/pdf/…", "title": "…" }
{ "action": "parse", "documentId": "…", "parse": { "modelVersion": "vlm", "language": "en" } }
{ "action": "read", "documentId": "…", "offset": 0, "maxChars": 12000 }
{ "action": "annotations", "documentId": "…" }
{ "action": "annotate", "documentId": "…", "annotation": { "quote": "…", "note": "…", "color": "sage" } }
{ "action": "translate", "text": "…", "targetLanguage": "zh" }
```

Agent 与 UI 走同一套 Host 操作：UI 通过 `/dsh-litnotes/api/*`，工具直接调用同一个服务对象。

## 隐私与网络

- 文件名、文献内容仅在**解析阶段**上传到 MinerU 官方接口；解析结果下载回本机。
- 翻译文本会发送到所选的翻译服务（Harness 翻译服务或默认模型）。
- Agent 工具运行在 Harness 进程内；HTTP 路由只接受已认证的本机浏览器会话
  （Host/Origin + Cookie 校验）。

## 故障排查

- **「文献服务还没就绪」** — Host 插件正在加载或不可用；稍等或查看 Harness 日志。
- **解析失败：Token 错误 / 过期** — 重新在设置里保存 Token。
- **文件过大 / 页数超限** — 轻量解析限 10 MB / 20 页；改用精准解析（需要 Token）或拆分文件。
- **翻译不可用** — 当前部署没有可用的翻译服务，且默认模型不可用；稍后重试或在设置里更换目标语言。

## 开发

```bash
node scripts/build-client.mjs   # ui/** → lib/client.js
node scripts/check.mjs          # manifest + syntax + build + 全部测试
node --test test/               # 单元 / 解析器 / 端到端（使用本地 MinerU mock）
```

设计/架构文档：`docs/ARCH.md`、`docs/UI-SPEC.md`、`docs/HOST-INTERFACES.md`、`docs/MINERU.md`。
KaTeX 运行时随包内置（`vendor/katex`，MIT，见其 LICENSE），解析结果中的公式在本地渲染，不访问外网。

插件以 bundle 形式安装到当前 profile（`plugin_manager install_bundle <本目录>`），Host 半为
`index.js`，Client 半为 `lib/client.js`（注册 `sidebar.panellist` 图标与 `main` 面板）。
