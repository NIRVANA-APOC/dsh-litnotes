/**
 * dsh-litnotes client application (generated into lib/client.js by build-client.mjs).
 *
 * This file is plain browser JS (no JSX/TypeScript). It is an ESM module only
 * for tooling friendliness: the build strips top-level `export ` keywords and
 * inlines it after ui/markdown.js and ui/highlight.js inside the module factory.
 *
 * The three placeholder statements below are REQUIRED verbatim; the build
 * replaces the right-hand sides with the design CSS and SVG art:
 */
const CSS = __MINERU_CSS_JSON__;
const PANEL_ICON = __MINERU_PANEL_ICON_JSON__;
const EMPTY_ART = __MINERU_EMPTY_ART_JSON__;

// ===========================================================================
// 1. Identity, constants, copy deck
// ===========================================================================

const NS = 'dsh-litnotes';
const PANEL_ID = 'litnotes';
const MRU_CLIENT_VERSION = 'client';

/** Accept string for the file picker (mirrors lib/mime.js SUPPORTED_EXTENSIONS). */
const MRU_ACCEPT = '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.png,.jpg,.jpeg,.jp2,.webp,.gif,.bmp,.html,.htm';

/** Annotation ink colors, in swatch order. */
const MRU_COLORS = ['yellow', 'sage', 'sky', 'rose'];

/** Reading modes. */
const MRU_MODES = ['original', 'bilingual', 'translated'];

/** Allowed reading scales. */
const MRU_SCALES = [0.9, 1, 1.12];

/** Client-side defaults; the host merges these with its own preferences. */
const MRU_DEFAULT_PREFS = {
  targetLanguage: 'zh',
  translationProvider: 'auto',
  readingMode: 'original',
  readingScale: 1,
  defaultEngine: 'auto',
  autoAllowAgentFallback: true,
  defaultModelVersion: 'vlm',
  defaultLanguage: 'ch',
  defaultIsOcr: false,
  defaultEnableFormula: true,
  defaultEnableTable: true,
  showPageMarks: true,
  // AI upgrade (docs/AI-SPEC.md §6/§9): host-persisted view state.
  aiPanelOpen: false,
  libraryView: 'library',
  docView: 'read',
  graphAutoBuild: false,
  notesFilter: 'all',
};

/** MinerU document language options (value -> dictionary key). */
const MRU_LANGUAGE_OPTIONS = [
  ['ch', 'setup.langCh'],
  ['en', 'setup.langEn'],
  ['japan', 'setup.langJapan'],
  ['korean', 'setup.langKorean'],
  ['fr', 'setup.langFr'],
  ['de', 'setup.langDe'],
  ['ru', 'setup.langRu'],
  ['es', 'setup.langEs'],
  ['ar', 'setup.langAr'],
];

/** Target languages offered for translation (value -> label). */
const MRU_TARGET_LANGUAGE_OPTIONS = [
  ['zh', '中文'],
  ['en', 'English'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['ru', 'Русский'],
  ['es', 'Español'],
];

/** Maximum selection quote stored on an annotation. */
const MRU_MAX_QUOTE = 2000;

/** Translation concurrency cap for "translate all". */
const MRU_TRANSLATE_CONCURRENCY = 4;

/** Margin tabs: outline / notes / AI conversation (docs/AI-SPEC.md §6). */
const MRU_MARGIN_TABS = ['outline', 'notes', 'ai'];

/** Margin-note origin filter (persisted preference `notesFilter`). */
const MRU_NOTES_FILTERS = ['all', 'ai', 'user'];

/** Library-topbar views: the library rail or the library-wide knowledge graph. */
const MRU_LIBRARY_VIEWS = ['library', 'graph'];

/** Paper runhead views: the reading paper or the per-document knowledge graph. */
const MRU_DOC_VIEWS = ['read', 'graph'];

/** Browser-stored reading-desk layout (UI-only state, like navigation memory). */
const MRU_LAYOUT_KEY = 'dsh-litnotes:layout';
const MRU_LAYOUT_DEFAULTS = Object.freeze({ railWidth: 288, marginWidth: 296, docWidth: 880 });
const MRU_LAYOUT_LIMITS = Object.freeze({
  rail: Object.freeze({ min: 220, max: 460 }),
  margin: Object.freeze({ min: 240, max: 520 }),
});
/** Reading-width presets (px): 窄 / 标准 / 宽 / 全宽. */
const MRU_DOC_WIDTH_PRESETS = Object.freeze([720, 880, 1040, 1200]);
/**
 * Readable-text measure per preset (px). The preset changes both the sheet
 * container and the text column so the reading line itself widens/narrows.
 */
const MRU_DOC_MEASURE_BY_WIDTH = Object.freeze({ 720: 500, 880: 560, 1040: 700, 1200: 840 });
/** Aspect colour legend, single source of truth for the client legend rows. */
const MRU_ASPECT_LEGEND = Object.freeze([
  Object.freeze({ aspect: 'definition', color: 'yellow', labelKey: 'aspect.definition' }),
  Object.freeze({ aspect: 'context', color: 'yellow', labelKey: 'aspect.context' }),
  Object.freeze({ aspect: 'method', color: 'sage', labelKey: 'aspect.method' }),
  Object.freeze({ aspect: 'result', color: 'sky', labelKey: 'aspect.result' }),
  Object.freeze({ aspect: 'limitation', color: 'rose', labelKey: 'aspect.limitation' }),
]);

/** zh dictionary — primary copy deck (docs/UI-SPEC.md §5). */
const ZH = {
  'panel.label': '文献库',
  'brand.name': 'LitNotes 文献库',
  'brand.count': '{count} 篇',
  'topbar.import': '导入文献',
  'topbar.upload': '上传文件',
  'topbar.fromUrl': '从链接导入',
  'rail.title': '文献',
  'rail.search': '搜索标题、文件名或批注',
  'rail.empty': '还没有文献。导入第一篇 PDF 开始。',
  'rail.searchEmpty': '没有匹配的文献',
  'rail.clear': '清除搜索',
  'rail.foot': '共 {count} 篇 · 已解析 {parsed}',
  'status.uploaded': '待解析',
  'status.parsing': '解析中',
  'status.parsed': '已解析',
  'status.failed': '解析失败',
  'empty.title': '把第一篇文献放进来',
  'empty.text': 'PDF、Word、图片或网页都行。MinerU 把它们转成可翻译、可批注的阅读稿。',
  'empty.choose': '选择文件',
  'empty.hint': '也可以直接把文件拖进这个窗口',
  'empty.select': '从左侧选一篇文献',
  'setup.title': '准备解析',
  'setup.text': 'MinerU 会识别版式、公式和表格，把文件转成可翻译、可批注的结构化阅读稿。',
  'setup.engine': '解析引擎',
  'setup.engineAuto': '自动（有 Token 用精准解析，否则优先本地）',
  'setup.engineStandard': '精准解析',
  'setup.engineLocal': '本地解析（离线 · 不上传）',
  'setup.engineLocalUnavailable': '本地解析不可用',
  'setup.engineLocalWhy': '本地解析不可用：{reason}',
  'setup.localReasonDisabled': '已在配置中关闭',
  'setup.localReasonUnavailable': '本机没有可用的本地解析器',
  'setup.localReasonType': '这种文件类型不支持本地解析',
  'setup.engineAgent': '轻量云端解析（免 Token · 会上传文件）',
  'setup.model': '模型',
  'setup.language': '文档语言',
  'setup.pageRanges': '页码范围',
  'setup.pageRangesHint': '留空解析全部，例如 2,4-6',
  'setup.formula': '公式识别',
  'setup.formulaHint': '保留 LaTeX 公式',
  'setup.table': '表格识别',
  'setup.tableHint': '还原表格结构',
  'setup.ocr': 'OCR',
  'setup.ocrHint': '扫描件建议开启',
  'setup.start': '开始解析',
  'setup.note': '精准解析消耗每日解析额度；轻量解析限 10 MB / 20 页。',
  'setup.noteLocal': '本地解析只提取文字层，保留段落与页码；公式、表格、图片与扫描件需云端精准解析。文件不会上传。',
  'setup.tokenWarn': '精准解析需要 MinerU Token。',
  'setup.tokenWarnLocal': '配置 Token 可解锁 MinerU 精准解析（公式/表格/OCR）。',
  'setup.tokenWarnPrivacy': '本地解析无需 Token，文件不会上传。',
  'setup.effectiveStandard': '将使用：MinerU 精准解析',
  'setup.effectiveLocal': '将使用：本地解析',
  'setup.effectiveAgent': '将使用：轻量云端解析（文件会上传）',
  'setup.effectiveBlocked': '将使用：没有可用引擎，请先配置 Token 或启用轻量云端解析',
  'setup.tokenAction': '去设置',
  'setup.langCh': '中文',
  'setup.langEn': 'English',
  'setup.langJapan': '日本語',
  'setup.langKorean': '한국어',
  'setup.langFr': 'Français',
  'setup.langDe': 'Deutsch',
  'setup.langRu': 'Русский',
  'setup.langEs': 'Español',
  'setup.langAr': 'العربية',
  'parsing.text': 'MinerU 正在解析 · {done} / {total} 页',
  'parsing.textNoProgress': 'MinerU 正在解析…',
  'parsing.phaseWaiting': '等待 MinerU 接收文件…',
  'parsing.phaseQueued': 'MinerU 排队中…',
  'parsing.phaseRunning': 'MinerU 正在解析…',
  'parsing.phaseConverting': '正在生成解析结果…',
  'parsing.elapsed': '已用时 {time}',
  'parsing.slowHint': 'pipeline 模型或 OCR 解析较慢（MinerU 侧可能排队数分钟）；完成后会自动进入阅读。',
  'parsing.cancel': '取消',
  'fail.title': '解析没有完成',
  'fail.retry': '重试',
  'fail.otherEngine': '换个引擎',
  'fail.localSuggestion': '换用云端解析或配置 Token',
  'reader.modeOriginal': '原文',
  'reader.modeBilingual': '对照',
  'reader.modeTranslated': '译文',
  'reader.modeGroup': '阅读模式',
  'reader.unknownSymbol': 'MinerU 未能识别此符号（源 PDF 字体或数学斜体字形导致）',
  'reader.unknownNotice': 'MinerU 未能识别本文中的 {count} 处符号，多为数学斜体字形。可以尝试更换解析模型或开启 OCR 重新解析。',
  'reader.translateAll': '翻译全文',
  'reader.translateBlock': '翻译本段',
  'reader.translating': '翻译中…',
  'reader.retryBlock': '重试',
  'reader.loading': '正在载入解析稿…',
  'reader.loadFailed': '解析稿没能载入。',
  'reader.emptyDoc': '这篇解析稿还没有内容。',
  'reader.copy': '复制',
  'reader.more': '更多操作',
  'reader.fontDec': '缩小字号',
  'reader.fontInc': '放大字号',
  'banner.localTitle': '本地解析结果',
  'banner.localText': '本文由本地解析生成：保留文字、段落与页码；公式、表格、图片未还原。',
  'banner.missingFonts': '个别字体缺失，文字可能有缺字。',
  'banner.scanned': '几乎没有提取到文字，可能是扫描件。',
  'banner.upgrade': '配置 Token 解锁精准解析',
  'block.annotate': '高亮并批注',
  'margin.label': '页边',
  'margin.outline': '大纲',
  'margin.notes': '批注',
  'margin.empty': '选中正文后，可以高亮或写下批注。',
  'margin.noteDelete': '删除批注',
  'margin.dropped': '有 {count} 条批注在当前解析稿里找不到位置，已暂时收起。',
  'notes.staleSection': '位置已变化',
  'notes.staleTag': '位置已变化',
  'notes.staleNotice': '重新解析后，{count} 条批注的位置发生变化，原文引用已保留',
  'sel.translate': '翻译',
  'sel.highlight': '高亮',
  'sel.removeHighlight': '取消高亮',
  'sel.note': '批注',
  'sel.copy': '复制',
  'sel.toolbar': '划词工具',
  'sel.colors': '高亮颜色',
  'sel.colorYellow': '黄色高亮',
  'sel.colorSage': '鼠尾草绿高亮',
  'sel.colorSky': '天蓝高亮',
  'sel.colorRose': '玫瑰高亮',
  'selcard.label': '划词翻译',
  'selcard.copy': '复制译文',
  'selcard.error': '翻译暂时不可用。',
  'selcard.retry': '重试',
  'selcard.close': '关闭',
  'noteeditor.title': '批注',
  'noteeditor.placeholder': '写点批注…',
  'noteeditor.save': '保存',
  'noteeditor.cancel': '取消',
  'translate.progress': '正在翻译 · {done} / {total}',
  'translate.cancel': '取消翻译',
  'translate.done': '已翻译 {count} 段',
  'translate.partial': '翻译完成：{done} 段成功，{failed} 段失败',
  'settings.title': '设置',
  'settings.sectionToken': 'MinerU 接入',
  'settings.token': 'API Token',
  'settings.tokenHint': '本地解析无需 Token；配置 Token 可解锁 MinerU 精准解析（公式/表格/OCR）。',
  'settings.tokenPlaceholder': '粘贴 Token',
  'settings.tokenSaved': '已配置 · 保存在本机凭据中',
  'settings.tokenMemory': '已配置 · 仅保存在本次会话（凭据服务不可用）',
  'settings.tokenMissing': '未配置',
  'settings.tokenMissingLocal': '当前默认将使用本地解析（文件不会上传）',
  'settings.sectionLocal': '本地解析',
  'settings.localBuiltin': '内置文字层提取',
  'settings.localPdfTool': '系统 pdftotext',
  'settings.localOffice': 'Office 转换（office-to-pdf）',
  'settings.localRedetect': '重新检测',
  'settings.localAvailable': '可用',
  'settings.localUnavailable': '不可用',
  'settings.localHint': '本地解析不上传文件；扫描件需云端解析或 OCR 侧车。',
  'settings.save': '保存',
  'settings.clear': '清除',
  'settings.close': '关闭',
  'settings.sectionRead': '阅读偏好',
  'settings.targetLang': '目标语言',
  'settings.provider': '翻译服务',
  'settings.providerAuto': '自动',
  'settings.pageMarks': '显示页面标记',
  'layout.resizeRail': '调整文献栏宽度',
  'layout.resizeMargin': '调整页边宽度',
  'layout.resizeHint': '拖动调整宽度，双击恢复默认',
  'layout.widthGroup': '阅读宽度',
  'layout.widthNarrow': '窄',
  'layout.widthStandard': '标准',
  'layout.widthWide': '宽',
  'layout.widthFull': '全宽',
  'aspect.legendTitle': '颜色图例',
  'aspect.definition': '定义',
  'aspect.context': '背景',
  'aspect.method': '方法',
  'aspect.result': '结果',
  'aspect.limitation': '局限',
  'settings.graphAutoBuild': '解析完成后自动生成知识图谱',
  'settings.scale': '正文字号',
  'settings.sectionStorage': '存储',
  'settings.dataDir': '数据目录',
  'settings.version': '版本',
  'menu.reparse': '重新解析',
  'menu.export': '导出 Markdown',
  'menu.delete': '删除文献',
  'menu.translateAll': '翻译全文',
  'menu.more': '更多',
  'confirm.deleteTitle': '删除这篇文献？',
  'confirm.deleteText': '原文、解析稿、高亮和批注都会一起删除，无法恢复。',
  'confirm.delete': '删除',
  'confirm.cancel': '取消',
  'toast.uploaded': '已导入「{name}」',
  'toast.parsed': '解析完成：{title}',
  'toast.parseFailed': '解析失败：{message}',
  'toast.saved': '已保存',
  'toast.copied': '已复制',
  'toast.copyFailed': '复制失败',
  'toast.highlighted': '已高亮',
  'toast.highlightRemoved': '已取消高亮',
  'toast.repaired': '已修复 {count} 页',
  'toast.repairPartial': '已修复 {count} 页，{failed} 页无法对齐',
  'reparse.onlyProblems': '只重新解析有问题的页面（{count} 页）',
  'reparse.onlyProblemsHint': '其余页面的解析结果、高亮与批注都会保留。',
  'reparse.needsToken': '按页修复需要 MinerU Token；没有 Token 时只能整篇用轻量解析重新解析。',
  'reparse.localRepair': '本地解析不支持按页修复；可整篇重新解析，或配置 Token 后整篇用云端解析。',
  'toast.noteSaved': '批注已保存',
  'toast.deleted': '已删除',
  'toast.exported': '已导出 Markdown',
  'toast.importFailed': '导入失败：{message}',
  'toast.parseRequestFailed': '无法开始解析：{message}',
  'drop.title': '松开即可导入',
  'drop.text': 'PDF · Word · 图片 · HTML',
  'err.hostUnavailable': '文献服务还没就绪，正在重试…',
  'err.network': '网络请求失败，请稍后再试。',
  'err.tokenMissing': '需要先在设置里填写 MinerU Token。',
  'err.fileTooLarge': '文件超过 {limit} MB，无法上传。',
  'err.unsupported': '暂不支持这种文件类型。',
  'err.noTranslation': '翻译服务不可用，无法生成译文。',
  'err.forbidden': '没有权限访问文献服务。',
  'err.generic': '操作没有完成。',
  'err.crashed': '阅读台出了点问题，重新打开文献库试试。',
  'err.localUnsupported': '本地解析不支持这种文件；可用轻量云端解析或配置 Token。',
  'err.localMissingTool': '本地解析工具不可用；请检查系统工具或改用云端解析。',
  'err.localEmptyText': '没有从文件中提取到文字（可能是扫描件）；请用云端解析或配置 OCR。',
  'err.localEncrypted': 'PDF 已加密，无法本地解析；请去除密码后重试，或改用云端解析。',
  'err.localFailed': '本地解析失败：{message}',
  'importUrl.title': '从链接导入',
  'importUrl.url': '链接地址',
  'importUrl.placeholder': 'https://example.com/paper.pdf',
  'importUrl.hint': '支持 PDF、Word、图片与网页链接',
  'importUrl.submit': '导入',
  'importUrl.importing': '正在导入…',
  'statusbar.engineStandard': 'MinerU 精准解析',
  'statusbar.engineAgent': 'MinerU 轻量解析',
  'statusbar.engineLocal': '本地解析',
  'statusbar.providerBuiltin': '内置',
  'statusbar.providerOffice': 'Office 转换',
  'statusbar.pages': '{count} 页',
  'statusbar.words': '{count} 词',
  'statusbar.translated': '已翻译 {percent}%',
  'statusbar.parsing': '解析中 {done}/{total}',
  'unit.pages': '页',
  'unit.words': '词',
  'unit.current': '当前',
  'time.today': '今天',
  'paper.metaModel': 'MinerU {model}',
  'parse.reparseTitle': '重新解析',
  'parse.starting': '正在开始解析…',
  // AI upgrade: margin tab, view switches, quick actions, panel + graph copy.
  'margin.ai': 'AI',
  'margin.aiTitle': 'AI 阅读助手',
  'topbar.viewLibrary': '文献库',
  'topbar.viewGraph': '全景图谱',
  'topbar.viewGroup': '文献库视图',
  'reader.viewRead': '阅读',
  'reader.viewGraph': '图谱',
  'reader.viewGroup': '文档视图',
  'sel.askAi': '问 AI',
  'ai.askBlock': '问 AI（这段）',
  'ai.title': 'AI 阅读助手',
  'ai.model': '模型 {model}',
  'ai.placeholderTitle': 'AI 阅读助手',
  'ai.placeholderText': 'AI 对话面板正在载入…',
  'ai.unavailable': 'AI 暂不可用',
  'ai.unavailableText': '当前 Harness 配置没有可用的语言模型。配置默认模型后即可在这里提问。',
  'ai.emptyTitle': '从这一页开始提问',
  'ai.emptyText': '答案只根据本文内容生成，并标注来源段落。',
  'ai.promptSummary': '总结全文',
  'ai.promptProblem': '这篇论文解决了什么',
  'ai.promptMethod': '方法是什么',
  'ai.promptLimit': '有什么局限',
  'ai.promptExplain': '解释这个概念',
  'ai.placeholder': '问点关于这篇论文的问题…',
  'ai.send': '发送',
  'ai.stop': '停止',
  'ai.regenerate': '重新生成',
  'ai.thinking': '正在阅读…',
  'ai.loading': '正在载入对话…',
  'ai.historyFailed': '对话记录载入失败。',
  'ai.retry': '重试',
  'ai.copy': '复制答案',
  'ai.copied': '已复制',
  'ai.copyFailed': '复制失败',
  'ai.contextSelection': '选中文本',
  'ai.contextParagraph': '当前段落',
  'ai.clearContext': '清除上下文',
  'ai.clearSelection': '清除选中',
  'ai.clearParagraph': '清除段落',
  'ai.citations': '引用',
  'ai.citationJump': '跳转到原文',
  'ai.page': '第 {page} 页',
  'ai.unverified': '{count} 条引用未通过校验',
  'ai.annotationsCreated': 'AI 新增 {count} 条高亮',
  'ai.error': 'AI 生成失败：{message}',
  'ai.stopped': '已停止生成',
  'ai.insufficient': '现有内容不足以回答这个问题。可以换个问法，或先精读全文生成图谱。',
  'ai.openGraph': '查看知识图谱',
  'ai.askAbout': '问 AI 关于「{label}」',
  'ai.followup': '继续追问',
  'ai.sendHint': 'Enter 发送 · Shift+Enter 换行',
  'graph.titleDoc': '本文知识图谱',
  'graph.titleLibrary': '全景图谱',
  'graph.placeholderTitle': '知识图谱',
  'graph.placeholderText': '知识图谱视图正在载入…',
  'graph.unavailable': '知识图谱引擎不可用。',
  'graph.error': '知识图谱载入失败。',
  'graph.retry': '重试',
  'graph.build': 'AI 精读全文',
  'graph.rebuild': '重建图谱',
  'graph.refresh': '刷新',
  'graph.building': '正在生成图谱…',
  'graph.progress': '正在生成 · {done} / {total}',
  'graph.reading': '正在阅读…',
  'graph.extracting': '正在抽取概念…',
  'graph.merging': '正在合并…',
  'graph.emptyDoc': '这篇论文还没有知识图谱。',
  'graph.emptyLibrary': '文献库还没有全景图谱。',
  'graph.emptyHint': 'AI 精读全文后，会自动抽取概念、方法与结论。',
  'graph.jump': '跳转到原文',
  'graph.ask': '问 AI 关于此概念',
  'graph.search': '搜索节点',
  'graph.legend': '节点类型',
  'graph.filters': '筛选',
  'graph.nodes': '{count} 个节点',
  'graph.edges': '{count} 条关系',
  'graph.loading': '正在载入图谱…',
  'graph.modeDoc': '本文图谱',
  'graph.modeLibrary': '全景图谱',
  'graph.close': '关闭',
  'graph.collapseClusters': '折叠次要节点',
  'graph.expandAll': '展开全部',
  'graph.concept': '概念',
  'graph.method': '方法',
  'graph.finding': '发现',
  'graph.definition': '定义',
  'graph.limitation': '局限',
  'graph.section': '章节',
  'graph.question': '问题',
  'graph.insight': '洞见',
  'graph.paper': '论文',
  'graph.topic': '主题',
  // AI modules (ui/chat.js, ui/graph.js) read these from the app dictionary.
  // Source: the former per-module copy decks; docs/AI-SPEC.md §6.
  'ai.modelDefault': '默认模型',
  'ai.modelUnavailable': '模型未连接',
  'ai.unavailableTitle': 'AI 模型尚未就绪',
  'ai.loadingHistory': '正在载入对话…',
  'ai.historyError': '对话载入失败。',
  'ai.quickSummary': '总结全文',
  'ai.quickSolved': '这篇论文解决了什么',
  'ai.quickMethod': '方法是什么',
  'ai.quickLimits': '有什么局限',
  'ai.quickConcept': '解释这个概念',
  'ai.hint': '⌘/Ctrl + Enter 发送 · Shift + Enter 换行',
  'ai.busyHint': '正在回答，可先写下一条问题…',
  'ai.answerEmpty': '没有收到回答，请重试。',
  'ai.dismiss': '关闭',
  'ai.citationsCount': '共 {count} 条引用',
  'ai.unverifiedNotice': '{count} 条引用未通过校验，已置灰且不会写入批注。',
  'ai.citationLabel': '引用 {index}',
  'ai.citationLabelPage': '引用 {index}，第 {page} 页',
  'ai.missingCitation': '引用 {index}（数据缺失）',
  'ai.jump': '跳到原文',
  'ai.unverifiedShort': '未通过校验',
  'ai.annotationsNotice': '已在原文标注 {count} 处引用',
  'ai.selection': '选中文本',
  'ai.visible': '当前段落',
  'ai.noDocument': '先从文献库选一篇已解析的论文。',
  'ai.errHost': 'AI 服务还未就绪，请稍后重试。',
  'ai.errModel': '模型不可用，请检查 DSH 的默认模型配置。',
  'ai.errFailed': '模型调用失败，请重试。',
  'ai.errContext': '检索到的上下文过长，请缩小提问范围。',
  'ai.errAborted': '生成已中断。',
  'ai.errNetwork': '网络请求失败，请重试。',
  'ai.errGeneric': '这次提问没有完成。',
  'ai.followups': '继续追问',
  'ai.legendTitle': '颜色图例',
  'ai.navLabel': '问题导航',
  'ai.navJump': '跳到第 {index} 个问题',
  'ai.navQuestion': '问题 {index}',
  'ai.toLatest': '回到最新',
  'graph.edgesTrimmed': '已聚焦 {shown}/{total} 条关系',
  'graph.aspectLegend': '批注颜色',
  'graph.aspect.definition': '定义/背景',
  'graph.aspect.method': '方法',
  'graph.aspect.result': '结果',
  'graph.aspect.limitation': '局限',
  'graph.canvas': '知识图谱画布',
  'graph.sources': '原文来源',
  'graph.documents': '相关文献',
  'graph.relations': '关系',
  'graph.noSummary': '暂无摘要',
  'graph.noSources': '暂无原文坐标',
  'graph.noRelations': '暂无关系',
  'graph.more': '还有 {count} 个',
  'graph.filtered': '显示 {shown} / {total} 个节点',
  'graph.collapsed': '已折叠 {count} 个节点',
  'graph.zoom': '缩放 {percent}%',
  'graph.zoomIn': '放大',
  'graph.zoomOut': '缩小',
  'graph.resetView': '重置视图',
  'graph.hint': '滚轮缩放 · 拖动节点固定位置',
  'graph.noMatches': '没有匹配的节点',
  'graph.noMatchesHint': '换个关键词，或清除筛选条件。',
  'graph.clearFilters': '清除筛选',
  'graph.unavailableHint': '配置可用的模型后，即可生成和浏览知识图谱。',
  'graph.clusterSummary': '{count} 个「{type}」节点折叠在这里',
  'graph.members': '成员',
  'graph.expandCluster': '展开这组节点',
  'graph.degree': '{count} 条关系',
  'graph.source.ai-summary': 'AI 精读',
  'graph.source.qa': '问答补充',
  'graph.source.user': '手动添加',
  'graph.source.aggregate': '聚合',
  'graph.edge.defines': '定义',
  'graph.edge.uses': '使用',
  'graph.edge.supports': '支持',
  'graph.edge.contradicts': '反驳',
  'graph.edge.part_of': '属于',
  'graph.edge.leads_to': '引出',
  'graph.edge.evolves_from': '演化自',
  'graph.edge.relates': '相关',
  'graph.edge.answers': '回答',
  'graph.edge.mentions': '提及',
  'graph.edge.shares': '共享主题',
  // AI curation / export / entailment / margin-filter copy (this round).
  'notes.filterLabel': '筛选批注',
  'notes.filterAll': '全部',
  'notes.filterAi': 'AI 批注',
  'notes.filterUser': '我的批注',
  'notes.filterAspect': '按侧重点',
  'notes.filterEmpty': '没有符合筛选条件的批注',
  'notes.filterClear': '清除筛选',
  'notes.filteredCount': '显示 {shown} / {total} 条',
  'notes.aiOrigin': 'AI 批注 · {aspect}',
  'notes.aiOriginPlain': 'AI 批注',
  'notes.userOrigin': '我的批注',
  'notes.sparkTitle': '由 AI 阅读生成',
  'graph.curate': '策展',
  'graph.rename': '重命名',
  'graph.renameTitle': '重命名节点',
  'graph.renamePlaceholder': '节点名称',
  'graph.renameSave': '保存',
  'graph.renameCancel': '取消',
  'graph.renameEmpty': '名称不能为空',
  'graph.renameFailed': '重命名失败',
  'graph.merge': '合并到…',
  'graph.mergeTitle': '合并节点',
  'graph.mergeHint': '点击要并入的目标节点',
  'graph.mergeConfirm': '确认合并',
  'graph.mergeCancel': '取消合并',
  'graph.merged': '已合并节点',
  'graph.mergeFailed': '合并失败',
  'graph.pin': '固定位置',
  'graph.unpin': '取消固定',
  'graph.pinned': '位置已固定',
  'graph.pinFailed': '固定失败',
  'graph.curationReadOnly': '全景图谱由文献自动聚合，不能直接编辑',
  'graph.curationSaved': '已保存',
  'graph.saving': '正在保存…',
  'graph.cancel': '取消',
  'ai.export': '导出对话',
  'ai.exported': '对话已导出',
  'ai.exportFailed': '导出对话失败',
  'ai.exportTitle': 'AI 对话',
  'ai.exportModel': '模型',
  'ai.exportTime': '导出时间',
  'ai.exportQuestion': '问题 {index}',
  'ai.exportAnswer': '回答 {index}',
  'ai.exportCitation': '引用',
  'ai.exportUnverified': '未通过校验',
  'ai.checkingClaims': '正在核对引文与论点…',
  'ai.entailmentPartial': '引文仅部分支持该论点',
  'ai.entailmentPartialShort': '部分支持',
  'ai.entailmentUnsupported': '引文未支持该论点',
  'ai.entailmentUnsupportedShort': '论点未获支持',
  'ai.entailmentNotice': '{count} 条引文与论点不符，已置灰且不写入批注',
  'ai.claimCheck': '论点核对',
  'settings.sectionAi': 'AI 功能',
  'settings.graphAutoBuildHint': '解析完成后自动生成单篇知识图谱',
  'settings.graphAutoBuildUnavailable': '需要可用的 AI 模型与图谱引擎',
  'toast.autoGraph': '解析完成，已开始自动生成知识图谱',
  'toast.graphBuilt': '知识图谱已生成',
  'toast.graphUpdated': '知识图谱已更新',
  'err.aiUnavailable': 'AI 服务不可用（{message}）',
  'err.aiFailed': 'AI 生成失败（{message}）',
  'err.contextTooLarge': '上下文超出模型限制，请缩小选中范围。',
};

/** en dictionary — fallback locale (docs/UI-SPEC.md §5). */
const EN = {
  'panel.label': 'Literature',
  'brand.name': 'LitNotes Library',
  'brand.count': '{count} papers',
  'topbar.import': 'Import',
  'topbar.upload': 'Upload file',
  'topbar.fromUrl': 'Import from URL',
  'rail.title': 'Library',
  'rail.search': 'Search title, file, or notes',
  'rail.empty': 'No papers yet. Import your first PDF.',
  'rail.searchEmpty': 'No matching papers',
  'rail.clear': 'Clear search',
  'rail.foot': '{count} papers · {parsed} parsed',
  'status.uploaded': 'Ready to parse',
  'status.parsing': 'Parsing',
  'status.parsed': 'Parsed',
  'status.failed': 'Parse failed',
  'empty.title': 'Bring in your first paper',
  'empty.text': 'PDFs, Word files, images, or pages. MinerU turns them into a readable, annotatable draft.',
  'empty.choose': 'Choose file',
  'empty.hint': 'Or drop files anywhere in this window',
  'empty.select': 'Pick a paper from the library',
  'setup.title': 'Ready to parse',
  'setup.text': 'MinerU detects layout, formulas, and tables, then turns the file into a structured reading draft.',
  'setup.engine': 'Engine',
  'setup.engineAuto': 'Auto (precise with a token, local first otherwise)',
  'setup.engineStandard': 'Precise',
  'setup.engineLocal': 'Local (offline, no upload)',
  'setup.engineLocalUnavailable': 'Local parsing unavailable',
  'setup.engineLocalWhy': 'Local parsing unavailable: {reason}',
  'setup.localReasonDisabled': 'disabled in the configuration',
  'setup.localReasonUnavailable': 'no local parser on this machine',
  'setup.localReasonType': 'this file type cannot be parsed locally',
  'setup.engineAgent': 'Lightweight cloud (no token, uploads the file)',
  'setup.model': 'Model',
  'setup.language': 'Document language',
  'setup.pageRanges': 'Page range',
  'setup.pageRangesHint': 'Leave empty for all, e.g. 2,4-6',
  'setup.formula': 'Formula recognition',
  'setup.formulaHint': 'Keep LaTeX formulas',
  'setup.table': 'Table recognition',
  'setup.tableHint': 'Rebuild table structure',
  'setup.ocr': 'OCR',
  'setup.ocrHint': 'Turn on for scanned pages',
  'setup.start': 'Start parsing',
  'setup.note': 'Precise parsing uses the daily quota; lightweight parsing is limited to 10 MB / 20 pages.',
  'setup.noteLocal': 'Local parsing extracts the text layer and keeps paragraphs and page marks; formulas, tables, figures and scanned pages need precise cloud parsing. The file is not uploaded.',
  'setup.tokenWarn': 'Precise parsing needs a MinerU token.',
  'setup.tokenWarnLocal': 'A token unlocks MinerU precise parsing (formulas/tables/OCR).',
  'setup.tokenWarnPrivacy': 'Local parsing needs no token and never uploads the file.',
  'setup.effectiveStandard': 'Will use: MinerU precise parsing',
  'setup.effectiveLocal': 'Will use: local parsing',
  'setup.effectiveAgent': 'Will use: lightweight cloud parsing (the file is uploaded)',
  'setup.effectiveBlocked': 'Will use: no engine available — configure a token or allow lightweight cloud parsing',
  'setup.tokenAction': 'Open settings',
  'setup.langCh': 'Chinese',
  'setup.langEn': 'English',
  'setup.langJapan': 'Japanese',
  'setup.langKorean': 'Korean',
  'setup.langFr': 'French',
  'setup.langDe': 'German',
  'setup.langRu': 'Russian',
  'setup.langEs': 'Spanish',
  'setup.langAr': 'Arabic',
  'parsing.text': 'MinerU is parsing · {done} / {total} pages',
  'parsing.textNoProgress': 'MinerU is parsing…',
  'parsing.phaseWaiting': 'Waiting for MinerU to receive the file…',
  'parsing.phaseQueued': 'Queued at MinerU…',
  'parsing.phaseRunning': 'MinerU is parsing…',
  'parsing.phaseConverting': 'Preparing the parsed result…',
  'parsing.elapsed': 'Elapsed {time}',
  'parsing.slowHint': 'The pipeline model and OCR are slower on MinerU (queueing can take minutes); the paper opens automatically when done.',
  'parsing.cancel': 'Cancel',
  'fail.title': "Parsing didn't finish",
  'fail.retry': 'Retry',
  'fail.otherEngine': 'Try another engine',
  'fail.localSuggestion': 'Try cloud parsing or configure a token',
  'reader.modeOriginal': 'Original',
  'reader.modeBilingual': 'Bilingual',
  'reader.modeTranslated': 'Translation',
  'reader.modeGroup': 'Reading mode',
  'reader.unknownSymbol': 'MinerU could not recognize this symbol (source PDF font or italic math glyph)',
  'reader.unknownNotice': 'MinerU could not recognize {count} symbols in this paper, mostly italic math glyphs. Try another parse model or enable OCR and reparse.',
  'reader.translateAll': 'Translate all',
  'reader.translateBlock': 'Translate this paragraph',
  'reader.translating': 'Translating…',
  'reader.retryBlock': 'Retry',
  'reader.loading': 'Loading the parsed draft…',
  'reader.loadFailed': "Couldn't load the parsed draft.",
  'reader.emptyDoc': 'This draft has no content yet.',
  'reader.copy': 'Copy',
  'reader.more': 'More',
  'reader.fontDec': 'Smaller text',
  'reader.fontInc': 'Larger text',
  'banner.localTitle': 'Local parse result',
  'banner.localText': 'Parsed locally: text, paragraphs and page marks are kept; formulas, tables and figures are not reconstructed.',
  'banner.missingFonts': 'Some fonts were missing; a few characters may be absent.',
  'banner.scanned': 'Little or no text was extracted; the file may be scanned.',
  'banner.upgrade': 'Configure a token for precise parsing',
  'block.annotate': 'Highlight and note',
  'margin.label': 'Margin',
  'margin.outline': 'Outline',
  'margin.notes': 'Notes',
  'margin.empty': 'Select text to highlight it or leave a note.',
  'margin.noteDelete': 'Delete note',
  'margin.dropped': '{count} notes no longer match this draft and are hidden.',
  'notes.staleSection': 'Position changed',
  'notes.staleTag': 'Position changed',
  'notes.staleNotice': 'After the reparse, {count} annotations changed position; their original quotes are kept.',
  'sel.translate': 'Translate',
  'sel.highlight': 'Highlight',
  'sel.removeHighlight': 'Remove highlight',
  'sel.note': 'Note',
  'sel.copy': 'Copy',
  'sel.toolbar': 'Selection tools',
  'sel.colors': 'Highlight color',
  'sel.colorYellow': 'Yellow highlight',
  'sel.colorSage': 'Sage highlight',
  'sel.colorSky': 'Sky highlight',
  'sel.colorRose': 'Rose highlight',
  'selcard.label': 'Selection',
  'selcard.copy': 'Copy translation',
  'selcard.error': 'Translation is unavailable.',
  'selcard.retry': 'Retry',
  'selcard.close': 'Close',
  'noteeditor.title': 'Note',
  'noteeditor.placeholder': 'Add a note…',
  'noteeditor.save': 'Save',
  'noteeditor.cancel': 'Cancel',
  'translate.progress': 'Translating · {done} / {total}',
  'translate.cancel': 'Stop translating',
  'translate.done': 'Translated {count} blocks',
  'translate.partial': 'Translation finished: {done} ok, {failed} failed',
  'settings.title': 'Settings',
  'settings.sectionToken': 'MinerU access',
  'settings.token': 'API token',
  'settings.tokenHint': 'Local parsing needs no token; configure a token to unlock MinerU precise parsing (formulas/tables/OCR).',
  'settings.tokenPlaceholder': 'Paste token',
  'settings.tokenSaved': 'Configured · stored in local credentials',
  'settings.tokenMemory': 'Configured · stored for this session only (credentials unavailable)',
  'settings.tokenMissing': 'Not configured',
  'settings.tokenMissingLocal': 'Current default: local parsing (the file is not uploaded)',
  'settings.sectionLocal': 'Local parsing',
  'settings.localBuiltin': 'Built-in text-layer extraction',
  'settings.localPdfTool': 'System pdftotext',
  'settings.localOffice': 'Office conversion (office-to-pdf)',
  'settings.localRedetect': 'Re-detect',
  'settings.localAvailable': 'Available',
  'settings.localUnavailable': 'Unavailable',
  'settings.localHint': 'Local parsing does not upload files; scanned pages need cloud parsing or an OCR sidecar.',
  'settings.save': 'Save',
  'settings.clear': 'Clear',
  'settings.close': 'Close',
  'settings.sectionRead': 'Reading',
  'settings.targetLang': 'Target language',
  'settings.provider': 'Translation service',
  'settings.providerAuto': 'Auto',
  'settings.pageMarks': 'Show page marks',
  'layout.resizeRail': 'Resize the library rail',
  'layout.resizeMargin': 'Resize the margin',
  'layout.resizeHint': 'Drag to resize, double-click to reset',
  'layout.widthGroup': 'Reading width',
  'layout.widthNarrow': 'Narrow',
  'layout.widthStandard': 'Standard',
  'layout.widthWide': 'Wide',
  'layout.widthFull': 'Full',
  'aspect.legendTitle': 'Colour legend',
  'aspect.definition': 'Definition',
  'aspect.context': 'Context',
  'aspect.method': 'Method',
  'aspect.result': 'Result',
  'aspect.limitation': 'Limitation',
  'settings.graphAutoBuild': 'Build the knowledge graph after parsing',
  'settings.scale': 'Reading size',
  'settings.sectionStorage': 'Storage',
  'settings.dataDir': 'Data directory',
  'settings.version': 'Version',
  'menu.reparse': 'Reparse',
  'menu.export': 'Export Markdown',
  'menu.delete': 'Delete paper',
  'menu.translateAll': 'Translate whole paper',
  'menu.more': 'More',
  'confirm.deleteTitle': 'Delete this paper?',
  'confirm.deleteText': 'The source, parsed draft, highlights, and notes are removed permanently.',
  'confirm.delete': 'Delete',
  'confirm.cancel': 'Cancel',
  'toast.uploaded': 'Imported "{name}"',
  'toast.parsed': 'Parsed: {title}',
  'toast.parseFailed': 'Parse failed: {message}',
  'toast.saved': 'Saved',
  'toast.copied': 'Copied',
  'toast.copyFailed': 'Copy failed',
  'toast.highlighted': 'Highlighted',
  'toast.highlightRemoved': 'Highlight removed',
  'toast.repaired': 'Repaired {count} pages',
  'toast.repairPartial': 'Repaired {count} pages; {failed} could not be aligned',
  'reparse.onlyProblems': 'Re-parse only the problematic pages ({count})',
  'reparse.onlyProblemsHint': 'Other pages, highlights, and notes stay untouched.',
  'reparse.needsToken': 'Page repair needs a MinerU token; without one only a full lightweight reparse is possible.',
  'reparse.localRepair': 'Page repair is unavailable for local parses; reparse the whole document, or configure a token and reparse in the cloud.',
  'toast.noteSaved': 'Note saved',
  'toast.deleted': 'Deleted',
  'toast.exported': 'Markdown exported',
  'toast.importFailed': 'Import failed: {message}',
  'toast.parseRequestFailed': "Couldn't start parsing: {message}",
  'drop.title': 'Drop to import',
  'drop.text': 'PDF · Word · images · HTML',
  'err.hostUnavailable': 'The library service is not ready yet — retrying…',
  'err.network': 'The request failed. Try again.',
  'err.tokenMissing': 'Add a MinerU token in settings first.',
  'err.fileTooLarge': 'The file exceeds {limit} MB.',
  'err.unsupported': 'This file type is not supported.',
  'err.noTranslation': 'No translation service is available.',
  'err.forbidden': 'No permission to reach the library service.',
  'err.generic': "The action didn't finish.",
  'err.crashed': 'The reading desk hit an error. Reopen the library to retry.',
  'err.localUnsupported': 'Local parsing does not support this file; use lightweight cloud parsing or configure a token.',
  'err.localMissingTool': 'The local parsing tool is unavailable; check system tools or use cloud parsing.',
  'err.localEmptyText': 'No text was extracted (the file may be scanned); use cloud parsing or configure OCR.',
  'err.localEncrypted': 'The PDF is encrypted and cannot be parsed locally; remove the password or use cloud parsing.',
  'err.localFailed': 'Local parsing failed: {message}',
  'importUrl.title': 'Import from URL',
  'importUrl.url': 'URL',
  'importUrl.placeholder': 'https://example.com/paper.pdf',
  'importUrl.hint': 'Supports PDF, Word, images, and web pages',
  'importUrl.submit': 'Import',
  'importUrl.importing': 'Importing…',
  'statusbar.engineStandard': 'MinerU precise',
  'statusbar.engineAgent': 'MinerU lightweight',
  'statusbar.engineLocal': 'Local',
  'statusbar.providerBuiltin': 'built-in',
  'statusbar.providerOffice': 'Office conversion',
  'statusbar.pages': '{count} pages',
  'statusbar.words': '{count} words',
  'statusbar.translated': '{percent}% translated',
  'statusbar.parsing': 'Parsing {done}/{total}',
  'unit.pages': 'pages',
  'unit.words': 'words',
  'unit.current': 'Current',
  'time.today': 'Today',
  'paper.metaModel': 'MinerU {model}',
  'parse.reparseTitle': 'Reparse',
  'parse.starting': 'Starting parse…',
  // AI upgrade: margin tab, view switches, quick actions, panel + graph copy.
  'margin.ai': 'AI',
  'margin.aiTitle': 'AI reading assistant',
  'topbar.viewLibrary': 'Library',
  'topbar.viewGraph': 'Library graph',
  'topbar.viewGroup': 'Library view',
  'reader.viewRead': 'Read',
  'reader.viewGraph': 'Graph',
  'reader.viewGroup': 'Document view',
  'sel.askAi': 'Ask AI',
  'ai.askBlock': 'Ask AI (this paragraph)',
  'ai.title': 'AI reading assistant',
  'ai.model': 'Model {model}',
  'ai.placeholderTitle': 'AI reading assistant',
  'ai.placeholderText': 'The AI panel is loading…',
  'ai.unavailable': 'AI is unavailable',
  'ai.unavailableText': 'No language-model route is configured in Harness. Set a default model to ask questions here.',
  'ai.emptyTitle': 'Start from this page',
  'ai.emptyText': 'Answers are generated from this paper only, with source paragraphs cited.',
  'ai.promptSummary': 'Summarize the paper',
  'ai.promptProblem': 'What problem does it solve',
  'ai.promptMethod': 'What is the method',
  'ai.promptLimit': 'What are the limitations',
  'ai.promptExplain': 'Explain this concept',
  'ai.placeholder': 'Ask something about this paper…',
  'ai.send': 'Send',
  'ai.stop': 'Stop',
  'ai.regenerate': 'Regenerate',
  'ai.thinking': 'Reading…',
  'ai.loading': 'Loading conversation…',
  'ai.historyFailed': "Couldn't load the conversation.",
  'ai.retry': 'Retry',
  'ai.copy': 'Copy answer',
  'ai.copied': 'Copied',
  'ai.copyFailed': 'Copy failed',
  'ai.contextSelection': 'Selection',
  'ai.contextParagraph': 'Current paragraph',
  'ai.clearContext': 'Clear context',
  'ai.clearSelection': 'Clear selection',
  'ai.clearParagraph': 'Clear paragraph',
  'ai.citations': 'Citations',
  'ai.citationJump': 'Jump to source',
  'ai.page': 'Page {page}',
  'ai.unverified': '{count} citations failed verification',
  'ai.annotationsCreated': 'AI added {count} highlights',
  'ai.error': 'AI failed: {message}',
  'ai.stopped': 'Generation stopped',
  'ai.insufficient': 'The available content is not enough to answer. Rephrase the question, or build the paper graph first.',
  'ai.openGraph': 'Open knowledge graph',
  'ai.askAbout': 'Ask AI about "{label}"',
  'ai.followup': 'Follow up',
  'ai.sendHint': 'Enter to send · Shift+Enter for a new line',
  'graph.titleDoc': 'Paper knowledge graph',
  'graph.titleLibrary': 'Library graph',
  'graph.placeholderTitle': 'Knowledge graph',
  'graph.placeholderText': 'The knowledge-graph view is loading…',
  'graph.unavailable': 'The knowledge-graph engine is unavailable.',
  'graph.error': 'The knowledge graph failed to load.',
  'graph.retry': 'Retry',
  'graph.build': 'Build with AI',
  'graph.rebuild': 'Rebuild graph',
  'graph.refresh': 'Refresh',
  'graph.building': 'Building the graph…',
  'graph.progress': 'Building · {done} / {total}',
  'graph.reading': 'Reading…',
  'graph.extracting': 'Extracting concepts…',
  'graph.merging': 'Merging…',
  'graph.emptyDoc': 'This paper has no knowledge graph yet.',
  'graph.emptyLibrary': 'The library graph is empty.',
  'graph.emptyHint': 'Building the graph extracts concepts, methods, and findings automatically.',
  'graph.jump': 'Jump to source',
  'graph.ask': 'Ask AI about this concept',
  'graph.search': 'Search nodes',
  'graph.legend': 'Node types',
  'graph.filters': 'Filters',
  'graph.nodes': '{count} nodes',
  'graph.edges': '{count} edges',
  'graph.loading': 'Loading graph…',
  'graph.modeDoc': 'Paper graph',
  'graph.modeLibrary': 'Library graph',
  'graph.close': 'Close',
  'graph.collapseClusters': 'Collapse minor nodes',
  'graph.expandAll': 'Expand all',
  'graph.concept': 'Concept',
  'graph.method': 'Method',
  'graph.finding': 'Finding',
  'graph.definition': 'Definition',
  'graph.limitation': 'Limitation',
  'graph.section': 'Section',
  'graph.question': 'Question',
  'graph.insight': 'Insight',
  'graph.paper': 'Paper',
  'graph.topic': 'Topic',
  // AI modules (ui/chat.js, ui/graph.js) read these from the app dictionary.
  // Source: the former per-module copy decks; docs/AI-SPEC.md §6.
  'ai.modelDefault': 'Default model',
  'ai.modelUnavailable': 'Model unavailable',
  'ai.unavailableTitle': 'AI model not ready',
  'ai.loadingHistory': 'Loading conversation…',
  'ai.historyError': 'Could not load the conversation.',
  'ai.quickSummary': 'Summarize the paper',
  'ai.quickSolved': 'What problem does this paper solve?',
  'ai.quickMethod': 'What is the method?',
  'ai.quickLimits': 'What are the limitations?',
  'ai.quickConcept': 'Explain this concept',
  'ai.hint': '⌘/Ctrl + Enter to send · Shift + Enter for a new line',
  'ai.busyHint': 'Answering… you can draft the next question',
  'ai.answerEmpty': 'No answer arrived. Try again.',
  'ai.dismiss': 'Dismiss',
  'ai.citationsCount': '{count} citations',
  'ai.unverifiedNotice': '{count} citations failed verification. They are dimmed and are not saved as annotations.',
  'ai.citationLabel': 'Citation {index}',
  'ai.citationLabelPage': 'Citation {index}, page {page}',
  'ai.missingCitation': 'Citation {index} (data missing)',
  'ai.jump': 'Jump to source',
  'ai.unverifiedShort': 'Unverified',
  'ai.annotationsNotice': 'Marked {count} citations in the paper',
  'ai.selection': 'Selection',
  'ai.visible': 'Current paragraph',
  'ai.noDocument': 'Select a parsed paper first.',
  'ai.errHost': 'The AI service is not ready yet. Try again shortly.',
  'ai.errModel': 'The model is unavailable. Check the default model in DSH.',
  'ai.errFailed': 'The model call failed. Try again.',
  'ai.errContext': 'The retrieved context is too long. Narrow the question.',
  'ai.errAborted': 'Generation was interrupted.',
  'ai.errNetwork': 'The request failed. Try again.',
  'ai.errGeneric': 'This question did not finish.',
  'ai.followups': 'Follow up',
  'ai.legendTitle': 'Colour legend',
  'ai.navLabel': 'Question navigator',
  'ai.navJump': 'Jump to question {index}',
  'ai.navQuestion': 'Question {index}',
  'ai.toLatest': 'Back to latest',
  'graph.edgesTrimmed': 'showing {shown}/{total} relations',
  'graph.aspectLegend': 'Annotation colours',
  'graph.aspect.definition': 'definition/context',
  'graph.aspect.method': 'method',
  'graph.aspect.result': 'result',
  'graph.aspect.limitation': 'limitation',
  'graph.canvas': 'Knowledge graph canvas',
  'graph.sources': 'Sources',
  'graph.documents': 'Papers',
  'graph.relations': 'Connections',
  'graph.noSummary': 'No summary',
  'graph.noSources': 'No source location',
  'graph.noRelations': 'No connections',
  'graph.more': '{count} more',
  'graph.filtered': 'Showing {shown} / {total} nodes',
  'graph.collapsed': '{count} nodes folded',
  'graph.zoom': 'Zoom {percent}%',
  'graph.zoomIn': 'Zoom in',
  'graph.zoomOut': 'Zoom out',
  'graph.resetView': 'Reset view',
  'graph.hint': 'Scroll to zoom · drag a node to pin it',
  'graph.noMatches': 'No matching nodes',
  'graph.noMatchesHint': 'Try another keyword, or clear the filters.',
  'graph.clearFilters': 'Clear filters',
  'graph.unavailableHint': 'Set up an available model to build and explore knowledge graphs.',
  'graph.clusterSummary': '{count} {type} nodes are folded here',
  'graph.members': 'Members',
  'graph.expandCluster': 'Expand this group',
  'graph.degree': '{count} connections',
  'graph.source.ai-summary': 'AI reading',
  'graph.source.qa': 'Q&A',
  'graph.source.user': 'Manual',
  'graph.source.aggregate': 'Aggregate',
  'graph.edge.defines': 'defines',
  'graph.edge.uses': 'uses',
  'graph.edge.supports': 'supports',
  'graph.edge.contradicts': 'contradicts',
  'graph.edge.part_of': 'part of',
  'graph.edge.leads_to': 'leads to',
  'graph.edge.evolves_from': 'evolves from',
  'graph.edge.relates': 'relates',
  'graph.edge.answers': 'answers',
  'graph.edge.mentions': 'mentions',
  'graph.edge.shares': 'shares topics',
  // AI curation / export / entailment / margin-filter copy (this round).
  'notes.filterLabel': 'Filter notes',
  'notes.filterAll': 'All',
  'notes.filterAi': 'AI notes',
  'notes.filterUser': 'My notes',
  'notes.filterAspect': 'By aspect',
  'notes.filterEmpty': 'No notes match this filter',
  'notes.filterClear': 'Clear filter',
  'notes.filteredCount': 'Showing {shown} / {total}',
  'notes.aiOrigin': 'AI note · {aspect}',
  'notes.aiOriginPlain': 'AI note',
  'notes.userOrigin': 'My note',
  'notes.sparkTitle': 'Created by AI reading',
  'graph.curate': 'Curate',
  'graph.rename': 'Rename',
  'graph.renameTitle': 'Rename node',
  'graph.renamePlaceholder': 'Node name',
  'graph.renameSave': 'Save',
  'graph.renameCancel': 'Cancel',
  'graph.renameEmpty': 'The name cannot be empty',
  'graph.renameFailed': 'Rename failed',
  'graph.merge': 'Merge into…',
  'graph.mergeTitle': 'Merge nodes',
  'graph.mergeHint': 'Click the target node to merge into',
  'graph.mergeConfirm': 'Confirm merge',
  'graph.mergeCancel': 'Cancel merge',
  'graph.merged': 'Nodes merged',
  'graph.mergeFailed': 'Merge failed',
  'graph.pin': 'Pin position',
  'graph.unpin': 'Unpin',
  'graph.pinned': 'Position pinned',
  'graph.pinFailed': 'Pin failed',
  'graph.curationReadOnly': 'The library map is aggregated from the papers and cannot be edited directly',
  'graph.curationSaved': 'Saved',
  'graph.saving': 'Saving…',
  'graph.cancel': 'Cancel',
  'ai.export': 'Export conversation',
  'ai.exported': 'Conversation exported',
  'ai.exportFailed': 'Could not export the conversation',
  'ai.exportTitle': 'AI conversation',
  'ai.exportModel': 'Model',
  'ai.exportTime': 'Exported',
  'ai.exportQuestion': 'Question {index}',
  'ai.exportAnswer': 'Answer {index}',
  'ai.exportCitation': 'Citation',
  'ai.exportUnverified': 'Unverified',
  'ai.checkingClaims': 'Checking citations against claims…',
  'ai.entailmentPartial': 'The quote only partly supports this claim',
  'ai.entailmentPartialShort': 'Partly supported',
  'ai.entailmentUnsupported': 'The quote does not support this claim',
  'ai.entailmentUnsupportedShort': 'Claim unsupported',
  'ai.entailmentNotice': '{count} citations do not support their claims; dimmed and not annotated',
  'ai.claimCheck': 'Claim check',
  'settings.sectionAi': 'AI features',
  'settings.graphAutoBuildHint': 'Build the paper knowledge graph automatically after parsing',
  'settings.graphAutoBuildUnavailable': 'Needs an available AI model and graph engine',
  'toast.autoGraph': 'Parsing finished — building the knowledge graph',
  'toast.graphBuilt': 'Knowledge graph built',
  'toast.graphUpdated': 'Knowledge graph updated',
  'err.aiUnavailable': 'AI service unavailable ({message})',
  'err.aiFailed': 'AI generation failed ({message})',
  'err.contextTooLarge': 'The context exceeds the model limit. Select less text.',
};

/** Fallback translation used by components rendered outside the locale seat. */
function mruTranslate(key, params) {
  const template = ZH[key] ?? EN[key] ?? key;
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

// ===========================================================================
// 2. Host transport (docs/ARCH.md §4, §9.2)
// ===========================================================================

/** Error from a host API call; `code` drives UI branches. */
class MruApiError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = 'MruApiError';
    this.code = code;
    this.status = status;
  }
}

