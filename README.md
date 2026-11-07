# dsh-litnotes

AI 原生文献库插件（DeepSeek Harness Web UI）：把本地文献、MinerU 解析、双语阅读、**带可跳转引用的 AI 问答**、**自动批注**与**双层知识图谱**放进同一个阅读工作台，并通过 7 个 Agent 工具让 DSH 聊天也能读写整个文献库。

> 前身为 `dsh-mineru`；数据目录会自动从 `~/.dsh/mineru` 迁移到 `~/.dsh/litnotes`。

## 功能总览

### 1. 本地文献库 + MinerU 解析
- 导入文件选择、拖拽、URL 导入；支持 PDF、Word、PPT、Excel、图片、HTML。
- MinerU 官方 API 双通道：精准解析（Token，pipeline/vlm、OCR/公式/表格/页码范围）与免 Token 轻量解析；异步任务、进度、取消、失败重试、宿主重启续跑。
- **本地解析（免 Token，T0/T0.5）**：没有 Token 时「自动」优先在本机解析——PDF 走内置 pdf.js（pdfjs-dist 5.4.449，Apache-2.0）提取文字层；doc/docx/ppt/pptx/xls/xlsx 先在**本机**经 DSH `officeToPdf` 服务转成 PDF 再提取（取决于当前 profile 是否挂载该服务）。不上传文件、不联网；公式/表格/图片/扫描件不还原（见下文「本地解析的限制」）。
- **按页修复**：重新解析只处理有问题的页面（如 MinerU 未能识别的字形页），其余页面与批注保持不变；总页数不变，失败/取消自动回滚。

### 2. 双语阅读台
- 衬线英文原文 + 更安静的中文译文；原文 / 对照 / 译文三种模式；大纲、页码标记、字号调节。
- 公式用内置 KaTeX 本地渲染（译文中的 `$...$` 也渲染）。
- 高亮（四色）/ 批注 / 页边列表 / 可取消高亮；切走再回来自动恢复上次文献与位置。

### 3. AI 阅读助手（右侧 AI 栏）
- 基于**当前文献**的 grounded 问答：回答只依据解析稿，流式输出，可停止 / 重新生成 / 追问。
- **引用优先**：每条回答带 `[n]` 引用；悬停看原文引文与页码，点击跳到正文对应位置并闪烁；后端用「引文必须真实出现在对应段落」校验，未通过的引用会被标灰且不产生批注。
- **回答即批注**：通过校验的引用自动在原文生成高亮批注（按侧重点着色：定义=黄、方法=绿、结果=蓝、局限=红），批注带 AI 来源标记、对话 id 与模型信息；每条回答最多 5 条，避免刷屏。
- 上下文感知：可直接针对当前段落或选中文字提问；快捷提问（总结、方法、局限、解释概念…）；每条回答附建议追问。
- 对话按文献持久化，可清空；回答与引用可复制。

### 4. 双层知识图谱
- **单篇文献图谱**：点「AI 精读」让模型通读全文，抽取概念/方法/发现/定义/局限/章节节点及其关系（uses / supports / contra…），生成 TL;DR 与术语表；节点保留 blockKey 溯源，点击可跳回原文。
- **问答持续充实图谱**：每次通过校验的问答会把问题/洞察节点与引用关系并入该文献图谱。
- **文献库图谱**：把所有文献聚合为「论文 + 主题」图谱（主题共现、聚类、TL;DR），点主题看论文与证据；随文献增长可一键重建。
- 图谱视图：手写 SVG 力导向布局（固定种子、可拖拽/缩放/过滤/搜索/折叠簇），明暗主题与窄屏可用。

### 5. DSH Agent 工具（7 个）
| 工具 | 用途 |
|---|---|
| `library_search` | 跨全库/单篇检索段落（返回 documentId/blockKey/page/snippet） |
| `library_read` | 读元数据/大纲、Markdown 切片、指定 blockKey、指定页 |
| `library_ask` | 让 AI 基于单篇文献回答并返回可引用证据（自动生成批注） |
| `library_annotate` | 列出/创建/更新/删除高亮与批注（按 aspect 着色） |
| `library_translate` | 翻译文本或指定段落 |
| `library_graph` | 读取/搜索/构建/更新单篇图谱，读取/重建全库图谱 |
| `library_manage` | 列表/状态/URL 导入/解析/按页修复/取消/改名/删除 |

所有工具返回带 `documentId`、`blockKey`、`page`、`quote` 的坐标，Agent 可以在 DSH 聊天里给出可追溯的引用。

## 第一次使用

