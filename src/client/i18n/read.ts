/**
 * Reader copy — owned by the reader UI workstream. Add keys in both languages.
 *
 * Naming follows DESIGN-V2 §9: `read.*` for the sheet and its controls,
 * `margin.*` for the note margin, `sel.*`/`selcard.*` for selection overlays,
 * `note.*` for the note editor. The reader never hard-codes copy.
 */

/** Typed key space of the reader dictionary (used by the reader store notices). */
export type ReadCopyKey = keyof typeof zh

export const zh = {
  /* Reading controls (context bar) */
  'read.mode.original': '原文',
  'read.mode.bilingual': '对照',
  'read.mode.translated': '译文',
  'read.controls.mode': '阅读模式',
  'read.controls.pageMarks': '页标记',
  'read.controls.outline': '大纲',
  'read.controls.scaleDown': '缩小字号',
  'read.controls.scaleUp': '放大字号',
  'read.controls.translateAll': '翻译全文',

  /* Sheet states */
  'read.loading': '正在载入解析稿…',
  'read.loadFailed': '解析稿没能载入。',
  'read.emptyDoc': '这篇解析稿还没有内容。',
  'read.retry': '重新载入',
  'read.unknownSymbol': 'MinerU 未能识别此符号（源 PDF 字体或数学斜体字形导致）',

  /* Outline popover */
  'read.outline.title': '大纲',
  'read.outline.empty': '这篇文献没有章节标题。',

  /* Block tools */
  'read.block.translate': '翻译本段',
  'read.block.translating': '翻译中…',
  'read.block.annotate': '批注本段',
  'read.block.ask': '询问 AI 此段',

  /* Translation states */
  'read.translation.pending': '翻译中…',
  'read.translation.failed': '这一段没有翻译成功。',
  'read.translation.retry': '重试',
  'read.translation.progress': '正在翻译 {done}/{total} 段',
  'read.translation.done': '翻译完成（{count} 段）',
  'read.translation.partial': '翻译了 {done} 段，{failed} 段失败',
  'read.translation.cancel': '停止',
  'read.translation.empty': '没有需要翻译的段落。',
  'read.translation.provider': '翻译来源：{provider}',

  /* Margin */
  'margin.title': '页边',
  'margin.notesCount': '{count} 条批注',
  'margin.empty': '还没有批注。选中原文即可高亮或批注。',
  'margin.emptyFiltered': '当前筛选下没有批注。',
  'margin.clearFilters': '清除筛选',
  'margin.noteEdit': '编辑批注',
  'margin.noteDelete': '删除批注',
  'margin.noteAiOrigin': 'AI · {aspect}',
  'margin.noteAiOriginPlain': 'AI 批注',
  'margin.staleNotice': '重新解析后有 {count} 条批注未能定位，原引用已保留。',
  'margin.staleSection': '未能定位的批注',
  'margin.staleTag': '位置丢失',
  'margin.dropped': '{count} 条批注与解析稿不匹配，已保留在保存列表中。',

  /* Selection toolbar */
  'sel.toolbar': '选区操作',
  'sel.highlight': '高亮',
  'sel.colors': '高亮颜色',
  'sel.note': '批注',
  'sel.askAi': '问 AI',
  'sel.translate': '翻译',
  'sel.removeHighlight': '取消高亮',
  'sel.copy': '复制',
  'sel.added': '已高亮',
  'sel.noteSaved': '批注已保存',
  'sel.deleted': '批注已删除',

  /* Selection translation card */
  'selcard.label': '选区翻译',
  'selcard.error': '翻译服务没有返回结果。',
  'selcard.retry': '重试',
  'selcard.copy': '复制译文',
  'selcard.close': '关闭翻译卡片',
  'selcard.provider': '翻译来源：{provider}',

  /* Note editor */
  'note.title': '批注',
  'note.placeholder': '写下你的理解…',
  'note.aspect': '侧重点',
  'note.save': '保存',
  'note.cancel': '取消',
  'note.delete': '删除',

  /* Model load errors */
  'read.error.annotations': '批注保存失败，稍后会自动重试。',
  'read.error.translation': '翻译请求失败。',

  /* Anchored annotation card (highlight click) */
  'read.annCard.label': '批注',
  'read.annCard.ai': 'AI 批注',
  'read.annCard.user': '我的批注',
  'read.annCard.edit': '编辑',
  'read.annCard.delete': '删除',
} as const

