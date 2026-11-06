# 侧车解析引擎调研（本地化降级 · 重武器 / 侧车）

> 快照日期：**2026-11-06**（本机 Linux，联网；PyPI JSON / GitHub raw / 官方文档实时抓取）。
> 研究范围：需要用户**另行安装**的本地解析引擎 / 服务（侧车，sidecar），面向「不熟悉技术、
> 没有 MinerU Token」的普通用户评估可落地性。
> 配套文档：`docs/research/integration.md`（插件侧集成设计，含 `local-engine.js` 接口与产物合成）、
> `docs/LOCAL-FALLBACK.md`（Lead 的总报告骨架）。本文只负责**引擎选型事实与取证**，不重复设计细节。
> 方法：只读取证，**未安装任何重型包**；体积来自 PyPI wheel 元数据，许可见仓库 LICENSE / PyPI
> `license_expression` / HuggingFace 模型卡，质量数字来自 OmniDocBench 官方榜单与官方 benchmark。

---

## 0. 结论摘要

### 0.1 分档结论（沿用 Lead 的 T0–T3 分档）

| 档 | 含义 | 代表 | 对普通用户 |
|---|---|---|---|
| **T0 零安装** | 插件自带 / DSH 自带，用户什么都不装 | 纯 Node PDF 文本层提取（另一成员方案）、云端 agent 轻量（现状） | ✅ 默认可用 |
| **T0.5 DSH 内置服务** | 本机已随 DSH 安装的服务，插件可用 `ctx.get()` 复用 | 官方 `office-to-pdf`（LibreOffice WASM，已随 web profile 挂载） | ✅ 对 Office 输入免费加分 |
| **T1 系统 CLI** | apt/brew/winget 装命令行工具，或系统已有 | `pdftotext`、`tesseract`、`ocrmypdf`、`soffice` | ⚠️ Linux/macOS 尚可，Windows 差 |
| **T2 侧车引擎** | `uv tool` / `pipx` / Docker 单独装 Python 引擎 | **MinerU 本地版 4.x**、Docling、MarkItDown、PaddleOCR、RapidOCR、Marker、GROBID、Unstructured | ⚠️ 需要开终端，10–30 分钟 |
| **T3 本地模型** | 本地 VLM / GPU 推理服务 | Ollama（qwen3-vl / minicpm-v）、Marker balanced+vLLM、MinerU GPU 档、PaddleOCR-VL | ❌ 硬件与安装门槛高，不建议本阶段做 |

**核心结论**：

1. **T2 里最值得集成的是 MinerU 本地版 4.x**：官方 CLI + 本地 HTTP API、纯 CPU 可跑 standard
   档（ONNX + llama.cpp，模型 ~2 GB、内存门槛 8 GB）、且 2026-04-18 起代码已从 AGPLv3 换成
   **Apache-2.0 + 附加条款**（宽松得多），权重也已是 Apache-2.0 的 MinerU2.5-Pro 系列。
   但「产物契约与云端完全一致」**不准确**——见 §0.3，需要一层适配。
2. **最轻的可用降级是 MarkItDown**（`pip install markitdown[pdf]`，几十 MB、毫秒级、MIT），
   只适合「有文本层的正经 PDF / Office / HTML」，公式表格图片基本丢失。
3. **Docling 是第二个值得集成的引擎**（单条 `pip install docling`、MIT、CPU 可跑、有
   `docling-serve` REST、模型许可干净），但独立质量证据弱于 MinerU2.5-Pro 与 PaddleOCR-VL。
4. **质量天花板其实在 PaddleOCR-VL-1.6**（OmniDocBench 96.34，Apache-2.0 代码与权重，
   0.9B），但安装链（paddlepaddle 186 MB Linux wheel + PaddleX 系）与 CLI/服务形态需再验证，
   列为「高潜力候选」而非首选。
5. **不建议做默认降级**：Marker（权重 OpenRAIL-M 有商业门槛 + GPU 依赖 + 依赖重）、Surya
   （同权重许可 + 需要独立推理服务）、GROBID（只出 TEI，不出 Markdown）、Unstructured
   （114 个依赖）、本地 VLM（质量不如专用解析器、硬件门槛高）。

### 0.2 推荐组合（按用户画像）

| 用户画像 | 推荐路径 | 理由 |
|---|---|---|
| 完全不想装东西 | T0（内置文本层）+ T0.5（Office→PDF） | 零成本；扫描件/复杂版式时提示配 Token |
| 愿意开一次终端（有 Python/uv） | **T2：MinerU 本地版 4.x（standard 档）** | 质量最高、CPU 可跑、输出最接近云端、许可宽松 |
| 电脑较弱（8–16 GB 内存 / 4–11 核） | T2：MinerU 本地版 `basic` 档，或 **Docling**，或 MarkItDown | `basic` 纯 ONNX ~0.8 GB 模型；Docling/MarkItDown 更轻 |
| 扫描件为主、无 Token | T2：OCRmyPDF+Tesseract / PaddleOCR / RapidOCR | 先 OCR 出文本层，再交 T0/T2 的文本解析 |
| 学术元数据 / 参考文献 | T2：GROBID（配合 Markdown 引擎） | 唯一能把 header/参考文献结构化的本地工具 |
| 有强力 GPU、追求极致 | T3：PaddleOCR-VL / Marker balanced / MinerU GPU | 质量与速度上限，但安装与硬件门槛高 |

### 0.3 重要修正：MinerU 本地产物 ≠ 云端产物（需适配层）

云端 standard 结果包（`docs/MINERU.md` §A3）是 `full.md` + `*_content_list.json` + `images/`
（+ `layout.json`、`*_model.json`）。MinerU **4.x 本地**（官方 Output Formats 文档
<https://opendatalab.github.io/MinerU/reference/output_files/>）是：

- `mineru-kit parse x.pdf -o x.md`：只渲染 Markdown 正文；
- `mineru-kit parse x.pdf -o out --format zip`：`markdown.md`、`middle_json.json`、
  `structured_content.json`、`images/`（`ParseResult.save` 落盘格式）；
- **Content List V1 / V2 只在 Python 渲染 API 里**：`mineru.render.render(result.middle_json,
  RenderFormat.CONTENT_LIST | CONTENT_LIST_V2)`；V1 API `/v1/tasks` 的 `output_formats` 只有
  `default | docx | html | latex`（**不含 content_list**）；
- 图片命名规则变为 `images/page_{page_idx}_{parent_type}_{parent_index}.{ext}`，历史包不自动迁移。

结论：MinerU 本地能给 **Markdown + images（+ middle_json，含零基 `page_idx` 与 bbox）**，
`content_list.json` 需要二选一：
(a) 在 Node 侧从 `middle_json.json` 合成（纯函数、可测试，推荐 v2 阶段做）；
(b) 调用一次 `python -c` 用安装好的 mineru 渲染 API 生成 V1/V2（依赖 Python 小脚本）；
(c) v1 先按「无 content_list」降级——现有阅读器对 `contentList=null` 已优雅降级
（见 `docs/research/integration.md` §3.4），代价是无页码标记与按页修复。
另：**MinerU 2.x/3.x 时代的 CLI 直接产出 `*_content_list.json`**，探测时要按大版本分支处理。