/** Resolve a host API route against the document base URI (prefix-safe). */
function mruApiUrl(method) {
  return new URL(`dsh-litnotes/api/${method}`, document.baseURI).href;
}

/** Resolve a vendored package asset (KaTeX) against the document base URI. */
function mruAssetUrl(rel) {
  return new URL(`dsh-litnotes/assets/${rel}`, document.baseURI).href;
}

/**
 * Navigation memory for the reading desk. The main panel unmounts when the
 * user switches to another Harness panel, so the open document and scroll
 * position are kept in browser storage (UI-only state, never user
 * configuration — durable reading preferences stay in the host preferences).
 */
const MRU_NAV_KEY = 'dsh-litnotes:navigation';

/** Read the remembered navigation state; null when unavailable/invalid. */
function mruReadNavState() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(MRU_NAV_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Merge one navigation patch into the remembered state (best effort). */
function mruWriteNavState(patch) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const current = mruReadNavState() || {};
    window.localStorage.setItem(MRU_NAV_KEY, JSON.stringify({ ...current, ...patch }));
  } catch {
    /* storage may be unavailable (private mode): navigation memory is best-effort */
  }
}

/**
 * Read the remembered layout (rail/margin widths + reading width). Unknown or
 * out-of-range values fall back to the defaults, so corrupted storage is safe.
 */
function mruLayoutRead() {
  const defaults = { ...MRU_LAYOUT_DEFAULTS };
  try {
    if (typeof window === 'undefined' || !window.localStorage) return defaults;
    const raw = window.localStorage.getItem(MRU_LAYOUT_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
    return {
      railWidth: mruLayoutClamp(parsed.railWidth, MRU_LAYOUT_LIMITS.rail) ?? defaults.railWidth,
      marginWidth: mruLayoutClamp(parsed.marginWidth, MRU_LAYOUT_LIMITS.margin) ?? defaults.marginWidth,
      docWidth: mruLayoutDocWidth(parsed.docWidth),
    };
  } catch {
    return defaults;
  }
}

/** Clamp one panel width to its limits; null when the input is not a number. */
function mruLayoutClamp(value, limits) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return mruClamp(Math.round(number), limits.min, limits.max);
}

/** Normalize a reading-width value to one of the presets. */
function mruLayoutDocWidth(value) {
  const number = Number(value);
  return MRU_DOC_WIDTH_PRESETS.includes(number) ? number : MRU_LAYOUT_DEFAULTS.docWidth;
}

/** Text measure (px) paired with a reading-width preset. */
function mruLayoutMeasure(value) {
  const width = mruLayoutDocWidth(value);
  return MRU_DOC_MEASURE_BY_WIDTH[width] || MRU_DOC_MEASURE_BY_WIDTH[MRU_LAYOUT_DEFAULTS.docWidth];
}

/** Dictionary key for one reading-width preset. */
function mruLayoutWidthLabelKey(width) {
  if (width === 720) return 'layout.widthNarrow';
  if (width === 1040) return 'layout.widthWide';
  if (width === 1200) return 'layout.widthFull';
  return 'layout.widthStandard';
}

/** Merge + persist a layout patch; returns the normalized layout it wrote. */
function mruLayoutWrite(patch) {
  const current = mruLayoutRead();
  const next = { ...current };
  if (patch && typeof patch === 'object') {
    const rail = mruLayoutClamp(patch.railWidth, MRU_LAYOUT_LIMITS.rail);
    if (rail !== null) next.railWidth = rail;
    const margin = mruLayoutClamp(patch.marginWidth, MRU_LAYOUT_LIMITS.margin);
    if (margin !== null) next.marginWidth = margin;
    if (patch.docWidth !== undefined) next.docWidth = mruLayoutDocWidth(patch.docWidth);
  }
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(MRU_LAYOUT_KEY, JSON.stringify(next));
    }
  } catch {
    /* storage may be unavailable (private mode): memory is best-effort */
  }
  return next;
}

/** Clear the browser text selection (after a highlight/note action). */
function mruClearBrowserSelection() {
  try {
    const selection = window.getSelection();
    if (selection) selection.removeAllRanges();
  } catch {
    /* no selection support: nothing to clear */
  }
}

/** 1-based pages whose content_list entries contain U+FFFD (for page repair). */
function mruProblemPages(contentList) {
  if (!Array.isArray(contentList)) return [];
  const pages = new Set();
  for (const entry of contentList) {
    if (entry === null || typeof entry !== 'object') continue;
    const page = Number(entry.page_idx);
    if (!Number.isInteger(page) || page < 0) continue;
    const values = [entry.text, entry.table_body, entry.code_body, entry.latex];
    for (const field of ['image_caption', 'table_caption']) {
      if (Array.isArray(entry[field])) values.push(...entry[field]);
    }
    for (const value of values) {
      if (typeof value === 'string' && value.indexOf('\ufffd') !== -1) {
        pages.add(page + 1);
        break;
      }
    }
  }
  return [...pages].sort((a, b) => a - b);
}

/** Replace U+FFFD in display-only text with a deliberate box marker. */
function mruDisplayText(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\ufffd/g, '□');
}

/**
 * Upstream MinerU task states mapped to the copy key the client shows.
 * `extract_progress` is only reported while MinerU is `running`, so a queued
 * (`pending` / `waiting-file`) or `converting` task has no page progress at
 * all; naming the phase keeps the wait legible instead of looking frozen.
 */
const MRU_REMOTE_STATE_KEYS = {
  'waiting-file': 'parsing.phaseWaiting',
  uploading: 'parsing.phaseWaiting',
  pending: 'parsing.phaseQueued',
  running: 'parsing.phaseRunning',
  converting: 'parsing.phaseConverting',
};

/** Copy key for the upstream MinerU state of a parsing document. */
function mruParsePhaseKey(doc) {
  const state = doc && doc.parse && typeof doc.parse.remoteState === 'string' ? doc.parse.remoteState : '';
  return MRU_REMOTE_STATE_KEYS[state] || 'parsing.textNoProgress';
}

/** Short elapsed time for the liveness line: "42s" or "3:07". */
function mruFormatElapsed(startedAt, nowValue) {
  const started = Date.parse(String(startedAt || ''));
  const now = Number(nowValue);
  if (!Number.isFinite(started) || !Number.isFinite(now)) return '';
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}:${String(seconds % 60).padStart(2, '0')}` : `${seconds}s`;
}

/** Whether this document is using the slow MinerU modes (pipeline / OCR). */
function mruIsSlowParse(doc) {
  const parse = doc && doc.parse;
  if (!parse || typeof parse !== 'object') return false;
  const options = parse.options && typeof parse.options === 'object' ? parse.options : {};
  return parse.modelVersion === 'pipeline' || parse.ocr === true || options.isOcr === true;
}

/** Resolve an extracted-image asset URL for one parsed figure. */
function mruImageUrl(docId, imagePath) {
  const path = String(imagePath ?? '');
  if (/^(https?:|data:)/i.test(path)) return path;
  return new URL(`dsh-litnotes/api/asset?id=${encodeURIComponent(docId)}&path=${encodeURIComponent(path)}`, document.baseURI).href;
}

/** POST one JSON method and unwrap the `{ok,value}` / `{ok,error}` envelope. */
async function mruPost(method, payload, options) {
  const opts = options || {};
  let response;
  try {
    response = await fetch(mruApiUrl(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (error) {
    if (error && (error.name === 'AbortError' || opts.signal?.aborted)) throw new MruApiError('aborted', 'aborted');
    throw new MruApiError('network', error instanceof Error ? error.message : 'network');
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (data && data.ok === true) return data.value;
  if (data && data.ok === false) {
    const info = data.error || {};
    throw new MruApiError(info.code || `http-${response.status}`, info.message || '', response.status);
  }
  if (response.status === 403 || response.status === 404 || response.status === 405) {
    throw new MruApiError('host-unavailable', `HTTP ${response.status}`, response.status);
  }
  throw new MruApiError(`http-${response.status}`, `HTTP ${response.status}`, response.status);
}

/**
 * POST one NDJSON-streaming method and deliver each decoded frame to
 * `options.onFrame(frame)` (docs/AI-SPEC.md §4). Resolves when the stream ends;
 * rethrows transport/host failures as `MruApiError` so callers can branch.
 */
async function mruStreamNdjson(method, payload, options) {
  const opts = options || {};
  let response;
  try {
    response = await fetch(mruApiUrl(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
      body: JSON.stringify(payload || {}),
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (error) {
    if (error && (error.name === 'AbortError' || opts.signal?.aborted)) throw new MruApiError('aborted', 'aborted');
    throw new MruApiError('network', error instanceof Error ? error.message : 'network');
  }
  if (!response.ok) {
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (data && data.ok === false) {
      const info = data.error || {};
      throw new MruApiError(info.code || `http-${response.status}`, info.message || '', response.status);
    }
    if (response.status === 403 || response.status === 404 || response.status === 405) {
      throw new MruApiError('host-unavailable', `HTTP ${response.status}`, response.status);
    }
    throw new MruApiError(`http-${response.status}`, `HTTP ${response.status}`, response.status);
  }
  const headers = response.headers;
  const contentType = headers && typeof headers.get === 'function' ? headers.get('content-type') || '' : '';
  // A JSON envelope answer means the host declined to stream (e.g. unavailable).
  if (contentType.indexOf('application/json') !== -1) {
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (data && data.ok === true) return data.value;
    if (data && data.ok === false) {
      const info = data.error || {};
      throw new MruApiError(info.code || 'ai-failed', info.message || '', response.status);
    }
    throw new MruApiError('bad-response', 'bad response', response.status);
  }
  const onFrame = typeof opts.onFrame === 'function' ? opts.onFrame : null;
  const decoder = typeof TextDecoder === 'function' ? new TextDecoder() : null;
  let buffer = '';
  const emitLine = (line) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let frame = null;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (frame && typeof frame === 'object' && onFrame) onFrame(frame);
  };
  const consume = (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      emitLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  };
  try {
    const body = response.body;
    if (body && typeof body.getReader === 'function') {
      const reader = body.getReader();
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        if (step.value !== undefined && step.value !== null) {
          consume(decoder ? decoder.decode(step.value, { stream: true }) : String(step.value));
        }
      }
      if (decoder) consume(decoder.decode());
    } else if (typeof response.text === 'function') {
      consume(await response.text());
    }
    if (buffer.trim() !== '') emitLine(buffer);
  } catch (error) {
    if (opts.signal?.aborted || (error && error.name === 'AbortError')) throw new MruApiError('aborted', 'aborted');
    throw new MruApiError('network', error instanceof Error ? error.message : 'network');
  }
  return undefined;
}

/** Raw XHR upload with progress; resolves `{document}` like the JSON API. */
function mruUpload(file, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    let xhr;
    try {
      xhr = new XMLHttpRequest();
      xhr.open('POST', mruApiUrl('upload'), true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
      if (opts.title) xhr.setRequestHeader('x-doc-title', encodeURIComponent(opts.title));
    } catch (error) {
      reject(new MruApiError('network', error instanceof Error ? error.message : 'network'));
      return;
    }
    const signal = opts.signal;
    const onAbort = () => {
      try {
        xhr.abort();
      } catch {
        /* ignore */
      }
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        reject(new MruApiError('aborted', 'aborted'));
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const finish = (fn, value) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    xhr.upload.onprogress = (event) => {
      if (opts.onProgress && event.lengthComputable && event.total > 0) opts.onProgress(event.loaded / event.total);
    };
    xhr.onerror = () => finish(reject, new MruApiError('network', 'network'));
    xhr.onabort = () => finish(reject, new MruApiError('aborted', 'aborted'));
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (data && data.ok === true) {
        finish(resolve, data.value);
        return;
      }
      if (data && data.ok === false) {
        const info = data.error || {};
        finish(reject, new MruApiError(info.code || `http-${xhr.status}`, info.message || '', xhr.status));
        return;
      }
      const code = xhr.status === 413 ? 'too-large' : xhr.status === 415 ? 'unsupported-type' : `http-${xhr.status}`;
      finish(reject, new MruApiError(code, `HTTP ${xhr.status}`, xhr.status));
    };
    try {
      xhr.send(file);
    } catch (error) {
      finish(reject, new MruApiError('network', error instanceof Error ? error.message : 'network'));
    }
  });
}

/** Fire-and-forget diagnostics ping; failures are intentionally silent. */
function mruPing(event, detail) {
  try {
    const body = { clientVersion: MRU_CLIENT_VERSION, event };
    if (detail !== undefined) body.detail = detail;
    const promise = fetch(mruApiUrl('health.ping'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      keepalive: true,
    });
    if (promise && typeof promise.catch === 'function') promise.catch(() => {});
  } catch {
    /* diagnostics must never break the app */
  }
}

/** Human message from a document's persisted error field (string or object). */
function mruDocErrorMessage(doc) {
  const error = doc ? doc.error : null;
  if (!error) return '';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string') return error.message;
  return '';
}

/** Map a transport/host error onto user-facing copy. */
function mruErrorText(t, error) {
  const code = error && error.code ? error.code : '';
  if (code === 'token-missing') return t('err.tokenMissing');
  if (code === 'too-large') return t('err.fileTooLarge', { limit: 200 });
  if (code === 'unsupported-type') return t('err.unsupported');
  if (code === 'host-unavailable') return t('err.hostUnavailable');
  if (code === 'network' || code === 'aborted') return t('err.network');
  if (code === 'translate-unavailable') return t('err.noTranslation');
  if (code === 'forbidden') return t('err.forbidden');
  if (code === 'ai-unavailable' || code === 'llm-unavailable' || code === 'ai-disabled') {
    return t('err.aiUnavailable', { message: (error && error.message) || '' });
  }
  if (code === 'ai-failed' || code === 'llm-failed') {
    return t('err.aiFailed', { message: (error && error.message) || '' });
  }
  if (code === 'context-too-large') return t('err.contextTooLarge');
  if (code === 'local-unsupported') return t('err.localUnsupported');
  if (code === 'local-missing-tool') return t('err.localMissingTool');
  if (code === 'local-empty-text') return t('err.localEmptyText');
  if (code === 'local-encrypted') return t('err.localEncrypted');
  if (code === 'local-failed') {
    const detail = error && typeof error.message === 'string' && error.message.trim() !== '' ? error.message : t('err.generic');
    return t('err.localFailed', { message: detail });
  }
  if (typeof code === 'string' && code.indexOf('local-') === 0) {
    const detail = error && typeof error.message === 'string' && error.message.trim() !== '' ? error.message : t('err.generic');
    return t('err.localFailed', { message: detail });
  }
  if (error && typeof error.message === 'string' && error.message.trim() !== '') return error.message;
  return t('err.generic');
}

/** Normalized AI availability facts from the host `status` payload (docs/AI-SPEC.md §9). */
function mruAiState(status) {
  const ai = status && status.ai && typeof status.ai === 'object' ? status.ai : null;
  return {
    available: Boolean(ai && ai.available),
    graph: Boolean(ai && ai.graph),
    route: ai && ai.route && typeof ai.route === 'object' ? ai.route : null,
  };
}

/** Human label for the AI model route ("deepseek-flash" / "provider · model"). */
function mruAiModelLabel(status) {
  const route = mruAiState(status).route;
  if (!route) return '';
  const model = typeof route.model === 'string' ? route.model.trim() : '';
  const provider = typeof route.provider === 'string' ? route.provider.trim() : '';
  if (model !== '') return model;
  return provider;
}

// ===========================================================================
// 2b. Local parsing helpers (T0/T0.5 client half)
// ===========================================================================

/** File extensions the local engine can handle, grouped by capability. */
const MRU_OFFICE_EXTS = ['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx'];
const MRU_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.jp2', '.webp', '.gif', '.bmp'];
const MRU_HTML_EXTS = ['.html', '.htm'];

/** Normalize the host's `local` capability snapshot; tolerant of older hosts. */
function mruLocalInfo(raw) {
  const local = raw && typeof raw === 'object' ? raw : null;
  if (!local) return null;
  const providers = Array.isArray(local.providers)
    ? local.providers.filter((entry) => entry && typeof entry.id === 'string' && entry.id !== '')
    : [];
  return {
    enabled: local.enabled !== false,
    available: typeof local.available === 'boolean' ? local.available : providers.some((entry) => entry.available === true),
    recommended: typeof local.recommended === 'string' ? local.recommended : '',
    providers,
    capabilities: local.capabilities && typeof local.capabilities === 'object' ? local.capabilities : {},
  };
}

/** True when `capabilities` allow `ext` to be parsed locally; `reason` is an i18n key. */
function mruLocalSupport(local, ext) {
  const info = mruLocalInfo(local);
  if (!info || !info.enabled) return { ok: false, reason: 'setup.localReasonDisabled' };
  if (!info.available) return { ok: false, reason: 'setup.localReasonUnavailable' };
  const capabilities = info.capabilities || {};
  const name = String(ext || '').toLowerCase().replace(/^\./, '');
  const dotted = name === '' ? '' : `.${name}`;
  let supported = false;
  if (dotted === '.pdf') supported = capabilities.textLayerPdf === true;
  else if (MRU_OFFICE_EXTS.includes(dotted)) supported = capabilities.office === true;
  else if (MRU_IMAGE_EXTS.includes(dotted)) supported = capabilities.images === true;
  else if (MRU_HTML_EXTS.includes(dotted)) supported = capabilities.html === true;
  return supported
    ? { ok: true, reason: '' }
    : { ok: false, reason: 'setup.localReasonType' };
}

/**
 * Client-side prediction of the engine `auto` will pick. Mirrors the host
 * policy: token → standard; otherwise a supported file → local; otherwise the
 * lightweight cloud engine when the user allows the upload; else blocked.
 */
function mruEffectiveEngine(engine, tokenConfigured, localSupported, autoAllowAgentFallback) {
  if (engine !== 'auto') return engine;
  if (tokenConfigured) return 'standard';
  if (localSupported) return 'local';
  if (autoAllowAgentFallback !== false) return 'agent';
  return 'blocked';
}

/** i18n key for the effective-engine hint shown next to the start button. */
function mruEffectiveEngineKey(engine) {
  if (engine === 'local') return 'setup.effectiveLocal';
  if (engine === 'agent') return 'setup.effectiveAgent';
  if (engine === 'standard') return 'setup.effectiveStandard';
  return 'setup.effectiveBlocked';
}

/** Short provider label for the status bar (builtin / Office conversion / tool name). */
function mruLocalProviderLabel(t, id) {
  if (id === 'builtin') return t('statusbar.providerBuiltin');
  if (id === 'system:officeToPdf') return t('statusbar.providerOffice');
  if (typeof id === 'string' && id.indexOf('system:') === 0) return id.slice('system:'.length);
  return typeof id === 'string' ? id : '';
}

/** Full provider label for the settings capability list. */
function mruLocalProviderName(t, id) {
  if (id === 'builtin') return t('settings.localBuiltin');
  if (id === 'system:officeToPdf') return t('settings.localOffice');
  if (typeof id === 'string' && id.indexOf('pdftotext') !== -1) return t('settings.localPdfTool');
  return typeof id === 'string' ? id : '';
}

// ===========================================================================
// 3. Small utilities (formatting, geometry, clipboard, icons, KaTeX)
// ===========================================================================

/** Clamp a number into `[min, max]`. */
function mruClamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** True when the user prefers reduced motion. */
function mruReducedMotion() {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** YYYY-MM-DD in the viewer's local time. */
function mruFormatDate(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "今天 14:20" style stamp used by margin notes. */
function mruFormatNoteTime(iso, t) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const translate = typeof t === 'function' ? t : mruTranslate;
  if (sameDay) return `${translate('time.today')} ${time}`;
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/** Locale-aware grouping for counts ("6,240" / "6240"). */
function mruFormatCount(value) {
  const number = Number(value) || 0;
  try {
    return new Intl.NumberFormat().format(number);
  } catch {
    return String(number);
  }
}

/** Human size for the rail metadata. */
function mruFormatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Clamp a fixed overlay next to a DOMRect, keeping 12px viewport margins. */
function mruOverlayPos(rect, width, height) {
  const viewportWidth = window.innerWidth || 1280;
  const viewportHeight = window.innerHeight || 800;
  let left = rect ? rect.left + rect.width / 2 - width / 2 : 12;
  left = mruClamp(left, 12, Math.max(12, viewportWidth - width - 12));
  let top = rect ? rect.top - height - 10 : 12;
  if (rect && top < 12) top = rect.bottom + 10;
  top = mruClamp(top, 12, Math.max(12, viewportHeight - height - 12));
  return { left: Math.round(left), top: Math.round(top) };
}

/** Copy text to the clipboard, returning a promise. */
async function mruCopy(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error('clipboard-unavailable');
}

/** Smoothly scroll to a reader block element. */
function mruScrollToElement(element, block) {
  if (!element || typeof element.scrollIntoView !== 'function') return;
  try {
    element.scrollIntoView({ block: block || 'center', behavior: mruReducedMotion() ? 'auto' : 'smooth' });
  } catch {
    element.scrollIntoView();
  }
}

/**
 * Rebuild the vendored panel SVG so it scales to `size` and takes its color
 * from the surrounding text (`currentColor`). Works whether design ships
 * `currentColor` or a hardcoded hex stroke/fill.
 */
function mruIconMarkup(source, size) {
  const raw = String(source ?? '');
  const viewBoxMatch = /viewBox="([^"]+)"/.exec(raw);
  const viewBox = viewBoxMatch ? viewBoxMatch[1] : `0 0 ${size} ${size}`;
  const inner = raw
    .replace(/^[\s\S]*?<svg[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '')
    .replace(/\b(fill|stroke)="([^"]*)"/gi, (match, attr, value) => {
      if (value === 'none' || value === 'currentColor' || value === 'inherit') return `${attr}="${value}"`;
      return `${attr}="currentColor"`;
    });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Number(size) || 16}" height="${Number(size) || 16}" viewBox="${viewBox}" fill="none" aria-hidden="true" focusable="false">${inner}</svg>`;
}