export const en: Record<keyof typeof zh, string> = {
  'read.mode.original': 'Original',
  'read.mode.bilingual': 'Bilingual',
  'read.mode.translated': 'Translation',
  'read.controls.mode': 'Reading mode',
  'read.controls.pageMarks': 'Page marks',
  'read.controls.outline': 'Outline',
  'read.controls.scaleDown': 'Smaller text',
  'read.controls.scaleUp': 'Larger text',
  'read.controls.translateAll': 'Translate all',
  'read.loading': 'Loading the parsed draft…',
  'read.loadFailed': "Couldn't load the parsed draft.",
  'read.emptyDoc': 'This draft has no content yet.',
  'read.retry': 'Load again',
  'read.unknownSymbol': 'MinerU could not recognize this symbol (source PDF font or italic math glyph)',
  'read.outline.title': 'Outline',
  'read.outline.empty': 'This paper has no section headings.',
  'read.block.translate': 'Translate this paragraph',
  'read.block.translating': 'Translating…',
  'read.block.annotate': 'Annotate this paragraph',
  'read.block.ask': 'Ask AI about this paragraph',
  'read.translation.pending': 'Translating…',
  'read.translation.failed': 'This paragraph was not translated.',
  'read.translation.retry': 'Retry',
  'read.translation.progress': 'Translating {done}/{total} paragraphs',
  'read.translation.done': 'Translated {count} paragraphs',
  'read.translation.partial': 'Translated {done}, {failed} failed',
  'read.translation.cancel': 'Stop',
  'read.translation.empty': 'Nothing left to translate.',
  'read.translation.provider': 'Translated by {provider}',
  'margin.title': 'Margin',
  'margin.notesCount': '{count} notes',
  'margin.empty': 'No notes yet. Select text in the paper to highlight or annotate it.',
  'margin.emptyFiltered': 'No notes match the current filter.',
  'margin.clearFilters': 'Clear filters',
  'margin.noteEdit': 'Edit note',
  'margin.noteDelete': 'Delete note',
  'margin.noteAiOrigin': 'AI · {aspect}',
  'margin.noteAiOriginPlain': 'AI note',
  'margin.staleNotice': '{count} annotations could not be located after the reparse; their original quotes are kept.',
  'margin.staleSection': 'Annotations without a position',
  'margin.staleTag': 'Lost position',
  'margin.dropped': '{count} annotations do not match the draft and are kept in the saved list.',
  'sel.toolbar': 'Selection actions',
  'sel.highlight': 'Highlight',
  'sel.colors': 'Highlight color',
  'sel.note': 'Annotate',
  'sel.askAi': 'Ask AI',
  'sel.translate': 'Translate',
  'sel.removeHighlight': 'Remove highlight',
  'sel.copy': 'Copy',
  'sel.added': 'Highlighted',
  'sel.noteSaved': 'Note saved',
  'sel.deleted': 'Note deleted',
  'selcard.label': 'Selection translation',
  'selcard.error': 'The translation service returned no result.',
  'selcard.retry': 'Retry',
  'selcard.copy': 'Copy translation',
  'selcard.close': 'Close translation card',
  'selcard.provider': 'Translated by {provider}',
  'note.title': 'Note',
  'note.placeholder': 'Write what you understood…',
  'note.aspect': 'Aspect',
  'note.save': 'Save',
  'note.cancel': 'Cancel',
  'note.delete': 'Delete',
  'read.error.annotations': 'Saving annotations failed; it will retry automatically.',
  'read.error.translation': 'The translation request failed.',

  /* Anchored annotation card (highlight click) */
  'read.annCard.label': 'Annotation',
  'read.annCard.ai': 'AI annotation',
  'read.annCard.user': 'My annotation',
  'read.annCard.edit': 'Edit',
  'read.annCard.delete': 'Delete',
}