---

## 1. 对比矩阵

许可证列拆开「代码 / 权重」；体积为安装后磁盘量级 [估]（由 wheel 元数据 + 官方模型表推算）。

| 引擎 | 解决场景 | 安装（新手难度） | 代码许可 | 权重许可 | 硬件门槛 | 单篇耗时量级* | 产物映射 | Host 集成 |
|---|---|---|---|---|---|---|---|---|
| **MinerU 本地 4.x** | 全场景（扫描/公式/表格），产物最接近云端 | `uv tool install "mineru>=4.0,<5"`（中） | MinerU Open Source License = Apache-2.0 + 附加条款（MAU>1亿 或 月收入>2000万美元需商业许可；在线服务须署名） | MinerU2.5-Pro-2605-1.2B / `MinerU-4_models_torch` = **Apache-2.0**；`MinerU-4_models_onnx` = 上游模型原许可（需审 manifest）；旧 2.5 权重 AGPL-3.0 | 标准档：模型~2 GB，8 GB 内存可跑 CPU（ONNX+llama.cpp），推荐 16 GB；CPU ≥12 逻辑核才自动开 standard | flash 秒级；basic 数十秒；standard 1–4 分钟；advanced 2–8 分钟 | Markdown+images 直接；content_list 需合成/渲染（§0.3） | CLI spawn；或 `mineru-kit api-server` 本地 HTTP `/v1/tasks` |
| **Marker 2.1.0** | 高质量转换（GPU 为核心） | `pip install marker-pdf` + PyTorch +（vllm Docker 或 llama.cpp）（难） | Apache-2.0 | 修改版 AI Pubs Open Rail-M：研究/个人/<$5M 融资或营收免费，超出需商业授权 | balanced 需 GPU（vLLM/Docker）；CPU 只能 `fast`/`--disable_ocr` | GPU 快；CPU fast 数十秒–数分钟 | md/json/html/chunks；JSON 带 page/bbox 可合成 | CLI `marker_single`；无稳定本地 REST 解析 API |
| **Docling 2.148.0** | 通用结构化解析、CPU 友好、REST 服务 | `pip install docling`（中） | MIT | `docling-layout-heron` Apache-2.0；`ds4sd/docling-models` CDLA-Permissive-2.0 + Apache-2.0 | 纯 CPU 可跑；torch wheel Linux 514 MB / macOS 132 MB；模型 ~0.5 GB；总磁盘 2–3 GB | 20–90 秒/篇 [估] | `--to md` / `--to json`（含 pages/bbox），可合成 content_list；可出图片 | CLI spawn；`docling-serve` REST `127.0.0.1:5001` |
| **MarkItDown 0.1.9** | 轻量文本提取（PDF/Office/HTML/EPUB） | `pip install 'markitdown[pdf,docx,pptx,xlsx]'`（易） | MIT | 无模型（不下载权重；pdfminer.six 纯文本） | 无 GPU；磁盘几十 MB | <2 秒/篇 | 仅 Markdown；无页码/图片 → contentList=null 或单页 | CLI spawn `markitdown file -o out.md` |
| **PaddleOCR 3.7 / PaddleOCR-VL-1.6** | OCR + 文档解析（SOTA 小模型） | `pip install paddleocr paddlepaddle`（中偏难） | Apache-2.0 | Apache-2.0（PaddleOCR-VL-1.5/1.6 模型卡）；PP-OCR 权重同系 | paddlepaddle Linux wheel 186 MB；PP-StructureV3 CPU 可跑；VL 0.9B 推理建议 GPU（待实测） | PP-StructureV3 CPU 数十秒；VL GPU 数秒/页 | Markdown/JSON（PP-StructureV3 带坐标），可合成 content_list | CLI / PaddleX 服务（待验证）；也可仅作 OCR 后端 |
| **RapidOCR 3.10** | 轻量 OCR（扫描件文字层） | `pip install rapidocr onnxruntime`（易） | Apache-2.0 | 内置 ONNX 模型来自 PaddleOCR，Baidu 版权，Apache-2.0 系（需署名） | 纯 CPU；磁盘 ~50 MB | 50–200 毫秒/页（CPU）[估] | 只有文字框 + 文本；需自组装 Markdown / 合成 content_list | Python 调用（CLI 形态待确认）→ 需 python shim |
| **Surya 0.23** | OCR/版面/表格（Marker 底座） | `pip install surya-ocr` + vllm/llama.cpp 服务（难） | Apache-2.0 | 修改版 AI Pubs Open Rail-M（同 Marker，$5M 门槛） | 需独立推理服务；GPU 或 llama.cpp CPU | 数秒/页（GPU） | HTML/Markdown/表格；无 content_list | 需自建推理服务，不建议直接集成 |
| **OCRmyPDF 17.13 + Tesseract 5.5.4** | 扫描 PDF 加 OCR 文字层 | `apt/brew install ocrmypdf tesseract`（中；Windows 仅 WSL） | OCRmyPDF **MPL-2.0**；Tesseract **Apache-2.0**；依赖 Ghostscript **AGPL-3.0** ⚠️ | 无模型权重（tessdata 语言包 Apache-2.0） | 纯 CPU；tesseract ~50 MB + 语言包 | 2–10 秒/页 [估] | 输出的是 **带文字层的 PDF**，不是 Markdown → 再喂 MarkItDown/Docling/pdftotext | CLI spawn（两步流水线） |
| **GROBID 0.9.1** | 学术 PDF 结构化（header/引用/正文 TEI） | Docker `grobid/grobid` 或 Java 部署（难） | Apache-2.0 | 随镜像发布的 CRF/Delft 模型（仓库内，Apache-2.0 项目） | Java 21 + Docker；纯 CPU | <1 秒/篇 [估] | **TEI XML**，需自写 TEI→Markdown/content_list 映射 | REST `:8070 /api/processFulltextDocument` |
| **Unstructured 0.27.36** | 通用元素切分（RAG 向） | `pip install 'unstructured[all-docs]'`（难，114 依赖） | Apache-2.0 | 依赖/模型混合（layout/OCR 模型各自许可），需逐一审计 | hi_res 版面模型 CPU 可跑但慢；安装 GB 级 | 数十秒/篇 [估] | elements JSON（带 bbox）→ 可合成 content_list | Python-only（无官方 REST），需 shim |
| **Ollama + VLM** | 页面 OCR / 兜底（T3） | 装 Ollama + `ollama pull`（中，模型 5–6 GB） | Ollama MIT | Qwen3-VL-8B / Qwen2.5-VL-7B / MiniCPM-V-4.5 / granite-docling-258M 均 **Apache-2.0** | 7–8B Q4 需 ~6 GB 显存/内存；CPU 很慢 | GPU 数秒–30 秒/页；CPU 1–5 分钟/页 [估] | 逐页文本，无结构/图片 → 合成 content_list（page_idx 可靠） | HTTP `127.0.0.1:11434`（Node fetch 直连） |

\* 耗时均为公开文档口径 + 量级估计，**未在本机实测**；解析速度强依赖 CPU 核数、PDF 复杂度、是否首次下载模型。

### 1.1 版本 / 体积取证快照（2026-11-06，PyPI JSON API）