/** Inline stroke glyphs used by the app chrome (currentColor). */
const MRU_GLYPHS = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 4 4',
  close: 'm6 6 12 12M18 6 6 18',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.5-3.5a7.6 7.6 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.6 3h-4l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z',
  rail: 'M4 5h16M4 12h10M4 19h16',
  margin: 'M4 4h16v16H4zM15 4v16',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  chevronDown: 'm6 9 6 6 6-6',
  translate: 'M4 6h9M8 4v2c0 4-2 7-4 8m5-3c1 2 3 4 5 4M14 12l3.5 8M20 20l-2.5-5.5M13.6 14.5h4.8',
  annotate: 'M4 20h4L20 8l-4-4L4 16v4Zm9-13 4 4',
  copy: 'M9 9h11v11H9zM4 15V4h11v3',
  trash: 'M5 7h14M10 4h4M7 7l1 13h8l1-13M10 11v6M14 11v6',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  export: 'M12 4v11m0 0 4-4m-4 4-4-4M5 19h14',
  file: 'M7 3h7l4 4v14H7zM14 3v4h4',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.4 1.4M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.4-1.4',
  check: 'm5 13 4 4L19 7',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-14v5l3 2',
  spark: 'M12 3l2.1 6.3L21 12l-6.9 2.7L12 21l-2.1-6.3L3 12l6.9-2.7L12 3Z',
  graph: 'M6 4.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm12 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm-6 11a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm-4.6-6.9 4.1 5.6m4.1-5.6-4.1 5.6',
  edit: 'M4 20h4L20 8l-4-4L4 16v4Zm9-13 4 4',
  pin: 'M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  merge: 'M7 4v5a3 3 0 0 0 3 3h8m0 0-3-3m3 3-3 3M7 20v-3',
};

/** Render one inline stroke glyph. */
function MruGlyph({ name, size }) {
  const edge = size || 16;
  return h('svg', {
    width: edge,
    height: edge,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }, h('path', { d: MRU_GLYPHS[name] || MRU_GLYPHS.more }));
}

/** Hidden-but-present spinner. */
function MruSpinner({ label, className }) {
  return h('span', { className: 'mru-spinner' + (className ? ` ${className}` : ''), 'aria-hidden': 'true' });
}

/** Lazily loaded KaTeX runtime shared by all formulas in the app. */
const MRU_KATEX = (() => {
  let status = 'idle';
  let scriptEl = null;
  let linkEl = null;
  const listeners = new Set();
  const setStatus = (next) => {
    status = next;
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        /* ignore subscriber failure */
      }
    }
  };
  return {
    getStatus() {
      return status;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Create the inert <link>/<script> pair on first need. */
    ensure() {
      if (status !== 'idle') return;
      if (typeof document === 'undefined') {
        setStatus('failed');
        return;
      }
      if (globalThis.katex) {
        setStatus('ready');
        return;
      }
      setStatus('loading');
      try {
        linkEl = document.createElement('link');
        linkEl.rel = 'stylesheet';
        linkEl.href = mruAssetUrl('katex/katex.min.css');
        linkEl.setAttribute('data-dsh-litnotes', 'katex');
        document.head.appendChild(linkEl);
        scriptEl = document.createElement('script');
        scriptEl.src = mruAssetUrl('katex/katex.min.js');
        scriptEl.async = true;
        scriptEl.setAttribute('data-dsh-litnotes', 'katex');
        scriptEl.onload = () => setStatus(globalThis.katex ? 'ready' : 'failed');
        scriptEl.onerror = () => setStatus('failed');
        document.head.appendChild(scriptEl);
      } catch {
        setStatus('failed');
      }
    },
    /** Remove the assets (plugin unload). */
    dispose() {
      listeners.clear();
      scriptEl?.parentNode?.removeChild(scriptEl);
      linkEl?.parentNode?.removeChild(linkEl);
      scriptEl = null;
      linkEl = null;
    },
  };
})();

/** Render a LaTeX formula, falling back to raw monospace text until KaTeX is ready. */
function MruFormula({ latex, display, katexReady, inline }) {
  const source = String(latex ?? '');
  const className = inline ? 'mru-formula mru-formula--inline' : 'mru-formula';
  const wrapper = inline ? 'span' : 'div';
  if (katexReady && typeof window !== 'undefined' && window.katex && typeof window.katex.renderToString === 'function') {
    let html = '';
    try {
      html = window.katex.renderToString(source, { displayMode: Boolean(display), throwOnError: false, strict: 'ignore' });
    } catch {
      html = '';
    }
    if (html) {
      return h(wrapper, {
        className,
        'data-latex': source,
        dangerouslySetInnerHTML: { __html: html },
      });
    }
  }
  return h(wrapper, { className: `${className} mru-formula__raw`, 'data-latex': source }, source);
}

// ===========================================================================
// 4. Reader model helpers + selection offsets
// ===========================================================================

/** Wrap parseMarkdown + appendPageMarks and survive a missing helper. */
function mruBuildModel(markdown, contentList, showPageMarks) {
  let model = parseMarkdown(String(markdown ?? ''));
  if (showPageMarks && contentList) {
    try {
      const withMarks = appendPageMarks(model, contentList);
      if (withMarks) model = withMarks;
    } catch {
      /* page marks are best-effort */
    }
  }
  if (!model || !Array.isArray(model.blocks)) model = { blocks: [], outline: [], stats: { blocks: 0, headings: 0, chars: 0, words: 0 } };
  return model;
}

/**
 * The text block currently crossing the reading line (`threshold`), used for
 * the AI context chip. Returns `{ blockKey, text }` or null.
 */
function mruVisibleBlock(body, model, threshold) {
  if (!body || !model || !Array.isArray(model.blocks)) return null;
  for (const block of model.blocks) {
    if (!mruIsTextBlock(block) || typeof block.plainText !== 'string' || block.plainText.trim() === '') continue;
    let element = null;
    try {
      element = body.querySelector(`[data-block-key="${String(block.key).replace(/"/g, '\\"')}"]`);
    } catch {
      element = null;
    }
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (rect.top <= threshold && rect.bottom > threshold - 24) {
      return { blockKey: block.key, text: block.plainText.slice(0, 800) };
    }
    if (rect.top > threshold) return null;
  }
  return null;
}

/**
 * Build the whole-list `annotations.save` payload: normalized (rendered)
 * annotations win by id, while orphan/stale ones are preserved untouched so a
 * reparse can never erase a user's note. (docs: stale-anchor bug)
 */
function mruMergeAnnotations(normalized, orphans) {
  const merged = new Map();
  for (const annotation of Array.isArray(normalized) ? normalized : []) {
    if (!annotation || typeof annotation.id !== 'string' || annotation.id === '') continue;
    merged.set(annotation.id, annotation);
  }
  for (const annotation of Array.isArray(orphans) ? orphans : []) {
    if (!annotation || typeof annotation.id !== 'string' || annotation.id === '') continue;
    if (!merged.has(annotation.id)) merged.set(annotation.id, annotation);
  }
  return Array.from(merged.values());
}

/** Normalize an orphan/stale annotation (no readable block) for display + save. */
function mruOrphanAnnotation(annotation) {
  if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) return null;
  const id = typeof annotation.id === 'string' ? annotation.id.trim() : '';
  if (id === '') return null;
  const createdAt = typeof annotation.createdAt === 'string' && annotation.createdAt !== ''
    ? annotation.createdAt
    : new Date(0).toISOString();
  const out = {
    id,
    blockKey: typeof annotation.blockKey === 'string' ? annotation.blockKey : '',
    start: Math.max(0, Math.trunc(Number(annotation.start)) || 0),
    end: Math.max(0, Math.trunc(Number(annotation.end)) || 0),
    quote: typeof annotation.quote === 'string' ? annotation.quote.slice(0, MRU_MAX_QUOTE) : '',
    color: MRU_COLORS.includes(annotation.color) ? annotation.color : 'yellow',
    note: typeof annotation.note === 'string' ? annotation.note : '',
    createdAt,
    updatedAt: typeof annotation.updatedAt === 'string' && annotation.updatedAt !== ''
      ? annotation.updatedAt
      : createdAt,
    // A client-side orphan is by definition no longer anchored in the draft.
    stale: true,
  };
  if (typeof annotation.staleReason === 'string' && annotation.staleReason !== '') out.staleReason = annotation.staleReason;
  if (annotation.reanchored === true) out.reanchored = true;
  if (annotation.origin === 'ai' || annotation.origin === 'user') out.origin = annotation.origin;
  if (MRU_ASPECT_LEGEND.some((entry) => entry.aspect === annotation.aspect)) out.aspect = annotation.aspect;
  if (typeof annotation.chatId === 'string' && annotation.chatId !== '') out.chatId = annotation.chatId;
  if (typeof annotation.messageId === 'string' && annotation.messageId !== '') out.messageId = annotation.messageId;
  if (annotation.model !== null && typeof annotation.model === 'object'
    && typeof annotation.model.provider === 'string' && typeof annotation.model.model === 'string') {
    out.model = { provider: annotation.model.provider, model: annotation.model.model };
  }
  return out;
}

/** Whether the model contains any formula worth loading KaTeX for. */
function mruModelNeedsKatex(model) {
  if (!model || !Array.isArray(model.blocks)) return false;
  for (const block of model.blocks) {
    if (block.kind === 'formula') return true;
    if (Array.isArray(block.runs) && block.runs.some((run) => run && run.type === 'math')) return true;
    if (Array.isArray(block.items)) {
      for (const item of block.items) {
        if (Array.isArray(item.runs) && item.runs.some((run) => run && run.type === 'math')) return true;
      }
    }
  }
  return false;
}

/** Blocks whose text can be translated / annotated (annotations use plainText offsets). */
function mruIsTextBlock(block) {
  return Boolean(block) && (block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'quote' || block.kind === 'list');
}

/** Blocks that can carry annotations: text blocks plus tables (per highlight.js). */
function mruIsAnnotatableBlock(block) {
  return mruIsTextBlock(block) || (Boolean(block) && block.kind === 'table');
}

/** Inline-math content of one run, tolerating either shape from markdown.js. */
function mruRunLatex(run) {
  if (!run) return '';
  if (typeof run.latex === 'string') return run.latex;
  const text = String(run.text ?? '');
  if (text.startsWith('$$') && text.endsWith('$$')) return text.slice(2, -2);
  if (text.startsWith('$') && text.endsWith('$')) return text.slice(1, -1);
  return text;
}

/** Overlay annotations over runs, adding the absolute plain-text start of each segment. */
function mruSegments(runs, annotations, baseOffset) {
  const base = Number(baseOffset) || 0;
  let segments = [];
  try {
    segments = overlayRuns(Array.isArray(runs) ? runs : [], Array.isArray(annotations) ? annotations : []);
  } catch {
    segments = [{ type: 'text', text: runsText(Array.isArray(runs) ? runs : []), styles: {}, annotationIds: [], color: null }];
  }
  let offset = base;
  for (const segment of segments) {
    segment.start = offset;
    segment.length = String(segment.text ?? '').length;
    offset += segment.length;
  }
  return segments;
}

/** Find the closest `[data-block-key]` element for a DOM node. */
function mruBlockElementOf(node) {
  if (!node) return null;
  const element = node.nodeType === 3 ? node.parentElement : node;
  if (!element || typeof element.closest !== 'function') return null;
  return element.closest('[data-block-key]');
}

/** Character offset of a DOM point inside a reader block's plain-text space. */
function mruOffsetOfPoint(blockElement, node, nodeOffset) {
  if (!blockElement) return 0;
  let segmentElement = node && node.nodeType === 3 ? node.parentElement : node;
  if (segmentElement && typeof segmentElement.closest === 'function') segmentElement = segmentElement.closest('[data-off]');
  if (segmentElement && blockElement.contains(segmentElement)) {
    const base = Number(segmentElement.getAttribute('data-off'));
    const length = Number(segmentElement.getAttribute('data-len'));
    let within = 0;
    try {
      const range = document.createRange();
      range.setStart(segmentElement, 0);
      range.setEnd(node, nodeOffset);
      within = range.toString().length;
    } catch {
      within = 0;
    }
    if (!Number.isFinite(length)) return base + Math.max(0, within);
    return base + mruClamp(within, 0, Math.max(0, length));
  }
  try {
    const range = document.createRange();
    range.selectNodeContents(blockElement);
    range.setEnd(node, nodeOffset);
    return range.toString().length;
  } catch {
    return 0;
  }
}

/**
 * Read the current window selection inside the paper body.
 * Returns { blockKey, start, end, quote, rect, source } or null.
 */
function mruReadSelection(bodyElement, blocksByKey, source) {
  if (!bodyElement || typeof window === 'undefined') return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!bodyElement.contains(range.commonAncestorContainer)) return null;
  const text = selection.toString();
  if (!text || text.trim() === '') return null;
  const startElement = mruBlockElementOf(range.startContainer);
  if (!startElement) return null;
  const blockKey = startElement.getAttribute('data-block-key');
  const block = blocksByKey ? blocksByKey.get(blockKey) : null;
  if (!block || !mruIsAnnotatableBlock(block)) return null;
  const start = mruClamp(mruOffsetOfPoint(startElement, range.startContainer, range.startOffset), 0, block.plainText.length);
  const endElement = mruBlockElementOf(range.endContainer);
  let end;
  if (endElement === startElement) {
    end = mruClamp(mruOffsetOfPoint(endElement, range.endContainer, range.endOffset), 0, block.plainText.length);
  } else {
    end = block.plainText.length;
  }
  if (end <= start) return null;
  return {
    blockKey,
    start,
    end,
    quote: text.length > MRU_MAX_QUOTE ? text.slice(0, MRU_MAX_QUOTE) : text,
    rect: range.getBoundingClientRect(),
    source: source || 'mouse',
  };
}

// ===========================================================================
// 5. Reader rendering (inline runs, blocks, paper)
// ===========================================================================

/**
 * Render inline runs with annotation overlays.
 * Every segment is wrapped in a span carrying `data-off`/`data-len` so DOM
 * selection can be mapped back to plain-text offsets.
 */
function mruRenderInline(runs, annotations, options) {
  const opts = options || {};
  const segments = mruSegments(runs, annotations, opts.baseOffset);
  const nodes = [];
  segments.forEach((segment, index) => {
    if (segment.type !== 'math' && !segment.text) return;
    let inner;
    if (segment.type === 'math') {
      inner = h(MruFormula, { latex: mruRunLatex(segment), inline: true, katexReady: opts.katexReady });
    } else {
      const rawText = String(segment.text);
      if (rawText.indexOf('\ufffd') === -1) {
        inner = rawText;
      } else {
        const label = opts.unknownSymbolLabel || '';
        const parts = rawText.split('\ufffd');
        const children = [];
        parts.forEach((part, partIndex) => {
          if (part !== '') children.push(part);
          if (partIndex < parts.length - 1) {
            children.push(h('span', {
              key: 'unknown-' + index + '-' + partIndex,
              className: 'mru-unknown-symbol',
              role: 'img',
              'aria-label': label,
              title: label,
            }, '□'));
          }
        });
        inner = children;
      }
    }
    const styles = segment.styles || {};
    if (styles.code) inner = h('code', { className: 'mru-inline-code' }, inner);
    if (styles.del) inner = h('del', null, inner);
    if (styles.em) inner = h('em', null, inner);
    if (styles.strong) inner = h('strong', null, inner);
    if (styles.link) {
      inner = h('a', { className: 'mru-link', href: styles.link, target: '_blank', rel: 'noopener noreferrer' }, inner);
    }
    if (Array.isArray(segment.annotationIds) && segment.annotationIds.length > 0) {
      const active = Boolean(opts.activeAnnotationId) && segment.annotationIds.indexOf(opts.activeAnnotationId) !== -1;
      inner = h('mark', {
        className: 'mru-hl mru-hl--' + (segment.color || 'yellow') + (active ? ' mru-hl--active' : ''),
        'data-annotation-id': segment.annotationIds[0],
        'data-annotation-ids': segment.annotationIds.join(' '),
        role: 'mark',
        onClick: (event) => {
          if (!opts.onMarkClick) return;
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed) return;
          opts.onMarkClick(segment.annotationIds[0], event);
        },
      }, inner);
    }
    nodes.push(h('span', {
      key: `seg-${index}`,
      'data-off': segment.start,
      'data-len': segment.length,
    }, inner));
  });
  return nodes;
}

/** Translation state for one block: text, pending, error, or nothing. */
function mruTranslationText(translations, blockKey) {
  if (!translations || typeof translations !== 'object') return null;
  const entries = translations.entries && typeof translations.entries === 'object'
    ? translations.entries
    : translations;
  const entry = entries[blockKey];
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && typeof entry.text === 'string') return entry.text;
  return null;
}

/**
 * Render translated text as rich content: markdown emphasis/code/links through
 * the same inline renderer the source uses, and `$...$` / `$$...$$` formulas
 * through KaTeX (raw fallback until the assets finish loading). Machine
 * translation keeps LaTeX source in the output, so plain-text rendering used to
 * leave every formula as raw `$...$`.
 */
function MruRichText(props) {
  const text = String(props && props.text !== undefined && props.text !== null ? props.text : '');
  const katexReady = Boolean(props && props.katexReady);
  const className = props && props.className ? props.className : 'mru-rich';
  let model = null;
  try {
    model = parseMarkdown(text);
  } catch {
    model = null;
  }
  const blocks = model && Array.isArray(model.blocks) ? model.blocks : [];
  const containsMath = text.indexOf('$') !== -1;
  React.useEffect(() => {
    if (!katexReady && containsMath) MRU_KATEX.ensure();
  }, [katexReady, containsMath]);
  if (blocks.length === 0) return h('span', { className }, text);
  const inline = (runs) => mruRenderInline(runs || [], [], { baseOffset: 0, katexReady, unknownSymbolLabel: '' });
  const nodes = [];
  blocks.forEach((block, index) => {
    if (block === null || typeof block !== 'object') return;
    if (block.kind === 'paragraph' || block.kind === 'heading' || block.kind === 'quote') {
      nodes.push(h('p', { key: 'rich-' + index, className: 'mru-rich__paragraph' }, inline(block.runs)));
      return;
    }
    if (block.kind === 'list') {
      const items = Array.isArray(block.items) ? block.items : [];
      items.forEach((item, itemIndex) => {
        nodes.push(h('p', {
          key: 'rich-' + index + '-' + itemIndex,
          className: 'mru-rich__item',
        }, h('span', { className: 'mru-rich__bullet', 'aria-hidden': 'true' }, '·'), inline(item && item.runs)));
      });
      return;
    }
    if (block.kind === 'formula') {
      nodes.push(h(MruFormula, { key: 'rich-' + index, latex: block.latex, display: true, katexReady }));
      return;
    }
    if (block.kind === 'code') {
      nodes.push(h('pre', { key: 'rich-' + index, className: 'mru-code' }, h('code', null, block.code || '')));
      return;
    }
    if (block.kind === 'table') {
      const head = Array.isArray(block.head) ? block.head : [];
      const rows = Array.isArray(block.rows) ? block.rows : [];
      const all = (head.length > 0 ? [head] : []).concat(rows);
      all.forEach((row, rowIndex) => {
        const cells = Array.isArray(row) ? row : [];
        const textValue = cells
          .map((cell) => (cell && typeof cell.plainText === 'string' ? cell.plainText : ''))
          .filter((value) => value !== '')
          .join('  ');
        if (textValue !== '') nodes.push(h('p', { key: 'rich-' + index + '-' + rowIndex }, textValue));
      });
      return;
    }
    // figure / page / rule carry no meaning inside a translation.
  });
  if (nodes.length === 0) return h('span', { className }, text);
  return h('div', { className }, nodes);
}

/** Render one block's translation block (bilingual / translated modes only). */
function mruTranslationNode(t, block, translation, job, provider, mode, onRetryTranslation, katexReady, flash) {
  if (mode === 'original') return null;
  if (typeof translation === 'string' && translation !== '') {
    const retranslating = Boolean(job && job.state === 'pending');
    return h('div', {
      className: 'mru-para__translation'
        + (retranslating ? ' mru-para__translation--pending' : '')
        + (flash ? ' mru-para__translation--flash' : ''),
    },
      h(MruRichText, { text: translation, katexReady }),
      provider ? h('span', { className: 'mru-para__provider' }, provider) : null);
  }
  if (job && job.state === 'pending') {
    return h('div', { className: 'mru-para__translation' }, h(MruSpinner));
  }
  if (job && job.state === 'error') {
    return h('div', { className: 'mru-para__translation' },
      h('span', { className: 'mru-para__error' },
        t('err.noTranslation'),
        h('button', {
          type: 'button',
          className: 'mru-link-btn mru-para__retry',
          onClick: () => onRetryTranslation && onRetryTranslation(block),
        }, t('reader.retryBlock'))));
  }
  return null;
}

/** Per-block hover tools (translate / retranslate / annotate). */
function mruBlockTools(t, block, options) {
  if (!mruIsTextBlock(block)) return null;
  const opts = options || {};
  const job = opts.job || null;
  const pending = Boolean(job && job.state === 'pending');
  const translated = Boolean(opts.translated);
  const label = pending ? t('reader.translating') : t('reader.translateBlock');
  return h('div', { className: 'mru-block__tools' },
    h('button', {
      type: 'button',
      className: 'mru-icon-btn mru-block__translate' + (translated ? ' mru-block__translate--done' : ''),
      'aria-label': label,
      title: label,
      disabled: pending,
      'aria-busy': pending ? 'true' : undefined,
      onMouseDown: (event) => event.preventDefault(),
      onClick: (event) => {
        if (!pending && opts.onTranslateBlock) opts.onTranslateBlock(block, event);
      },
    }, pending ? h(MruSpinner) : h(MruGlyph, { name: 'translate' })),
    h('button', {
      type: 'button',
      className: 'mru-icon-btn mru-block__annotate',
      'aria-label': t('block.annotate'),
      title: t('block.annotate'),
      onMouseDown: (event) => event.preventDefault(),
      onClick: () => opts.onAnnotateBlock && opts.onAnnotateBlock(block),
    }, h(MruGlyph, { name: 'annotate' })),
    h('button', {
      type: 'button',
      className: 'mru-icon-btn mru-block__ask',
      'aria-label': t('ai.askBlock'),
      title: t('ai.askBlock'),
      onMouseDown: (event) => event.preventDefault(),
      onClick: () => opts.onAskBlock && opts.onAskBlock(block),
    }, h(MruGlyph, { name: 'spark' })));
}

/** Normalize the table block's head/rows into arrays of row arrays. */
function mruTableRows(block) {
  const head = Array.isArray(block.head) ? block.head : [];
  let headRows = [];
  if (head.length > 0) headRows = Array.isArray(head[0]) ? head : [head];
  const rows = Array.isArray(block.rows) ? block.rows : [];
  return { headRows, rows };
}

/** Render one parsed block with the UI-SPEC §3.5 class contract. */
function MruBlockView(props) {
  const {
    t, block, docId, annotations, translations, jobs, providers, mode, katexReady,
    activeAnnotationId, onTranslateBlock, onAnnotateBlock, onRetryTranslation, onMarkClick,
    onAskBlock, flashBlock,
  } = props;
  const anns = Array.isArray(annotations) ? annotations : [];
  const blocksTranslations = translations || {};
  const translation = mruTranslationText(blocksTranslations, block.key);
  const job = jobs ? jobs[block.key] : null;
  const provider = providers ? providers[block.key] : null;
  const hasTranslation = typeof translation === 'string' && translation !== '';
  const translatedClass = mode === 'translated' && hasTranslation ? ' mru-block--has-translation' : '';
  const inline = (runs, baseOffset) => mruRenderInline(runs, anns, {
    baseOffset, katexReady, activeAnnotationId, onMarkClick,
    unknownSymbolLabel: t('reader.unknownSymbol'),
  });
  const translationNode = mruTranslationNode(t, block, translation, job, provider, mode, onRetryTranslation, katexReady, Boolean(props.translationFlash) && props.translationFlash === block.key);
  const tools = mruBlockTools(t, block, {
    onTranslateBlock, onAnnotateBlock, onAskBlock, translated: hasTranslation, job,
  });
  const flashClass = flashBlock && block.key && flashBlock === block.key ? ' mru-block--flash' : '';

  if (block.kind === 'heading') {
    const level = mruClamp(Number(block.level) || 1, 1, 4);
    const tag = 'h' + Math.min(level + 1, 6);
    return h('div', {
      className: `mru-block mru-block--h${level}${translatedClass}${flashClass}`,
      'data-block-key': block.key,
    },
      tools,
      h(tag, { className: `mru-h mru-h--${level}` }, inline(block.runs || [], 0)),
      translationNode);
  }

  if (block.kind === 'paragraph') {
    const showOriginal = mode !== 'translated' || hasTranslation || Boolean(job);
    return h('div', { className: `mru-block mru-block--p${translatedClass}${flashClass}`, 'data-block-key': block.key },
      tools,
      showOriginal ? h('p', { className: 'mru-para__text' }, inline(block.runs || [], 0)) : null,
      showOriginal ? translationNode : h('div', { className: 'mru-para__translation mru-para__translation--source' }, inline(block.runs || [], 0)));
  }

  if (block.kind === 'quote') {
    const showOriginal = mode !== 'translated' || hasTranslation || Boolean(job);
    return h('blockquote', { className: `mru-block mru-block--quote${translatedClass}${flashClass}`, 'data-block-key': block.key },
      showOriginal ? h('p', { className: 'mru-para__text' }, inline(block.runs || [], 0)) : null,
      showOriginal ? translationNode : h('div', { className: 'mru-para__translation mru-para__translation--source' }, inline(block.runs || [], 0)));
  }

  if (block.kind === 'list') {
    const items = Array.isArray(block.items) ? block.items : [];
    const listTag = block.ordered ? 'ol' : 'ul';
    const listClass = 'mru-list' + (block.ordered ? ' mru-list--ordered' : '');
    let cursor = 0;
    const lis = items.map((item, index) => {
      const itemRuns = Array.isArray(item.runs) ? item.runs : [];
      const itemText = typeof item.plainText === 'string' ? item.plainText : runsText(itemRuns);
      const itemStart = cursor;
      const itemAnns = anns
        .map((annotation) => ({
          ...annotation,
          start: annotation.start - itemStart,
          end: annotation.end - itemStart,
        }))
        .filter((annotation) => annotation.end > 0 && annotation.start < itemText.length);
      cursor += itemText.length;
      return h('li', { key: `item-${index}`, className: 'mru-list__item' }, mruRenderInline(itemRuns, itemAnns, {
        baseOffset: itemStart, katexReady, activeAnnotationId, onMarkClick,
      }));
    });
    return h('div', { className: `mru-block mru-block--list${translatedClass}${flashClass}`, 'data-block-key': block.key },
      tools,
      h(listTag, { className: listClass, start: block.ordered && block.start ? block.start : undefined }, lis),
      translationNode);
  }

  if (block.kind === 'code') {
    return h('div', { className: 'mru-block mru-block--code' },
      h('pre', { className: 'mru-code' }, h('code', null, String(block.code ?? block.plainText ?? ''))));
  }

  if (block.kind === 'formula') {
    return h('div', { className: 'mru-block mru-block--formula' },
      h(MruFormula, { latex: block.latex ?? block.plainText ?? '', display: true, katexReady }));
  }

  if (block.kind === 'figure') {
    const imageUrl = block.src ? mruImageUrl(docId, block.src) : '';
    return h('figure', { className: 'mru-block mru-block--figure' },
      imageUrl ? h('span', { className: 'mru-figure__img-wrap' },
        h('img', { className: 'mru-figure__img', loading: 'lazy', src: imageUrl, alt: block.alt || '' })) : null,
      block.caption ? h('figcaption', { className: 'mru-figure__caption' }, block.caption) : null);
  }

  if (block.kind === 'table') {
    const { headRows, rows } = mruTableRows(block);
    // The parser flattens a table into one plain-text space: head cells first,
    // then body rows left-to-right, with a single space between consecutive
    // cells. Track that cursor so annotations land on the right cell text.
    let cellCursor = 0;
    const renderCell = (cell, cellIndex, isHeader) => {
      const cellText = cell && typeof cell.plainText === 'string'
        ? cell.plainText
        : runsText(cell && Array.isArray(cell.runs) ? cell.runs : []);
      const cellStart = cellCursor;
      cellCursor += cellText.length + 1;
      const cellAnns = anns
        .map((annotation) => ({
          ...annotation,
          start: annotation.start - cellStart,
          end: annotation.end - cellStart,
        }))
        .filter((annotation) => annotation.end > 0 && annotation.start < cellText.length);
      const tag = isHeader || (cell && cell.header) ? 'th' : 'td';
      return h(tag, {
        key: `cell-${cellIndex}`,
        colSpan: cell && cell.colspan > 1 ? cell.colspan : undefined,
        rowSpan: cell && cell.rowspan > 1 ? cell.rowspan : undefined,
      }, mruRenderInline(cell && Array.isArray(cell.runs) ? cell.runs : [], cellAnns, {
        baseOffset: cellStart, katexReady, activeAnnotationId, onMarkClick,
      }));
    };
    return h('div', { className: 'mru-block mru-block--table', 'data-block-key': block.key },
      h('div', { className: 'mru-table-wrap' },
        h('table', { className: 'mru-table' },
          headRows.length > 0 ? h('thead', null, headRows.map((row, rowIndex) =>
            h('tr', { key: `head-${rowIndex}` }, (Array.isArray(row) ? row : []).map((cell, cellIndex) =>
              renderCell(cell, cellIndex, true))))) : null,
          rows.length > 0 ? h('tbody', null, rows.map((row, rowIndex) =>
            h('tr', { key: `row-${rowIndex}` }, (Array.isArray(row) ? row : []).map((cell, cellIndex) =>
              renderCell(cell, cellIndex, false))))) : null)),
      block.caption ? h('div', { className: 'mru-table__caption' }, block.caption) : null);
  }

  if (block.kind === 'page') {
    return h('div', { className: 'mru-pagemark', 'data-page': String(block.page ?? '') },
      h('span', { className: 'mru-pagemark__label' }, String(block.page ?? '')));
  }

  if (block.kind === 'rule') return h('hr', { className: 'mru-hr' });

  if (Array.isArray(block.runs)) {
    return h('div', { className: 'mru-block mru-block--p', 'data-block-key': block.key },
      h('p', { className: 'mru-para__text' }, inline(block.runs, 0)));
  }
  return null;
}

// --- AI / graph module surfaces -------------------------------------------
// ui/chat.js (`MruAiPanel`) and ui/graph.js (`MruGraphView`) are concatenated
// into the same bundle scope before app.js. These resolvers keep the reading
// desk renderable while either module is absent (placeholders during the AI
// workstream) and switch to the real component as soon as it defines itself.

/** Resolve the AI panel module (ui/chat.js), or null while it is absent. */
function mruAiPanelComponent() {
  return typeof MruAiPanel === 'function' ? MruAiPanel : null;
}

/** Resolve the graph view module (ui/graph.js), or null while it is absent. */
function mruGraphViewComponent() {
  return typeof MruGraphView === 'function' ? MruGraphView : null;
}

/** Minimal AI panel used only while ui/chat.js is a placeholder. */
function MruAiPanelFallback(props) {
  const { t, available, modelLabel } = props;
  return h('div', { className: 'mru-ai mru-ai--placeholder' },
    h('div', { className: 'mru-ai__head' },
      h('h3', { className: 'mru-ai__title' }, t('ai.title')),
      modelLabel ? h('span', { className: 'mru-ai__model' }, t('ai.model', { model: modelLabel })) : null),
    h('div', { className: 'mru-ai__empty' },
      h('p', { className: 'mru-ai__empty-title' }, available ? t('ai.placeholderTitle') : t('ai.unavailable')),
      h('p', { className: 'mru-ai__empty-text' }, available ? t('ai.placeholderText') : t('ai.unavailableText'))));
}

