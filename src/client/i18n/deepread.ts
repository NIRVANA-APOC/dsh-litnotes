/**
 * AI 精读 (deep read) copy — owned by the `client-panel` workstream.
 *
 * Every string the close-reading panel and store render lives here in both
 * languages; the merged dictionary in `./index.ts` stays key-complete at
 * compile time (`en` is typed as `Record<keyof typeof zh, string>`, so a key
 * added to one language but not the other is a type error).
 *
 * Scope: the idle invitation, the running phase checklist, the report section
 * titles and evidence/confidence vocabulary, the annotation cards, the error
 * vocabulary and the Markdown export framing. Paper quotes stay verbatim in the
 * paper language; only the reading notes and report copy are localized.
 */

export const zh = {
  /* Idle invitation (no report for this paper yet). */
  'deepread.title': 'AI 精读',
  'deepread.promise': '让 AI 通读全文、逐节精读，生成可跳转的精读报告与高质量批注。',
  'deepread.cost': '约 20–30 次模型调用 · 2–4 分钟 · 会消耗 token',
  'deepread.idleHint': '逐节阅读正文并写入批注；可随时停止，只有跑完的运行才会写入原文。',
  'deepread.start': '开始精读',

  /* Running: phase checklist + progress. */
  'deepread.running': '正在精读',
  'deepread.stop': '停止精读',
  'deepread.stopHint': '停止后本次不会写入任何批注。',
  'deepread.progressLabel': '精读进度',
  'deepread.phaseCount': '{done}/{total}',
  'deepread.sectionCurrent': '当前：{section}',
  'deepread.phase.mapping': '建立阅读地图',
  'deepread.phase.reading': '逐节精读',
  'deepread.phase.gaps': '补读薄弱章节',
  'deepread.phase.judging': '批注校订',
  'deepread.phase.synthesizing': '撰写报告',
  'deepread.phase.annotating': '写入原文',

  /* Record loading. */
  'deepread.loading': '正在载入精读记录…',
  'deepread.loadFailed': '精读记录载入失败。',

  /* Done: report header and measured stats. */
  'deepread.reportTitle': '精读报告',
  'deepread.model': '模型 {model}',
  'deepread.modelUnknown': '模型未知',
  'deepread.generatedAt': '生成于 {time}',
  'deepread.truncated': '原文超出精读长度上限，尾部分章节只读了提纲。',
  'deepread.stats.sections': '通读 {count} 节',
  'deepread.stats.annotations': '生成 {count} 条批注',
  'deepread.stats.coverage': '覆盖率 {percent}%',

  /* Report section titles (rendered in this order, empty sections omitted). */
  'deepread.section.tldr': '一句话结论',
  'deepread.section.problem': '研究问题',
  'deepread.section.gap': '研究空白',
  'deepread.section.contributions': '核心贡献',
  'deepread.section.method': '方法',
  'deepread.section.evaluation': '实验与证据',
  'deepread.section.findings': '主要发现',
  'deepread.section.limitations': '局限与风险',
  'deepread.section.openQuestions': '开放问题',
  'deepread.section.argumentMap': '论证地图',
  'deepread.section.glossary': '术语',
  'deepread.section.readingPath': '阅读路径',
  'deepread.section.verdict': '总体评价',

  /* Evidence strength (contributions) and verdict confidence. */
  'deepread.evidence.strong': '强',
  'deepread.evidence.partial': '部分',
  'deepread.evidence.thin': '弱',
  'deepread.confidence.high': '高',
  'deepread.confidence.medium': '中',
  'deepread.confidence.low': '低',
  'deepread.verdict.confidence': '信心 {level}',
  'deepread.verdict.strengths': '优点',
  'deepread.verdict.weaknesses': '不足',

  /* Evidence links: every report point jumps to its source block. */
  'deepread.jump.page': '原文 p.{page}',
  'deepread.jump.nopage': '原文',
  'deepread.jump.card': '跳到原文',

  /* Collapsible annotation cards of this run. */
  'deepread.annotations': '本次批注',
  'deepread.annotations.persisted': '已写入原文 {written}/{total}',

  /* Report actions. */
  'deepread.rerun': '重新精读',
  'deepread.copy': '复制报告',
  'deepread.copied': '报告已复制',
  'deepread.copyFailed': '复制失败',
  'deepread.copyEmpty': '报告为空，暂时无法复制。',

  /* Error state and retry. */
  'deepread.error.title': '精读没有完成',
  'deepread.error.llmUnavailable': '模型不可用，检查 DSH 的默认模型配置。',
  'deepread.error.llmFailed': '模型调用失败，重试一次。',
  'deepread.error.badRequest': '这篇论文没有可精读的正文，先重新解析。',
  'deepread.error.aborted': '精读被中断。',
  'deepread.error.hostError': '主机处理精读时出错，重试一次。',
  'deepread.error.network': '网络请求失败，重试一次。',
  'deepread.error.generic': '这次精读没有完成。',
  'deepread.error.previous': '上一次的精读报告仍可查看。',
  'deepread.retry': '重试',
  'deepread.dismiss': '关闭',

  /* Toast after a successful run. */
  'deepread.toast.done': '精读完成：生成 {count} 条批注',

  /* Markdown export reuses the reader-facing keys above. */
} as const