| 包 | 版本（发布日期） | wheel 体积 | 关键依赖体积 |
|---|---|---|---|
| `mineru` | 4.1.7（2026-11-04） | 3.67 MB | 59 deps；base 含 `onnxruntime`~23 MB、`mineru-llama-cpp`~20.5 MB、`pypdfium2`~4.9 MB；torch 仅 Apple Silicon/[torch]/[full] |
| `magic-pdf`（旧名） | 1.3.12（2025-05-24，AGPL-3.0） | 10.79 MB | 已被 `mineru` 取代 |
| `marker-pdf` | 2.1.0（2026-10-29） | 0.19 MB | 依赖 torch≥2.7（Linux 514 MB）、surya-ocr、transformers、anthropic/openai/google-genai |
| `docling` | 2.148.0（2026-11-05） | 0.01 MB（元包） | `docling-slim[standard]`；torch 514 MB（Linux）/132 MB（macOS arm64）；`docling-parse` ~10 MB；模型 ~0.5 GB |
| `markitdown` | 0.1.9（2026-10-21） | 0.09 MB | 核心仅 bs4/markdownify/magika/requests；`[pdf]` 加 pdfminer.six + pdfplumber |
| `paddleocr` / `paddlepaddle` | 3.7.0 / 3.3.1 | 0.14 MB / **185.8 MB**（Linux） | Paddle 框架 wheel 大是主要成本 |
| `rapidocr` | 3.10.0 | 26.0 MB（含模型） | onnxruntime 22.7 MB |
| `surya-ocr` | 0.23.0 | 0.2 MB | torch + transformers + 推理服务 |
| `ocrmypdf` | 17.13.0 | 0.54 MB | 需系统 tesseract + ghostscript |
| `unstructured` | 0.27.36 | 1.6 MB | **114 deps**（`[all-docs]` 还会拉 CV/OCR 栈） |
| `docling-serve` | 1.38.2 | 0.3 MB | MIT，FastAPI 服务 |

---

## 2. MinerU 本地版 4.x（**首选侧车**）

### 2.1 解决什么场景
与云端同源的本地解析：PDF / 图片 / Office / HTML → 结构化 Markdown，覆盖扫描件 OCR、
公式、表格、双栏阅读顺序。**无 Token、离线、隐私敏感、超过云端轻量档 10 MB/20 页**的用户
都可以用；也是唯一能「本地结果与云端结果大体同构、随时可切回云端」的引擎。

### 2.2 质量证据
- OmniDocBench 官方榜单（<https://github.com/opendatalab/OmniDocBench>，2026-03-31 轮）：
  **MinerU2.5-Pro 95.75**（Overall）、MinerU-2.5 93.04、MinerU-Pipeline 86.47；
  同表 Marker 78.44、olmOCR 85.74、Gemini 3 Pro 92.91、PaddleOCR-VL-1.6 96.34。
- MinerU 官方 changelog：3.0.0（2026-03-29）pipeline 后端 OmniDocBench v1.5 得 86.2；
  3.1.0 起主 VLM 升为 MinerU2.5-Pro，4.1.7 为当前稳定版
  （<https://opendatalab.github.io/MinerU/reference/changelog/>）。
- **与云端 standard 的差异未实证**：云端 `model_version=vlm|pipeline` 的服务端模型版本不公开，
  本地 4.1 用 MinerU2.5-Pro-2605-1.2B。建议接入前做 3–5 篇论文的 golden test（md 文本相似度 +
  content_list 结构），不要向用户承诺「与云端结果一致」。

### 2.3 安装与新手可行度（中）
官方推荐（README <https://github.com/opendatalab/MinerU>）：
```bash
# 1) 装 uv（Python 包管理器，自带 Python 下载）
# 2) 一条命令装 MinerU（>=4.0,<5，Python 3.11–3.14）
uv tool install --python 3.12 "mineru>=4.0,<5"
# 或 pipx install --python python3.12 "mineru>=4.0,<5"
mineru-kit parse paper.pdf -o paper.md --tier standard
```
- 首次解析会下载模型（basic≈0.8 GB，standard≈2 GB，可 `mineru-kit models download --tier standard`
  预下载）；支持 `model.source=modelscope` 中国镜像。
- 平台：Windows / Linux / macOS 均支持 CPU 推理；GPU 走 DirectML（Win）/WebGPU（Linux）/
  MPS（Mac）；NVIDIA 高吞吐用 `mineru[full]`（vLLM）。
- 新手难度：**需要开终端**，但 uv 会代管 Python，步骤比 Docling/Marker 少；Windows 可用
  PowerShell。真正的门槛是「2 GB 模型下载 + 首次解析等待」。

### 2.4 硬件门槛 / 耗时（官方口径）
| 档位 | 模型引擎 | 模型下载 | 最低内存 | 加速器 | 质量/速度定位 |
|---|---|---|---|---|---|
| `flash` | 无模型（原生文本） | 0 | — | 不需要 | 最低质量、最快；Office/HTML 等原生格式固定用这档 |
| `basic` | ONNX | ~0.8 GB | 2 GB | CPU 可跑 | 基础质量、中等速度 |
| `basic` | PyTorch | ~0.8 GB | 8 GB | 建议 GPU/MPS | 同上 |
| `standard` | ONNX + llama.cpp | ~2 GB | 8 GB | **CPU 可跑**（Vulkan 建议） | 标准高质量；官方称有合适硬件时速度接近 basic |
| `standard` | PyTorch + llama.cpp | ~2 GB | 16 GB | 需 GPU/MPS（8 GB+ VRAM） | 同上 |
| `advanced` | PyTorch + vLLM/lmdeploy/mlx | ~3 GB | 16 GB | 需 GPU（8 GB+ VRAM） | 最难文档、最慢 |

官方另注：高吞吐部署建议 ≥16 GB 内存；8 GB VRAM 只是规划起点；**CPU 逻辑核 ≥12 才会自动
推荐 standard，4–11 核只到 basic，<4 核只有 flash**（`usage/tiers/`）。

### 2.5 许可证（代码与权重分开，**2026 年已重大变化**）
- **代码**：自 3.1.0（2026-04-18）起从 **AGPLv3 改为 MinerU Open Source License = Apache-2.0 +
  附加条款**（<https://github.com/opendatalab/MinerU/blob/master/LICENSE.md>）：
  ① 商业使用免费，但 MAU>1 亿或月收入>$2000 万需单独商业许可；② 基于 MinerU 提供在线服务
  须显著标注使用了 MinerU；③ 违反则许可自动终止。对本插件（本地工具、非在线服务）**合规无压力**。
  同一许可版本线还有一次模型清理：**3.0.0（2026-03-29）**移除 2 个 AGPLv3 模型（doclayoutyolo、
  mfd_yolov8）与 1 个 CC-BY-NC-SA 4.0 模型（layoutreader），**3.1.0（2026-04-18）**才切换许可
  （changelog 分属两个版本，不是同一版本；见官方 changelog）。这是可商用化的关键。
- **权重**：`MinerU2.5-Pro-2605-1.2B` 模型卡 **apache-2.0**；`MinerU-4_models_torch` **apache-2.0**；
  `MinerU-4_models_onnx` 模型卡说明「原模型许可与署名仍适用」，需按 `manifest.json` 逐项审计
  （含 PP-OCR/PP-FormulaNet 系，多为 Apache-2.0）。