/** Minimal graph surface used only while ui/graph.js is a placeholder. */
function MruGraphPlaceholder(props) {
  const { t, mode, graph, building, progress, available, error, onBuild, onRefresh } = props;
  const titleKey = mode === 'library' ? 'graph.titleLibrary' : 'graph.titleDoc';
  const nodeCount = graph && Array.isArray(graph.nodes) ? graph.nodes.length : 0;
  let statusText;
  if (available === false) statusText = t('graph.unavailable');
  else if (error) statusText = error;
  else if (building) {
    statusText = progress && Number(progress.total) > 0
      ? t('graph.progress', { done: Number(progress.done) || 0, total: Number(progress.total) || 0 })
      : t('graph.building');
  } else if (nodeCount > 0) statusText = t('graph.nodes', { count: nodeCount });
  else statusText = mode === 'library' ? t('graph.emptyLibrary') : t('graph.emptyDoc');
  return h('div', { className: 'mru-graph mru-graph--placeholder' },
    h('div', { className: 'mru-graph__head' },
      h('h2', { className: 'mru-graph__title' }, t(titleKey)),
      h('div', { className: 'mru-graph__actions' },
        onRefresh ? h('button', {
          type: 'button',
          className: 'mru-btn mru-btn--ghost mru-btn--sm',
          onClick: () => onRefresh(),
        }, t('graph.refresh')) : null,
        onBuild ? h('button', {
          type: 'button',
          className: 'mru-btn mru-btn--primary mru-btn--sm',
          'data-action': 'graph-build',
          disabled: Boolean(building),
          onClick: () => onBuild(),
        }, building ? t('graph.building') : (mode === 'library' ? t('graph.rebuild') : t('graph.build'))) : null)),
    h('div', { className: 'mru-graph__empty' },
      h('p', { className: 'mru-graph__status' }, statusText),
      h('p', { className: 'mru-graph__empty-text' }, t('graph.emptyHint'))));
}

/** Render the AI panel module, or the placeholder while it is absent. */
function MruAiSurface(props) {
  const Component = mruAiPanelComponent();
  if (Component) return h(Component, props);
  return h(MruAiPanelFallback, { t: props.t, available: props.available, modelLabel: props.modelLabel });
}

/** Render the graph view module, or the placeholder while it is absent. */
function MruGraphSurface(props) {
  const Component = mruGraphViewComponent();
  if (Component) {
    return h(Component, {
      t: props.t,
      mode: props.mode,
      graph: props.graph || null,
      building: Boolean(props.building),
      progress: props.progress || null,
      error: props.error || '',
      available: props.available !== false,
      loading: Boolean(props.loading),
      onJump: props.onJump,
      onAsk: props.onAsk,
      onBuild: props.onBuild,
      onRefresh: props.onRefresh,
      onUpdateGraph: props.onUpdateGraph,
    });
  }
  return h(MruGraphPlaceholder, {
    t: props.t,
    mode: props.mode,
    graph: props.graph || null,
    building: Boolean(props.building),
    progress: props.progress || null,
    available: props.available !== false,
    error: props.error || '',
    onBuild: props.onBuild,
    onRefresh: props.onRefresh,
  });
}

/** Paper meta line: file · format · pages · engine model · date. */
function mruPaperMeta(t, doc, readerPages) {
  const parts = [];
  if (doc.originalName) parts.push(doc.originalName);
  const ext = String(doc.ext || '').replace(/^\./, '').toUpperCase();
  if (ext) parts.push(ext);
  const pages = Number(doc.parse && doc.parse.pages) || Number(readerPages) || 0;
  if (pages > 0) parts.push(t('statusbar.pages', { count: pages }));
  const modelVersion = doc.parse && doc.parse.modelVersion;
  if (modelVersion) parts.push(t('paper.metaModel', { model: modelVersion }));
  const created = mruFormatDate(doc.createdAt);
  if (created) parts.push(created);
  const children = [];
  parts.forEach((part, index) => {
    if (index > 0) children.push(h('span', { key: `dot-${index}`, className: 'mru-dot' }, '·'));
    children.push(h('span', { key: `part-${index}` }, part));
  });
  return children;
}

/** The reading paper: runhead, title, meta, blocks, translations. */
function MruPaper(props) {
  const {
    t, doc, reader, mode, katexReady, annotationsByBlock, translations, jobs, providers,
    translationFlash, activeAnnotationId, translateAll, bodyRef, onReaderMouseUp, onReaderKeyUp,
    onModeChange, onScaleDown, onScaleUp, onMoreMenu, onTranslateBlock, onAnnotateBlock,
    onRetryTranslation, onMarkClick, onCancelTranslateAll, onReparse, onOpenSettings,
    docView, onDocViewChange, graphView, flashBlock, onAskBlock,
    docWidth, onDocWidthChange,
  } = props;
  const view = MRU_DOC_VIEWS.includes(docView) ? docView : 'read';
  const graph = graphView || {};
  const [unknownNoticeDismissed, setUnknownNoticeDismissed] = React.useState(false);
  const [legendPopover, setLegendPopover] = React.useState(null);
  const effectiveDocWidth = mruLayoutDocWidth(docWidth);
  React.useEffect(() => {
    if (!legendPopover) return undefined;
    const onPointerDown = (event) => {
      const target = event ? event.target : null;
      if (!target || typeof target.closest !== 'function') return;
      if (target.closest('.mru-aspect-popover') || target.closest('.mru-runhead__legend')) return;
      setLegendPopover(null);
    };
    const onKeyDown = (event) => {
      if (!event || event.key !== 'Escape') return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      setLegendPopover(null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [legendPopover]);
  const openLegend = (event) => {
    let rect = null;
    try {
      const target = event && event.currentTarget;
      rect = target && typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null;
    } catch {
      rect = null;
    }
    setLegendPopover({ rect });
  };
  const legendPos = legendPopover ? mruOverlayPos(legendPopover.rect, 332, 214) : null;
  const [localBannerDismissed, setLocalBannerDismissed] = React.useState(false);
  const model = reader.model || { blocks: [], outline: [], stats: { blocks: 0, headings: 0, chars: 0, words: 0 } };
  const blocks = Array.isArray(model.blocks) ? model.blocks : [];
  const title = String(doc.title || doc.originalName || '');
  let skipKey = null;
  for (const block of blocks) {
    if (block.kind === 'page' || block.kind === 'rule') continue;
    if (block.kind === 'heading' && Number(block.level) === 1 && title && String(block.plainText || '').trim().toLowerCase() === title.trim().toLowerCase()) {
      skipKey = block.key;
    }
    break;
  }
  const modeButtons = MRU_MODES.map((value) => h('button', {
    key: value,
    type: 'button',
    className: 'mru-segmented__item' + (mode === value ? ' mru-segmented__item--active' : ''),
    'aria-pressed': mode === value ? 'true' : 'false',
    onClick: () => onModeChange(value),
  }, t(value === 'original' ? 'reader.modeOriginal' : value === 'bilingual' ? 'reader.modeBilingual' : 'reader.modeTranslated')));
  const translatePct = translateAll && translateAll.total > 0
    ? Math.round((translateAll.done / translateAll.total) * 100) : 0;
  let unknownCount = 0;
  for (const block of blocks) {
    const text = block && typeof block.plainText === 'string' ? block.plainText : '';
    if (text.indexOf('\ufffd') !== -1) unknownCount += (text.match(/\ufffd/g) || []).length;
  }
  const parseMeta = doc.parse && typeof doc.parse === 'object' ? doc.parse : {};
  const isLocalParse = parseMeta.engine === 'local';
  const localParse = isLocalParse && parseMeta.local && typeof parseMeta.local === 'object' ? parseMeta.local : null;
  const localWarnings = localParse && Array.isArray(localParse.warnings) ? localParse.warnings : [];
  const localNoticeParts = isLocalParse ? [t('banner.localText')] : [];
  if (localWarnings.indexOf('missing-fonts') !== -1) localNoticeParts.push(t('banner.missingFonts'));
  if (localWarnings.indexOf('scanned') !== -1) localNoticeParts.push(t('banner.scanned'));
  const showLocalBanner = isLocalParse && !localBannerDismissed;
  const body = view === 'graph'
    ? h('div', { className: 'mru-paper__body mru-paper__body--graph' },
      h(MruGraphSurface, {
        t,
        mode: 'doc',
        graph: graph.graph || null,
        building: Boolean(graph.building),
        progress: graph.progress || null,
        error: graph.error || '',
        available: graph.available !== false,
        loading: Boolean(graph.loading),
        onJump: graph.onJump,
        onAsk: graph.onAsk,
        onBuild: graph.onBuild,
        onRefresh: graph.onRefresh,
        onUpdateGraph: graph.onUpdateGraph,
      }))
    : blocks.length === 0
    ? h('div', { className: 'mru-empty mru-empty--quiet' }, h('p', { className: 'mru-empty__text' }, t('reader.emptyDoc')))
    : blocks.map((block) => {
      if (block.key && skipKey !== null && block.key === skipKey) return null;
      const blockAnns = annotationsByBlock && annotationsByBlock.get(block.key);
      return h(MruBlockView, {
        key: block.key || `block-${block.index}`,
        t,
        block,
        docId: doc.id,
        annotations: blockAnns || [],
        translations,
        jobs,
        providers,
        translationFlash,
        mode,
        katexReady,
        activeAnnotationId,
        onTranslateBlock,
        onAnnotateBlock,
        onRetryTranslation,
        onMarkClick,
        onAskBlock,
        flashBlock,
      });
    });
  return h('article', {
    className: 'mru-paper' + (mode === 'translated' ? ' mru-paper--translated' : ''),
    key: doc.id || 'paper',
  },
    h('header', { className: 'mru-paper__runhead' },
      h('div', { className: 'mru-paper__runhead-title' }, title),
      h('div', { className: 'mru-paper__runhead-actions' },
        h('div', { className: 'mru-runhead__width-group', role: 'group', 'aria-label': t('layout.widthGroup') },
          MRU_DOC_WIDTH_PRESETS.map((width) => h('button', {
            key: width,
            type: 'button',
            className: 'mru-runhead__width' + (effectiveDocWidth === width ? ' mru-runhead__width--active' : ''),
            'aria-pressed': effectiveDocWidth === width ? 'true' : 'false',
            'aria-label': `${t(mruLayoutWidthLabelKey(width))} ${width}px`,
            title: `${t(mruLayoutWidthLabelKey(width))} · ${width}px`,
            onClick: () => {
              if (typeof onDocWidthChange === 'function') onDocWidthChange(width);
            },
          }, t(mruLayoutWidthLabelKey(width))))),
        h('button', {
          type: 'button',
          className: 'mru-btn mru-btn--ghost mru-btn--sm mru-runhead__legend',
          'aria-haspopup': 'dialog',
          'aria-expanded': legendPopover ? 'true' : 'false',
          title: t('aspect.legendTitle'),
          onClick: openLegend,
        }, h(MruGlyph, { name: 'spark', size: 13 }), t('aspect.legendTitle')),
        h('div', { className: 'mru-segmented mru-segmented--view', role: 'group', 'aria-label': t('reader.viewGroup') },
          h('button', {
            type: 'button',
            className: 'mru-segmented__item' + (view === 'read' ? ' mru-segmented__item--active' : ''),
            'aria-pressed': view === 'read' ? 'true' : 'false',
            onClick: () => onDocViewChange('read'),
          }, t('reader.viewRead')),
          h('button', {
            type: 'button',
            className: 'mru-segmented__item' + (view === 'graph' ? ' mru-segmented__item--active' : ''),
            'aria-pressed': view === 'graph' ? 'true' : 'false',
            onClick: () => onDocViewChange('graph'),
          }, t('reader.viewGraph'))),
        view === 'read'
          ? h('div', { className: 'mru-segmented', role: 'group', 'aria-label': t('reader.modeGroup') }, modeButtons)
          : null,
        view === 'read' ? h('button', {
          type: 'button',
          className: 'mru-btn mru-btn--ghost mru-btn--icon mru-font-dec',
          'aria-label': t('reader.fontDec'),
          title: t('reader.fontDec'),
          onClick: onScaleDown,
        }, 'A−') : null,
        view === 'read' ? h('button', {
          type: 'button',
          className: 'mru-btn mru-btn--ghost mru-btn--icon mru-font-inc',
          'aria-label': t('reader.fontInc'),
          title: t('reader.fontInc'),
          onClick: onScaleUp,
        }, 'A+') : null,
        h('button', {
          type: 'button',
          className: 'mru-btn mru-btn--ghost mru-btn--icon mru-more',
          'aria-label': t('reader.more'),
          title: t('reader.more'),
          onClick: (event) => onMoreMenu(event.currentTarget),
        }, h(MruGlyph, { name: 'more' })))),
    h('div', { className: 'mru-paper__col' },
      h('h1', { className: 'mru-paper__title' }, title),
      h('div', { className: 'mru-paper__meta' }, mruPaperMeta(t, doc, reader.pages)),
      h('div', { className: 'mru-paper__rule' }),
      unknownCount > 0 && !unknownNoticeDismissed
        ? h('div', { className: 'mru-banner mru-banner--warn mru-banner--inline', role: 'status' },
          h('span', { className: 'mru-banner__text' }, t('reader.unknownNotice', { count: unknownCount })),
          h('div', { className: 'mru-banner__actions' },
            h('button', {
              type: 'button',
              className: 'mru-btn mru-btn--ghost mru-btn--sm',
              onClick: () => { if (onReparse) onReparse(true); },
            }, t('menu.reparse')),
            h('button', {
              type: 'button',
              className: 'mru-icon-btn',
              'aria-label': t('settings.close'),
              title: t('settings.close'),
              onClick: () => setUnknownNoticeDismissed(true),
            }, '×')))
        : null,
      showLocalBanner
        ? h('div', { className: 'mru-banner mru-banner--info mru-banner--inline mru-banner--local', role: 'status' },
          h('div', { className: 'mru-banner__body' },
            h('strong', { className: 'mru-banner__title' }, t('banner.localTitle')),
            h('span', { className: 'mru-banner__text' }, localNoticeParts.join(' '))),
          h('div', { className: 'mru-banner__actions' },
            h('button', {
              type: 'button',
              className: 'mru-btn mru-btn--ghost mru-btn--sm',
              onClick: () => { if (onOpenSettings) onOpenSettings(); },
            }, t('banner.upgrade')),
            h('button', {
              type: 'button',
              className: 'mru-btn mru-btn--ghost mru-btn--sm',
              onClick: () => { if (onReparse) onReparse(false); },
            }, t('menu.reparse')),
            h('button', {
              type: 'button',
              className: 'mru-icon-btn',
              'aria-label': t('settings.close'),
              title: t('settings.close'),
              onClick: () => setLocalBannerDismissed(true),
            }, '×')))
        : null,
      translateAll && translateAll.running ? h('div', { className: 'mru-parsing mru-parsing--translate' },
        h('div', { className: 'mru-parsing__row' },
          h(MruSpinner),
          h('span', { className: 'mru-parsing__text' }, t('translate.progress', { done: translateAll.done, total: translateAll.total })),
          h('button', {
            type: 'button',
            className: 'mru-btn mru-btn--ghost mru-btn--sm',
            onClick: onCancelTranslateAll,
          }, t('translate.cancel'))),
        h('div', { className: 'mru-progress' },
          h('div', { className: 'mru-progress__fill', style: { width: `${translatePct}%` } }))) : null,
      view === 'read'
        ? h('div', {
          className: 'mru-paper__body',
          ref: bodyRef,
          onMouseUp: onReaderMouseUp,
          onKeyUp: onReaderKeyUp,
        }, body)
        : body),
    legendPopover && legendPos
      ? h('div', {
        className: 'mru-aspect-popover',
        role: 'dialog',
        'aria-label': t('aspect.legendTitle'),
        style: { left: `${legendPos.left}px`, top: `${legendPos.top}px` },
      },
        h('div', { className: 'mru-aspect-popover__head' },
          h('span', { className: 'mru-aspect-popover__title' }, t('aspect.legendTitle')),
          h('button', {
            type: 'button',
            className: 'mru-icon-btn',
            'aria-label': t('settings.close'),
            title: t('settings.close'),
            onClick: () => setLegendPopover(null),
          }, '×')),
        h(MruAspectLegend, { t }))
      : null);
}

/** Centered "loading the parsed draft…" state (shown after a 400ms delay). */
function MruReaderLoading({ t }) {
  return h('div', { className: 'mru-empty', 'aria-busy': 'true' },
    h(MruSpinner),
    h('p', { className: 'mru-empty__text' }, t('reader.loading')));
}

/** Full empty-library state. */
function MruEmptyLibrary({ t, onChooseFile, onImportUrl }) {
  return h('div', { className: 'mru-empty' },
    h('div', { className: 'mru-empty__art', 'aria-hidden': 'true', dangerouslySetInnerHTML: { __html: EMPTY_ART } }),
    h('h1', { className: 'mru-empty__title' }, t('empty.title')),
    h('p', { className: 'mru-empty__text' }, t('empty.text')),
    h('div', { className: 'mru-empty__actions' },
      h('button', { type: 'button', className: 'mru-btn mru-btn--primary', onClick: onChooseFile }, t('empty.choose')),
      h('button', { type: 'button', className: 'mru-btn mru-btn--ghost', onClick: onImportUrl }, t('topbar.fromUrl'))),
    h('p', { className: 'mru-empty__hint' }, t('empty.hint')));
}

/** Quiet "pick a paper" state. */
function MruEmptyQuiet({ t }) {
  return h('div', { className: 'mru-empty mru-empty--quiet' },
    h('h1', { className: 'mru-empty__title' }, t('empty.select')));
}

// ===========================================================================
// 6. Parse states (setup / parsing / failure)
// ===========================================================================

/** Switch row used by the setup panel. */
function mruToggleRow(t, titleKey, hintKey, checked, onToggle, disabled) {
  const off = disabled === true;
  return h('div', { className: 'mru-toggle-row' + (off ? ' mru-toggle-row--disabled' : '') },
    h('span', { className: 'mru-toggle-row__text' },
      h('span', { className: 'mru-toggle-row__title' }, t(titleKey)),
      h('span', { className: 'mru-toggle-row__hint' }, t(hintKey))),
    h('span', {
      className: 'mru-switch' + (checked ? ' mru-switch--on' : '') + (off ? ' mru-switch--disabled' : ''),
      role: 'switch',
      'aria-checked': checked ? 'true' : 'false',
      'aria-disabled': off ? 'true' : 'false',
      tabIndex: off ? -1 : 0,
      onClick: () => { if (!off) onToggle(!checked); },
      onKeyDown: (event) => {
        if (off) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle(!checked);
        }
      },
    }));
}

/** Parse options form (uploaded / failed documents, also reused by reparse). */
function MruSetupPanel(props) {
  const {
    t, prefs, doc, local, tokenConfigured, busy, errorMessage, onSubmit, onOpenSettings,
  } = props;
  const support = mruLocalSupport(local, doc && doc.ext);
  const localDisabled = !support.ok;
  const preferredEngine = props.initialEngine || prefs.defaultEngine || 'auto';
  const [engine, setEngine] = React.useState(preferredEngine === 'local' && localDisabled ? 'auto' : preferredEngine);
  const [modelVersion, setModelVersion] = React.useState(prefs.defaultModelVersion || 'vlm');
  const [language, setLanguage] = React.useState(prefs.defaultLanguage || 'ch');
  const [pageRanges, setPageRanges] = React.useState('');
  const [isOcr, setIsOcr] = React.useState(Boolean(prefs.defaultIsOcr));
  const [enableFormula, setEnableFormula] = React.useState(prefs.defaultEnableFormula !== false);
  const [enableTable, setEnableTable] = React.useState(prefs.defaultEnableTable !== false);
  const isLocal = engine === 'local';
  const effective = mruEffectiveEngine(engine, Boolean(tokenConfigured), support.ok, prefs.autoAllowAgentFallback);
  const needsToken = engine === 'standard' || (engine === 'auto' && (effective === 'agent' || effective === 'blocked'));
  const options = {
    engine,
    modelVersion,
    language,
    isOcr,
    enableFormula,
    enableTable,
    pageRanges: pageRanges.trim(),
  };
  const start = () => {
    if (busy) return;
    onSubmit(options);
  };
  React.useEffect(() => {
    if (engine === 'local' && localDisabled) setEngine('auto');
  }, [engine, localDisabled]);
  React.useEffect(() => {
    const onKey = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        start();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [engine, modelVersion, language, isOcr, enableFormula, enableTable, pageRanges, busy]);
  return h('section', { className: 'mru-setup' },
    h('div', { className: 'mru-setup__intro' },
      h('h2', { className: 'mru-setup__title' }, t('setup.title')),
      h('p', { className: 'mru-setup__text' }, t('setup.text'))),
    needsToken ? h('div', { className: 'mru-callout mru-callout--warn mru-callout--stack' },
      h('span', { className: 'mru-callout__body' },
        h('span', { className: 'mru-callout__text' }, t('setup.tokenWarnLocal')),
        h('span', { className: 'mru-callout__sub' }, t('setup.tokenWarnPrivacy'))),
      h('button', { type: 'button', className: 'mru-link-btn', onClick: onOpenSettings }, t('setup.tokenAction'))) : null,
    errorMessage ? h('div', { className: 'mru-callout mru-callout--warn mru-callout--error' }, errorMessage) : null,
    h('div', { className: 'mru-setup__grid' },
      h('div', { className: 'mru-field' },
        h('label', { className: 'mru-field__label' }, t('setup.engine')),
        h('select', {
          className: 'mru-select',
          value: engine,
          onChange: (event) => setEngine(event.target.value),
        },
          h('option', { value: 'auto' }, t('setup.engineAuto')),
          h('option', { value: 'standard' }, t('setup.engineStandard')),
          h('option', { value: 'local', disabled: localDisabled },
            localDisabled ? `${t('setup.engineLocal')} — ${t('setup.engineLocalUnavailable')}` : t('setup.engineLocal')),
          h('option', { value: 'agent' }, t('setup.engineAgent'))),
        localDisabled
          ? h('span', { className: 'mru-field__hint mru-field__hint--warn' },
            t('setup.engineLocalWhy', { reason: t(support.reason) }))
          : null),
      h('div', { className: 'mru-field' },
        h('label', { className: 'mru-field__label' }, t('setup.model')),
        h('select', {
          className: 'mru-select',
          value: modelVersion,
          disabled: engine === 'agent' || isLocal,
          onChange: (event) => setModelVersion(event.target.value),
        },
          h('option', { value: 'vlm' }, 'vlm'),
          h('option', { value: 'pipeline' }, 'pipeline'))),
      h('div', { className: 'mru-field' },
        h('label', { className: 'mru-field__label' }, t('setup.language')),
        h('select', {
          className: 'mru-select',
          value: language,
          disabled: isLocal,
          onChange: (event) => setLanguage(event.target.value),
        },
          MRU_LANGUAGE_OPTIONS.map(([value, key]) => h('option', { key: value, value }, t(key))))),
      h('div', { className: 'mru-field' },
        h('label', { className: 'mru-field__label' }, t('setup.pageRanges')),
        h('input', {
          className: 'mru-input',
          type: 'text',
          value: pageRanges,
          placeholder: '2,4-6',
          onChange: (event) => setPageRanges(event.target.value),
        }),
        h('span', { className: 'mru-field__hint' }, t('setup.pageRangesHint')))),
    h('div', { className: 'mru-setup__toggles' },
      mruToggleRow(t, 'setup.formula', 'setup.formulaHint', enableFormula, setEnableFormula, isLocal),
      mruToggleRow(t, 'setup.table', 'setup.tableHint', enableTable, setEnableTable, isLocal),
      mruToggleRow(t, 'setup.ocr', 'setup.ocrHint', isOcr, setIsOcr, isLocal)),
    h('div', { className: 'mru-setup__foot' },
      h('button', {
        type: 'button',
        className: 'mru-btn mru-btn--primary',
        disabled: busy,
        onClick: start,
      }, busy ? t('parse.starting') : t('setup.start')),
      h('span', { className: 'mru-setup__effective' }, t(mruEffectiveEngineKey(effective))),
      h('span', { className: 'mru-note-text' }, t(isLocal ? 'setup.noteLocal' : 'setup.note'))));
}

/**
 * Parsing progress panel.
 *
 * MinerU only reports page progress while the task is `running`, and the
 * pipeline model / OCR often report `extracted_pages: 0` for the whole queue
 * and warm-up phase. A determinate 0 % bar then looks frozen, so without a
 * positive page count the panel shows the upstream phase, a live elapsed timer
 * and an indeterminate bar. `inline` renders it above the old paper when an
 * already-parsed document is being reparsed / page-repaired.
 */
function MruParsingPanel({ t, doc, onCancel, inline }) {
  const progress = doc && doc.parse && doc.parse.progress ? doc.parse.progress : null;
  const done = progress && Number.isFinite(Number(progress.extracted)) ? Number(progress.extracted) : 0;
  const total = progress && Number.isFinite(Number(progress.total)) ? Number(progress.total) : 0;
  const determinate = done > 0 && total > 0;
  const percent = determinate ? mruClamp(Math.round((done / total) * 100), 0, 100) : 0;
  const startedAt = doc && doc.parse ? doc.parse.startedAt : null;
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = mruFormatElapsed(startedAt, now);
  const text = determinate ? t('parsing.text', { done, total }) : t(mruParsePhaseKey(doc));
  return h('div', { className: 'mru-parsing' + (inline ? ' mru-parsing--inline' : ''), 'aria-busy': 'true' },
    h('div', { className: 'mru-parsing__row' },
      h(MruSpinner),
      h('span', { className: 'mru-parsing__text' }, text),
      elapsed ? h('span', { className: 'mru-parsing__elapsed' }, t('parsing.elapsed', { time: elapsed })) : null,
      h('button', { type: 'button', className: 'mru-btn mru-btn--ghost mru-btn--sm', onClick: onCancel }, t('parsing.cancel'))),
    h('div', {
      className: 'mru-progress' + (determinate ? '' : ' mru-progress--indeterminate'),
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': determinate ? String(percent) : undefined,
      'aria-label': t('parsing.textNoProgress'),
    },
      h('div', { className: 'mru-progress__fill', style: determinate ? { width: `${percent}%` } : undefined })),
    mruIsSlowParse(doc) ? h('p', { className: 'mru-parsing__hint' }, t('parsing.slowHint')) : null);
}

/** Parse failure panel. */
function MruFailPanel({ t, message, suggestion, onRetry, onOtherEngine }) {
  return h('div', { className: 'mru-fail' },
    h('h2', { className: 'mru-fail__title' }, t('fail.title')),
    h('p', { className: 'mru-fail__text' }, message || t('err.generic')),
    suggestion ? h('p', { className: 'mru-fail__hint' }, suggestion) : null,
    h('div', { className: 'mru-fail__actions' },
      h('button', { type: 'button', className: 'mru-btn mru-btn--primary', onClick: onRetry }, t('fail.retry')),
      h('button', { type: 'button', className: 'mru-btn mru-btn--ghost', onClick: onOtherEngine }, t('fail.otherEngine'))));
}

// ===========================================================================
// 7. Main column dispatcher
// ===========================================================================

/** Center column: paper, parse states, or empty states. */
function MruMain(props) {
  const {
    t, boot, docsReady, docsCount, selectedDoc, reader, prefs, parseBusy, parseError,
    onChooseFile, onImportUrl, onSetupSubmit, onOpenSettings, onCancelParse, onRetryParse,
    onOtherEngine, onReloadReader, onOpenDoc, onReparse,
  } = props;
  const scroll = (children) => h('main', { className: 'mru-main' },
    h('div', { className: 'mru-paper-scroll', ref: props.scrollRef }, children));
  const wrap = scroll;

  if (props.libraryView === 'graph') {
    return h('main', { className: 'mru-main mru-main--graph' },
      h(MruGraphSurface, Object.assign({ t, mode: 'library' }, props.libraryGraphProps || {})));
  }

  if (selectedDoc === null || selectedDoc === undefined) {
    if (props.selectedId) return scroll(h(MruReaderLoading, { t }));
    if (!docsReady) return wrap(h('div', { className: 'mru-empty', 'aria-busy': 'true' }, h(MruSpinner)));
    if (docsCount === 0) return wrap(h(MruEmptyLibrary, { t, onChooseFile, onImportUrl }));
    return wrap(h(MruEmptyQuiet, { t }));
  }

  if (reader.phase === 'ready') {
    const paper = h(MruPaper, {
      ...props.paperProps,
      doc: selectedDoc,
      reader,
      key: selectedDoc.id,
      onReparse,
      onOpenSettings,
    });
    // A reparse / page repair on an already-read document keeps the old paper
    // on screen; without this inline panel the long pipeline/OCR wait looks
    // like nothing is happening. The wrapper stays mounted between states so
    // the paper is never remounted (scroll position / dismissed notices stay).
    return scroll(h(React.Fragment, null,
      selectedDoc.status === 'parsing'
        ? h(MruParsingPanel, { t, doc: selectedDoc, onCancel: onCancelParse, inline: true })
        : null,
      paper));
  }

  if (reader.phase === 'loading') {
    if (!reader.showSpinner) return wrap(h('div', { className: 'mru-empty', 'aria-busy': 'true' }));
    return scroll(h(MruReaderLoading, { t }));
  }

  if (reader.phase === 'error') {
    return scroll(h(MruFailPanel, {
      t,
      message: reader.error || t('reader.loadFailed'),
      onRetry: onReloadReader,
      onOtherEngine: onOpenDoc ? () => onOpenDoc(selectedDoc.id) : onReloadReader,
    }));
  }

  if (selectedDoc.status === 'parsed') {
    return scroll(h(MruReaderLoading, { t }));
  }
  if (selectedDoc.status === 'parsing') {
    return scroll(h(MruParsingPanel, { t, doc: selectedDoc, onCancel: onCancelParse }));
  }
  if (selectedDoc.status === 'failed') {
    const failureEngine = selectedDoc.parse && typeof selectedDoc.parse === 'object' ? selectedDoc.parse.engine : '';
    return scroll(h(MruFailPanel, {
      t,
      message: mruDocErrorMessage(selectedDoc),
      suggestion: failureEngine === 'local' ? t('fail.localSuggestion') : '',
      onRetry: onRetryParse,
      onOtherEngine,
    }));
  }
  return scroll(h(MruSetupPanel, {
    t,
    doc: selectedDoc,
    prefs,
    local: props.local,
    tokenConfigured: Boolean(props.tokenConfigured),
    busy: Boolean(parseBusy),
    errorMessage: parseError || '',
    onSubmit: onSetupSubmit,
    onOpenSettings,
  }));
}

// ===========================================================================
// 8. Chrome: topbar, rail, margin, status bar, overlays
// ===========================================================================

/** Top bar: brand, import menu, rail/margin toggles, settings. */
function MruTopbar(props) {
  const {
    t, counts, menuOpen, onImportMenu, onToggleRail, onToggleMargin, onOpenSettings,
    railOpen, marginOpen, libraryView, onLibraryView,
  } = props;
  return h('div', { className: 'mru-topbar' },
    h('div', { className: 'mru-brand' },
      h('span', {
        className: 'mru-brand__mark',
        'aria-hidden': 'true',
        dangerouslySetInnerHTML: { __html: mruIconMarkup(PANEL_ICON, 20) },
      }),
      h('span', { className: 'mru-brand__name' }, t('brand.name')),
      h('span', { className: 'mru-brand__count' }, t('brand.count', { count: counts.total || 0 }))),
    h('div', { className: 'mru-topbar__spacer' }),
    h('div', { className: 'mru-topbar__actions' },
      h('div', { className: 'mru-topbar__view' },
        h('div', { className: 'mru-segmented mru-segmented--view', role: 'group', 'aria-label': t('topbar.viewGroup') },
          h('button', {
            type: 'button',
            className: 'mru-segmented__item' + (libraryView !== 'graph' ? ' mru-segmented__item--active' : ''),
            'aria-pressed': libraryView !== 'graph' ? 'true' : 'false',
            onClick: () => onLibraryView('library'),
          }, t('topbar.viewLibrary')),
          h('button', {
            type: 'button',
            className: 'mru-segmented__item' + (libraryView === 'graph' ? ' mru-segmented__item--active' : ''),
            'aria-pressed': libraryView === 'graph' ? 'true' : 'false',
            onClick: () => onLibraryView('graph'),
          }, t('topbar.viewGraph')))),
      h('button', {
        type: 'button',
        className: 'mru-btn mru-btn--primary',
        'data-action': 'import',
        'aria-haspopup': 'menu',
        'aria-expanded': menuOpen ? 'true' : 'false',
        onClick: (event) => onImportMenu(event.currentTarget),
      }, t('topbar.import')),
      h('button', {
        type: 'button',
        className: 'mru-btn mru-btn--ghost mru-btn--icon mru-toggle-rail',
        'aria-label': t('rail.title'),
        'aria-pressed': railOpen ? 'true' : 'false',
        onClick: onToggleRail,
      }, h(MruGlyph, { name: 'rail' })),
      h('button', {
        type: 'button',
        className: 'mru-btn mru-btn--ghost mru-btn--icon mru-toggle-margin',
        'aria-label': t('margin.label'),
        'aria-pressed': marginOpen ? 'true' : 'false',
        onClick: onToggleMargin,
      }, h(MruGlyph, { name: 'margin' })),
      h('button', {
        type: 'button',
        className: 'mru-btn mru-btn--ghost mru-btn--icon',
        'aria-label': t('settings.title'),
        title: t('settings.title'),
        onClick: onOpenSettings,
      }, h(MruGlyph, { name: 'settings' }))));
}

/** One library row. */
function MruDocRow({ t, doc, active, onSelect, onMenu }) {
  const pages = Number(doc.parse && doc.parse.pages) || 0;
  const metaParts = [];
  const ext = String(doc.ext || '').replace(/^\./, '').toUpperCase();
  if (ext) metaParts.push(ext);
  if (pages > 0) metaParts.push(t('unit.pages', { count: pages }));
  if (doc.parse && doc.parse.modelVersion) metaParts.push(doc.parse.modelVersion);
  else if (doc.size) metaParts.push(mruFormatSize(doc.size));
  const statusKey = `status.${doc.status || 'uploaded'}`;
  const metaChildren = [];
  metaParts.forEach((part, index) => {
    if (index > 0) metaChildren.push(h('span', { key: `dot-${index}`, className: 'mru-dot' }, '·'));
    metaChildren.push(h('span', { key: `part-${index}` }, part));
  });
  return h('button', {
    type: 'button',
    role: 'listitem',
    className: 'mru-doc' + (active ? ' mru-doc--active' : ''),
    'data-status': doc.status || 'uploaded',
    'aria-current': active ? 'page' : undefined,
    onClick: () => onSelect(doc.id),
  },
    h('span', { className: 'mru-doc__title' }, doc.title || doc.originalName || doc.id || ''),
    h('span', { className: 'mru-doc__meta' }, metaChildren),
    h('span', { className: `mru-chip mru-chip--${doc.status || 'uploaded'}` },
      t(statusKey),
      doc.status === 'parsing' ? h('span', { className: 'mru-chip__pulse', 'aria-hidden': 'true' }) : null),
    h('span', { className: 'mru-doc__actions' },
      h('span', {
        className: 'mru-icon-btn',
        role: 'button',
        tabIndex: 0,
        'aria-label': t('reader.more'),
        title: t('reader.more'),
        onClick: (event) => {
          event.preventDefault();
          event.stopPropagation();
          onMenu(event.currentTarget, doc);
        },
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            onMenu(event.currentTarget, doc);
          }
        },
      }, h(MruGlyph, { name: 'more' }))));
}

/** Upload-in-progress row with a determinate chip bar. */
function MruUploadRow({ t, upload }) {
  const percent = mruClamp(Math.round((upload.progress || 0) * 100), 0, 100);
  return h('div', { className: 'mru-doc', 'data-status': 'uploaded' },
    h('span', { className: 'mru-doc__title' }, upload.name),
    h('span', { className: 'mru-doc__meta' }, t('status.uploaded')),
    h('span', { className: 'mru-chip mru-chip--uploaded' },
      `${percent}%`,
      h('span', {
        className: 'mru-chip__progress',
        'aria-hidden': 'true',
        style: { width: `${percent}%` },
      })));
}

/** Left library rail: head, search, document list, foot. */
function MruRail(props) {
  const {
    t, docs, docsReady, hasDocs, search, onSearch, onClearSearch, selectedId,
    onSelectDoc, onDocMenu, uploads, counts, searchRef,
  } = props;
  let list;
  if (!docsReady) {
    list = h(React.Fragment, null,
      h('div', { className: 'mru-doc-skeleton', key: 'sk1' }),
      h('div', { className: 'mru-doc-skeleton', key: 'sk2' }),
      h('div', { className: 'mru-doc-skeleton', key: 'sk3' }));
  } else if (docs.length === 0 && uploads.length === 0) {
    list = h('div', { className: 'mru-rail__empty' }, hasDocs ? t('rail.searchEmpty') : t('rail.empty'));
  } else {
    const rows = docs.map((doc) => h(MruDocRow, {
      key: doc.id,
      t,
      doc,
      active: doc.id === selectedId,
      onSelect: onSelectDoc,
      onMenu: onDocMenu,
    }));
    const uploadRows = uploads.map((upload) => h(MruUploadRow, { key: upload.key, t, upload }));
    list = rows.concat(uploadRows);
  }
  return h('aside', { className: 'mru-rail' },
    h('div', { className: 'mru-rail__head' },
      h('h2', { className: 'mru-rail__title' }, t('rail.title')),
      h('span', { className: 'mru-rail__count' }, String(counts.total || 0))),
    h('div', { className: 'mru-search' },
      h('span', { className: 'mru-search__icon', 'aria-hidden': 'true' }, h(MruGlyph, { name: 'search', size: 15 })),
      h('input', {
        className: 'mru-search__input',
        type: 'search',
        placeholder: t('rail.search'),
        'aria-label': t('rail.search'),
        value: search,
        ref: searchRef,
        onChange: (event) => onSearch(event.target.value),
        onKeyDown: (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClearSearch();
          }
        },
      }),
      h('button', {
        type: 'button',
        className: 'mru-search__clear',
        'aria-label': t('rail.clear'),
        title: t('rail.clear'),
        onClick: onClearSearch,
      }, '×')),
    h('div', { className: 'mru-rail__list', role: 'list' }, list),
    h('div', { className: 'mru-rail__foot' },
      t('rail.foot', { count: counts.total || 0, parsed: counts.parsed || 0 })));
}