1. 左栏点 **LitNotes 文献库**。
2. 导入一篇 PDF（或 URL），选择解析参数开始解析：默认「自动」在**没有 Token 时优先本地解析**——有文字层的 PDF 在本机解析、不上传；本地不支持的格式（扫描件、图片、未挂载 officeToPdf 时的 Office）会回退到免 Token 的云端轻量解析（会上传文件，由偏好 `autoAllowAgentFallback` 控制，默认开启）或提示配置 Token。
3. **推荐配置 Token**（设置 → MinerU 接入）：精准解析（公式/表格/OCR/200MB/200页）与本地解析可随时切换；想强制离线时在解析面板把引擎切到「本地解析（离线 · 不上传）」。
4. 解析完成后：开启右侧「AI」标签提问；在「阅读 | 图谱」间切换查看单篇图谱；在文献库顶部「文献库 | 全景图谱」查看全库图谱。
5. 首次生成单篇图谱点「AI 精读全文」；之后每轮问答都会自动充实图谱。

## 本地解析（T0/T0.5）与限制

本地解析只读文件的**文字层**，请按下面的预期使用（不要把它当成 MinerU 精准解析的等价替代）：

- **PDF**：正文、段落、标题和页码可靠；双栏论文的阅读顺序在常见样本上正确。没有 Token 时这是默认路径。
- **公式**：不还原 LaTeX，只会变成一行线性文本（`x = …` 之类，可能夹杂符号）。
- **表格**：不还原表格结构，只会变成若干行文本。
- **图片 / 图表**：不抽取图片，阅读台里不会出现原图（云端解析才有）。
- **扫描件 / 纯图片 PDF**：没有文字层，会报「没有提取到文字（可能是扫描件）」；请改用云端解析或配置 Token（OCR）。
- **Office（T0.5）**：经本机 `officeToPdf` 转成 PDF 后再提取，版面基本保留，但没有原始 OOXML 的段落/表格结构；当前 profile 未挂载该服务时 Office 不能本地解析（会回退云端或提示配置 Token）。
- **页码范围 / 按页修复**：不适用；页码范围只对云端解析有效，本地文档只能整篇重新解析。
- 默认上限：PDF ≤ 200 MB、≤ 500 页、提取文本 ≤ 32 MiB、超时 120 秒；Office 输入 ≤ 100 MB（均可在插件配置的 `local` 块调整）。

本地解析与云端解析写同一套 `parsed/` 产物契约（`full.md`；本地与精准解析还写 `content_list.json`，本地为合成版、用于页码标记），所以阅读、翻译、高亮和批注的用法完全一致；本地解析不会写 `images/`。

## 数据与隐私

```
~/.dsh/litnotes/
  documents/<id>/source.<ext>        原始文件
  documents/<id>/parsed/             解析稿（full.md、content_list.json、images/；本地解析为合成 content_list.json、无 images/）
  documents/<id>/annotations.json    高亮/批注（含 AI 来源、aspect、chatId、model）
  documents/<id>/translations.json   段落译文缓存
  documents/<id>/chat.json           AI 对话历史（含引用与 promptVersion）
  documents/<id>/graph.json          单篇知识图谱
  library-graph.json                 文献库知识图谱
  preferences.json                   阅读/AI 偏好
  diagnostics/client.log             前端诊断日志（≤200 行）
```

- 文件与解析结果保存在本机；仅在解析阶段上传到 MinerU 官方接口。
- 本地解析（T0/T0.5）完全在本机完成，不上传文件；Office 文件也只在本机转换成 PDF。
- AI 问答会把检索到的相关段落发送给 DSH 配置的默认模型；不发送整篇无关内容。
- MinerU Token 保存在 DSH 本机凭据中，不会返回前端、不会写日志。

## 开发

```bash
node scripts/build-client.mjs          # ui/** → lib/client.js
node scripts/check.mjs                 # manifest + 语法 + 构建 + 全部测试
node scripts/check.mjs --require-client-ai   # 严格门禁（AI UI 必须存在）
node --test test/                      # 单元 / 解析器 / 引擎 / 端到端（含假 LLM 与 MinerU mock）
```

- 本地解析引擎：`lib/local-engine.js` / `lib/local-pdf.js` / `lib/local-synth.js` / `lib/local-office.js` + `vendor/pdfjs/`（pdfjs-dist 5.4.449，Apache-2.0）；`scripts/check.mjs` 含 vendored 文件与版本同步门禁。
- 架构与契约：[docs/ARCH.md](docs/ARCH.md)、[docs/AI-SPEC.md](docs/AI-SPEC.md)
- 产品愿景与 AI 细节：[docs/VISION.md](docs/VISION.md)、[docs/RESEARCH.md](docs/RESEARCH.md)
- 设计系统与说明：[docs/UI-SPEC.md](docs/UI-SPEC.md)、[docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md)
- QA 报告：[docs/QA-REPORT.md](docs/QA-REPORT.md)、[docs/QA-REPORT-AI.md](docs/QA-REPORT-AI.md)

插件以 bundle 形式安装到当前 profile（`plugin_manager install_bundle link:<本目录>`）；Host 半为 `index.js` + `lib/**`，Client 半由 `ui/**` 构建为 `lib/client.js`（注册 `sidebar.panellist` 图标、`main` 面板与右侧 AI 栏）。