- ⚠️ 旧版 `MinerU2.5-2509-1.2B` 权重是 **agpl-3.0**；若用户机器装的是 2.x/3.0.x，许可状态不同。
  探测时务必读版本，报告里不要笼统写「MinerU 是 AGPL」或「MinerU 全 Apache」。

### 2.6 产物与契约映射
- `mineru-kit parse x.pdf -o out --format zip` → `markdown.md`（→ `parsed/full.md`）、
  `images/`（→ `parsed/images/`）、`middle_json.json`（`schema:"docvortex.middle"`, `schema_version:"2.0"`，
  `pages[].blocks[]` 带零基 `page_idx`、bbox、标题层级线索）。
- `content_list.json`：v1 建议先按「无 content_list」降级（现阅读器已支持）；v2 用
  `middle_json.json` 在 Node 侧合成纯数组（`type/text/page_idx/bbox/text_level`），
  或调用 `mineru.render.render(..., RenderFormat.CONTENT_LIST)`（需 Python 脚本）。
- 也可直连本地服务：`mineru-kit api-server --host 127.0.0.1 --port 8000 --tier standard`
  → `/v1/tasks`（提交 manifest、PUT 上传、轮询、按 file_id 取 result），`/docs` 有 OpenAPI；
  单文件同步可加 `mineru-kit file-parse-server`（默认 8003）。
- 探测与版本：`mineru version --json`、`mineru-kit --help`、`mineru-kit hardware detect --json`、
  `mineru server status --json`。

### 2.7 主要风险
- **CLI/API 变动快**：4.1 的 `/v1/tasks` 取代旧 `/v1/uploads`+`/v1/parse/jobs`（breaking）；
  必须锁定 `>=4.0,<5` 并在探测时按大版本分流（2.x/3.x 的输出 flag 不同）。
- 首次运行下载 0.8–3 GB 模型；公司网络/代理可能失败，需 `MINERU_MODEL_SOURCE=modelscope` 或离线
  预下载；插件不能静默下载，必须有进度/超时/取消。
- Python 运行时 + 2 GB 磁盘对「普通用户」仍是明显门槛；且 window 上首次 `uv` 安装需要网络。
- 4.1 起原生 Office 仅 `flash` 档；想要 Office 高质量需先 Office→PDF（见 §9）再走 standard。

---

## 3. Marker（datalab）

- **场景**：高质量 PDF→Markdown/JSON，GPU 机器上的「快 + 准」型转换器；也支持图片/Office
  （`marker-pdf[full]`）。
- **质量证据**：官方 olmocr-bench（1,403 PDF、~8,400 断言）自报 **balanced 76.0% / 纯数字版
  83.5%**，并称「优于 MinerU 与 docling、吞吐约为 MinerU 的 5 倍」（GPU 口径，厂商自测，
  <https://github.com/datalab-to/marker#benchmarks>）。第三方 OmniDocBench 榜单 Marker 78.44。
  两者结论有张力（不同 benchmark），建议以 OmniDocBench 与自有 golden test 为准。
- **安装**：`pip install marker-pdf` + PyTorch；GPU 需 `vllm`（Docker + NVIDIA Container Toolkit），
  CPU/Apple Silicon 需 `llama.cpp` 的 `llama-server`。CLI `marker_single file.pdf
  --output_format [markdown|json|html|chunks] --output_dir out`；`marker` 跑目录。
- **硬件/耗时**：`balanced` 需 GPU（最佳质量）；`fast` 面向 CPU/MPS；`fast, no OCR`（纯 pdftext +
  20M 版面模型）**完全不需要 GPU**；`--disable_ocr` 完全关闭 VLM。
- **许可证**：代码 **Apache-2.0**；权重 **修改版 AI Pubs Open Rail-M**——研究/个人/融资或营收
  <$500 万免费，超出需商业授权（<https://www.datalab.to/pricing>）。对本插件问题不大，但必须
  在文档中披露。
- **产物映射**：markdown/json/html/chunks；JSON 是带 page/bbox 的树，可合成 content_list；
  图片可导出。
- **Host 集成**：spawn `marker_single`，超时/取消同 CLI；它没有面向解析的稳定本地 REST。
- **风险**：依赖重（torch + LLM SDK + surya），GPU/Docker 门槛高；权重商业门槛；质量模式
  与 CPU 模式差距大，不适合作为「普通用户默认」。

---

## 4. Docling（IBM，**次选侧车**）

- **场景**：通用文档结构化（PDF/DOCX/PPTX/XLSX/HTML/EPUB/图片），CPU 友好，产物是统一
  `DoclingDocument`，可导出 Markdown / JSON / HTML / DocTags；内置 OCR（easyocr/rapidocr/tesseract
  可选）、表格结构、公式、代码块；支持 MCP 与 REST 服务。
- **质量证据**：arXiv 2408.09869（Docling 技术报告）；OmniDocBench 历史上评测过 Docling
  （2025-01-16 加入），当前榜单只在版面检测表保留 `docling-layout-heron` 一栏，**没有最新
  端到端 Overall 数字**；Marker 官方对比称优于 docling。结论：**可用、干净、但独立质量证据弱于
  MinerU2.5-Pro / PaddleOCR-VL**，适合「有文本层 + 常规版式」的论文。
- **安装**：`pip install docling`（Python ≥3.10；CPU-only 可用
  `--extra-index-url https://download.pytorch.org/whl/cpu`）；CLI `docling file.pdf` 生成 .md，
  `--to json` 出无损 JSON，`--pipeline vlm --vlm-model granite_docling` 可选 VLM。
- **硬件/体积**：纯 CPU 可跑；torch wheel Linux 514 MB/macOS 132 MB + 模型
  `docling-layout-heron` 163.7 MB、TableFormer accurate 213 MB/fast 145 MB、docling-parse ~10 MB
  → 安装后 **2–3 GB** [估]；磁盘/内存低于 MinerU standard。
- **许可证**：代码 **MIT**；模型 `docling-layout-heron` **Apache-2.0**，`ds4sd/docling-models`
  **CDLA-Permissive-2.0 + Apache-2.0**——本项目里许可最干净的重型引擎。
- **服务化**：`pip install docling-serve` + `docling-serve run --enable-ui` → REST
  `http://127.0.0.1:5001`（`/docs` 交互文档、`/v1/convert/source` 同步、`.../async` 异步），
  或 `podman/docker run -p 5001:5001 quay.io/docling-project/docling-serve`。docling-serve 也是 MIT。
- **产物映射**：`--to md` → full.md；`--to json` 的 DoclingDocument 含 pages/bbox/图片引用，
  可合成 content_list；图片需显式导出选项（`generate_picture_images`）。
- **探测**：`docling --version`（或 `python -c "import docling; print(docling.__version__)"`）、
  `docling-serve --version`、GET `http://127.0.0.1:5001/docs`。
- **风险**：表格/公式质量不如 MinerU2.5-Pro；模型下载与 torch 体积；版本迭代快（2.148.x 周更）；
  OCR 依赖 easyocr（torch）或 rapidocr（onnxruntime）需另装 extra。