export const en: Record<keyof typeof zh, string> = {
  'deepread.title': 'AI deep read',
  'deepread.promise':
    'Reads the whole paper section by section and produces a jumpable close-reading report with high-quality annotations.',
  'deepread.cost': 'About 20–30 model calls · 2–4 minutes · uses tokens',
  'deepread.idleHint':
    'Reads every section to annotate the page; stop anytime — only a finished run writes annotations.',
  'deepread.start': 'Start deep read',

  'deepread.running': 'Reading the paper',
  'deepread.stop': 'Stop',
  'deepread.stopHint': 'Stopping writes nothing from this run.',
  'deepread.progressLabel': 'Deep-read progress',
  'deepread.phaseCount': '{done}/{total}',
  'deepread.sectionCurrent': 'Now: {section}',
  'deepread.phase.mapping': 'Map the paper',
  'deepread.phase.reading': 'Read section by section',
  'deepread.phase.gaps': 'Re-read thin sections',
  'deepread.phase.judging': 'Review annotations',
  'deepread.phase.synthesizing': 'Write the report',
  'deepread.phase.annotating': 'Mark the paper',

  'deepread.loading': 'Loading the deep-read record…',
  'deepread.loadFailed': 'Could not load the deep-read record.',

  'deepread.reportTitle': 'Close-reading report',
  'deepread.model': 'Model {model}',
  'deepread.modelUnknown': 'Model unknown',
  'deepread.generatedAt': 'Generated {time}',
  'deepread.truncated': 'The paper exceeded the deep-read source limit; tail sections were read from the outline only.',
  'deepread.stats.sections': '{count} sections read',
  'deepread.stats.annotations': '{count} annotations',
  'deepread.stats.coverage': '{percent}% coverage',

  'deepread.section.tldr': 'Bottom line',
  'deepread.section.problem': 'Research problem',
  'deepread.section.gap': 'Research gap',
  'deepread.section.contributions': 'Core contributions',
  'deepread.section.method': 'Method',
  'deepread.section.evaluation': 'Evaluation & evidence',
  'deepread.section.findings': 'Key findings',
  'deepread.section.limitations': 'Limitations & risks',
  'deepread.section.openQuestions': 'Open questions',
  'deepread.section.argumentMap': 'Argument map',
  'deepread.section.glossary': 'Glossary',
  'deepread.section.readingPath': 'Reading path',
  'deepread.section.verdict': 'Overall verdict',

  'deepread.evidence.strong': 'Strong',
  'deepread.evidence.partial': 'Partial',
  'deepread.evidence.thin': 'Thin',
  'deepread.confidence.high': 'High',
  'deepread.confidence.medium': 'Medium',
  'deepread.confidence.low': 'Low',
  'deepread.verdict.confidence': 'Confidence: {level}',
  'deepread.verdict.strengths': 'Strengths',
  'deepread.verdict.weaknesses': 'Weaknesses',

  'deepread.jump.page': 'p.{page}',
  'deepread.jump.nopage': 'Source',
  'deepread.jump.card': 'Jump to source',

  'deepread.annotations': 'Annotations from this run',
  'deepread.annotations.persisted': 'Saved to the paper: {written}/{total}',

  'deepread.rerun': 'Read again',
  'deepread.copy': 'Copy report',
  'deepread.copied': 'Report copied',
  'deepread.copyFailed': 'Could not copy the report',
  'deepread.copyEmpty': 'The report is empty and cannot be copied.',

  'deepread.error.title': 'Deep read did not finish',
  'deepread.error.llmUnavailable': 'The model is unavailable. Check the default model in DSH.',
  'deepread.error.llmFailed': 'The model call failed. Try again.',
  'deepread.error.badRequest': 'This paper has no readable body. Parse it again first.',
  'deepread.error.aborted': 'The deep read was interrupted.',
  'deepread.error.hostError': 'The host failed while running the deep read. Try again.',
  'deepread.error.network': 'The request failed. Try again.',
  'deepread.error.generic': 'This deep read did not finish.',
  'deepread.error.previous': 'The previous report is still shown below.',
  'deepread.retry': 'Retry',
  'deepread.dismiss': 'Dismiss',

  'deepread.toast.done': 'Deep read finished: {count} annotations added',

}

/** Locale keys owned by the deep-read panel and store. */
export type DeepReadLocaleKey = keyof typeof zh