/** Aspect colour legend row: dot + always-visible text label (docs/UI-POLISH-SPEC.md §5). */
function MruAspectLegend(props) {
  const { t } = props;
  const className = 'mru-aspect-legend' + (props.className ? ` ${props.className}` : '');
  return h('div', { className, role: 'list' },
    MRU_ASPECT_LEGEND.map((entry) => h('span', {
      key: entry.aspect,
      className: 'mru-aspect-legend__item',
      role: 'listitem',
      title: t(entry.labelKey),
    },
      h('span', {
        className: 'mru-aspect-legend__dot mru-aspect-legend__dot--' + entry.aspect,
        'aria-hidden': 'true',
      }),
      h('span', { className: 'mru-aspect-legend__label' }, t(entry.labelKey)))));
}

/**
 * Draggable panel divider between rail/main and main/margin.
 * Pointer drag updates live; pointerup persists through the parent. Arrow keys
 * move the divider by 8px, double-click restores the default width.
 */
function MruResizer(props) {
  const { t, kind, value, active, onChange, onReset, onDragStart, onDragEnd } = props;
  const limits = kind === 'rail' ? MRU_LAYOUT_LIMITS.rail : MRU_LAYOUT_LIMITS.margin;
  const fallback = kind === 'rail' ? MRU_LAYOUT_DEFAULTS.railWidth : MRU_LAYOUT_DEFAULTS.marginWidth;
  const label = t(kind === 'rail' ? 'layout.resizeRail' : 'layout.resizeMargin');
  const current = Math.round(Number(value) || fallback);
  const apply = (width, persist) => {
    if (typeof onChange === 'function') onChange(mruClamp(Math.round(width), limits.min, limits.max), Boolean(persist));
  };
  const onPointerDown = (event) => {
    if (!event || (event.button !== undefined && event.button !== 0)) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    const startX = Number(event.clientX) || 0;
    const startWidth = current;
    if (typeof onDragStart === 'function') onDragStart();
    const element = event.currentTarget;
    try {
      if (element && typeof element.setPointerCapture === 'function' && event.pointerId !== undefined) {
        element.setPointerCapture(event.pointerId);
      }
    } catch {
      /* pointer capture is an enhancement only */
    }
    const onMove = (moveEvent) => {
      const delta = (Number(moveEvent.clientX) || startX) - startX;
      apply(kind === 'rail' ? startWidth + delta : startWidth - delta, false);
    };
    const finish = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', finish, true);
      if (typeof onDragEnd === 'function') onDragEnd();
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', finish, true);
  };
  const onKeyDown = (event) => {
    const key = event && event.key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    const step = key === 'ArrowRight' ? 8 : -8;
    apply(kind === 'rail' ? current + step : current - step, true);
  };
  return h('div', {
    className: 'mru-resizer mru-resizer--' + kind + (active ? ' mru-resizer--active' : ''),
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': label,
    'aria-valuenow': current,
    'aria-valuemin': limits.min,
    'aria-valuemax': limits.max,
    'aria-valuetext': `${label} ${current}px`,
    title: t('layout.resizeHint'),
    tabIndex: 0,
    'data-resizer': kind,
    onPointerDown,
    onKeyDown,
    onDoubleClick: () => {
      if (typeof onReset === 'function') onReset();
    },
  });
}

/** Right margin: outline ticks and annotation cards. */
function MruMargin(props) {
  const {
    t, tab, onTabChange, model, annotations, droppedCount, activeAnnotationId,
    activeHeadingKey, onOutlineClick, onNoteClick, onNoteDelete, docTitle, aiPanelProps,
    staleAnnotations, notesFilter, onNotesFilterChange,
  } = props;
  const activeTab = MRU_MARGIN_TABS.includes(tab) ? tab : 'outline';
  const originFilter = MRU_NOTES_FILTERS.includes(notesFilter) ? notesFilter : 'all';
  const [aspectFilter, setAspectFilter] = React.useState(null);
  const outlineAll = model && Array.isArray(model.outline) ? model.outline : [];
  const titleText = String(docTitle || '').trim().toLowerCase();
  const outline = outlineAll.filter((item) => !(titleText !== ''
    && Number(item.level) === 1
    && String(item.text || '').trim().toLowerCase() === titleText));
  const tabClass = (value) => 'mru-tab' + (activeTab === value ? ' mru-tab--active' : '');
  /** Aspect label key for one annotation aspect, or '' when unknown. */
  const aspectLabelKey = (aspect) => {
    const entry = MRU_ASPECT_LEGEND.find((item) => item.aspect === aspect);
    return entry === undefined ? '' : entry.labelKey;
  };
  let body;
  let notesFilterNode = null;
  let legendNode = null;
  if (activeTab === 'ai') {
    body = aiPanelProps
      ? h(MruAiSurface, Object.assign({ key: `ai-${aiPanelProps.documentId}` }, aiPanelProps))
      : null;
  } else if (activeTab === 'outline') {
    if (outline.length === 0) {
      body = h('div', { className: 'mru-margin__empty' }, t('margin.empty'));
    } else {
      body = h('nav', { className: 'mru-outline' }, outline.map((item, index) => {
        const level = mruClamp(Number(item.level) || 2, 1, 4);
        const active = activeHeadingKey !== null && activeHeadingKey === item.key;
        return h('button', {
          key: item.key || `outline-${index}`,
          type: 'button',
          className: `mru-outline__item mru-outline__item--l${level}` + (active ? ' mru-outline__item--active' : ''),
          'aria-current': active ? 'true' : undefined,
          onClick: () => onOutlineClick(item),
        }, item.text || '');
      }));
    }
  } else {
    const notes = Array.isArray(annotations) ? annotations : [];
    const stale = Array.isArray(staleAnnotations) ? staleAnnotations : [];
    const total = notes.length + stale.length;
    const aiCount = notes.filter((annotation) => annotation.origin === 'ai').length
      + stale.filter((annotation) => annotation.origin === 'ai').length;
    const userCount = total - aiCount;
    const matchOrigin = (annotation) => {
      if (originFilter === 'ai') return annotation.origin === 'ai';
      if (originFilter === 'user') return annotation.origin !== 'ai';
      return true;
    };
    const matchAspect = (annotation) => aspectFilter === null
      || (typeof annotation.aspect === 'string' && annotation.aspect === aspectFilter);
    const visibleNotes = notes.filter((annotation) => matchOrigin(annotation) && matchAspect(annotation));
    const visibleStale = stale.filter((annotation) => matchOrigin(annotation) && matchAspect(annotation));
    const shown = visibleNotes.length + visibleStale.length;
    const filterActive = originFilter !== 'all' || aspectFilter !== null;
    const clearFilters = () => {
      setAspectFilter(null);
      if (originFilter !== 'all' && typeof onNotesFilterChange === 'function') onNotesFilterChange('all');
    };
    if (total > 0) {
      const chips = [
        ['all', 'notes.filterAll', total],
        ['ai', 'notes.filterAi', aiCount],
        ['user', 'notes.filterUser', userCount],
      ];
      notesFilterNode = h('div', { className: 'mru-note-filter', role: 'group', 'aria-label': t('notes.filterLabel') },
        h('div', { className: 'mru-note-filter__chips' },
          chips.map(([value, labelKey, count]) => h('button', {
            key: value,
            type: 'button',
            className: 'mru-note-filter__chip' + (originFilter === value ? ' mru-note-filter__chip--active' : ''),
            'aria-pressed': originFilter === value ? 'true' : 'false',
            'data-filter': value,
            onClick: () => {
              if (typeof onNotesFilterChange === 'function') {
                onNotesFilterChange(originFilter === value && value !== 'all' ? 'all' : value);
              }
            },
          }, t(labelKey), h('span', { className: 'mru-note-filter__count' }, String(count)))),
          h('span', { key: 'aspects', className: 'mru-note-filter__aspects', role: 'group', 'aria-label': t('notes.filterAspect') },
            MRU_ASPECT_LEGEND.map((entry) => h('button', {
              key: entry.aspect,
              type: 'button',
              className: 'mru-note-filter__aspect mru-note-filter__aspect--' + entry.color
                + (aspectFilter === entry.aspect ? ' mru-note-filter__aspect--active' : ''),
              'data-aspect': entry.aspect,
              'aria-pressed': aspectFilter === entry.aspect ? 'true' : 'false',
              'aria-label': t(entry.labelKey),
              title: t(entry.labelKey),
              onClick: () => setAspectFilter((current) => (current === entry.aspect ? null : entry.aspect)),
            }, h('span', {
              className: 'mru-note-filter__dot mru-note-filter__dot--' + entry.aspect,
              'aria-hidden': 'true',
            }))))),
        filterActive
          ? h('div', { className: 'mru-note-filter__status' },
              h('span', null, t('notes.filteredCount', { shown, total })),
              h('button', {
                type: 'button',
                className: 'mru-note-filter__clear',
                onClick: clearFilters,
              }, t('notes.filterClear')))
          : null);
      legendNode = h('div', { className: 'mru-margin__legend' }, h(MruAspectLegend, { t }));
    }
    const list = [];
    if (droppedCount > 0) {
      list.push(h('div', { key: 'notice', className: 'mru-margin__notice' }, t('margin.dropped', { count: droppedCount })));
    }
    if (visibleStale.length > 0) {
      list.push(h('div', {
        key: 'stale-notice',
        className: 'mru-margin__notice mru-margin__notice--stale',
        role: 'status',
      }, t('notes.staleNotice', { count: visibleStale.length })));
    }
    if (total === 0) {
      list.push(h('div', { key: 'empty', className: 'mru-margin__empty' }, t('margin.empty')));
    } else if (shown === 0) {
      list.push(h('div', { key: 'filter-empty', className: 'mru-margin__empty mru-margin__empty--filtered' },
        h('span', null, t('notes.filterEmpty')),
        h('button', {
          type: 'button',
          className: 'mru-link-btn',
          onClick: clearFilters,
        }, t('notes.filterClear'))));
    } else {
      visibleNotes.forEach((annotation) => {
        const active = activeAnnotationId !== null && activeAnnotationId === annotation.id;
        const labelKey = aspectLabelKey(annotation.aspect);
        const aiOrigin = annotation.origin === 'ai';
        list.push(h('article', {
          key: annotation.id,
          className: 'mru-note' + (active ? ' mru-note--active' : '') + (aiOrigin ? ' mru-note--ai' : ''),
          'data-annotation-id': annotation.id,
          'data-origin': annotation.origin || 'user',
          onClick: () => onNoteClick(annotation),
        },
          h('div', { className: 'mru-note__head' },
            h('span', { className: 'mru-note__swatch', 'data-color': annotation.color || 'yellow', 'aria-hidden': 'true' }),
            aiOrigin
              ? h('span', { className: 'mru-note__origin', title: t('notes.sparkTitle') },
                  h(MruGlyph, { name: 'spark', size: 11 }),
                  h('span', null, labelKey !== '' ? t('notes.aiOrigin', { aspect: t(labelKey) }) : t('notes.aiOriginPlain')))
              : null,
            h('span', { className: 'mru-note__time' }, mruFormatNoteTime(annotation.updatedAt || annotation.createdAt, t)),
            h('button', {
              type: 'button',
              className: 'mru-icon-btn mru-note__delete',
              'aria-label': t('margin.noteDelete'),
              title: t('margin.noteDelete'),
              onClick: (event) => {
                event.stopPropagation();
                onNoteDelete(annotation);
              },
            }, h(MruGlyph, { name: 'trash' }))),
          h('blockquote', { className: 'mru-note__quote' }, mruDisplayText(annotation.quote)),
          annotation.note ? h('p', { className: 'mru-note__body' }, annotation.note) : null));
      });
      if (visibleStale.length > 0) {
        list.push(h('section', { key: 'stale-section', className: 'mru-margin__stale' },
          h('h3', { className: 'mru-margin__stale-title' }, t('notes.staleSection')),
          visibleStale.map((annotation) => h('article', {
            key: `stale-${annotation.id}`,
            className: 'mru-note mru-note--stale' + (annotation.origin === 'ai' ? ' mru-note--ai' : ''),
            'data-annotation-id': annotation.id,
            'data-origin': annotation.origin || 'user',
            'data-stale': annotation.staleReason || 'true',
            // No jump-to-text affordance: this anchor no longer resolves.
          },
            h('div', { className: 'mru-note__head' },
              h('span', { className: 'mru-note__swatch', 'data-color': annotation.color || 'yellow', 'aria-hidden': 'true' }),
              annotation.origin === 'ai'
                ? h('span', { className: 'mru-note__origin', title: t('notes.sparkTitle') },
                    h(MruGlyph, { name: 'spark', size: 11 }),
                    h('span', null, t('notes.aiOriginPlain')))
                : null,
              h('span', { className: 'mru-note__stale-tag' }, t('notes.staleTag')),
              h('span', { className: 'mru-note__time' }, mruFormatNoteTime(annotation.updatedAt || annotation.createdAt, t)),
              h('button', {
                type: 'button',
                className: 'mru-icon-btn mru-note__delete',
                'aria-label': t('margin.noteDelete'),
                title: t('margin.noteDelete'),
                onClick: (event) => {
                  event.stopPropagation();
                  onNoteDelete(annotation);
                },
              }, h(MruGlyph, { name: 'trash' }))),
            h('blockquote', { className: 'mru-note__quote' }, mruDisplayText(annotation.quote)),
            annotation.note ? h('p', { className: 'mru-note__body' }, annotation.note) : null))));
      }
    }
    body = h('div', { className: 'mru-notes' }, list);
  }
  return h('aside', { className: 'mru-margin' },
    h('div', { className: 'mru-margin__tabs', role: 'tablist' },
      h('button', {
        type: 'button',
        role: 'tab',
        className: tabClass('outline'),
        'aria-selected': activeTab === 'outline' ? 'true' : 'false',
        onClick: () => onTabChange('outline'),
      }, t('margin.outline')),
      h('button', {
        type: 'button',
        role: 'tab',
        className: tabClass('notes'),
        'aria-selected': activeTab === 'notes' ? 'true' : 'false',
        onClick: () => onTabChange('notes'),
      }, t('margin.notes'), h('span', { className: 'mru-tab__count' }, String((annotations ? annotations.length : 0) + (Array.isArray(staleAnnotations) ? staleAnnotations.length : 0)))),
      h('button', {
        type: 'button',
        role: 'tab',
        className: tabClass('ai'),
        'aria-selected': activeTab === 'ai' ? 'true' : 'false',
        onClick: () => onTabChange('ai'),
      }, h(MruGlyph, { name: 'spark', size: 13 }), h('span', { className: 'mru-tab__label' }, t('margin.ai')))),
    notesFilterNode,
    legendNode,
    h('div', { className: 'mru-margin__body' }, body));
}

/** Bottom status bar. */
function MruStatusbar(props) {
  const { t, doc, reader, translations, counts, version, boot } = props;
  const left = [];
  const right = [];
  if (doc) {
    const engine = doc.parse && doc.parse.engine;
    const engineKey = engine === 'agent' ? 'statusbar.engineAgent' : engine === 'local' ? 'statusbar.engineLocal' : 'statusbar.engineStandard';
    left.push(h('span', { key: 'engine' }, t(engineKey)));
    const provider = doc.parse && typeof doc.parse.provider === 'string' ? doc.parse.provider : '';
    if (engine === 'local' && provider !== '') {
      left.push(h('span', { key: 'provider-dot', className: 'mru-dot' }, '·'));
      left.push(h('span', { key: 'provider' }, mruLocalProviderLabel(t, provider)));
    }
    const modelVersion = doc.parse && doc.parse.modelVersion;
    if (modelVersion) {
      left.push(h('span', { key: 'dot-1', className: 'mru-dot' }, '·'));
      left.push(h('span', { key: 'model' }, modelVersion));
    }
    const pages = Number(doc.parse && doc.parse.pages) || Number(reader.pages) || 0;
    if (doc.status === 'parsing') {
      const progress = doc.parse && doc.parse.progress;
      const done = progress ? Number(progress.extracted) || 0 : 0;
      const total = progress ? Number(progress.total) || 0 : 0;
      const elapsed = mruFormatElapsed(doc.parse && doc.parse.startedAt, Date.now());
      const label = done > 0 && total > 0 ? t('statusbar.parsing', { done, total }) : t(mruParsePhaseKey(doc));
      right.push(h('span', { key: 'parsing' }, elapsed ? `${label} · ${elapsed}` : label));
    } else if (pages > 0) {
      right.push(h('span', { key: 'pages' }, t('statusbar.pages', { count: pages })));
    }
    if (reader.phase === 'ready' && reader.model && reader.model.stats) {
      const words = Number(reader.model.stats.words) || 0;
      if (right.length > 0) right.push(h('span', { key: 'dot-2', className: 'mru-dot' }, '·'));
      right.push(h('span', { key: 'words' }, t('statusbar.words', { count: mruFormatCount(words) })));
      const entries = translations && translations.entries ? translations.entries : {};
      const textBlocks = reader.model.blocks.filter((block) => mruIsTextBlock(block) && block.plainText && block.plainText.trim() !== '').length;
      const translated = Object.keys(entries).length;
      const percent = textBlocks > 0 ? Math.round((Math.min(translated, textBlocks) / textBlocks) * 100) : 0;
      right.push(h('span', { key: 'dot-3', className: 'mru-dot' }, '·'));
      right.push(h('span', { key: 'translated' }, t('statusbar.translated', { percent })));
    }
  } else {
    left.push(h('span', { key: 'engine' }, t('statusbar.engineStandard')));
    right.push(h('span', { key: 'counts' }, t('rail.foot', { count: counts.total || 0, parsed: counts.parsed || 0 })));
  }
  if (boot === 'error') {
    left.push(h('span', { key: 'dot-4', className: 'mru-dot' }, '·'));
    left.push(h('span', { key: 'offline' }, t('err.hostUnavailable')));
  }
  return h('div', { className: 'mru-statusbar' },
    left,
    h('div', { className: 'mru-topbar__spacer', key: 'statusbar-spacer' }),
    right);
}

// ===========================================================================
// 9. Generic overlays: menus, modals, swatches, toasts, drop target
// ===========================================================================

/** Compute a clamped fixed position for a popup menu. */
function mruMenuPos(rect, width, height) {
  const viewportWidth = window.innerWidth || 1280;
  const viewportHeight = window.innerHeight || 800;
  let left = rect ? rect.left : 12;
  left = mruClamp(left, 8, Math.max(8, viewportWidth - width - 8));
  let top = rect ? rect.bottom + 6 : 12;
  if (rect && top + height > viewportHeight - 8) top = Math.max(8, rect.top - height - 6);
  top = mruClamp(top, 8, Math.max(8, viewportHeight - height - 8));
  return { left: Math.round(left), top: Math.round(top) };
}

/** Fixed-position popup menu (import menu / document menu). */
function MruMenu(props) {
  const { items, rect } = props;
  const width = 226;
  const height = items.length * 34 + 16;
  const pos = mruMenuPos(rect, width, height);
  return h('div', {
    className: 'mru-menu-wrap',
    style: { position: 'fixed', left: `${pos.left}px`, top: `${pos.top}px`, zIndex: 60 },
  },
    h('div', { className: 'mru-menu', role: 'menu' }, items.map((item, index) => {
      if (item.separator) return h('div', { key: `sep-${index}`, className: 'mru-menu__sep' });
      return h('button', {
        key: `item-${index}`,
        type: 'button',
        role: 'menuitem',
        className: 'mru-menu__item' + (item.danger ? ' mru-menu__item--danger' : ''),
        onClick: () => item.onSelect(),
      }, item.label);
    })));
}