---

## 5. MarkItDown（微软，**最轻兜底**）

- **场景**：把「有文本层」的 PDF、DOCX/PPTX/XLSX、HTML、EPUB、邮件等快速转 Markdown；面向
  LLM 文本消费，不追求高保真。
- **质量边界**（README 原话）：*"the output is often reasonably presentable and human-friendly…
  may not be the best option for high-fidelity document conversions for human consumption"*
  （<https://github.com/microsoft/markitdown>）。PDF 走 pdfminer.six/pdfplumber 的纯文本抽取，
  **不做版面分析、阅读顺序、表格/公式重建、不加图片**；扫描件无 OCR（官方 `markitdown-ocr`
  插件要靠外部 LLM Vision，不是本地 OCR）。
- **安装**：`pip install 'markitdown[pdf, docx, pptx, xlsx]'`（或 `[all]`）；CLI
  `markitdown file.pdf -o out.md`。核心依赖只有 bs4/markdownify/magika/requests 等，
  磁盘几十 MB，**新手最容易装成功**。
- **许可**：代码 **MIT**；无模型权重。
- **产物映射**：仅 Markdown；无 `page_idx`、无图片、无表格坐标 → `contentList=null`（阅读器可降级，
  但无页码标记/按页修复），`pages` 用现有 `meta.parse.pages` 兜底。
- **Host 集成**：spawn CLI，毫秒–秒级，超时 30 秒足够；也可用其 Python 包但没必要。
- **定位**：**T2 的最低成本兜底**，或「Office/HTML 输入的快速通路」；不要用于扫描件、公式/图表
  密集论文。与 `officeToPdf` 相比，它直接读 OOXML 更快，但不保留排版。

---

## 6. OCR 线（扫描件 / 无文本层 PDF）

> 触发条件：T0 文本层提取为空或字符数/页异常低（`local-empty-text`）；优先引导「云端 standard
> 或 T2 光学引擎」，而不是静默降级。

### 6.1 OCRmyPDF + Tesseract
- **场景**：给扫描 PDF 加不可见的 OCR 文字层，产出仍可当普通 PDF 用；然后交给 MarkItDown /
  Docling / pdftotext 提文本。**不产出 Markdown**。
- **安装**：Debian/Ubuntu `apt install ocrmypdf`；Fedora `dnf install`；macOS `brew install ocrmypdf`；
  **Windows 只能 WSL**（官方 README 安装表）。依赖 Tesseract + Ghostscript。
- **许可证**：OCRmyPDF **MPL-2.0**；Tesseract **Apache-2.0**；Ghostscript **AGPL-3.0** ⚠️
  （本地个人使用无碍；若要随插件分发/商业打包需评估）。tessdata 语言包 Apache-2.0。
- **硬件/耗时**：纯 CPU，2–10 秒/页 [估]；中文需下载 `chi_sim` 等语言包。
- **集成**：两步流水线 `ocrmypdf --skip-text in.pdf out.pdf` → 再提文本；spawn CLI，超时按页数缩放。
- **新手**：Linux/macOS 中等，Windows 差；不如直接用 T2 的 PaddleOCR/RapidOCR。

### 6.2 PaddleOCR / PaddleOCR-VL（**质量天花板候选**）
- **场景**：OCR + 文档解析。`PP-StructureV3` 输出 Markdown/JSON（含文字/表格/单元格坐标）；
  `PaddleOCR-VL-1.6`（0.9B）是当前 OmniDocBench 最高分小模型之一。
- **质量证据**：OmniDocBench **PaddleOCR-VL-1.6 = 96.34**（> MinerU2.5-Pro 95.75）；
  PaddleOCR README 自报 96.3%（<https://github.com/PaddlePaddle/PaddleOCR>）。
- **许可证**：代码 **Apache-2.0**；`PaddlePaddle/PaddleOCR-VL*`、`PaddleOCR-VL-1.6` 权重
  **Apache-2.0**（HF 模型卡实测）。这是「质量 + 许可」都很好的一条线。
- **安装**：`pip install paddleocr paddlepaddle`；paddlepaddle Linux wheel **185.8 MB**，另下载
  0.9B 权重；新手难度中偏难（Paddle 生态依赖多、GPU/CPU 版本选择）。
- **短板**：CLI/服务形态与 CPU 推理速度、显存需求尚未在本机验证（官方示例以 GPU 为主）；
  PP-StructureV3 输出结构与云端 `content_list` 不同，需要适配；语言/版面选项多。
- **结论**：**P2 阶段值得单独 spike**（如果 CPU 可行，它可能是比 MinerU 本地更好的默认）；
  在验证前不写进首推路径。

### 6.3 RapidOCR（**最轻 OCR**）
- **场景**：纯 CPU、ONNX Runtime、无需 torch 的 OCR；适合扫描件文字层兜底。
- **安装**：`pip install rapidocr onnxruntime`（README 的安装行）；磁盘 ~50 MB；Apache-2.0。
- **许可细节**：项目 **Apache-2.0**；内置模型「derived from official PaddleOCR models，
  上游权重版权归百度/PaddleOCR 权利方」，按 Apache-2.0 使用需保留署名（README License/Models 段）。
- **产物**：文字框 + 文本 + 置信度；**没有版面结构/Markdown**，需要自写「按行聚类 → 段落 →
  Markdown」逻辑（与 T0 合成的 `local-synth` 共用思路），content_list 可按页合成 text 块。
- **集成**：以 Python API 为主（CLI 形态未验证），Node Host 需 `python -c` shim 或先落一个本地小服务；
  对「零 npm 依赖的 Host」而言比 MinerU/Docling 麻烦一点。
- **结论**：可作 T2 的 OCR 后端备选；不作为默认推荐。

### 6.4 Surya
- 定位：OCR / 版面 / 表格 / 阅读顺序（Marker 的底座），2.x 起是 VLM + 独立推理服务。
- **许可证**：代码 **Apache-2.0**；权重 **修改版 AI Pubs Open Rail-M**（$5M 门槛，同 Marker）。
  **注意**：Surya 历史上曾为 GPL-3.0，当前 README 明确标注 Apache-2.0 代码 + OpenRAIL-M 权重；网上旧资料不可作为依据（改版日期未核实）。
- 需求：`pip install surya-ocr` + vllm（GPU）或 llama.cpp（CPU）；属于「自己搭推理服务」，
  对普通用户不现实；仅作 Marker 依赖理解。
- 输出：HTML/表格/OCR 文本；无 content_list。

---

## 7. 学术专用：GROBID / Unstructured

### 7.1 GROBID 0.9.1（Apache-2.0，Java/Docker）
- **场景**：把学术 PDF 解析成 **TEI XML**：header 元数据（标题/作者/摘要/关键词）、正文结构、
  参考文献、引用、致谢等。**不是 Markdown 引擎**，但对「文献库元数据 + 参考文献」价值独特。
- **质量**：学术解析领域多年的事实标准（GROBID 论文与项目主页
  <https://github.com/kermitt2/grobid>，最新 release **0.9.1 / 2026-08-04**，0.9.0 / 2026-04-07）。
- **安装**：Docker（`grobid/grobid` 或 `lfoppiano/grobid` 镜像）最简单；Java 部署需 JDK。
  REST：`:8070 /api/processFulltextDocument`（返回 TEI XML），`:8070/api/version`。
- **硬件/耗时**：纯 CPU，<1 秒/篇 [估]；Docker 镜像与 Java 运行时为安装成本 [估 1 GB 级]。
- **许可**：**Apache-2.0**（LICENSE 实测），模型随仓库发布，无额外权重限制。
- **集成**：Node `fetch` POST 到本地 8070；TEI→Markdown/content_list 需自写映射（`<pb>` 可给页码，
  `<div>/<p>/<head>` 可给标题层级）——工作量大，建议只用于**元数据/参考文献**，正文仍交
  MinerU/Docling。
- **新手**：Docker 门槛高；不建议进普通用户路径。

### 7.2 Unstructured 0.27.36（Apache-2.0，但依赖复杂）
- **场景**：通用元素切分（Title/NarrativeText/Table/Image…），带 `metadata.coordinates`，
  天然适合合成 content_list；`hi_res` 模式有版面模型、可接 OCR。
- **许可**：代码 **Apache-2.0**（PyPI + pyproject），但**依赖与模型许可混杂**（OCR/版面模型
  各自许可，`[all-docs]` 会拉 PaddleOCR/Tesseract/detectron2 等），需要逐项审计——「许可证复杂度」
  正是它不适合作为默认侧车的原因。
- **安装**：`pip install 'unstructured[all-docs]'`，**114 个基础依赖**，安装后 GB 级、依赖冲突常见；
  无官方 REST（Python only），Node Host 集成需 shim。
- **质量**：OmniDocBench 仅出现在版面检测对照表（Unstructured 0.16.23），无最新端到端分数。
- **结论**：暂不推荐；若未来需要「元素级坐标 + 表格 HTML」，可作为参考实现。

---

## 8. 本地 VLM（T3，简要）

- **形态**：Ollama 本地推理 + 视觉模型，Node Host 直接 `fetch http://127.0.0.1:11434/api/generate`
  （base64 图片），逐页 OCR/转写，再拼 Markdown + 按页合成 content_list。
- **候选与体积**（`ollama.com/library`，2026-11-06）：
  `qwen3-vl:8b` 6.2 GB（8B 档；Qwen3-VL-8B-Instruct 权重 **Apache-2.0**）、
  `qwen2.5vl:7b` 6.0 GB（Apache-2.0）、`minicpm-v:8b` 5.5 GB（MiniCPM-V-4.5 **Apache-2.0**）、
  `granite-docling-258M`（Apache-2.0，未上 Ollama 库，需走 Docling 的 vlm pipeline）。
- **硬件门槛**：7–8B Q4 需约 6 GB 显存（或 16 GB 内存 CPU 推理）；CPU 版 1–5 分钟/页 [估]，
  GPU 数秒–30 秒/页 [估]；整库多篇论文不现实。
- **质量**：通用 VLM 在文档解析上不如专用小模型——OmniDocBench：Qwen3-VL-235B 89.78、
  GPT-5.2 86.59，而 MinerU2.5-Pro 95.75、PaddleOCR-VL-1.6 96.34；小参数 VLM 的表格/公式更弱，
  且存在**幻觉/漏字**风险（OCR 场景不可接受）。
- **许可**：Ollama MIT；上列权重均 Apache-2.0（Qwen 72B 等大模型另有 Qwen License，未列入）。
- **结论**：只适合「极端离线 + 扫描件 + 用户已有大显存 GPU」的兜底，不进推荐路径；不要宣传为
  与 MinerU 等质量。

---

## 9. Office 输入复用：DSH 内置 `office-to-pdf`

### 9.1 事实核实
- **web profile 已挂载**：`@deepseek-ai/dsh-web-app` bundle 的 `cordis.patch.yml` 含
  `- id: office-to-pdf / name: '@deepseek-ai/dsh-office-to-pdf'`；本机 web profile 的
  `package.json` bundles 列表包含 `@deepseek-ai/dsh-web-app` → 运行中的 Host 有
  `ctx.get('officeToPdf')` 服务（服务名在 `lib/index.js` 里注册为 `"officeToPdf"`）。
- **API**：`convert(request, signal) → Promise<{ pdf: Uint8Array, missingFonts, cacheKey, generation }>`；
  request = `{ extension: 'doc'|'docx'|'xls'|'xlsx'|'ppt'|'pptx', priority: 'foreground'|'background',
  source: { key, version, bytes?, read(signal, maxBytes) } }`（deferred bounded read，宿主做授权与
  版本校验）。配置默认：输入 ≤ 50 MB（`maxInputBytes 52428800`）、输出 ≤ 100 MB、超时 60 s、
  并发 2。
- **引擎**：`@deepseek-ai/libreoffice-kit`（**MPL-2.0**）按平台选原生包；其
  `optionalDependencies` 只有 darwin-arm64 / darwin-x64 / win32-x64 / win32-arm64 / wasm，
  **没有 Linux 原生包** → Linux 上走 `@deepseek-ai/libreoffice-kit-wasm`（本机 pnpm store 已装
  `libreoffice-kit-wasm@0.1.5`）。`dsh-office-to-pdf` 包本身 **MIT**。
- **限制**：WASM 转换比原生慢、字体缺失（`missingFonts` 需回传 UI）、不支持加密/宏文档；
  `timeoutMs` 60 s 对超大 PPT 可能不够。

### 9.2 在本方案中的价值
1. **T0.5 免费增强**：Office 文档（doc/docx/ppt/pptx/xls/xlsx）→ 本地 PDF，再交给 T0 文本层提取
   或 T2 侧车。用户无需装 LibreOffice。
2. **对 MinerU 本地版尤其重要**：MinerU 4.1 对原生 Office 只给 `flash` 档（低质量）；先
   `officeToPdf` 转 PDF，再走 **standard** 档才能得到高质量 Office 解析。这是「Office 输入
   本地高保真」的唯一低成本路径。
3. **兜底一致性**：云端 standard 原生支持 Office（200 MB）；本地路径用 officeToPdf 后与 PDF 路径
   共用同一套解析器，产物同构。

### 9.3 风险
- WASM 渲染质量/字体（尤其中文 Office 文档在无中文字体环境会缺字）；`missingFonts` 必须提示用户。
- 60 s 超时、50 MB 上限；失败要能降级到「云端 standard（有 Token）」或 MarkItDown 直读 OOXML。
- 该服务在 `dsh-web-app` bundle 里是**默认挂载**，但独立组合（非 web profile）可能没有 → 必须
  `ctx.get('officeToPdf')` 判空 + 能力声明，不能硬依赖。

---

## 10. 推荐组合与检测策略

### 10.1 引擎选择树（建议）