/** Modal shell with mask, focus trap and focus restore. */
function MruModal({ onClose, labelledBy, panelClass, children, maskClosable }) {
  const panelRef = React.useRef(null);
  React.useEffect(() => {
    const panel = panelRef.current;
    const previous = document.activeElement;
    let focusable = [];
    const collect = () => {
      if (!panel) return [];
      return Array.from(panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter((element) => !element.disabled && element.getAttribute('aria-hidden') !== 'true');
    };
    focusable = collect();
    const preferred = panel ? panel.querySelector('input, select, textarea, button') : null;
    if (preferred && typeof preferred.focus === 'function') preferred.focus();
    const onKeyDown = (event) => {
      if (event.key !== 'Tab') return;
      focusable = collect();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    panel?.addEventListener('keydown', onKeyDown);
    return () => {
      panel?.removeEventListener('keydown', onKeyDown);
      if (previous && typeof previous.focus === 'function') {
        try {
          previous.focus();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);
  return h('div', { className: 'mru-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': labelledBy },
    h('div', { className: 'mru-modal__mask', onClick: () => { if (maskClosable !== false) onClose(); } }),
    h('div', { className: 'mru-modal__panel' + (panelClass ? ` ${panelClass}` : ''), ref: panelRef }, children));
}

/** Four annotation color buttons. */
function MruSwatches({ t, value, onPick }) {
  return h('span', { className: 'mru-swatches', role: 'group', 'aria-label': t('sel.colors') },
    MRU_COLORS.map((color) => {
      const key = `sel.color${color.charAt(0).toUpperCase()}${color.slice(1)}`;
      return h('button', {
        key: color,
        type: 'button',
        className: 'mru-swatch mru-swatch--' + color + (value === color ? ' mru-swatch--active' : ''),
        'data-color': color,
        'aria-label': t(key),
        title: t(key),
        'aria-pressed': value === color ? 'true' : 'false',
        onClick: () => onPick(color),
      });
    }));
}

/** Toast stack. */
function MruToasts({ toasts, onClose, t }) {
  return h('div', { className: 'mru-toasts', 'aria-live': 'polite' },
    toasts.map((toast) => h('div', {
      key: toast.id,
      className: 'mru-toast' + (toast.kind === 'error' ? ' mru-toast--error' : ''),
      role: 'status',
    },
      h('span', { className: 'mru-toast__text' }, toast.text),
      h('button', {
        type: 'button',
        className: 'mru-toast__close',
        'aria-label': t('settings.close'),
        onClick: () => onClose(toast.id),
      }, '×'))));
}

/** Drag-over overlay. */
function MruDrop({ t }) {
  return h('div', { className: 'mru-drop', 'aria-hidden': 'true' },
    h('div', { className: 'mru-drop__card' },
      h('strong', { className: 'mru-drop__title' }, t('drop.title')),
      h('span', { className: 'mru-drop__text' }, t('drop.text'))));
}

// ===========================================================================
// 10. Selection overlays (toolbar, translation card, note editor)
// ===========================================================================

/** Selection toolbar; focuses itself after a keyboard selection. */
function MruSelbar({ t, selection, onTranslate, onHighlight, onNote, onCopy, onRemoveHighlight, onAskAi }) {
  const firstRef = React.useRef(null);
  React.useEffect(() => {
    if (selection && selection.source === 'keyboard' && firstRef.current && typeof firstRef.current.focus === 'function') {
      firstRef.current.focus();
    }
  }, [selection]);
  const removable = Array.isArray(selection.annotationIds) && selection.annotationIds.length > 0;
  const pos = mruOverlayPos(selection.rect, removable ? 512 : 404, 44);
  return h('div', {
    className: 'mru-selbar',
    role: 'toolbar',
    'aria-label': t('sel.toolbar'),
    style: { left: `${pos.left}px`, top: `${pos.top}px` },
  },
    h('button', {
      type: 'button',
      ref: firstRef,
      className: 'mru-selbar__btn mru-selbar__btn--primary',
      onClick: () => onTranslate(),
    }, t('sel.translate')),
    onAskAi ? h('button', {
      type: 'button',
      className: 'mru-selbar__btn mru-selbar__btn--ai',
      onClick: () => onAskAi(),
    }, h(MruGlyph, { name: 'spark', size: 13 }), h('span', { className: 'mru-selbar__btn-label' }, t('sel.askAi'))) : null,
    h('span', { className: 'mru-selbar__sep', 'aria-hidden': 'true' }),
    h('span', { className: 'mru-swatches', role: 'group', 'aria-label': t('sel.colors') },
      MRU_COLORS.map((color) => {
        const key = `sel.color${color.charAt(0).toUpperCase()}${color.slice(1)}`;
        return h('button', {
          key: color,
          type: 'button',
          className: 'mru-swatch mru-swatch--' + color,
          'data-color': color,
          'aria-label': t(key),
          title: t(key),
          onClick: () => onHighlight(color),
        });
      })),
    h('button', { type: 'button', className: 'mru-selbar__btn', onClick: () => onNote() }, t('sel.note')),
    removable
      ? h('button', {
        type: 'button',
        className: 'mru-selbar__btn mru-selbar__btn--remove',
        onClick: () => onRemoveHighlight(selection.annotationIds),
      }, t('sel.removeHighlight'))
      : null,
    h('button', { type: 'button', className: 'mru-selbar__btn', onClick: () => onCopy() }, t('sel.copy')));
}

/** Selection translation card. */
function MruSelcard({ t, card, onClose, onRetry, onCopy, katexReady }) {
  const pos = mruOverlayPos(card.rect, 420, 236);
  let body;
  if (card.state === 'loading') {
    body = h(MruSpinner);
  } else if (card.state === 'error') {
    body = h('p', { className: 'mru-selcard__error' },
      t('selcard.error'),
      h('button', { type: 'button', className: 'mru-link-btn', onClick: onRetry }, t('selcard.retry')));
  } else {
    body = h('div', { className: 'mru-selcard__text' }, h(MruRichText, { text: card.translation || '', katexReady }));
  }
  return h('div', {
    className: 'mru-selcard',
    role: 'dialog',
    'aria-label': t('selcard.label'),
    style: { left: `${pos.left}px`, top: `${pos.top}px` },
  },
    h('div', { className: 'mru-selcard__head' },
      h('span', { className: 'mru-selcard__label' }, t('selcard.label')),
      h('button', {
        type: 'button',
        className: 'mru-icon-btn',
        'aria-label': t('selcard.close'),
        onClick: onClose,
      }, '×')),
    h('p', { className: 'mru-selcard__src' }, mruDisplayText(card.quote)),
    h('div', { className: 'mru-selcard__body' }, body),
    h('div', { className: 'mru-selcard__foot' },
      h('span', { className: 'mru-selcard__provider' }, card.provider || ''),
      h('button', {
        type: 'button',
        className: 'mru-btn mru-btn--ghost mru-btn--sm',
        disabled: card.state !== 'done' || !card.translation,
        onClick: onCopy,
      }, t('selcard.copy'))));
}

/**
 * Floating translation card for one paragraph ("翻译本段"). Mirrors the
 * selection card's translator's-slip language, but for a whole block: source
 * quote, rich translation (markdown + KaTeX), provider footer, copy. It reads
 * live translation/job state and never changes the reading mode.
 */
function MruBlockCard({ t, card, translation, job, provider, katexReady, onClose, onRetry, onCopy }) {
  const pos = mruOverlayPos(card.rect, 448, 320);
  const pending = Boolean(job && job.state === 'pending');
  const failed = Boolean(job && job.state === 'error');
  const hasTranslation = typeof translation === 'string' && translation !== '';
  let body;
  if (hasTranslation) {
    body = h('div', { className: 'mru-selcard__text' + (pending ? ' mru-selcard__text--pending' : '') },
      h(MruRichText, { text: translation, katexReady }));
  } else if (failed) {
    body = h('p', { className: 'mru-selcard__error' },
      t('selcard.error'),
      h('button', { type: 'button', className: 'mru-link-btn', onClick: onRetry }, t('selcard.retry')));
  } else {
    body = h('span', { className: 'mru-selcard__loading' }, h(MruSpinner));
  }
  return h('div', {
    className: 'mru-selcard mru-selcard--block',
    role: 'dialog',
    'aria-label': t('reader.translateBlock'),
    style: { left: `${pos.left}px`, top: `${pos.top}px` },
  },
    h('div', { className: 'mru-selcard__head' },
      h('span', { className: 'mru-selcard__label' }, t('reader.translateBlock')),
      h('button', {
        type: 'button',
        className: 'mru-icon-btn',
        'aria-label': t('selcard.close'),
        onClick: onClose,
      }, '×')),
    card.quote ? h('p', { className: 'mru-selcard__src' }, mruDisplayText(card.quote)) : null,
    h('div', { className: 'mru-selcard__body' }, body),
    h('div', { className: 'mru-selcard__foot' },
      h('span', { className: 'mru-selcard__provider' }, provider || ''),
      h('button', {
        type: 'button',
        className: 'mru-btn mru-btn--ghost mru-btn--sm',
        disabled: !hasTranslation,
        onClick: onCopy,
      }, t('selcard.copy'))));
}

/** Note editor popover (create + edit). */
function MruNoteEditor({ t, editor, onNoteChange, onColorChange, onCancel, onSave, onDelete }) {
  const pos = mruOverlayPos(editor.rect, 384, 224);
  return h('div', {
    className: 'mru-noteeditor',
    role: 'dialog',
    'aria-label': t('noteeditor.title'),
    style: { left: `${pos.left}px`, top: `${pos.top}px` },
  },
    editor.origin === 'ai'
      ? h('div', { className: 'mru-noteeditor__head' },
          h('span', { className: 'mru-noteeditor__origin', title: t('notes.sparkTitle') },
            h(MruGlyph, { name: 'spark', size: 11 }),
            h('span', null, t('notes.aiOriginPlain'))),
          editor.aspect && MRU_ASPECT_LEGEND.some((entry) => entry.aspect === editor.aspect)
            ? h('span', { className: 'mru-noteeditor__aspect' },
                h('span', {
                  className: 'mru-noteeditor__aspect-dot mru-aspect-legend__dot--' + editor.aspect,
                  'aria-hidden': 'true',
                }),
                t('aspect.' + editor.aspect))
            : null)
      : null,
    h('blockquote', { className: 'mru-noteeditor__quote' }, mruDisplayText(editor.quote)),
    h('textarea', {
      className: 'mru-textarea mru-noteeditor__input',
      placeholder: t('noteeditor.placeholder'),
      'aria-label': t('noteeditor.placeholder'),
      value: editor.note || '',
      autoFocus: true,
      onChange: (event) => onNoteChange(event.target.value),
    }),
    h('div', { className: 'mru-noteeditor__foot' },
      h(MruSwatches, { t, value: editor.color, onPick: onColorChange }),
      editor.mode === 'edit' && onDelete
        ? h('button', {
          type: 'button',
          className: 'mru-btn mru-btn--ghost mru-btn--sm mru-btn--danger',
          onClick: onDelete,
        }, editor.note ? t('confirm.delete') : t('sel.removeHighlight'))
        : null,
      h('button', {
        type: 'button',
        className: 'mru-btn mru-btn--ghost mru-btn--sm',
        onClick: onCancel,
      }, t('noteeditor.cancel')),
      h('button', {
        type: 'button',
        className: 'mru-btn mru-btn--primary mru-btn--sm',
        onClick: onSave,
      }, t('noteeditor.save'))));
}

// ===========================================================================
// 11. Modals: settings, import-by-URL, delete confirm, reparse
// ===========================================================================

/** Normalize the providers list reported by settings.get. */
function mruProviderOptions(settings) {
  const options = [{ id: 'auto', label: null, auto: true }];
  const list = settings && Array.isArray(settings.providers) ? settings.providers : [];
  for (const entry of list) {
    const id = typeof entry === 'string' ? entry : entry && entry.id;
    if (!id || id === 'auto') continue;
    const label = typeof entry === 'string' ? entry : entry.label || entry.name || entry.id;
    options.push({ id, label, auto: false });
  }
  const current = (settings && settings.currentProvider)
    || (settings && settings.preferences && settings.preferences.translationProvider)
    || '';
  if (current && current !== 'auto' && !options.some((option) => option.id === current)) {
    options.push({ id: current, label: current, auto: false });
  }
  return options;
}

/** Settings modal: MinerU token, local parsing capabilities, reading preferences, storage info. */
function MruSettingsModal(props) {
  const { t, status, settings, onClose, onSaveToken, onClearToken, onUpdatePrefs, tokenBusy } = props;
  const [tokenInput, setTokenInput] = React.useState('');
  const [localBusy, setLocalBusy] = React.useState(false);
  const tokenConfigured = Boolean(status && status.tokenConfigured);
  const tokenPersistent = status ? status.tokenPersistent !== false : true;
  const local = mruLocalInfo((settings && settings.local) || (status && status.local));
  const localAvailable = Boolean(local && local.enabled && local.available);
  const prefs = props.prefs || MRU_DEFAULT_PREFS;
  const aiGraphReady = Boolean(mruAiState(status).graph);
  const providerOptions = mruProviderOptions(settings);
  const configuredHint = tokenConfigured
    ? (tokenPersistent ? t('settings.tokenSaved') : t('settings.tokenMemory'))
    : t('settings.tokenMissing');
  const dataDir = status && status.dataDirDisplay ? status.dataDirDisplay : '';
  const version = status && status.version ? String(status.version) : '';
  const redetectLocal = () => {
    if (localBusy || typeof props.onRedetect !== 'function') return;
    setLocalBusy(true);
    Promise.resolve()
      .then(() => props.onRedetect())
      .catch(() => {})
      .then(() => setLocalBusy(false));
  };
  const localRows = local && local.enabled && local.providers.length > 0
    ? local.providers.map((provider) => h('div', {
      key: provider.id,
      className: 'mru-local-row',
      title: typeof provider.reason === 'string' ? provider.reason : undefined,
    },
      h('span', { className: 'mru-local-row__name' }, mruLocalProviderName(t, provider.id)),
      h('span', { className: 'mru-local-row__state' + (provider.available ? ' mru-local-row__state--ok' : '') },
        t(provider.available ? 'settings.localAvailable' : 'settings.localUnavailable')),
      provider.version ? h('span', { className: 'mru-local-row__version' }, String(provider.version)) : null))
    : h('p', { className: 'mru-field__hint' }, t('settings.localUnavailable'));
  return h(MruModal, { onClose, labelledBy: 'mru-settings-title', panelClass: 'mru-modal__panel--settings' },
    h('header', { className: 'mru-modal__head' },
      h('h2', { className: 'mru-modal__title', id: 'mru-settings-title' }, t('settings.title')),
      h('button', { type: 'button', className: 'mru-icon-btn', 'aria-label': t('settings.close'), onClick: onClose }, '×')),
    h('div', { className: 'mru-modal__body' },
      h('section', { className: 'mru-section' },
        h('h3', { className: 'mru-section__title' }, t('settings.sectionToken')),
        h('p', { className: 'mru-section__desc' }, t('settings.tokenHint')),
        h('div', { className: 'mru-field' },
          h('label', { className: 'mru-field__label' }, t('settings.token')),
          h('div', { className: 'mru-field__row' },
            h('input', {
              className: 'mru-input',
              type: 'password',
              placeholder: t('settings.tokenPlaceholder'),
              'aria-label': t('settings.token'),
              value: tokenInput,
              autoComplete: 'off',
              onChange: (event) => setTokenInput(event.target.value),
            }),
            h('button', {
              type: 'button',
              className: 'mru-btn mru-btn--ghost mru-btn--sm',
              disabled: tokenBusy || tokenInput.trim() === '',
              onClick: () => {
                const token = tokenInput.trim();
                if (token === '') return;
                onSaveToken(token, () => setTokenInput(''));
              },
            }, t('settings.save')),
            h('button', {
              type: 'button',
              className: 'mru-btn mru-btn--ghost mru-btn--sm mru-btn--danger',
              disabled: tokenBusy || !tokenConfigured,
              onClick: () => onClearToken(),
            }, t('settings.clear'))),
          h('span', { className: 'mru-field__hint' + (tokenConfigured ? ' mru-field__hint--ok' : '') }, configuredHint),
          !tokenConfigured && localAvailable
            ? h('span', { className: 'mru-field__hint' }, t('settings.tokenMissingLocal'))
            : null)),
      h('section', { className: 'mru-section' },
        h('div', { className: 'mru-section__head' },
          h('h3', { className: 'mru-section__title' }, t('settings.sectionLocal')),
          typeof props.onRedetect === 'function'
            ? h('button', {
              type: 'button',
              className: 'mru-btn mru-btn--ghost mru-btn--sm',
              disabled: localBusy,
              onClick: redetectLocal,
            }, t('settings.localRedetect'))
            : null),
        h('p', { className: 'mru-section__desc' }, t('settings.localHint')),
        h('div', { className: 'mru-local-list' }, localRows)),
      h('section', { className: 'mru-section' },
        h('h3', { className: 'mru-section__title' }, t('settings.sectionRead')),
        h('div', { className: 'mru-field' },
          h('label', { className: 'mru-field__label' }, t('settings.targetLang')),
          h('select', {
            className: 'mru-select',
            value: prefs.targetLanguage,
            onChange: (event) => onUpdatePrefs({ targetLanguage: event.target.value }),
          }, MRU_TARGET_LANGUAGE_OPTIONS.map(([value, label]) => h('option', { key: value, value }, label)))),
        h('div', { className: 'mru-field' },
          h('label', { className: 'mru-field__label' }, t('settings.provider')),
          h('select', {
            className: 'mru-select',
            value: prefs.translationProvider,
            onChange: (event) => onUpdatePrefs({ translationProvider: event.target.value }),
          }, providerOptions.map((option) => h('option', { key: option.id, value: option.id },
            option.auto ? t('settings.providerAuto') : String(option.label))))),
        h('div', { className: 'mru-field' },
          h('label', { className: 'mru-field__label' }, t('settings.scale')),
          h('select', {
            className: 'mru-select',
            value: String(prefs.readingScale || 1),
            onChange: (event) => onUpdatePrefs({ readingScale: Number(event.target.value) }),
          }, MRU_SCALES.map((scale) => h('option', { key: scale, value: String(scale) }, `${Math.round(scale * 100)}%`)))),
        h('div', { className: 'mru-toggle-row mru-toggle-row--plain' },
          h('span', { className: 'mru-toggle-row__text' },
            h('span', { className: 'mru-toggle-row__title' }, t('settings.pageMarks'))),
          h('span', {
            className: 'mru-switch' + (prefs.showPageMarks ? ' mru-switch--on' : ''),
            role: 'switch',
            'aria-checked': prefs.showPageMarks ? 'true' : 'false',
            tabIndex: 0,
            onClick: () => onUpdatePrefs({ showPageMarks: !prefs.showPageMarks }),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onUpdatePrefs({ showPageMarks: !prefs.showPageMarks });
              }
            },
          })),
      ),
      h('section', { className: 'mru-section' },
        h('h3', { className: 'mru-section__title' }, t('settings.sectionAi')),
        h('div', { className: 'mru-toggle-row mru-toggle-row--plain' + (aiGraphReady ? '' : ' mru-toggle-row--disabled') },
          h('span', { className: 'mru-toggle-row__text' },
            h('span', { className: 'mru-toggle-row__title' }, t('settings.graphAutoBuild')),
            h('span', { className: 'mru-toggle-row__hint' },
              aiGraphReady ? t('settings.graphAutoBuildHint') : t('settings.graphAutoBuildUnavailable'))),
          h('span', {
            className: 'mru-switch' + (prefs.graphAutoBuild ? ' mru-switch--on' : '') + (aiGraphReady ? '' : ' mru-switch--disabled'),
            role: 'switch',
            'aria-checked': prefs.graphAutoBuild ? 'true' : 'false',
            'aria-disabled': aiGraphReady ? undefined : 'true',
            tabIndex: aiGraphReady ? 0 : -1,
            onClick: () => {
              if (aiGraphReady) onUpdatePrefs({ graphAutoBuild: !prefs.graphAutoBuild });
            },
            onKeyDown: (event) => {
              if (aiGraphReady && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                onUpdatePrefs({ graphAutoBuild: !prefs.graphAutoBuild });
              }
            },
          }))),
      h('section', { className: 'mru-section' },
        h('h3', { className: 'mru-section__title' }, t('settings.sectionStorage')),
        h('div', { className: 'mru-field' },
          h('label', { className: 'mru-field__label' }, t('settings.dataDir')),
          h('input', { className: 'mru-input', type: 'text', readOnly: true, value: dataDir || '—', 'aria-label': t('settings.dataDir') })),
        h('div', { className: 'mru-field' },
          h('label', { className: 'mru-field__label' }, t('settings.version')),
          h('input', { className: 'mru-input', type: 'text', readOnly: true, value: version || '—', 'aria-label': t('settings.version') })))),
    h('footer', { className: 'mru-modal__foot' },
      h('button', { type: 'button', className: 'mru-btn mru-btn--ghost', onClick: onClose }, t('settings.close'))));
}

/** Import-by-URL modal. */
function MruImportUrlModal(props) {
  const { t, onClose, onImport, busy, errorMessage } = props;
  const [url, setUrl] = React.useState('');
  const submit = () => {
    const value = url.trim();
    if (value === '' || busy) return;
    onImport(value);
  };
  return h(MruModal, { onClose, labelledBy: 'mru-import-title', panelClass: 'mru-modal__panel--import' },
    h('header', { className: 'mru-modal__head' },
      h('h2', { className: 'mru-modal__title', id: 'mru-import-title' }, t('importUrl.title')),
      h('button', { type: 'button', className: 'mru-icon-btn', 'aria-label': t('settings.close'), onClick: onClose }, '×')),
    h('div', { className: 'mru-modal__body' },
      h('div', { className: 'mru-field' },
        h('label', { className: 'mru-field__label' }, t('importUrl.url')),
        h('input', {
          className: 'mru-input mru-input--url',
          type: 'url',
          placeholder: t('importUrl.placeholder'),
          'aria-label': t('importUrl.url'),
          value: url,
          autoFocus: true,
          onChange: (event) => setUrl(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          },
        }),
        h('span', { className: 'mru-field__hint' }, t('importUrl.hint'))),
      errorMessage ? h('div', { className: 'mru-callout mru-callout--warn' }, errorMessage) : null),
    h('footer', { className: 'mru-modal__foot' },
      h('button', { type: 'button', className: 'mru-btn mru-btn--ghost', onClick: onClose }, t('confirm.cancel')),
      h('button', {
        type: 'button',
        className: 'mru-btn mru-btn--primary',
        disabled: busy || url.trim() === '',
        onClick: submit,
      }, busy ? t('importUrl.importing') : t('importUrl.submit'))));
}

/** Delete confirmation modal. */
function MruConfirmDeleteModal(props) {
  const { t, title, busy, onCancel, onConfirm } = props;
  return h(MruModal, { onClose: onCancel, labelledBy: 'mru-confirm-title', panelClass: 'mru-modal__panel--confirm' },
    h('div', { className: 'mru-modal__body' },
      h('h2', { className: 'mru-confirm__title', id: 'mru-confirm-title' }, t('confirm.deleteTitle')),
      h('p', { className: 'mru-confirm__text' }, t('confirm.deleteText')),
      title ? h('p', { className: 'mru-confirm__text mru-confirm__text--name' }, title) : null),
    h('div', { className: 'mru-confirm__actions' },
      h('button', { type: 'button', className: 'mru-btn mru-btn--ghost', onClick: onCancel }, t('confirm.cancel')),
      h('button', {
        type: 'button',
        className: 'mru-btn mru-btn--primary mru-btn--danger',
        disabled: busy,
        onClick: onConfirm,
      }, t('confirm.delete'))));
}

/** Reparse dialog — the same setup form inside a modal shell. */
function MruReparseModal(props) {
  const {
    t, prefs, doc, local, tokenConfigured, busy, errorMessage, onStart, onOpenSettings, onClose,
    problemPages, defaultOnlyProblems,
  } = props;
  const pages = Array.isArray(problemPages) ? problemPages : [];
  const sourceEngine = doc && doc.parse ? doc.parse.engine : '';
  const isLocalSource = sourceEngine === 'local';
  const canRepair = pages.length > 0 && !isLocalSource;
  const [onlyProblems, setOnlyProblems] = React.useState(Boolean(defaultOnlyProblems) && canRepair);
  const submit = (options) => {
    if (onlyProblems && canRepair) {
      onStart({ ...options, merge: true, pages });
      return;
    }
    onStart(options);
  };
  return h(MruModal, { onClose, labelledBy: 'mru-reparse-title' },
    h('header', { className: 'mru-modal__head' },
      h('h2', { className: 'mru-modal__title', id: 'mru-reparse-title' }, t('parse.reparseTitle')),
      h('button', { type: 'button', className: 'mru-icon-btn', 'aria-label': t('settings.close'), onClick: onClose }, '×')),
    h('div', { className: 'mru-modal__body' },
      canRepair
        ? h('button', {
          type: 'button',
          className: 'mru-toggle-row mru-toggle-row--plain mru-repair-option',
          role: 'switch',
          'aria-checked': onlyProblems ? 'true' : 'false',
          onClick: () => setOnlyProblems((value) => !value),
        },
          h('span', { className: 'mru-toggle-row__text' },
            h('span', { className: 'mru-toggle-row__title' }, t('reparse.onlyProblems', { count: pages.length })),
            h('span', { className: 'mru-toggle-row__hint' },
              tokenConfigured ? t('reparse.onlyProblemsHint') : t('reparse.needsToken'))),
          h('span', { className: 'mru-switch' + (onlyProblems ? ' mru-switch--on' : ''), 'aria-hidden': 'true' }))
        : null,
      isLocalSource
        ? h('p', { className: 'mru-reparse-hint' }, t('reparse.localRepair'))
        : null,
      h(MruSetupPanel, {
        t,
        prefs,
        doc,
        local,
        tokenConfigured,
        initialEngine: isLocalSource ? 'local' : '',
        busy,
        errorMessage,
        onSubmit: submit,
        onOpenSettings,
      })));
}

// ===========================================================================
// 12. The application component
// ===========================================================================

/** Normalize host preferences into the client's known shape. */
function mruNormalizePrefs(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const prefs = { ...MRU_DEFAULT_PREFS, ...source };
  if (!MRU_MODES.includes(prefs.readingMode)) prefs.readingMode = MRU_DEFAULT_PREFS.readingMode;
  const scale = Number(prefs.readingScale);
  prefs.readingScale = MRU_SCALES.includes(scale) ? scale : 1;
  prefs.showPageMarks = prefs.showPageMarks !== false;
  prefs.defaultIsOcr = Boolean(prefs.defaultIsOcr);
  prefs.defaultEnableFormula = prefs.defaultEnableFormula !== false;
  prefs.defaultEnableTable = prefs.defaultEnableTable !== false;
  prefs.autoAllowAgentFallback = prefs.autoAllowAgentFallback !== false;
  if (prefs.defaultEngine !== 'auto' && prefs.defaultEngine !== 'standard'
    && prefs.defaultEngine !== 'local' && prefs.defaultEngine !== 'agent') {
    prefs.defaultEngine = 'auto';
  }
  if (typeof prefs.targetLanguage !== 'string' || prefs.targetLanguage === '') prefs.targetLanguage = 'zh';
  if (typeof prefs.translationProvider !== 'string' || prefs.translationProvider === '') prefs.translationProvider = 'auto';
  prefs.aiPanelOpen = prefs.aiPanelOpen === true;
  prefs.graphAutoBuild = prefs.graphAutoBuild === true;
  prefs.notesFilter = MRU_NOTES_FILTERS.includes(prefs.notesFilter) ? prefs.notesFilter : 'all';
  prefs.libraryView = MRU_LIBRARY_VIEWS.includes(prefs.libraryView) ? prefs.libraryView : 'library';
  prefs.docView = MRU_DOC_VIEWS.includes(prefs.docView) ? prefs.docView : 'read';
  prefs.marginTab = MRU_MARGIN_TABS.includes(prefs.marginTab)
    ? prefs.marginTab
    : (prefs.aiPanelOpen ? 'ai' : 'outline');
  return prefs;
}

/** Build the host parse-options payload from saved preferences. */
function mruDefaultParseOptions(prefs) {
  return {
    engine: prefs.defaultEngine || 'auto',
    modelVersion: prefs.defaultModelVersion || 'vlm',
    language: prefs.defaultLanguage || 'ch',
    isOcr: Boolean(prefs.defaultIsOcr),
    enableFormula: prefs.defaultEnableFormula !== false,
    enableTable: prefs.defaultEnableTable !== false,
    pageRanges: '',
  };
}

/** The reading-desk application mounted into the `main` panel. */
function MineruApp(props) {
  const t = typeof props.t === 'function' ? props.t : mruTranslate;

  // --- state -------------------------------------------------------------
  const [boot, setBoot] = React.useState('loading');
  const [status, setStatus] = React.useState(null);
  const [docs, setDocs] = React.useState([]);
  const [docsReady, setDocsReady] = React.useState(false);
  const [prefs, setPrefs] = React.useState(MRU_DEFAULT_PREFS);
  const [search, setSearch] = React.useState('');
  const [selectedId, setSelectedId] = React.useState(null);
  const [detail, setDetail] = React.useState(null);
  const [reader, setReader] = React.useState({ phase: 'empty' });
  const [annotations, setAnnotations] = React.useState([]);
  const [droppedAnnotations, setDroppedAnnotations] = React.useState(0);
  // Annotations whose anchor is gone after a reparse: kept, shown as stale cards
  // and always included in the whole-list save (never silently erased).
  const [staleAnnotations, setStaleAnnotations] = React.useState([]);
  const [translations, setTranslations] = React.useState({ targetLanguage: 'zh', entries: {} });
  const [translationJobs, setTranslationJobs] = React.useState({});
  const [translationFlash, setTranslationFlash] = React.useState(null);
  const [translationProviders, setTranslationProviders] = React.useState({});
  const [translateAll, setTranslateAll] = React.useState(null);
  const [activeAnnotationId, setActiveAnnotationId] = React.useState(null);
  const [railOpen, setRailOpen] = React.useState(false);
  const [marginOpen, setMarginOpen] = React.useState(false);
  const [marginTab, setMarginTab] = React.useState('outline');
  const [activeHeadingKey, setActiveHeadingKey] = React.useState(null);
  const [selection, setSelection] = React.useState(null);
  const [selCard, setSelCard] = React.useState(null);
  const [blockCard, setBlockCard] = React.useState(null);
  const [noteEditor, setNoteEditor] = React.useState(null);
  const [menu, setMenu] = React.useState(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [settingsData, setSettingsData] = React.useState(null);
  const [tokenBusy, setTokenBusy] = React.useState(false);
  const [importUrlOpen, setImportUrlOpen] = React.useState(false);
  const [importUrlBusy, setImportUrlBusy] = React.useState(false);
  const [importUrlError, setImportUrlError] = React.useState('');
  const [confirmDelete, setConfirmDelete] = React.useState(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [reparseDoc, setReparseDoc] = React.useState(null);
  const [reparseOnlyProblemsDefault, setReparseOnlyProblemsDefault] = React.useState(false);
  const [parseBusy, setParseBusy] = React.useState(false);
  const [parseError, setParseError] = React.useState('');
  const [uploads, setUploads] = React.useState([]);
  const [toasts, setToasts] = React.useState([]);
  const [dropActive, setDropActive] = React.useState(false);
  const [katexReady, setKatexReady] = React.useState(MRU_KATEX.getStatus() === 'ready');
  // AI upgrade (docs/AI-SPEC.md §6): view switches, margin conversation, graphs.
  const [libraryView, setLibraryView] = React.useState('library');
  const [docView, setDocView] = React.useState('read');
  const [notesFilter, setNotesFilter] = React.useState('all');
  const [aiSelectionContext, setAiSelectionContext] = React.useState(null);
  const [aiParagraphContext, setAiParagraphContext] = React.useState(null);
  const [aiVisible, setAiVisible] = React.useState(null);
  const [aiContextMuted, setAiContextMuted] = React.useState(false);
  const [aiFocusSeq, setAiFocusSeq] = React.useState(0);
  const [docGraph, setDocGraph] = React.useState({ phase: 'idle', docId: null, graph: null, building: false, progress: null, error: '', available: true });
  const [libraryGraph, setLibraryGraph] = React.useState({ phase: 'idle', graph: null, building: false, progress: null, error: '', available: true });
  const [flashBlock, setFlashBlock] = React.useState(null);
  // Layout polish (docs/UI-POLISH-SPEC.md §2/§4): resizable panels + reading width.
  const [layout, setLayout] = React.useState(() => mruLayoutRead());
  const [resizing, setResizing] = React.useState(false);

  // --- refs --------------------------------------------------------------
  const rootRef = React.useRef(null);
  const scrollRef = React.useRef(null);
  const bodyRef = React.useRef(null);
  const searchRef = React.useRef(null);
  const fileInputRef = React.useRef(null);
  const latestRef = React.useRef({});
  const apiRef = React.useRef({});
  const annotationsStoreRef = React.useRef([]);
  const staleAnnotationsRef = React.useRef([]);
  // Ids this client is authoritative about for the additive annotation merge
  // (docs/AI-SPEC.md §2 "concurrent writers"): loaded annotations plus every
  // one created here; never ids that only arrived from another writer.
  const annotationsBaseIdsRef = React.useRef(new Set());
  const translationsStoreRef = React.useRef({ targetLanguage: 'zh', entries: {} });
  const translationInflightRef = React.useRef(new Set());
  const translationFlashTimerRef = React.useRef(null);
  const prevStatusesRef = React.useRef(new Map());
  const selCacheRef = React.useRef(new Map());
  const selSeqRef = React.useRef(0);
  const toastSeqRef = React.useRef(0);
  const toastTimersRef = React.useRef(new Map());
  const uploadSeqRef = React.useRef(0);
  const annTimerRef = React.useRef(null);
  const annPendingRef = React.useRef(null);
  const transTimerRef = React.useRef(null);
  const transPendingRef = React.useRef(null);
  const translateAllAbortRef = React.useRef(null);
  const activeTimerRef = React.useRef(null);
  const readerTimerRef = React.useRef(null);
  const mountedRef = React.useRef(true);
  const navStateRef = React.useRef(mruReadNavState());
  const navRestoreRef = React.useRef(navStateRef.current && typeof navStateRef.current.documentId === 'string'
    ? {
      documentId: navStateRef.current.documentId,
      scrollTop: Number(navStateRef.current.scrollTop) || 0,
      marginTab: MRU_MARGIN_TABS.includes(navStateRef.current.marginTab) ? navStateRef.current.marginTab : 'outline',
    }
    : null);
  const pendingScrollRef = React.useRef(null);
  const pendingMarginTabRef = React.useRef(null);
  const navSavedAtRef = React.useRef(0);
  const docGraphAbortRef = React.useRef(null);
  const libraryGraphAbortRef = React.useRef(null);
  const docGraphDirtyRef = React.useRef(false);
  const pendingJumpRef = React.useRef(null);
  const flashBlockTimerRef = React.useRef(null);
  const viewsInitializedRef = React.useRef(false);
  const autoBuiltGraphsRef = React.useRef(new Set());
  const aiContextMutedRef = React.useRef(false);
  const aiVisibleAtRef = React.useRef(0);
  const layoutRef = React.useRef(layout);

  // --- toasts ------------------------------------------------------------
  const toast = (text, kind) => {
    const id = ++toastSeqRef.current;
    setToasts((previous) => previous.slice(-3).concat([{ id, text: String(text ?? ''), kind: kind || 'info' }]));
    const timer = setTimeout(() => {
      toastTimersRef.current.delete(id);
      setToasts((previous) => previous.filter((item) => item.id !== id));
    }, kind === 'error' ? 6000 : 4200);
    toastTimersRef.current.set(id, timer);
  };
  const dismissToast = (id) => {
    const timer = toastTimersRef.current.get(id);
    if (timer) clearTimeout(timer);
    toastTimersRef.current.delete(id);
    setToasts((previous) => previous.filter((item) => item.id !== id));
  };

  // --- library state -----------------------------------------------------
  const applyStatus = (value) => {
    if (!value || typeof value !== 'object') return;
    const normalized = { ...value };
    const configured = value.configured && typeof value.configured === 'object' ? value.configured : null;
    if (normalized.tokenConfigured === undefined && configured) normalized.tokenConfigured = Boolean(configured.token);
    if (!normalized.dataDirDisplay && configured && configured.dataDir) normalized.dataDirDisplay = configured.dataDir;
    if (normalized.translatorAvailable === undefined && configured) normalized.translatorAvailable = Boolean(configured.translator);
    if (normalized.modelAvailable === undefined && configured) normalized.modelAvailable = Boolean(configured.model);
    setStatus(normalized);
    const nextPrefs = mruNormalizePrefs(value.preferences);
    setPrefs(nextPrefs);
    // Adopt the persisted view switches once; later settings.update responses
    // must not fight the switches the user just used.
    if (!viewsInitializedRef.current) {
      viewsInitializedRef.current = true;
      setLibraryView(nextPrefs.libraryView);
      setDocView(nextPrefs.docView);
      setNotesFilter(nextPrefs.notesFilter);
    }
  };

  const applyList = (value) => {
    const list = value && Array.isArray(value.documents) ? value.documents : [];
    const previousStatuses = prevStatusesRef.current;
    const nextStatuses = new Map();
    setDocsReady(true);
    setDocs(list);
    for (const doc of list) {
      nextStatuses.set(doc.id, doc.status);
      const previous = previousStatuses.get(doc.id);
      if (previous && previous !== doc.status) {
        const repair = doc.parse && doc.parse.repair;
        if (doc.status === 'parsed' && repair && Array.isArray(repair.pages)) {
          const failed = Array.isArray(repair.failedPages) ? repair.failedPages.length : 0;
          toast(failed > 0
            ? t('toast.repairPartial', { count: repair.pages.length, failed })
            : t('toast.repaired', { count: repair.pages.length }), failed > 0 ? 'error' : 'info');
        } else if (doc.status === 'parsed' && doc.parse && typeof doc.parse.repairError === 'string' && doc.parse.repairError !== '') {
          toast(mruDocErrorMessage({ error: doc.parse.repairError }), 'error');
        } else if (doc.status === 'parsed') toast(t('toast.parsed', { title: doc.title || doc.originalName || '' }));
        else if (doc.status === 'failed') toast(t('toast.parseFailed', { message: mruDocErrorMessage(doc) }), 'error');
        if (doc.status === 'parsed' && previous !== 'parsed') autoBuildGraphFor(doc);
      }
    }
    prevStatusesRef.current = nextStatuses;
    const current = latestRef.current;
    const selected = current.selectedId;
    if (!selected) return;
    const entry = list.find((doc) => doc.id === selected);
    if (!entry) return;
    setDetail((previous) => (previous && previous.document
      ? { ...previous, document: { ...previous.document, ...entry } }
      : previous));
    const previousStatus = previousStatuses.get(selected);
    if (previousStatus === 'parsing' && entry.status === 'parsed') {
      void loadReader(selected, entry);
      // A successful reparse / page repair re-anchors annotations host-side;
      // reload them so highlights move with the quote instead of going stale.
      void reloadAnnotations(selected);
    }
    if (previousStatus === 'parsing' && entry.status !== 'parsing') {
      if (entry.status === 'uploaded' || entry.status === 'failed') setReader({ phase: 'idle', docId: selected });
    }
  };

  const refreshList = async () => {
    try {
      const value = await mruPost('library.list', {});
      applyList(value);
    } catch {
      /* quiet refresh */
    }
  };
  const refreshStatus = async () => {
    try {
      const value = await mruPost('status', {});
      if (value) applyStatus(value);
    } catch {
      /* quiet refresh */
    }
  };

  // --- persistence queues ------------------------------------------------
  /** The three-way merge baseline sent with every whole-list annotation save. */
  const annotationBaseIds = () => {
    const set = annotationsBaseIdsRef.current;
    return set instanceof Set ? Array.from(set) : [];
  };
  /**
   * Send one whole-list annotation save. `baseIds` lets the host merge instead
   * of replace: ids the client never saw (a concurrent Q&A/agent annotation)
   * are kept, while ids the client knew and dropped stay deleted.
   */
  const postAnnotationsSave = (docId, list) => mruPost('annotations.save', {
    id: docId,
    annotations: list,
    baseIds: annotationBaseIds(),
  }).then((value) => {
    if (!value || !Array.isArray(value.items) || latestRef.current.selectedId !== docId) return value;
    const known = new Set();
    for (const item of annotationsStoreRef.current) if (item && typeof item.id === 'string') known.add(item.id);
    for (const item of staleAnnotationsRef.current) if (item && typeof item.id === 'string') known.add(item.id);
    // A concurrent writer added an annotation we have never rendered: reload so
    // it appears in the margin (and enters the merge baseline) instead of
    // silently staying invisible.
    if (value.items.some((item) => item && typeof item.id === 'string' && !known.has(item.id))) {
      void reloadAnnotations(docId);
    }
    return value;
  });
  const flushAnnotations = () => {
    if (annTimerRef.current) {
      clearTimeout(annTimerRef.current);
      annTimerRef.current = null;
    }
    const pending = annPendingRef.current;
    annPendingRef.current = null;
    if (!pending || !pending.id) return;
    void postAnnotationsSave(pending.id, pending.list).catch((error) => {
      if (latestRef.current.selectedId === pending.id) toast(mruErrorText(t, error), 'error');
    });
  };
  const queueAnnotationsSave = (id, list) => {
    if (!id) return;
    annPendingRef.current = { id, list };
    if (annTimerRef.current) return;
    annTimerRef.current = setTimeout(() => {
      annTimerRef.current = null;
      const pending = annPendingRef.current;
      annPendingRef.current = null;
      if (!pending || !pending.id) return;
      void postAnnotationsSave(pending.id, pending.list).catch((error) => {
        if (latestRef.current.selectedId === pending.id) toast(mruErrorText(t, error), 'error');
      });
    }, 800);
  };
  const flushTranslations = () => {
    if (transTimerRef.current) {
      clearTimeout(transTimerRef.current);
      transTimerRef.current = null;
    }
    const pending = transPendingRef.current;
    transPendingRef.current = null;
    if (!pending || !pending.id) return;
    void mruPost('translations.save', {
      id: pending.id,
      targetLanguage: pending.targetLanguage,
      entries: pending.entries,
    }).catch((error) => toast(mruErrorText(t, error), 'error'));
  };
  const queueTranslationsSave = (id, store) => {
    if (!id || !store) return;
    transPendingRef.current = { id, targetLanguage: store.targetLanguage || 'zh', entries: store.entries || {} };
    if (transTimerRef.current) return;
    transTimerRef.current = setTimeout(() => {
      transTimerRef.current = null;
      const pending = transPendingRef.current;
      transPendingRef.current = null;
      if (!pending || !pending.id) return;
      void mruPost('translations.save', {
        id: pending.id,
        targetLanguage: pending.targetLanguage,
        entries: pending.entries,
      }).catch((error) => toast(mruErrorText(t, error), 'error'));
    }, 1000);
  };

  // --- document loading --------------------------------------------------
  const clearDocumentState = (id) => {
    annotationsStoreRef.current = [];
    staleAnnotationsRef.current = [];
    annotationsBaseIdsRef.current = new Set();
    setStaleAnnotations([]);
    translationsStoreRef.current = { targetLanguage: 'zh', entries: {} };
    setAnnotations([]);
    setDroppedAnnotations(0);
    setTranslations({ targetLanguage: latestRef.current.prefs.targetLanguage || 'zh', entries: {} });
    setTranslationJobs({});
    setTranslationProviders({});
    setTranslateAll(null);
    setActiveAnnotationId(null);
    setSelection(null);
    setSelCard(null);
    setBlockCard(null);
    setNoteEditor(null);
    setActiveHeadingKey(null);
    setParseError('');
    setReader({ phase: 'loading', showSpinner: false, docId: id || null });
  };

  const loadReader = async (id, document) => {
    const doc = document || (latestRef.current.docs || []).find((item) => item.id === id) || null;
    setReader({ phase: 'loading', showSpinner: false, docId: id });
    if (readerTimerRef.current) clearTimeout(readerTimerRef.current);
    readerTimerRef.current = setTimeout(() => {
      readerTimerRef.current = null;
      if (mountedRef.current && latestRef.current.reader.phase === 'loading') {
        setReader((previous) => (previous.phase === 'loading' ? { ...previous, showSpinner: true } : previous));
      }
    }, 400);
    try {
      const value = await mruPost('document.markdown', { id });
      if (latestRef.current.selectedId !== id) return;
      const model = mruBuildModel(value && value.markdown, value && value.contentList, latestRef.current.prefs.showPageMarks);
      setReader({
        phase: 'ready',
        model,
        contentList: value && Array.isArray(value.contentList) ? value.contentList : null,
        pages: value && value.pages ? value.pages : (doc && doc.parse && doc.parse.pages) || null,
        docId: id,
        showSpinner: false,
      });
    } catch (error) {
      if (latestRef.current.selectedId !== id) return;
      setReader({ phase: 'error', error: mruErrorText(t, error), docId: id });
    }
  };

  const selectDoc = async (id) => {
    if (!id) return;
    const previousId = latestRef.current.selectedId;
    if (previousId && previousId !== id && scrollRef.current) {
      mruWriteNavState({ documentId: previousId, scrollTop: scrollRef.current.scrollTop });
    }
    clearDocumentState(id);
    setSelectedId(id);
    setDetail(null);
    if (docGraphAbortRef.current) {
      docGraphAbortRef.current.abort();
      docGraphAbortRef.current = null;
    }
    docGraphDirtyRef.current = false;
    setDocGraph({ phase: 'idle', docId: id, graph: null, building: false, progress: null, error: '', available: true });
    setAiSelectionContext(null);
    setAiParagraphContext(null);
    setAiVisible(null);
    setAiContextMuted(false);
    aiContextMutedRef.current = false;
    setFlashBlock(null);
    pendingJumpRef.current = null;
    const initialTab = pendingMarginTabRef.current
      || (latestRef.current.prefs.aiPanelOpen ? 'ai' : (latestRef.current.prefs.marginTab || 'outline'));
    setMarginTab(MRU_MARGIN_TABS.includes(initialTab) ? initialTab : 'outline');
    pendingMarginTabRef.current = null;
    try {
      const value = await mruPost('library.get', { id });
      if (latestRef.current.selectedId !== id) return;
      if (!value || !value.document) throw new MruApiError('not-found', 'document missing');
      const document = value.document;
      const translationData = value.translations && typeof value.translations === 'object' ? value.translations : null;
      const entries = translationData && translationData.entries && typeof translationData.entries === 'object'
        ? translationData.entries : {};
      const targetLanguage = (translationData && translationData.targetLanguage)
        || latestRef.current.prefs.targetLanguage || 'zh';
      translationsStoreRef.current = { targetLanguage, entries };
      setTranslations({ targetLanguage, entries });
      setDetail({
        document,
        annotations: Array.isArray(value.annotations) ? value.annotations : [],
        translations: translationData,
      });
      annotationsStoreRef.current = [];
      annotationsBaseIdsRef.current = new Set();
      if (document.status === 'parsed') {
        await loadReader(id, document);
      } else {
        setReader({ phase: 'idle', docId: id });
      }
    } catch (error) {
      if (latestRef.current.selectedId !== id) return;
      setReader({ phase: 'error', error: mruErrorText(t, error), docId: id });
      toast(mruErrorText(t, error), 'error');
    }
  };

  const reloadReader = () => {
    const state = latestRef.current;
    if (!state.selectedId) return;
    void selectDoc(state.selectedId);
  };

  // --- parse actions -----------------------------------------------------
  const startParse = async (docId, options) => {
    if (!docId) return;
    setParseBusy(true);
    setParseError('');
    try {
      const value = await mruPost('parse.start', { id: docId, options: options || {} });
      const document = value && value.document;
      if (document) {
        setDocs((previous) => previous.map((item) => (item.id === document.id ? { ...item, ...document } : item)));
        prevStatusesRef.current.set(document.id, document.status);
        setDetail((previous) => (previous && previous.document && previous.document.id === document.id
          ? { ...previous, document: { ...previous.document, ...document } }
          : previous));
        if (latestRef.current.selectedId === document.id) {
          setReader((previous) => (previous.phase === 'ready' ? previous : { phase: 'idle', docId: document.id }));
        }
      }
      setReparseDoc(null);
    } catch (error) {
      const text = mruErrorText(t, error);
      setParseError(text);
      toast(t('toast.parseRequestFailed', { message: text }), 'error');
    } finally {
      setParseBusy(false);
    }
  };

  const cancelParse = async (docId) => {
    if (!docId) return;
    try {
      const value = await mruPost('parse.cancel', { id: docId });
      const document = value && value.document;
      if (document) {
        setDocs((previous) => previous.map((item) => (item.id === document.id ? { ...item, ...document } : item)));
        prevStatusesRef.current.set(document.id, document.status);
        setDetail((previous) => (previous && previous.document && previous.document.id === document.id
          ? { ...previous, document: { ...previous.document, ...document } }
          : previous));
        // A cancelled page repair leaves the document parsed with its previous
        // parse intact — the reader already shows exactly that, so keep it
        // instead of dropping into a "loading" state that never resolves.
        if (document.status !== 'parsed') {
          setReader((previous) => (previous.docId === document.id ? { phase: 'idle', docId: document.id } : previous));
        }
      }
    } catch (error) {
      toast(mruErrorText(t, error), 'error');
    }
  };

  // --- import / export / delete -----------------------------------------
  const importFiles = async (files) => {
    const list = Array.from(files || []).filter(Boolean);
    if (list.length === 0) return;
    for (const file of list) {
      const key = `upload-${++uploadSeqRef.current}`;
      setUploads((previous) => previous.concat([{ key, name: file.name, progress: 0 }]));
      try {
        const value = await mruUpload(file, {
          onProgress: (percent) => setUploads((previous) => previous.map((item) => (item.key === key ? { ...item, progress: percent } : item))),
        });
        setUploads((previous) => previous.filter((item) => item.key !== key));
        const document = value && value.document;
        if (document) {
          setDocs((previous) => [document].concat(previous.filter((item) => item.id !== document.id)));
          prevStatusesRef.current.set(document.id, document.status);
          toast(t('toast.uploaded', { name: file.name }));
          if (!latestRef.current.selectedId) void selectDoc(document.id);
        }
      } catch (error) {
        setUploads((previous) => previous.filter((item) => item.key !== key));
        toast(mruErrorText(t, error), 'error');
      }
    }
  };

  const onFileInputChange = (event) => {
    const input = event.currentTarget;
    const files = input.files ? Array.from(input.files) : [];
    input.value = '';
    if (files.length > 0) void importFiles(files);
  };

  const chooseFile = () => {
    if (fileInputRef.current) fileInputRef.current.click();
  };

  const importFromUrl = async (url) => {
    setImportUrlBusy(true);
    setImportUrlError('');
    try {
      const value = await mruPost('library.importUrl', { url });
      const document = value && value.document;
      setImportUrlOpen(false);
      if (document) {
        setDocs((previous) => [document].concat(previous.filter((item) => item.id !== document.id)));
        prevStatusesRef.current.set(document.id, document.status);
        toast(t('toast.uploaded', { name: document.originalName || document.title || url }));
        void selectDoc(document.id);
      }
    } catch (error) {
      const text = mruErrorText(t, error);
      setImportUrlError(text);
      toast(t('toast.importFailed', { message: text }), 'error');
    } finally {
      setImportUrlBusy(false);
    }
  };

  /** Safe download filename for user-facing exports (keeps the extension). */
  const mruSafeExportName = (name) => {
    const raw = String(name || 'export.md').trim();
    const cleaned = raw.replace(/[\\/:*?"<>|]/g, '_').trim();
    return cleaned === '' ? 'export.md' : cleaned;
  };

  /** Trigger a client-side text download; returns whether the click happened. */
  const mruDownloadText = (filename, text, mime) => {
    try {
      const blob = new Blob([String(text === undefined || text === null ? '' : text)], {
        type: mime || 'text/markdown;charset=utf-8',
      });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = mruSafeExportName(filename);
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
      return true;
    } catch (error) {
      return false;
    }
  };

  const exportDocument = async (doc) => {
    if (!doc) return;
    try {
      const value = await mruPost('document.markdown', { id: doc.id });
      const markdown = value && typeof value.markdown === 'string' ? value.markdown : '';
      const filename = `${String(doc.title || doc.originalName || 'document')}.md`;
      if (!mruDownloadText(filename, markdown)) throw new Error('download unavailable');
      toast(t('toast.exported'));
    } catch (error) {
      toast(mruErrorText(t, error), 'error');
    }
  };

  const confirmDeleteDocument = async () => {
    const target = latestRef.current.confirmDelete;
    if (!target || !target.id) return;
    setDeleteBusy(true);
    try {
      await mruPost('library.remove', { id: target.id });
      setDocs((previous) => previous.filter((item) => item.id !== target.id));
      prevStatusesRef.current.delete(target.id);
      if (latestRef.current.selectedId === target.id) {
        setSelectedId(null);
        setDetail(null);
        clearDocumentState(null);
        setReader({ phase: 'empty' });
      }
      setConfirmDelete(null);
      toast(t('toast.deleted'));
    } catch (error) {
      toast(mruErrorText(t, error), 'error');
    } finally {
      setDeleteBusy(false);
    }
  };

  // --- annotations -------------------------------------------------------
  const findBlock = (blockKey) => {
    const model = latestRef.current.reader && latestRef.current.reader.model;
    if (!model || !Array.isArray(model.blocks)) return null;
    return model.blocks.find((block) => block && block.key === blockKey) || null;
  };

  const flashAnnotation = (id) => {
    setActiveAnnotationId(id);
    if (activeTimerRef.current) clearTimeout(activeTimerRef.current);
    activeTimerRef.current = setTimeout(() => {
      activeTimerRef.current = null;
      setActiveAnnotationId(null);
    }, 1600);
  };

  const scrollToAnnotation = (id) => {
    const body = bodyRef.current;
    if (!body) return;
    let element = null;
    try {
      element = body.querySelector(`[data-annotation-id="${String(id).replace(/"/g, '\\"')}"]`);
    } catch {
      element = null;
    }
    if (!element) {
      const annotation = (annotationsStoreRef.current || []).find((item) => item.id === id);
      if (annotation) {
        try {
          element = body.querySelector(`[data-block-key="${String(annotation.blockKey).replace(/"/g, '\\"')}"]`);
        } catch {
          element = null;
        }
      }
    }
    if (element) mruScrollToElement(element, 'center');
    flashAnnotation(id);
  };

  const addAnnotation = (input) => {
    const block = findBlock(input.blockKey);
    const plainLength = block && typeof block.plainText === 'string' ? block.plainText.length : 0;
    const start = mruClamp(Number(input.start) || 0, 0, plainLength);
    const end = mruClamp(Number(input.end) || 0, start, plainLength);
    if (end <= start) return null;
    const now = new Date().toISOString();
    const annotation = {
      id: newAnnotationId(),
      blockKey: String(input.blockKey || ''),
      start,
      end,
      quote: String(input.quote || '').slice(0, MRU_MAX_QUOTE),
      color: MRU_COLORS.includes(input.color) ? input.color : 'yellow',
      note: typeof input.note === 'string' ? input.note : '',
      createdAt: now,
      updatedAt: now,
    };
    const next = annotationsStoreRef.current.concat([annotation]);
    annotationsStoreRef.current = next;
    if (annotationsBaseIdsRef.current instanceof Set) annotationsBaseIdsRef.current.add(annotation.id);
    setAnnotations(next);
    queueAnnotationsSave(latestRef.current.selectedId, mruMergeAnnotations(next, staleAnnotationsRef.current));
    flashAnnotation(annotation.id);
    return annotation;
  };

  const updateAnnotation = (id, patch) => {
    const now = new Date().toISOString();
    const next = annotationsStoreRef.current.map((annotation) => {
      if (annotation.id !== id) return annotation;
      const merged = { ...annotation, ...patch, updatedAt: now };
      if (!MRU_COLORS.includes(merged.color)) merged.color = annotation.color || 'yellow';
      if (typeof merged.note !== 'string') merged.note = annotation.note || '';
      return merged;
    });
    annotationsStoreRef.current = next;
    setAnnotations(next);
    queueAnnotationsSave(latestRef.current.selectedId, mruMergeAnnotations(next, staleAnnotationsRef.current));
  };

  const deleteAnnotation = (id) => {
    // Deletion may target a normal annotation or an orphan/stale card; remove it
    // from whichever list holds it and persist the merged remainder.
    const normalizedNext = annotationsStoreRef.current.filter((annotation) => annotation.id !== id);
    const staleNext = staleAnnotationsRef.current.filter((annotation) => annotation.id !== id);
    annotationsStoreRef.current = normalizedNext;
    staleAnnotationsRef.current = staleNext;
    setAnnotations(normalizedNext);
    setStaleAnnotations(staleNext);
    queueAnnotationsSave(latestRef.current.selectedId, mruMergeAnnotations(normalizedNext, staleNext));
    if (activeAnnotationId === id) setActiveAnnotationId(null);
    toast(t('toast.deleted'));
  };

  const openAnnotationEditor = (id, event) => {
    const annotation = (annotationsStoreRef.current || []).find((item) => item.id === id);
    if (!annotation) return;
    let rect = null;
    if (event && event.currentTarget && typeof event.currentTarget.getBoundingClientRect === 'function') {
      rect = event.currentTarget.getBoundingClientRect();
    }
    if (!rect) {
      const body = bodyRef.current;
      const element = body ? body.querySelector(`[data-annotation-id="${String(id).replace(/"/g, '\\"')}"]`) : null;
      if (element) rect = element.getBoundingClientRect();
    }
    setSelection(null);
    setSelCard(null);
    setBlockCard(null);
    setNoteEditor({
      mode: 'edit',
      annotationId: id,
      blockKey: annotation.blockKey,
      start: annotation.start,
      end: annotation.end,
      quote: annotation.quote,
      note: annotation.note || '',
      color: annotation.color || 'yellow',
      origin: annotation.origin || 'user',
      aspect: annotation.aspect || '',
      rect,
    });
    flashAnnotation(id);
  };

  const noteEditorSave = () => {
    const editor = latestRef.current.noteEditor;
    mruClearBrowserSelection();
    if (!editor) return;
    if (editor.mode === 'edit' && editor.annotationId) {
      updateAnnotation(editor.annotationId, { note: editor.note || '', color: editor.color });
    } else {
      addAnnotation({
        blockKey: editor.blockKey,
        start: editor.start,
        end: editor.end,
        quote: editor.quote,
        color: editor.color,
        note: editor.note || '',
      });
    }
    setNoteEditor(null);
    toast(t('toast.noteSaved'));
  };

  // --- selection ---------------------------------------------------------
  const captureReaderSelection = (source) => {
    const state = latestRef.current;
    const model = state.reader && state.reader.model;
    const body = bodyRef.current;
    if (!model || !body) return;
    const blocksByKey = new Map();
    for (const block of model.blocks) {
      if (block && block.key) blocksByKey.set(block.key, block);
    }
    let info = null;
    try {
      info = mruReadSelection(body, blocksByKey, source);
    } catch {
      info = null;
    }
    if (!info) return;
    if (info.end - info.start > MRU_MAX_QUOTE) {
      info = { ...info, end: info.start + MRU_MAX_QUOTE, quote: info.quote.slice(0, MRU_MAX_QUOTE) };
    }
    const overlapping = [];
    for (const annotation of annotationsStoreRef.current || []) {
      if (annotation && annotation.blockKey === info.blockKey
        && Number(annotation.start) < info.end && Number(annotation.end) > info.start) {
        overlapping.push(annotation.id);
      }
    }
    if (overlapping.length > 0) info = { ...info, annotationIds: overlapping };
    setSelection(info);
    setSelCard(null);
    setBlockCard(null);
    setNoteEditor(null);
  };

  const onReaderMouseUp = (event) => {
    if (event && event.button !== 0) return;
    window.setTimeout(() => {
      if (mountedRef.current) captureReaderSelection('mouse');
    }, 0);
  };

  const onReaderKeyUp = (event) => {
    const key = event && event.key ? event.key : '';
    const isSelectionKey = key === 'Shift' || key.indexOf('Arrow') === 0
      || key === 'Home' || key === 'End' || key === 'PageUp' || key === 'PageDown';
    if (!isSelectionKey) return;
    window.setTimeout(() => {
      if (mountedRef.current) captureReaderSelection('keyboard');
    }, 0);
  };

  const requestSelectionTranslation = async (base) => {
    const sequence = ++selSeqRef.current;
    const cacheKey = `${base.blockKey}:${base.start}:${base.end}:${String(base.quote).slice(0, 160)}`;
    const cached = selCacheRef.current.get(cacheKey);
    if (cached) {
      setSelCard({ ...base, state: 'done', translation: cached.translation, provider: cached.provider });
      return;
    }
    setSelCard({ ...base, state: 'loading' });
    try {
      const value = await mruPost('translate', {
        text: base.quote,
        targetLanguage: latestRef.current.prefs.targetLanguage,
        provider: latestRef.current.prefs.translationProvider,
      });
      if (sequence !== selSeqRef.current) return;
      const translation = value && typeof value.translation === 'string' ? value.translation : '';
      const provider = (value && value.provider) || '';
      if (translation === '') throw new MruApiError('translate-unavailable', 'empty translation');
      selCacheRef.current.set(cacheKey, { translation, provider });
      setSelCard({ ...base, state: 'done', translation, provider });
    } catch {
      if (sequence !== selSeqRef.current) return;
      setSelCard({ ...base, state: 'error' });
    }
  };

  const selectionTranslate = () => {
    const info = latestRef.current.selection;
    if (!info) return;
    setSelection(null);
    void requestSelectionTranslation(info);
  };

  const selectionHighlight = (color) => {
    const info = latestRef.current.selection;
    if (!info) return;
    addAnnotation({
      blockKey: info.blockKey,
      start: info.start,
      end: info.end,
      quote: info.quote,
      color,
      note: '',
    });
    mruClearBrowserSelection();
    setSelection(null);
    toast(t('toast.highlighted'));
  };

  /** Remove every annotation covered by the current selection («取消高亮»). */
  const removeHighlights = (ids) => {
    const idSet = new Set(Array.isArray(ids) ? ids : []);
    if (idSet.size === 0) return;
    const next = annotationsStoreRef.current.filter((annotation) => !idSet.has(annotation.id));
    annotationsStoreRef.current = next;
    setAnnotations(next);
    queueAnnotationsSave(latestRef.current.selectedId, mruMergeAnnotations(next, staleAnnotationsRef.current));
    if (activeAnnotationId && idSet.has(activeAnnotationId)) setActiveAnnotationId(null);
    mruClearBrowserSelection();
    setSelection(null);
    toast(t('toast.highlightRemoved'));
  };

  const selectionNote = () => {
    const info = latestRef.current.selection;
    if (!info) return;
    setNoteEditor({
      mode: 'create',
      blockKey: info.blockKey,
      start: info.start,
      end: info.end,
      quote: info.quote,
      note: '',
      color: 'yellow',
      rect: info.rect,
    });
    setSelection(null);
  };

  const selectionCopy = async () => {
    const info = latestRef.current.selection;
    if (!info) return;
    try {
      await mruCopy(info.quote);
      toast(t('toast.copied'));
    } catch {
      toast(t('toast.copyFailed'), 'error');
    }
  };

  const selCardCopy = async () => {
    const card = latestRef.current.selCard;
    if (!card || !card.translation) return;
    try {
      await mruCopy(card.translation);
      toast(t('toast.copied'));
    } catch {
      toast(t('toast.copyFailed'), 'error');
    }
  };

  const blockAnnotate = (block) => {
    if (!block || !block.plainText) return;
    const body = bodyRef.current;
    let rect = null;
    try {
      const element = body && body.querySelector(`[data-block-key="${String(block.key).replace(/"/g, '\\"')}"]`);
      if (element) rect = element.getBoundingClientRect();
    } catch {
      rect = null;
    }
    setSelection(null);
    setSelCard(null);
    setNoteEditor({
      mode: 'create',
      blockKey: block.key,
      start: 0,
      end: Math.min(block.plainText.length, MRU_MAX_QUOTE),
      quote: block.plainText.slice(0, MRU_MAX_QUOTE),
      note: '',
      color: 'yellow',
      rect,
    });
  };

  // --- translation -------------------------------------------------------
  const setTranslationEntry = (blockKey, text, provider) => {
    const current = translationsStoreRef.current || { targetLanguage: 'zh', entries: {} };
    const entries = { ...(current.entries || {}) };
    entries[blockKey] = text;
    const targetLanguage = latestRef.current.prefs.targetLanguage || current.targetLanguage || 'zh';
    const next = { targetLanguage, entries };
    translationsStoreRef.current = next;
    setTranslations(next);
    queueTranslationsSave(latestRef.current.selectedId, next);
    if (provider) {
      setTranslationProviders((previous) => ({ ...previous, [blockKey]: String(provider) }));
    }
  };

  const translationLanguage = () => {
    const current = translationsStoreRef.current;
    return (current && current.targetLanguage) || latestRef.current.prefs.targetLanguage || 'zh';
  };

  const translateBlock = async (block, options) => {
    const opts = options || {};
    if (!block || !block.key || typeof block.plainText !== 'string' || block.plainText.trim() === '') return;
    const documentId = latestRef.current.selectedId;
    if (!documentId) return;
    const inflight = translationInflightRef.current;
    if (inflight.has(block.key)) return;
    const existing = (translationsStoreRef.current.entries || {})[block.key];
    if (typeof existing === 'string' && existing !== '' && !opts.force) return;
    // A translation has to have somewhere to appear: reveal bilingual reading
    // when the reader is in original-only mode, otherwise the click looks dead.
    if (opts.reveal !== false) revealTranslations();
    inflight.add(block.key);
    setTranslationJobs((previous) => ({ ...previous, [block.key]: { state: 'pending' } }));
    try {
      const value = await mruPost('translate', {
        text: block.plainText,
        targetLanguage: latestRef.current.prefs.targetLanguage,
        provider: latestRef.current.prefs.translationProvider,
      });
      if (latestRef.current.selectedId !== documentId) return;
      const text = value && typeof value.translation === 'string' ? value.translation : '';
      if (text === '') throw new MruApiError('translate-unavailable', 'empty translation');
      setTranslationEntry(block.key, text, value && value.provider);
      if (opts.flashOnDone) flashTranslation(block.key);
      setTranslationJobs((previous) => {
        const next = { ...previous };
        delete next[block.key];
        return next;
      });
    } catch (error) {
      if (latestRef.current.selectedId !== documentId) return;
      if (error && error.code === 'aborted') return;
      setTranslationJobs((previous) => ({ ...previous, [block.key]: { state: 'error' } }));
      if (!opts.quiet) toast(mruErrorText(t, error), 'error');
    } finally {
      inflight.delete(block.key);
    }
  };

  const cancelTranslateAll = () => {
    if (translateAllAbortRef.current) {
      translateAllAbortRef.current.abort();
      translateAllAbortRef.current = null;
    }
    setTranslateAll(null);
  };

  const translateAllBlocks = async () => {
    const state = latestRef.current;
    const model = state.reader && state.reader.model;
    const documentId = state.selectedId;
    if (!model || !documentId || translateAllAbortRef.current) return;
    const blocks = (model.blocks || []).filter((block) => mruIsTextBlock(block)
      && typeof block.plainText === 'string' && block.plainText.trim() !== '');
    const entries = (translationsStoreRef.current && translationsStoreRef.current.entries) || {};
    const todo = blocks.filter((block) => typeof entries[block.key] !== 'string' || entries[block.key] === '');
    if (todo.length === 0) {
      toast(t('translate.done', { count: 0 }));
      return;
    }
    const controller = new AbortController();
    translateAllAbortRef.current = controller;
    const targetLanguage = state.prefs.targetLanguage;
    const provider = state.prefs.translationProvider;
    let cursor = 0;
    let finished = 0;
    let ok = 0;
    let failed = 0;
    let stopped = false;
    setTranslateAll({ running: true, done: 0, total: todo.length });
    const worker = async () => {
      for (;;) {
        if (stopped || controller.signal.aborted) return;
        const index = cursor;
        cursor += 1;
        if (index >= todo.length) return;
        const block = todo[index];
        try {
          const value = await mruPost('translate', {
            text: block.plainText,
            targetLanguage,
            provider,
          }, { signal: controller.signal });
          if (controller.signal.aborted) {
            stopped = true;
            return;
          }
          const text = value && typeof value.translation === 'string' ? value.translation : '';
          if (text === '') failed += 1;
          else {
            setTranslationEntry(block.key, text, value && value.provider);
            ok += 1;
          }
        } catch (error) {
          if (controller.signal.aborted || (error && error.code === 'aborted')) {
            stopped = true;
            return;
          }
          failed += 1;
        }
        if (controller.signal.aborted) {
          stopped = true;
          return;
        }
        finished += 1;
        setTranslateAll({ running: true, done: finished, total: todo.length });
      }
    };
    const workers = [];
    for (let i = 0; i < MRU_TRANSLATE_CONCURRENCY; i += 1) workers.push(worker());
    await Promise.all(workers);
    if (translateAllAbortRef.current === controller) translateAllAbortRef.current = null;
    setTranslateAll(null);
    if (stopped) toast(t('translate.partial', { done: ok, failed }));
    else if (failed === 0) toast(t('translate.done', { count: ok }));
    else toast(t('translate.partial', { done: ok, failed }), 'error');
  };

  // --- AI integration: view switches, conversation context, graphs --------
  // Own the AI state that the chat panel (MruAiPanel) and graph view
  // (MruGraphView) receive as props; the modules stay presentational.

  const docGraphEnabled = () => mruAiState(latestRef.current.status).graph;

  /** Persist and adopt the library/dock view switches. */
  const changeLibraryView = (view) => {
    if (!MRU_LIBRARY_VIEWS.includes(view) || latestRef.current.libraryView === view) return;
    setLibraryView(view);
    mruWriteNavState({ libraryView: view });
    void updatePrefs({ libraryView: view });
    if (view === 'graph') void loadLibraryGraph();
  };

  const changeDocView = (view) => {
    if (!MRU_DOC_VIEWS.includes(view) || latestRef.current.docView === view) return;
    setDocView(view);
    if (view === 'graph') {
      const id = latestRef.current.selectedId;
      if (id) void loadDocGraph(id);
    }
    void updatePrefs({ docView: view });
  };

  const changeMarginTab = (tab) => {
    if (!MRU_MARGIN_TABS.includes(tab) || latestRef.current.marginTab === tab) return;
    setMarginTab(tab);
    mruWriteNavState({ marginTab: tab });
    void updatePrefs({ marginTab: tab, aiPanelOpen: tab === 'ai' });
  };

  /** Persist the margin-note origin filter ("全部 / AI 批注 / 我的批注"). */
  const changeNotesFilter = (value) => {
    const next = MRU_NOTES_FILTERS.includes(value) ? value : 'all';
    if (latestRef.current.notesFilter === next) return;
    setNotesFilter(next);
    void updatePrefs({ notesFilter: next });
  };

  /** Open the margin conversation (quick actions / Cmd-J). */
  const openAiPanel = () => {
    if (latestRef.current.libraryView === 'graph') {
      setLibraryView('library');
      void updatePrefs({ libraryView: 'library' });
    }
    setMarginTab('ai');
    setMarginOpen(true);
    setAiFocusSeq((value) => value + 1);
    setAiContextMuted(false);
    aiContextMutedRef.current = false;
    mruWriteNavState({ marginTab: 'ai' });
    void updatePrefs({ marginTab: 'ai', aiPanelOpen: true });
    // The chat module owns its composer: focus it once the panel has mounted.
    window.setTimeout(() => {
      const root = rootRef.current;
      if (!root || typeof root.querySelector !== 'function') return;
      const input = root.querySelector('textarea.mru-ai__input, input.mru-ai__input');
      if (input && typeof input.focus === 'function') input.focus();
    }, 80);
  };

  const askBlockAi = (block) => {
    if (!block || typeof block.key !== 'string') return;
    setAiParagraphContext({ blockKey: block.key, text: String(block.plainText || '').slice(0, 800) });
    openAiPanel();
  };

  const askSelectionAi = () => {
    const info = latestRef.current.selection;
    if (!info) return;
    setAiSelectionContext({ blockKey: info.blockKey, quote: info.quote, start: info.start, end: info.end });
    setSelection(null);
    setSelCard(null);
    setBlockCard(null);
    openAiPanel();
  };

  const askGraphNode = (node) => {
    if (!node || typeof node !== 'object') return;
    const label = typeof node.label === 'string' ? node.label : '';
    const summary = typeof node.summary === 'string' ? node.summary : '';
    const quote = summary !== '' ? `${label}：${summary}` : label;
    const blockKey = Array.isArray(node.blockKeys) && typeof node.blockKeys[0] === 'string' ? node.blockKeys[0] : '';
    const documentId = (typeof node.documentId === 'string' && node.documentId !== '' ? node.documentId : '')
      || (Array.isArray(node.documentIds) && typeof node.documentIds[0] === 'string' ? node.documentIds[0] : '')
      || latestRef.current.selectedId;
    if (latestRef.current.libraryView === 'graph') {
      setLibraryView('library');
      void updatePrefs({ libraryView: 'library' });
    }
    if (documentId && latestRef.current.selectedId !== documentId) void selectDoc(documentId);
    setAiSelectionContext({ blockKey, quote: quote.slice(0, MRU_MAX_QUOTE), start: 0, end: 0 });
    openAiPanel();
  };

  const clearAiContext = (kind) => {
    if (kind === 'selection') {
      setAiSelectionContext(null);
      return;
    }
    setAiParagraphContext(null);
    setAiVisible(null);
    setAiContextMuted(true);
    aiContextMutedRef.current = true;
  };

  const flashBlockNow = (blockKey) => {
    if (!blockKey) return;
    setFlashBlock(blockKey);
    if (flashBlockTimerRef.current) clearTimeout(flashBlockTimerRef.current);
    flashBlockTimerRef.current = setTimeout(() => {
      flashBlockTimerRef.current = null;
      if (mountedRef.current) setFlashBlock(null);
    }, 1600);
  };

  /** Scroll the paper to a block (from a citation or a graph node) and flash it. */
  const jumpToBlock = (blockKey, documentId) => {
    if (!blockKey || typeof blockKey !== 'string') return;
    const state = latestRef.current;
    const targetDoc = documentId || state.selectedId;
    if (state.libraryView === 'graph') {
      setLibraryView('library');
      void updatePrefs({ libraryView: 'library' });
    }
    if (documentId && state.selectedId !== documentId) {
      pendingJumpRef.current = { documentId, blockKey };
      void selectDoc(documentId);
      return;
    }
    if (state.docView !== 'read') {
      pendingJumpRef.current = { documentId: targetDoc, blockKey };
      setDocView('read');
      void updatePrefs({ docView: 'read' });
      return;
    }
    const body = bodyRef.current;
    let element = null;
    if (body) {
      try {
        element = body.querySelector(`[data-block-key="${String(blockKey).replace(/"/g, '\\"')}"]`);
      } catch {
        element = null;
      }
    }
    if (!element) {
      pendingJumpRef.current = { documentId: targetDoc, blockKey };
      return;
    }
    mruScrollToElement(element, 'center');
    flashBlockNow(blockKey);
    const related = (annotationsStoreRef.current || []).filter((annotation) => annotation && annotation.blockKey === blockKey);
    if (related.length > 0) flashAnnotation(related[related.length - 1].id);
  };

  /** Accept both documented graph onJump shapes: onJump(blockKey) / onJump(documentId, blockKey). */
  const graphJump = (first, second) => {
    if (typeof second === 'string' && second !== '') jumpToBlock(second, typeof first === 'string' ? first : undefined);
    else if (typeof first === 'string') jumpToBlock(first, undefined);
  };

  /** Reload the persisted annotations for a document (AI answers add highlights). */
  const reloadAnnotations = async (documentId) => {
    const id = documentId || latestRef.current.selectedId;
    if (!id) return;
    try {
      const value = await mruPost('library.get', { id });
      if (!value || latestRef.current.selectedId !== id) return;
      setDetail((previous) => {
        if (!previous || !previous.document) return previous;
        return {
          ...previous,
          document: value.document || previous.document,
          annotations: Array.isArray(value.annotations) ? value.annotations : previous.annotations,
        };
      });
    } catch {
      /* annotation refresh is best-effort */
    }
  };

  /** Q&A added graph knowledge: refresh the graph when it is on screen. */
  const handleGraphDelta = () => {
    docGraphDirtyRef.current = true;
    const state = latestRef.current;
    if (state.docView === 'graph' && state.selectedId) void loadDocGraph(state.selectedId);
  };

  const loadDocGraph = async (documentId) => {
    const id = documentId || latestRef.current.selectedId;
    if (!id) return;
    if (!docGraphEnabled()) {
      setDocGraph({ phase: 'unavailable', docId: id, graph: null, building: false, progress: null, error: '', available: false });
      return;
    }
    setDocGraph((previous) => ({
      phase: 'loading',
      docId: id,
      graph: previous.docId === id ? previous.graph : null,
      building: false,
      progress: null,
      error: '',
      available: true,
    }));
    try {
      const value = await mruPost('graph.doc', { documentId: id });
      const graph = value && value.graph ? value.graph : null;
      setDocGraph({ phase: 'ready', docId: id, graph, building: false, progress: null, error: '', available: true });
      docGraphDirtyRef.current = false;
    } catch (error) {
      const unavailable = Boolean(error && (error.code === 'ai-unavailable' || error.code === 'llm-unavailable' || error.code === 'ai-disabled'));
      setDocGraph({
        phase: unavailable ? 'unavailable' : 'error',
        docId: id,
        graph: null,
        building: false,
        progress: null,
        error: unavailable ? '' : mruErrorText(t, error),
        available: !unavailable,
      });
    }
  };

  const buildDocGraph = async (documentId) => {
    const id = documentId || latestRef.current.selectedId;
    if (!id) return;
    if (!docGraphEnabled()) {
      setDocGraph((previous) => ({ ...previous, phase: 'unavailable', available: false, graph: null }));
      toast(t('graph.unavailable'), 'error');
      return;
    }
    if (docGraphAbortRef.current) docGraphAbortRef.current.abort();
    const controller = new AbortController();
    docGraphAbortRef.current = controller;
    let sawGraph = false;
    setDocGraph((previous) => ({
      ...previous,
      phase: previous.graph ? 'ready' : 'loading',
      docId: id,
      building: true,
      progress: null,
      error: '',
      available: true,
    }));
    try {
      await mruStreamNdjson('graph.build', { documentId: id, force: true }, {
        signal: controller.signal,
        onFrame: (frame) => {
          if (!frame || typeof frame !== 'object') return;
          if (frame.type === 'progress') {
            setDocGraph((previous) => ({
              ...previous,
              building: true,
              progress: {
                phase: typeof frame.phase === 'string' ? frame.phase : '',
                done: Number(frame.done) || 0,
                total: Number(frame.total) || 0,
              },
            }));
          } else if (frame.type === 'graph') {
            sawGraph = true;
            docGraphDirtyRef.current = false;
            setDocGraph((previous) => ({
              ...previous,
              phase: 'ready',
              graph: frame.graph || previous.graph,
              available: true,
              error: '',
            }));
          } else if (frame.type === 'error') {
            setDocGraph((previous) => ({
              ...previous,
              building: false,
              progress: null,
              phase: previous.graph ? 'ready' : 'error',
              error: typeof frame.message === 'string' && frame.message !== '' ? frame.message : t('graph.error'),
            }));
          }
        },
      });
      setDocGraph((previous) => ({ ...previous, building: false, progress: null }));
      if (sawGraph) toast(t('toast.graphBuilt'));
    } catch (error) {
      if (error && error.code === 'aborted') {
        setDocGraph((previous) => ({ ...previous, building: false, progress: null }));
        return;
      }
      const unavailable = Boolean(error && (error.code === 'ai-unavailable' || error.code === 'llm-unavailable' || error.code === 'ai-disabled'));
      setDocGraph((previous) => ({
        ...previous,
        building: false,
        progress: null,
        available: !unavailable,
        phase: previous.graph ? 'ready' : (unavailable ? 'unavailable' : 'error'),
        error: unavailable ? '' : mruErrorText(t, error),
      }));
      toast(mruErrorText(t, error), 'error');
    } finally {
      if (docGraphAbortRef.current === controller) docGraphAbortRef.current = null;
    }
  };

  /**
   * Auto-build a paper graph once per session when the preference is on
   * (docs/AI-SPEC.md §6/§9). The parse-transition watcher and the empty-graph
   * view trigger share this guard, so a parse never kicks off two builds.
   */
  const autoBuildGraphFor = (doc) => {
    const state = latestRef.current;
    const id = doc && typeof doc.id === 'string' ? doc.id : '';
    if (id === '' || !state.prefs.graphAutoBuild || !mruAiState(state.status).graph) return false;
    if (autoBuiltGraphsRef.current.has(id)) return false;
    autoBuiltGraphsRef.current.add(id);
    toast(t('toast.autoGraph'));
    window.setTimeout(() => {
      if (mountedRef.current) void buildDocGraph(id);
    }, 800);
    return true;
  };

  // Auto-build switch: opening a parsed paper whose graph is still empty also
  // triggers the build (covers a reload while the paper was being parsed).
  // Reads the latest state through the ref so it can stay above the derived
  // state declarations in this component.
  React.useEffect(() => {
    const state = latestRef.current || {};
    if (state.docView !== 'graph') return;
    const list = Array.isArray(state.docs) ? state.docs : [];
    const detailDoc = state.detail && state.detail.document ? state.detail.document : null;
    const doc = list.find((item) => item && item.id === state.selectedId)
      || (detailDoc && detailDoc.id === state.selectedId ? detailDoc : null);
    const graphState = state.docGraph || {};
    if (!doc || doc.status !== 'parsed') return;
    if (graphState.phase !== 'ready' || graphState.building || !graphState.graph) return;
    if (Array.isArray(graphState.graph.nodes) && graphState.graph.nodes.length > 0) return;
    autoBuildGraphFor(doc);
  }, [docView, docGraph]);

  const loadLibraryGraph = async () => {
    if (!docGraphEnabled()) {
      setLibraryGraph({ phase: 'unavailable', graph: null, building: false, progress: null, error: '', available: false });
      return;
    }
    setLibraryGraph((previous) => ({
      phase: 'loading',
      graph: previous.graph,
      building: false,
      progress: null,
      error: '',
      available: true,
    }));
    try {
      const value = await mruPost('graph.library', {});
      setLibraryGraph({ phase: 'ready', graph: value && value.graph ? value.graph : null, building: false, progress: null, error: '', available: true });
    } catch (error) {
      const unavailable = Boolean(error && (error.code === 'ai-unavailable' || error.code === 'llm-unavailable' || error.code === 'ai-disabled'));
      setLibraryGraph({
        phase: unavailable ? 'unavailable' : 'error',
        graph: null,
        building: false,
        progress: null,
        error: unavailable ? '' : mruErrorText(t, error),
        available: !unavailable,
      });
    }
  };

  const rebuildLibraryGraph = async () => {
    if (!docGraphEnabled()) {
      setLibraryGraph((previous) => ({ ...previous, phase: 'unavailable', available: false, graph: null }));
      toast(t('graph.unavailable'), 'error');
      return;
    }
    if (libraryGraphAbortRef.current) libraryGraphAbortRef.current.abort();
    const controller = new AbortController();
    libraryGraphAbortRef.current = controller;
    let sawGraph = false;
    setLibraryGraph((previous) => ({
      ...previous,
      phase: previous.graph ? 'ready' : 'loading',
      building: true,
      progress: null,
      error: '',
      available: true,
    }));
    try {
      await mruStreamNdjson('graph.library.rebuild', {}, {
        signal: controller.signal,
        onFrame: (frame) => {
          if (!frame || typeof frame !== 'object') return;
          if (frame.type === 'progress') {
            setLibraryGraph((previous) => ({
              ...previous,
              building: true,
              progress: {
                phase: typeof frame.phase === 'string' ? frame.phase : '',
                done: Number(frame.done) || 0,
                total: Number(frame.total) || 0,
              },
            }));
          } else if (frame.type === 'graph') {
            sawGraph = true;
            setLibraryGraph((previous) => ({ ...previous, phase: 'ready', graph: frame.graph || previous.graph, available: true, error: '' }));
          } else if (frame.type === 'error') {
            setLibraryGraph((previous) => ({
              ...previous,
              building: false,
              progress: null,
              phase: previous.graph ? 'ready' : 'error',
              error: typeof frame.message === 'string' && frame.message !== '' ? frame.message : t('graph.error'),
            }));
          }
        },
      });
      setLibraryGraph((previous) => ({ ...previous, building: false, progress: null }));
      if (sawGraph) toast(t('toast.graphBuilt'));
    } catch (error) {
      if (error && error.code === 'aborted') {
        setLibraryGraph((previous) => ({ ...previous, building: false, progress: null }));
        return;
      }
      const unavailable = Boolean(error && (error.code === 'ai-unavailable' || error.code === 'llm-unavailable' || error.code === 'ai-disabled'));
      setLibraryGraph((previous) => ({
        ...previous,
        building: false,
        progress: null,
        available: !unavailable,
        phase: previous.graph ? 'ready' : (unavailable ? 'unavailable' : 'error'),
        error: unavailable ? '' : mruErrorText(t, error),
      }));
      toast(mruErrorText(t, error), 'error');
    } finally {
      if (libraryGraphAbortRef.current === controller) libraryGraphAbortRef.current = null;
    }
  };

  // --- layout: resizable panels + reading width --------------------------
  layoutRef.current = layout;

  const mruLayoutTarget = (kind) => (kind === 'rail'
    ? { key: 'railWidth', limits: MRU_LAYOUT_LIMITS.rail }
    : { key: 'marginWidth', limits: MRU_LAYOUT_LIMITS.margin });

  const applyLayoutWidth = (kind, width, persist) => {
    const target = mruLayoutTarget(kind);
    const clamped = mruLayoutClamp(width, target.limits);
    if (clamped === null) return;
    setLayout((previous) => (previous[target.key] === clamped ? previous : { ...previous, [target.key]: clamped }));
    if (persist === true) {
      layoutRef.current = { ...(layoutRef.current || MRU_LAYOUT_DEFAULTS), [target.key]: clamped };
      mruLayoutWrite({ [target.key]: clamped });
    }
  };

  /** Persist the current widths (pointerup / keyboard / double-click reset). */
  const persistLayout = () => {
    const current = layoutRef.current || MRU_LAYOUT_DEFAULTS;
    mruLayoutWrite({ railWidth: current.railWidth, marginWidth: current.marginWidth });
  };

  const resetLayoutWidth = (kind) => {
    const target = mruLayoutTarget(kind);
    const fallback = MRU_LAYOUT_DEFAULTS[target.key];
    setLayout((previous) => (previous[target.key] === fallback ? previous : { ...previous, [target.key]: fallback }));
    layoutRef.current = { ...(layoutRef.current || MRU_LAYOUT_DEFAULTS), [target.key]: fallback };
    mruLayoutWrite({ [target.key]: fallback });
  };

  const setDocWidth = (width) => {
    const next = mruLayoutDocWidth(width);
    setLayout((previous) => (previous.docWidth === next ? previous : { ...previous, docWidth: next }));
    layoutRef.current = { ...(layoutRef.current || MRU_LAYOUT_DEFAULTS), docWidth: next };
    mruLayoutWrite({ docWidth: next });
  };

  const beginResize = () => setResizing(true);
  const endResize = () => {
    setResizing(false);
    persistLayout();
  };

  // --- preferences / settings -------------------------------------------
  const updatePrefs = async (patch) => {
    const previous = latestRef.current.prefs;
    const next = mruNormalizePrefs({ ...previous, ...patch });
    setPrefs(next);
    try {
      const value = await mruPost('settings.update', { preferences: next });
      if (value && value.preferences) setPrefs(mruNormalizePrefs(value.preferences));
    } catch (error) {
      setPrefs(previous);
      toast(mruErrorText(t, error), 'error');
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'showPageMarks')) {
      const state = latestRef.current;
      if (state.selectedId && state.reader && state.reader.phase === 'ready') {
        void loadReader(state.selectedId, state.detail && state.detail.document);
      }
    }
  };

  const setReadingMode = (mode) => {
    if (MRU_MODES.includes(mode)) void updatePrefs({ readingMode: mode });
  };

  /** Make translation output visible: original-only mode switches to bilingual. */
  const revealTranslations = () => {
    if (latestRef.current.prefs.readingMode === 'original') setReadingMode('bilingual');
  };

  /** Briefly mark a block's translation so a "翻译本段" click has a visible result. */
  const flashTranslation = (blockKey) => {
    if (!blockKey) return;
    setTranslationFlash(blockKey);
    if (translationFlashTimerRef.current) clearTimeout(translationFlashTimerRef.current);
    translationFlashTimerRef.current = setTimeout(() => setTranslationFlash(null), 1600);
  };

  React.useEffect(() => () => {
    if (translationFlashTimerRef.current) clearTimeout(translationFlashTimerRef.current);
  }, []);

  /**
   * The hover-tools 「翻译本段」 action: open a floating card with this
   * paragraph's translation. The card reads live translation/job state, so it
   * shows a spinner while the request runs and the result when it lands; an
   * already translated paragraph opens it without a new request. The reading
   * mode is never changed by this action.
   */
  const openBlockTranslation = (block, event) => {
    if (!block || typeof block.key !== 'string' || block.key === '') return;
    let rect = null;
    try {
      const target = event && event.currentTarget;
      if (target && typeof target.getBoundingClientRect === 'function') rect = target.getBoundingClientRect();
    } catch {
      rect = null;
    }
    setSelection(null);
    setSelCard(null);
    setNoteEditor(null);
    setBlockCard({
      blockKey: block.key,
      quote: String(block.plainText || '').slice(0, 1200),
      rect,
    });
    const entries = (translationsStoreRef.current && translationsStoreRef.current.entries) || {};
    const existing = entries[block.key];
    if (typeof existing !== 'string' || existing === '') {
      void translateBlock(block, { reveal: false, flashOnDone: false });
    }
  };
  const adjustScale = (direction) => {
    const current = Number(latestRef.current.prefs.readingScale) || 1;
    const index = MRU_SCALES.indexOf(current);
    const base = index === -1 ? 1 : index;
    const nextIndex = mruClamp(base + direction, 0, MRU_SCALES.length - 1);
    void updatePrefs({ readingScale: MRU_SCALES[nextIndex] });
  };

  const openSettings = () => {
    setSettingsData(null);
    setSettingsOpen(true);
  };

  /** Refresh the local capability snapshot (settings panel 「重新检测」). */
  const redetectLocal = async () => {
    try {
      const value = await mruPost('settings.get', {});
      setSettingsData(value || null);
      if (value && value.local) {
        setStatus((previous) => (previous ? { ...previous, local: value.local } : previous));
      }
    } catch {
      /* capability refresh is best-effort */
    }
  };

  const saveToken = async (token, done) => {
    setTokenBusy(true);
    try {
      await mruPost('settings.setToken', { token });
      setStatus((previous) => (previous ? { ...previous, tokenConfigured: true } : previous));
      toast(t('toast.saved'));
      if (typeof done === 'function') done();
    } catch (error) {
      toast(mruErrorText(t, error), 'error');
    } finally {
      setTokenBusy(false);
    }
  };

  const clearToken = async () => {
    setTokenBusy(true);
    try {
      await mruPost('settings.clearToken', {});
      setStatus((previous) => (previous ? { ...previous, tokenConfigured: false } : previous));
      toast(t('toast.saved'));
    } catch (error) {
      toast(mruErrorText(t, error), 'error');
    } finally {
      setTokenBusy(false);
    }
  };

  // --- menus / overlays --------------------------------------------------
  const openImportMenu = (element) => {
    setMenu({
      kind: 'topbar',
      rect: element && typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null,
    });
  };
  const openDocMenu = (element, doc) => {
    if (!doc) return;
    setMenu({
      kind: 'doc',
      docId: doc.id,
      rect: element && typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null,
    });
  };
  const openRunheadMenu = (element) => {
    if (!latestRef.current.selectedId) return;
    setMenu({
      kind: 'doc',
      docId: latestRef.current.selectedId,
      rect: element && typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null,
    });
  };

  const closeTopOverlay = () => {
    const state = latestRef.current;
    if (state.menu) { setMenu(null); return true; }
    if (state.noteEditor) { setNoteEditor(null); return true; }
    if (state.selCard) { setSelCard(null); return true; }
    if (state.blockCard) { setBlockCard(null); return true; }
    if (state.selection) { setSelection(null); return true; }
    if (state.reparseDoc) { setReparseDoc(null); return true; }
    if (state.importUrlOpen) { setImportUrlOpen(false); return true; }
    if (state.settingsOpen) { setSettingsOpen(false); return true; }
    if (state.confirmDelete) { setConfirmDelete(null); return true; }
    if (state.railOpen) { setRailOpen(false); return true; }
    if (state.marginOpen) { setMarginOpen(false); return true; }
    return false;
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      if (closeTopOverlay()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    const root = rootRef.current;
    const target = event.target;
    if (!root || !target || typeof target.nodeType !== 'number' || !root.contains(target)) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && String(event.key).toLowerCase() === 'f') {
      event.preventDefault();
      setRailOpen(true);
      window.setTimeout(() => {
        const input = searchRef.current;
        if (input && typeof input.focus === 'function') {
          input.focus();
          if (typeof input.select === 'function') input.select();
        }
      }, 0);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && String(event.key).toLowerCase() === 'j') {
      if (!latestRef.current.selectedId) return;
      event.preventDefault();
      apiRef.current.openAiPanel();
    }
  };

  const handlePointerDown = (event) => {
    const state = latestRef.current;
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (state.menu && !target.closest('.mru-menu-wrap') && !target.closest('[data-action="import"]')) {
      setMenu(null);
    }
    if (state.selection || state.selCard || state.noteEditor || state.blockCard) {
      const inside = target.closest('.mru-selbar') || target.closest('.mru-selcard') || target.closest('.mru-noteeditor');
      if (!inside) {
        setSelection(null);
        setSelCard(null);
        setNoteEditor(null);
        setBlockCard(null);
      }
    }
  };

  // --- latest-state mirrors (handlers read the committed render) ---------
  latestRef.current = {
    boot,
    status,
    docs,
    docsReady,
    prefs,
    search,
    selectedId,
    detail,
    reader,
    annotations,
    droppedAnnotations,
    staleAnnotations,
    translations,
    translationJobs,
    translationProviders,
    translateAll,
    activeAnnotationId,
    railOpen,
    marginOpen,
    marginTab,
    activeHeadingKey,
    selection,
    selCard,
    blockCard,
    noteEditor,
    menu,
    settingsOpen,
    settingsData,
    tokenBusy,
    importUrlOpen,
    importUrlBusy,
    importUrlError,
    confirmDelete,
    deleteBusy,
    reparseDoc,
    parseBusy,
    parseError,
    uploads,
    toasts,
    dropActive,
    katexReady,
    libraryView,
    docView,
    notesFilter,
    aiSelectionContext,
    aiParagraphContext,
    aiVisible,
    aiContextMuted,
    aiFocusSeq,
    docGraph,
    libraryGraph,
    flashBlock,
    layout,
    resizing,
  };

  apiRef.current = {
    applyStatus,
    applyList,
    refreshList,
    refreshStatus,
    importFiles,
    loadReader,
    selectDoc,
    handleKeyDown,
    handlePointerDown,
    closeTopOverlay,
    translateAllBlocks,
    cancelTranslateAll,
    captureReaderSelection,
    openAiPanel,
    askSelectionAi,
    changeLibraryView,
    changeDocView,
    changeMarginTab,
    jumpToBlock,
    loadDocGraph,
    loadLibraryGraph,
    buildDocGraph,
    rebuildLibraryGraph,
    reloadAnnotations,
  };

  // --- derived state -----------------------------------------------------
  const filteredDocs = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query === '') return docs;
    return docs.filter((doc) => String(doc.title || '').toLowerCase().includes(query)
      || String(doc.originalName || '').toLowerCase().includes(query));
  }, [docs, search]);

  const counts = React.useMemo(() => {
    const result = { total: docs.length, parsed: 0, parsing: 0, failed: 0 };
    for (const doc of docs) {
      if (doc.status === 'parsed') result.parsed += 1;
      else if (doc.status === 'parsing') result.parsing += 1;
      else if (doc.status === 'failed') result.failed += 1;
    }
    return result;
  }, [docs]);

  const selectedDoc = React.useMemo(() => {
    if (!selectedId) return null;
    if (detail && detail.document && detail.document.id === selectedId) return detail.document;
    return docs.find((doc) => doc.id === selectedId) || null;
  }, [selectedId, detail, docs]);

  const annotationsByBlock = React.useMemo(() => {
    try {
      return groupAnnotations(annotations);
    } catch {
      return new Map();
    }
  }, [annotations]);

  const needsKatex = React.useMemo(() => mruModelNeedsKatex(reader.model), [reader]);

  // --- effects -----------------------------------------------------------
  // Bootstrap: status + library list, tolerating a host that is not ready yet.
  React.useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    let timer = null;
    const run = async () => {
      try {
        const values = await Promise.all([mruPost('status', {}), mruPost('library.list', {})]);
        if (cancelled) return;
        setBoot('ready');
        apiRef.current.applyStatus(values[0]);
        apiRef.current.applyList(values[1]);
      } catch {
        if (cancelled) return;
        setBoot('error');
        attempts += 1;
        if (attempts < 8) timer = setTimeout(run, 4000);
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Poll the library while any document is parsing.
  React.useEffect(() => {
    if (boot !== 'ready') return undefined;
    if (!docs.some((doc) => doc.status === 'parsing')) return undefined;
    const timer = setInterval(() => {
      void apiRef.current.refreshList();
    }, 2500);
    return () => clearInterval(timer);
  }, [docs, boot]);

  // Refresh on focus / visibility regain.
  React.useEffect(() => {
    const refresh = () => {
      if (latestRef.current.boot !== 'ready') return;
      void apiRef.current.refreshStatus();
      void apiRef.current.refreshList();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // KaTeX: subscribe to readiness and load the runtime on first formula.
  React.useEffect(() => {
    const unsubscribe = MRU_KATEX.subscribe((next) => setKatexReady(next === 'ready'));
    if (needsKatex) MRU_KATEX.ensure();
    return unsubscribe;
  }, [needsKatex]);

  // Normalize persisted annotations against the freshly parsed model.
  React.useEffect(() => {
    const state = latestRef.current;
    const model = state.reader && state.reader.model;
    const detailValue = state.detail;
    if (!model || !detailValue || !detailValue.document) return;
    if (state.reader.docId !== detailValue.document.id) return;
    const blocksByKey = new Map();
    for (const block of model.blocks || []) {
      if (block && block.key) blocksByKey.set(block.key, block);
    }
    const normalized = [];
    const stale = [];
    let dropped = 0;
    for (const annotation of Array.isArray(detailValue.annotations) ? detailValue.annotations : []) {
      if (!annotation || typeof annotation !== 'object') {
        dropped += 1;
        continue;
      }
      const block = blocksByKey.get(annotation.blockKey);
      const orphan = annotation.stale === true || !block || !mruIsAnnotatableBlock(block)
        ? mruOrphanAnnotation(annotation)
        : null;
      if (orphan !== null) {
        stale.push(orphan);
        continue;
      }
      const result = normalizeAnnotation(annotation, block);
      if (result) normalized.push(result);
      else dropped += 1;
    }
    annotationsStoreRef.current = normalized;
    staleAnnotationsRef.current = stale;
    const baseIds = new Set();
    for (const annotation of normalized) if (annotation && typeof annotation.id === 'string') baseIds.add(annotation.id);
    for (const annotation of stale) if (annotation && typeof annotation.id === 'string') baseIds.add(annotation.id);
    annotationsBaseIdsRef.current = baseIds;
    setAnnotations(normalized);
    setStaleAnnotations(stale);
    setDroppedAnnotations(dropped);
  }, [reader.phase, reader.model, reader.docId, detail]);

  // Reader scroll: close selection overlays and track the active outline item.
  React.useEffect(() => {
    const element = scrollRef.current;
    if (!element) return undefined;
    let frame = null;
    const update = () => {
      frame = null;
      const state = latestRef.current;
      if (state.selection || state.selCard || state.blockCard) {
        setSelection(null);
        setSelCard(null);
        setBlockCard(null);
      }
      const model = state.reader && state.reader.model;
      const body = bodyRef.current;
      const container = scrollRef.current;
      if (!model || !body || !container) return;
      const selected = state.selectedId;
      if (selected) {
        const now = Date.now();
        if (now - navSavedAtRef.current > 250) {
          navSavedAtRef.current = now;
          mruWriteNavState({ documentId: selected, scrollTop: container.scrollTop });
        }
      }
      const threshold = container.getBoundingClientRect().top + 72;
      let active = null;
      for (const item of model.outline || []) {
        let itemElement = null;
        try {
          itemElement = body.querySelector(`[data-block-key="${String(item.key).replace(/"/g, '\\"')}"]`);
        } catch {
          itemElement = null;
        }
        if (!itemElement) continue;
        if (itemElement.getBoundingClientRect().top <= threshold) active = item.key;
        else break;
      }
      setActiveHeadingKey(active);
      // Track the paragraph under the reading line so the AI panel can offer
      // it as context. Throttled: queries during every scroll frame are costly.
      const now = Date.now();
      if (now - aiVisibleAtRef.current > 200) {
        aiVisibleAtRef.current = now;
        const visible = mruVisibleBlock(body, model, threshold);
        if (visible) {
          setAiVisible((previous) => (previous && previous.blockKey === visible.blockKey ? previous : visible));
          if (aiContextMutedRef.current) {
            aiContextMutedRef.current = false;
            setAiContextMuted(false);
          }
        }
      }
    };
    const onScroll = () => {
      if (frame === null) frame = window.requestAnimationFrame(update);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', onScroll);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [reader.phase]);

  // Re-open the paper the user was reading when they left the library panel.
  React.useEffect(() => {
    if (!docsReady) return;
    const restore = navRestoreRef.current;
    if (!restore) return;
    navRestoreRef.current = null;
    if (latestRef.current.selectedId) return;
    const doc = docs.find((item) => item && item.id === restore.documentId);
    if (!doc) return;
    pendingScrollRef.current = { documentId: doc.id, scrollTop: restore.scrollTop };
    pendingMarginTabRef.current = restore.marginTab;
    void selectDoc(doc.id);
  }, [docsReady, docs]);

  // Remember the open document so a remount restores it.
  React.useEffect(() => {
    if (selectedId) mruWriteNavState({ documentId: selectedId });
  }, [selectedId]);

  // Remember the margin tab (outline/notes) alongside the document.
  React.useEffect(() => {
    if (latestRef.current.selectedId) mruWriteNavState({ marginTab });
  }, [marginTab]);

  // Restore the saved scroll offset on the first render of a restored paper;
  // otherwise a fresh paper starts at the top.
  React.useEffect(() => {
    if (reader.phase !== 'ready' || !scrollRef.current) return;
    const pending = pendingScrollRef.current;
    if (pending && pending.documentId === selectedId) {
      pendingScrollRef.current = null;
      scrollRef.current.scrollTop = pending.scrollTop || 0;
      return;
    }
    scrollRef.current.scrollTop = 0;
  }, [reader.phase, selectedId]);

  // Global keyboard + pointer listeners (Escape, search focus, overlay dismiss).
  React.useEffect(() => {
    const onKeyDown = (event) => apiRef.current.handleKeyDown(event);
    const onKeyUp = (event) => {
      const key = event && event.key ? event.key : '';
      const isSelectionKey = key === 'Shift' || key.indexOf('Arrow') === 0
        || key === 'Home' || key === 'End' || key === 'PageUp' || key === 'PageDown';
      if (!isSelectionKey) return;
      window.setTimeout(() => {
        if (mountedRef.current) apiRef.current.captureReaderSelection('keyboard');
      }, 0);
    };
    const onPointerDown = (event) => apiRef.current.handlePointerDown(event);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);

  // Drag & drop import anywhere on the reading desk.
  React.useEffect(() => {
    const element = rootRef.current;
    if (!element) return undefined;
    let depth = 0;
    const hasFiles = (event) => {
      const transfer = event.dataTransfer;
      if (!transfer || !transfer.types) return false;
      for (const type of transfer.types) {
        if (type === 'Files') return true;
      }
      return false;
    };
    const onDragEnter = (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setDropActive(true);
    };
    const onDragOver = (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDropActive(false);
    };
    const onDrop = (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDropActive(false);
      const files = event.dataTransfer ? event.dataTransfer.files : null;
      void apiRef.current.importFiles(files);
    };
    element.addEventListener('dragenter', onDragEnter);
    element.addEventListener('dragover', onDragOver);
    element.addEventListener('dragleave', onDragLeave);
    element.addEventListener('drop', onDrop);
    return () => {
      element.removeEventListener('dragenter', onDragEnter);
      element.removeEventListener('dragover', onDragOver);
      element.removeEventListener('dragleave', onDragLeave);
      element.removeEventListener('drop', onDrop);
    };
  }, []);

  // Load the settings detail when the modal opens.
  React.useEffect(() => {
    if (!settingsOpen) return undefined;
    let cancelled = false;
    mruPost('settings.get', {})
      .then((value) => {
        if (cancelled) return;
        setSettingsData(value || null);
        if (value && value.preferences) setPrefs(mruNormalizePrefs(value.preferences));
        if (value && value.local) {
          setStatus((previous) => (previous ? { ...previous, local: value.local } : previous));
        }
      })
      .catch(() => {
        if (!cancelled) setSettingsData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [settingsOpen]);

  // Unmount cleanup: stop timers, abort translation, flush pending saves.
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (readerTimerRef.current) clearTimeout(readerTimerRef.current);
      if (activeTimerRef.current) clearTimeout(activeTimerRef.current);
      for (const timer of toastTimersRef.current.values()) clearTimeout(timer);
      toastTimersRef.current.clear();
      if (translateAllAbortRef.current) translateAllAbortRef.current.abort();
      if (annTimerRef.current) {
        clearTimeout(annTimerRef.current);
        annTimerRef.current = null;
      }
      if (transTimerRef.current) {
        clearTimeout(transTimerRef.current);
        transTimerRef.current = null;
      }
      const pendingAnnotations = annPendingRef.current;
      annPendingRef.current = null;
      if (pendingAnnotations && pendingAnnotations.id) {
        void mruPost('annotations.save', {
          id: pendingAnnotations.id,
          annotations: pendingAnnotations.list,
          baseIds: annotationBaseIds(),
        }).catch(() => {});
      }
      const pendingTranslations = transPendingRef.current;
      transPendingRef.current = null;
      if (pendingTranslations && pendingTranslations.id) {
        void mruPost('translations.save', {
          id: pendingTranslations.id,
          targetLanguage: pendingTranslations.targetLanguage,
          entries: pendingTranslations.entries,
        }).catch(() => {});
      }
    };
  }, []);

  // Seed the AI context chip with the paragraph at the reading line.
  React.useEffect(() => {
    if (reader.phase !== 'ready' || !reader.model) return undefined;
    const timer = window.setTimeout(() => {
      const body = bodyRef.current;
      const container = scrollRef.current;
      if (!mountedRef.current || !body || !container) return;
      const threshold = container.getBoundingClientRect().top + 72;
      const visible = mruVisibleBlock(body, reader.model, threshold);
      if (visible) {
        setAiVisible(visible);
        if (aiContextMutedRef.current) {
          aiContextMutedRef.current = false;
          setAiContextMuted(false);
        }
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [reader.phase, reader.model, selectedId]);

  // Lazy-load the document graph when its view is open (also retries once the
  // AI engine becomes available after a host reload).
  React.useEffect(() => {
    if (docView !== 'graph' || !selectedId) return;
    if (!mruAiState(latestRef.current.status).graph) return;
    if (docGraph.docId !== selectedId || docGraph.phase === 'idle' || docGraph.phase === 'unavailable') {
      void loadDocGraph(selectedId);
    }
  }, [docView, selectedId, docGraph.docId, docGraph.phase]);

  // Lazy-load the library graph when its view is open.
  React.useEffect(() => {
    if (libraryView !== 'graph') return;
    if (!mruAiState(latestRef.current.status).graph) return;
    if (libraryGraph.phase === 'idle' || libraryGraph.phase === 'unavailable') void loadLibraryGraph();
  }, [libraryView, libraryGraph.phase]);

  // A citation / graph-node jump may arrive while the paper is still loading
  // or while the graph view is open: replay it once the reader is ready.
  React.useEffect(() => {
    if (reader.phase !== 'ready' || docView !== 'read' || !selectedId) return undefined;
    const pending = pendingJumpRef.current;
    if (!pending || pending.documentId !== selectedId) return undefined;
    pendingJumpRef.current = null;
    const timer = window.setTimeout(() => {
      if (mountedRef.current) jumpToBlock(pending.blockKey);
    }, 80);
    return () => clearTimeout(timer);
  }, [reader.phase, docView, selectedId]);

  // Unmount cleanup for graph streams and the citation flash timer.
  React.useEffect(() => () => {
    if (docGraphAbortRef.current) docGraphAbortRef.current.abort();
    if (libraryGraphAbortRef.current) libraryGraphAbortRef.current.abort();
    if (flashBlockTimerRef.current) clearTimeout(flashBlockTimerRef.current);
  }, []);

  // --- popup content -----------------------------------------------------
  let menuItems = [];
  if (menu && menu.kind === 'topbar') {
    menuItems = [
      { label: t('topbar.upload'), onSelect: () => { setMenu(null); chooseFile(); } },
      {
        label: t('topbar.fromUrl'),
        onSelect: () => {
          setMenu(null);
          setImportUrlError('');
          setImportUrlOpen(true);
        },
      },
    ];
  } else if (menu && menu.kind === 'doc') {
    const doc = docs.find((item) => item.id === menu.docId) || null;
    if (doc) {
      menuItems = [{
        label: t('menu.reparse'),
        onSelect: () => {
          setMenu(null);
          setParseError('');
          setReparseOnlyProblemsDefault(false);
          setReparseDoc(doc);
        },
      }];
      if (doc.status === 'parsed') {
        if (doc.id === selectedId && reader.phase === 'ready') {
          menuItems.push({
            label: t('menu.translateAll'),
            onSelect: () => {
              setMenu(null);
              void translateAllBlocks();
            },
          });
        }
        menuItems.push({
          label: t('menu.export'),
          onSelect: () => {
            setMenu(null);
            void exportDocument(doc);
          },
        });
      }
      menuItems.push({ separator: true });
      menuItems.push({
        label: t('menu.delete'),
        danger: true,
        onSelect: () => {
          setMenu(null);
          setConfirmDelete({ id: doc.id, title: doc.title || doc.originalName || '' });
        },
      });
    }
  }

  // --- AI / graph props --------------------------------------------------
  const aiState = mruAiState(status);
  const contextBlock = aiParagraphContext
    || (!aiContextMuted ? aiVisible : null);
  const aiPanelProps = selectedDoc ? {
    t,
    documentId: selectedDoc.id,
    documentTitle: selectedDoc.title || selectedDoc.originalName || '',
    modelLabel: mruAiModelLabel(status),
    available: aiState.available,
    katexReady,
    context: {
      visibleBlockKey: contextBlock ? contextBlock.blockKey : null,
      visibleText: contextBlock ? (contextBlock.text || contextBlock.quote || '') : '',
      selection: aiSelectionContext
        ? { blockKey: aiSelectionContext.blockKey, quote: aiSelectionContext.quote }
        : null,
    },
    selection: aiSelectionContext
      ? { blockKey: aiSelectionContext.blockKey, quote: aiSelectionContext.quote }
      : null,
    onJump: (blockKey) => jumpToBlock(blockKey),
    onAnnotationsChanged: () => { void reloadAnnotations(selectedDoc.id); },
    onGraphDelta: () => handleGraphDelta(),
    onOpenGraph: () => {
      if (latestRef.current.libraryView === 'graph') {
        setLibraryView('library');
        void updatePrefs({ libraryView: 'library' });
      }
      changeDocView('graph');
    },
    post: mruPost,
    streamChat: (request, handlers) => mruStreamNdjson('chat', request, {
      onFrame: handlers && handlers.onFrame,
      signal: handlers && handlers.signal,
    }),
    onNotify: (text, kind) => toast(text, kind),
    onExportConversation: (markdown, filename) => mruDownloadText(filename, markdown),
    onClearContext: (kind) => clearAiContext(kind),
    focusSeq: aiFocusSeq,
    onOpenSettings: openSettings,
  } : null;
  const docGraphViewProps = {
    graph: docGraph.graph,
    loading: docGraph.phase === 'loading',
    building: Boolean(docGraph.building),
    progress: docGraph.progress,
    error: docGraph.error || '',
    available: aiState.graph && docGraph.available !== false,
    onJump: graphJump,
    onAsk: askGraphNode,
    onBuild: () => {
      const id = latestRef.current.selectedId;
      if (id) void buildDocGraph(id);
    },
    onRefresh: () => {
      const id = latestRef.current.selectedId;
      if (id) void loadDocGraph(id);
    },
    // Graph curation (rename / merge / pin): patch = { nodes?, edges?, merge? }.
    // Keeps the legacy (nodes, edges) call shape working; resolves the updated KG.
    onUpdateGraph: (patch, legacyEdges) => {
      const id = latestRef.current.selectedId;
      if (!id) return Promise.resolve(null);
      const source = Array.isArray(patch)
        ? { nodes: patch, edges: legacyEdges }
        : (patch && typeof patch === 'object' ? patch : {});
      const payload = { documentId: id };
      if (Array.isArray(source.nodes)) payload.nodes = source.nodes;
      if (Array.isArray(source.edges)) payload.edges = source.edges;
      if (Array.isArray(source.merge)) payload.merge = source.merge;
      return mruPost('graph.update', payload)
        .then((value) => {
          const graph = value && value.graph ? value.graph : null;
          if (graph) {
            setDocGraph((previous) => ({ ...previous, graph, phase: 'ready', available: true, error: '' }));
          }
          return graph;
        })
        .catch((error) => {
          toast(mruErrorText(t, error), 'error');
          throw error;
        });
    },
  };
  const libraryGraphViewProps = {
    graph: libraryGraph.graph,
    loading: libraryGraph.phase === 'loading',
    building: Boolean(libraryGraph.building),
    progress: libraryGraph.progress,
    error: libraryGraph.error || '',
    available: aiState.graph && libraryGraph.available !== false,
    onJump: graphJump,
    onAsk: askGraphNode,
    onBuild: () => { void rebuildLibraryGraph(); },
    onRefresh: () => { void loadLibraryGraph(); },
  };

  const paperProps = {
    t,
    mode: prefs.readingMode,
    katexReady,
    annotationsByBlock,
    translations,
    jobs: translationJobs,
    providers: translationProviders,
    translationFlash,
    activeAnnotationId,
    translateAll,
    bodyRef,
    onReaderMouseUp,
    onReaderKeyUp,
    onModeChange: setReadingMode,
    onScaleDown: () => adjustScale(-1),
    onScaleUp: () => adjustScale(1),
    onMoreMenu: openRunheadMenu,
    onTranslateBlock: openBlockTranslation,
    onAnnotateBlock: blockAnnotate,
    onRetryTranslation: (block) => { void translateBlock(block, { force: true, reveal: true }); },
    onMarkClick: openAnnotationEditor,
    onCancelTranslateAll: cancelTranslateAll,
    docView,
    onDocViewChange: changeDocView,
    graphView: docGraphViewProps,
    flashBlock,
    onAskBlock: askBlockAi,
    docWidth: layout.docWidth,
    onDocWidthChange: setDocWidth,
  };

  const rootClassName = 'mru-root'
    + (railOpen ? ' mru-root--rail-open' : '')
    + (marginOpen ? ' mru-root--margin-open' : '')
    + (dropActive ? ' mru-root--dragging' : '')
    + (resizing ? ' mru-root--resizing' : '');
  const dataStatus = boot === 'loading' ? 'idle' : boot === 'error' ? 'error' : 'ready';
  const rootStyle = {
    '--mru-read-scale': String(prefs.readingScale || 1),
    '--mru-doc-width': `${mruLayoutDocWidth(layout.docWidth)}px`,
    '--mru-measure': `${mruLayoutMeasure(layout.docWidth)}px`,
  };
  const showMargin = Boolean(selectedDoc) && libraryView !== 'graph';
  const workspaceStyle = {
    '--mru-rail-width': `${layout.railWidth}px`,
    '--mru-margin-width': `${layout.marginWidth}px`,
  };

  // --- render ------------------------------------------------------------
  return h('div', {
    ref: rootRef,
    className: rootClassName,
    'data-status': dataStatus,
    style: rootStyle,
  },
    h('style', null, CSS),
    h(MruTopbar, {
      t,
      counts,
      menuOpen: Boolean(menu && menu.kind === 'topbar'),
      onImportMenu: openImportMenu,
      onToggleRail: () => setRailOpen((value) => !value),
      onToggleMargin: () => setMarginOpen((value) => !value),
      onOpenSettings: openSettings,
      railOpen,
      marginOpen,
      libraryView,
      onLibraryView: changeLibraryView,
    }),
    boot === 'error'
      ? h('div', { className: 'mru-banner mru-banner--warn', role: 'status' }, t('err.hostUnavailable'))
      : null,
    h('div', { className: 'mru-workspace', style: workspaceStyle },
      h(MruRail, {
        t,
        docs: filteredDocs,
        docsReady,
        hasDocs: docs.length > 0,
        search,
        onSearch: setSearch,
        onClearSearch: () => setSearch(''),
        selectedId,
        onSelectDoc: (id) => {
          if (latestRef.current.libraryView === 'graph') {
            setLibraryView('library');
            void updatePrefs({ libraryView: 'library' });
          }
          void selectDoc(id);
        },
        onDocMenu: openDocMenu,
        uploads,
        counts,
        searchRef,
      }),
      h(MruResizer, {
        t,
        kind: 'rail',
        value: layout.railWidth,
        active: resizing,
        onChange: (width, persist) => applyLayoutWidth('rail', width, persist),
        onReset: () => resetLayoutWidth('rail'),
        onDragStart: beginResize,
        onDragEnd: endResize,
      }),
      h(MruMain, {
        t,
        boot,
        docsReady,
        docsCount: docs.length,
        selectedId,
        selectedDoc,
        reader,
        prefs,
        parseBusy,
        parseError,
        local: status ? status.local : null,
        tokenConfigured: Boolean(status && status.tokenConfigured),
        scrollRef,
        paperProps,
        libraryView,
        libraryGraphProps: libraryGraphViewProps,
        onChooseFile: chooseFile,
        onImportUrl: () => {
          setImportUrlError('');
          setImportUrlOpen(true);
        },
        onSetupSubmit: (options) => { void startParse(selectedId, options); },
        onOpenSettings: openSettings,
        onCancelParse: () => { void cancelParse(selectedId); },
        onRetryParse: () => { void startParse(selectedId, mruDefaultParseOptions(prefs)); },
        onOtherEngine: () => {
          // Rotate the available engines: local → agent → standard → local.
          const currentEngine = selectedDoc && selectedDoc.parse ? selectedDoc.parse.engine : undefined;
          const localOk = mruLocalSupport(status ? status.local : null, selectedDoc && selectedDoc.ext).ok;
          const engine = currentEngine === 'local'
            ? 'agent'
            : currentEngine === 'agent'
              ? 'standard'
              : localOk ? 'local' : 'agent';
          void startParse(selectedId, { ...mruDefaultParseOptions(prefs), engine });
        },
        onReloadReader: reloadReader,
        onOpenDoc: (id) => { void selectDoc(id); },
        onReparse: (onlyProblems) => {
          const doc = selectedDoc;
          if (!doc) return;
          setParseError('');
          setReparseOnlyProblemsDefault(onlyProblems === true);
          setReparseDoc(doc);
        },
      }),
      showMargin ? h(MruResizer, {
        t,
        kind: 'margin',
        value: layout.marginWidth,
        active: resizing,
        onChange: (width, persist) => applyLayoutWidth('margin', width, persist),
        onReset: () => resetLayoutWidth('margin'),
        onDragStart: beginResize,
        onDragEnd: endResize,
      }) : null,
      showMargin ? h(MruMargin, {
        t,
        tab: marginTab,
        onTabChange: changeMarginTab,
        aiPanelProps,
        model: reader.model || null,
        docTitle: selectedDoc.title || selectedDoc.originalName || '',
        annotations,
        staleAnnotations,
        droppedCount: droppedAnnotations,
        notesFilter,
        onNotesFilterChange: changeNotesFilter,
        activeAnnotationId,
        activeHeadingKey,
        onOutlineClick: (item) => {
          const body = bodyRef.current;
          if (!body) return;
          let element = null;
          try {
            element = body.querySelector(`[data-block-key="${String(item.key).replace(/"/g, '\\"')}"]`);
          } catch {
            element = null;
          }
          if (element) mruScrollToElement(element, 'start');
          setActiveHeadingKey(item.key);
        },
        onNoteClick: (annotation) => scrollToAnnotation(annotation.id),
        onNoteDelete: (annotation) => deleteAnnotation(annotation.id),
      }) : null),
    h(MruStatusbar, {
      t,
      doc: selectedDoc,
      reader,
      translations,
      counts,
      version: status ? status.version : '',
      boot,
    }),
    railOpen
      ? h('div', { className: 'mru-scrim', 'aria-hidden': 'true', onClick: () => setRailOpen(false) })
      : null,
    dropActive ? h(MruDrop, { t }) : null,
    h(MruToasts, { t, toasts, onClose: dismissToast }),
    h('input', {
      type: 'file',
      multiple: true,
      accept: MRU_ACCEPT,
      hidden: true,
      ref: fileInputRef,
      onChange: onFileInputChange,
    }),
    menu ? h(MruMenu, { items: menuItems, rect: menu.rect }) : null,
    selection ? h(MruSelbar, {
      t,
      selection,
      onTranslate: selectionTranslate,
      onHighlight: selectionHighlight,
      onNote: selectionNote,
      onCopy: () => { void selectionCopy(); },
      onRemoveHighlight: removeHighlights,
      onAskAi: askSelectionAi,
    }) : null,
    selCard ? h(MruSelcard, {
      t,
      card: selCard,
      onClose: () => setSelCard(null),
      onRetry: () => { void requestSelectionTranslation(selCard); },
      onCopy: () => { void selCardCopy(); },
      katexReady,
    }) : null,
    blockCard ? h(MruBlockCard, {
      t,
      card: blockCard,
      translation: mruTranslationText(translations, blockCard.blockKey),
      job: translationJobs[blockCard.blockKey] || null,
      provider: translationProviders[blockCard.blockKey] || null,
      katexReady,
      onClose: () => setBlockCard(null),
      onRetry: () => {
        const state = latestRef.current;
        const model = state.reader && state.reader.model;
        const block = model && Array.isArray(model.blocks)
          ? model.blocks.find((item) => item && item.key === blockCard.blockKey)
          : null;
        if (block) void translateBlock(block, { reveal: false, force: true });
      },
      onCopy: () => {
        const current = mruTranslationText(translations, blockCard.blockKey);
        if (typeof current !== 'string' || current === '') return;
        void mruCopy(current)
          .then(() => toast(t('toast.copied')))
          .catch(() => toast(t('toast.copyFailed'), 'error'));
      },
    }) : null,
    noteEditor ? h(MruNoteEditor, {
      t,
      editor: noteEditor,
      onNoteChange: (note) => setNoteEditor((previous) => (previous ? { ...previous, note } : previous)),
      onColorChange: (color) => setNoteEditor((previous) => (previous ? { ...previous, color } : previous)),
      onCancel: () => setNoteEditor(null),
      onSave: noteEditorSave,
      onDelete: () => {
        const editor = latestRef.current.noteEditor;
        if (!editor || !editor.annotationId) return;
        setNoteEditor(null);
        deleteAnnotation(editor.annotationId);
      },
    }) : null,
    settingsOpen ? h(MruSettingsModal, {
      t,
      status,
      settings: settingsData,
      prefs,
      onClose: () => setSettingsOpen(false),
      onSaveToken: saveToken,
      onClearToken: clearToken,
      onUpdatePrefs: (patch) => { void updatePrefs(patch); },
      onRedetect: redetectLocal,
      tokenBusy,
    }) : null,
    importUrlOpen ? h(MruImportUrlModal, {
      t,
      busy: importUrlBusy,
      errorMessage: importUrlError,
      onClose: () => setImportUrlOpen(false),
      onImport: (url) => { void importFromUrl(url); },
    }) : null,
    confirmDelete ? h(MruConfirmDeleteModal, {
      t,
      title: confirmDelete.title,
      busy: deleteBusy,
      onCancel: () => setConfirmDelete(null),
      onConfirm: () => { void confirmDeleteDocument(); },
    }) : null,
    reparseDoc ? h(MruReparseModal, {
      t,
      prefs,
      doc: reparseDoc,
      local: status ? status.local : null,
      tokenConfigured: Boolean(status && status.tokenConfigured),
      problemPages: mruProblemPages(reader.contentList),
      defaultOnlyProblems: reparseOnlyProblemsDefault,
      busy: parseBusy,
      errorMessage: parseError,
      onStart: (options) => { void startParse(reparseDoc.id, options); },
      onOpenSettings: () => {
        setReparseDoc(null);
        openSettings();
      },
      onClose: () => setReparseDoc(null),
    }) : null);
}

// ===========================================================================
// 13. Diagnostics, error boundary, plugin registration
// ===========================================================================

/** Panel icon for the sidebar list; reports one "icon-rendered" diagnostic. */
function MineruPanelIcon(props) {
  const edge = Number(props && props.size) || 18;
  const active = Boolean(props && props.active);
  React.useEffect(() => {
    mruPing('icon-rendered');
  }, []);
  const markup = React.useMemo(() => mruIconMarkup(PANEL_ICON, edge), [edge]);
  return h('span', {
    className: 'mru-host-icon',
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: edge,
      height: edge,
      color: 'currentColor',
      opacity: active ? 1 : 0.82,
    },
    'aria-hidden': 'true',
    dangerouslySetInnerHTML: { __html: markup },
  });
}

/** Catches render crashes and reports them through health.ping. */
class MruErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    let detail = null;
    try {
      detail = {
        message: String(error && error.message ? error.message : error),
        stack: String(info && info.componentStack ? info.componentStack : '').slice(0, 4000),
      };
    } catch {
      detail = null;
    }
    mruPing('panel-error', detail);
  }

  render() {
    if (this.state.error) {
      const t = typeof this.props.t === 'function' ? this.props.t : mruTranslate;
      return h('div', { className: 'mru-root', 'data-status': 'error' },
        h('style', null, CSS),
        h('div', { className: 'mru-empty' },
          h('h1', { className: 'mru-empty__title' }, t('err.crashed'))));
    }
    return this.props.children;
  }
}

/** Registered `main` panel: the reading desk behind an error boundary. */
function MineruRoot(props) {
  return h(MruErrorBoundary, { t: props.t }, h(MineruApp, props));
}

/**
 * Client plugin body. Called from the generated bundle factory.
 * @param {(id: string) => any} require - module table accessor.
 * @returns {{inject: string[], apply: (ctx: any) => void}}
 */
export function clientMain(require) {
  return {
    inject: ['slots', 'locale', 'layout'],
    apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-litnotes: dictionaries');
      const t = ctx.locale.bind(NS);
      ctx.effect(() => () => MRU_KATEX.dispose(), 'dsh-litnotes: katex assets');
      mruPing('active');
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 35,
        locale: NS,
        label: () => t('panel.label'),
      }, MineruPanelIcon)), 'dsh-litnotes: sidebar entry');
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
      }, MineruRoot)), 'dsh-litnotes: main panel');
    },
  };
}