```
输入文件
├─ .doc/.docx/.ppt/.pptx/.xls/.xlsx
│   ├─ 有 officeToPdf（T0.5）→ 转 PDF → 进入 PDF 分支（本地高保真）
│   └─ 无 officeToPdf → MarkItDown（T2，直读 OOXML，速度快、丢排版）
├─ .html/.htm/.epub/.txt → MarkItDown（T2）或现有 T0 HTML→MD
├─ .pdf
│   ├─ 文本层可用（T0 内置提取成功）→ T0 直接可用；用户可选 T2 提升结构质量
│   ├─ 文本层为空/极低（扫描件）
│   │   ├─ 用户有 T2 MinerU 本地版 → standard/basic 档（含 OCR）
│   │   ├─ 有 OCRmyPDF+Tesseract / PaddleOCR / RapidOCR → OCR 文字层后再 T0/T2
│   │   └─ 否则提示「配置 Token 用云端精准解析」或安装 T2
│   └─ 用户显式选择 T2 侧车 → 按以下优先级探测第一个可用：
│       MinerU 本地版 4.x > Docling > PaddleOCR(PP-StructureV3) > MarkItDown
└─ 图片 → MinerU 本地版（OCR）或 PaddleOCR/RapidOCR；本地 VLM 仅 T3 兜底
```

### 10.2 探测 / 版本命令表（Host 用，`spawn` 带 2 s 超时、结果缓存 5–10 分钟）

| 引擎 | 可执行文件 | 版本探测 | 就绪/能力探测（可选） |
|---|---|---|---|
| MinerU 本地 4.x | `mineru-kit`、`mineru` | `mineru version --json`；`mineru-kit --help` | `mineru-kit hardware detect --json`；`mineru server status --json`；`mineru-kit models show` |
| MinerU 本地 2.x/3.x | `magic-pdf`、`mineru` | `mineru --version` / `magic-pdf --version` | 输出 flag 不同，需单独适配 |
| Docling | `docling` | `docling --version` 或 `python -c "import docling;print(docling.__version__)"` | `docling --help` |
| docling-serve | `docling-serve` | `docling-serve --version` | GET `http://127.0.0.1:5001/docs`（HTTP 200） |
| MarkItDown | `markitdown` | `markitdown --help`（无 `--version` 时以 pip 元数据兜底） | `markitdown --help` |
| Marker | `marker_single` | `marker_single --help` | `pip show marker-pdf` 取版本 |
| PaddleOCR | `paddleocr` | `paddleocr --version` | `python -c "import paddleocr"` |
| RapidOCR | 以 Python API 为主（CLI 未验证） | `python -c "import rapidocr;print(rapidocr.__version__)"` | import 探测 |
| OCRmyPDF | `ocrmypdf` | `ocrmypdf --version` | `tesseract --version`、`gs --version` |
| Tesseract | `tesseract` | `tesseract --version` | `tesseract --list-langs`（中文包 chi_sim） |
| GROBID | `docker`（或 `java`） | `docker --version` | GET `http://127.0.0.1:8070/api/version` |
| Ollama | `ollama` | `ollama --version` | GET `http://127.0.0.1:11434/api/tags`（列模型） |
| 系统 PDF 工具（T1） | `pdftotext`、`pdftoppm`、`mutool`、`soffice` | `pdftotext -v`、`soffice --version` | `command -v` |

探测安全约束（与 `docs/research/integration.md` §4.5 一致）：命令与参数来自**可信配置**、
不经客户端；`spawn(cmd, args, { shell:false })`；PATH 与 cwd 固定；输出上限；超时后杀进程树
（Windows `taskkill /T /F`）；只有在用户显式选择「本地/侧车」时才运行；版本不满足（如 MinerU
<4.0 或 >=5.0）时给出明确提示而不是硬跑。

### 10.3 输出契约映射与合成（实现要点）

| 引擎 | full.md | content_list.json | images/ | 页码 |
|---|---|---|---|---|
| MinerU 4.x zip | `markdown.md` 重命名 | `middle_json.json` 合成（推荐）或 python render V1/V2 | `images/`（新命名规则） | middle_json `page_idx`（0 基） |
| Docling | `--to md` | `--to json`（DoclingDocument）合成 | 需显式导出 picture | JSON page 序号 |
| MarkItDown | CLI 输出 | 无 → `null`（阅读器降级） | 无 | 无（用 `meta.parse.pages`） |
| Marker | `output.md` | JSON 树合成 | marker 导出的 images | JSON page_id |
| OCR 线 | 由文本层再提取 | 按页合成 text 块（`page_idx` 可靠） | 页面图片可选 | 可靠 |
| VLM | 逐页拼接 | 按页合成 | 无 | 可靠 |

合成规则沿用 `docs/research/integration.md` §3.3：写**纯数组**、字段 `{page_idx,type,text,text_level?}`，
不写 `<!-- page: N -->` 之类 Markdown 页码标记；`text` 必须与 full.md 的 block 文本同源，防止
页标记漂移。v1 可先 `keepContentList:false`（=保持 `contentList=null` 的优雅降级），v2 再开放。

### 10.4 安装 UX 分级（给普通用户的落地文案）

- **A. 零安装**：不提示任何安装；扫描件/复杂版式时提示「配置 Token 解锁精准解析」。
- **B. 一条命令（推荐）**：设置面板给可复制命令 + 官方链接：
  - MinerU 本地版：`uv tool install --python 3.12 "mineru>=4.0,<5"`（Windows 用 PowerShell 安装 uv 后同命令）；
    首次解析前提示「将下载约 2 GB 模型，耗时取决于网速」。
  - Docling：`uv tool install docling`；MarkItDown：`uv tool install "markitdown[pdf,docx,pptx,xlsx]"`。
  - 插件**不代跑**安装命令（网络/权限/供应链风险），只做「复制命令 + 完成后点重新检测」。
- **C. 专家模式**：OCRmyPDF/Tesseract（包管理器）、GROBID（Docker）、Marker（PyTorch + vLLM/llama.cpp）、
  docling-serve / MinerU api-server（本地 HTTP）——在设置里手填命令/URL。
- **Windows 特别提示**：MinerU 支持 Windows CPU；Docling 支持；MarkItDown 支持；OCRmyPDF 仅 WSL；
  GROBID 需 Docker Desktop；Marker GPU 模式需 Linux/Docker + NVIDIA。

---

## 11. 风险与未决问题

### 11.1 主要风险（按严重度）
1. **「本地 = 高质量」预期错误**：T0/T1 与轻量 T2（MarkItDown）在双栏、公式、表格、扫描件上
   会明显退化；必须用质量 banner/`local-empty-text`/provider 标注向用户暴露真实来源。
2. **MinerU 契约漂移**：4.1 breaking（`/v1/tasks` 取代旧 API；`content_list` 不再直接落盘）；
   2.x/3.x/4.x 三套 CLI/输出。必须锁版本 + golden test + 版本分支。
3. **许可误读**：MinerU 代码 2026-04 已改 Apache-2.0+条款（旧资料说 AGPL）；权重新旧不同
   （Pro-2605 Apache vs 2.5-2509 AGPL）；Marker/Surya 权重 OpenRAIL-M 有 $5M 门槛；Ghostscript
   AGPL；PyMuPDF 双许可 AGPL/商业（勿引入）。报告与 UI 必须按「代码/权重」分别标注。
4. **安装与运行环境**：Python/uv/venv、PATH、Windows 长路径/编码、代理、2 GB 模型下载、
   首次解析几十分钟——普通用户失败率高；离线预下载/镜像源/明确错误提示是必需品。
5. **安全**：spawn 用户侧车 = 执行本机二进制。必须 `shell:false`、可信配置、超时、输出上限、
   进程树清理、staging 目录 `resolveWithin` 校验；禁止客户端指定命令。
6. **隐私承诺变化**：现 README 说「文件仅在解析阶段上传 MinerU」；加本地引擎后需重写隐私说明
   （本地解析不上传），并避免用户误以为「本地=一定不上传」（agent 轻量仍是云端）。
7. **磁盘与并发**：多引擎共存可能吃掉 3–6 GB；并发解析在 CPU 上会互相拖慢 → 本地引擎并发
   建议 1，云端仍 2。
8. **Office 语义**：officeToPdf WASM 字体缺失、60 s 超时、50 MB 上限；MinerU 原生 Office 仅
   flash 档——必须写清「Office 高质量 = 先 officeToPdf 再 standard」。

### 11.2 未决问题（需要 spike / 实测）
- [ ] **MinerU 4.1 本地 standard 与云端 standard 的实际差异**：3–5 篇代表性论文（双栏、公式、
  表格、扫描件）做 md 文本相似度 + content_list 结构对比；决定是否宣传「同源结果」。
- [ ] **CPU 实测耗时**：12 核/8 核 Linux、Windows 各跑 1 篇 10 页论文的 flash/basic/standard，
  给出可信的 UI 预估（当前只有官方档位描述）。
- [ ] **content_list 方案选型**：Node 从 `middle_json` 合成 vs `python -c` 调 render API；
  需要评估 middle_json schema 稳定性与合成复杂度（推荐先做合成纯函数 + fixture 测试）。
- [ ] **MinerU-4_models_onnx 的逐模型许可审计**：`manifest.json` 列出的上游仓库与许可，确认
  Apache-2.0 兼容后再对外宣称「MinerU 本地全链 Apache-2.0」。
- [ ] **PaddleOCR-VL CPU 可行性**：0.9B 在无 GPU 机器上的速度/内存，以及 CLI/服务形态、
  Markdown/JSON 输出到 content_list 的映射成本；若可行，其质量高于 MinerU2.5-Pro。
- [ ] **RapidOCR / OCRmyPDF 的集成方式**：RapidOCR 的 CLI 形态未验证，是否值得为它写 python shim；
  OCRmyPDF 在 Windows 仅 WSL 的替代方案。
- [ ] **officeToPdf 实测**：Linux WASM 对中文 Office 的缺字率与耗时；与 `soffice`（T1）对比。
- [ ] **安装引导的可行性**：是否随插件提供「安装助手」文档页/DSH skill；如何在不违反权限模型
  的前提下降低普通用户门槛（例如 uv 一键脚本）。
- [ ] **多引擎探测的版本策略**：MinerU 2.x 用户升级到 4.x 是否自动；>=5 的未来兼容计划。

---

## 附录 A：取证来源与命令

**PyPI JSON API**（2026-11-06 实测）：`mineru` 4.1.7、`magic-pdf` 1.3.12、`marker-pdf` 2.1.0、
`docling` 2.148.0、`docling-serve` 1.38.2、`markitdown` 0.1.9、`paddleocr` 3.7.0、
`paddlepaddle` 3.3.1、`rapidocr` 3.10.0、`surya-ocr` 0.23.0、`ocrmypdf` 17.13.0、
`unstructured` 0.27.36、`torch` 2.15.0、`onnxruntime` 1.31.1。
体积字段取各包 wheels 的 `size`（Linux x86_64/macOS/Windows 分别标注）。

**关键 URL**
- MinerU：<https://github.com/opendatalab/MinerU> ·
  <https://opendatalab.github.io/MinerU/usage/tiers/> ·
  <https://opendatalab.github.io/MinerU/reference/output_files/> ·
  <https://opendatalab.github.io/MinerU/reference/changelog/> ·
  <https://opendatalab.github.io/MinerU/usage/model_source/> ·
  <https://opendatalab.github.io/MinerU/quick_start/> ·
  LICENSE <https://github.com/opendatalab/MinerU/blob/master/LICENSE.md> ·
  模型卡 <https://huggingface.co/opendatalab/MinerU2.5-Pro-2605-1.2B>、
  <https://huggingface.co/opendatalab/MinerU-4_models_torch>、
  <https://huggingface.co/opendatalab/MinerU2.5-2509-1.2B>（旧权重 AGPL）
- Marker / Surya：<https://github.com/datalab-to/marker> ·
  <https://github.com/datalab-to/surya> · <https://www.datalab.to/pricing>
- Docling：<https://github.com/docling-project/docling> ·
  <https://docling-project.github.io/docling/getting_started/installation/> ·
  <https://docling-project.github.io/docling/usage/api_server/> ·
  <https://pypi.org/project/docling-serve/> · arXiv:2408.09869 ·
  模型 <https://huggingface.co/docling-project/docling-layout-heron>、
  <https://huggingface.co/ds4sd/docling-models>
- MarkItDown：<https://github.com/microsoft/markitdown>
- OCR 线：<https://github.com/ocrmypdf/OCRmyPDF> · <https://ocrmypdf.readthedocs.io/> ·
  <https://github.com/tesseract-ocr/tesseract> · <https://github.com/PaddlePaddle/PaddleOCR> ·
  <https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6> ·
  <https://github.com/RapidAI/RapidOCR> · <https://rapidai.github.io/RapidOCRDocs/>
- GROBID：<https://github.com/kermitt2/grobid>（0.9.1，Apache-2.0） ·
  <https://grobid.readthedocs.io/>
- Unstructured：<https://github.com/Unstructured-IO/unstructured>
- 质量榜单：<https://github.com/opendatalab/OmniDocBench>（Overall 表：MinerU2.5-Pro 95.75 /
  MinerU-2.5 93.04 / MinerU-Pipeline 86.47 / PaddleOCR-VL-1.6 96.34 / Marker 78.44 /
  olmOCR 85.74 / Gemini 3 Pro 92.91 / Qwen3-VL-235B 89.78 / GPT-5.2 86.59）
- 本地 VLM：<https://ollama.com/library/qwen3-vl>、`/qwen2.5vl`、`/minicpm-v`；
  权重许可 <https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct>、
  <https://huggingface.co/openbmb/MiniCPM-V-4_5>、
  <https://huggingface.co/ibm-granite/granite-docling-258M>
- Office 复用（本仓库/本机取证）：`@deepseek-ai/dsh-web-app` bundle 的 `cordis.patch.yml`
  含 `office-to-pdf` 行；`@deepseek-ai/dsh-office-to-pdf@0.2.2-rc.1`（MIT，`lib/index.js`
  注册服务名 `officeToPdf`，`convert()` 签名见 `lib/types/types.d.ts`）；
  `@deepseek-ai/libreoffice-kit@0.1.5`（MPL-2.0）optionalDependencies 无 Linux 原生包 →
  `@deepseek-ai/libreoffice-kit-wasm@0.1.5` 兜底。

**未做**（按任务约束）：未 `pip install` 任何重型引擎、未跑真实解析、未实测耗时；所有「耗时」与
「安装后磁盘」均标注 [估]，接入前用 golden test + 目标机器实测替换。
