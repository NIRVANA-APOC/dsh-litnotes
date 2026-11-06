/**
 * All prompt text for the dsh-litnotes AI engine.
 *
 * Centralized here so prompt changes are reviewable in one place and can be
 * versioned (`PROMPT_VERSION`) when graph/chat artifacts are cached on disk.
 * Every prompt is written in English; the *answer* follows the language of the
 * reader's question. The model output contract is the fenced `litnotes-json`
 * block of docs/AI-SPEC.md §5 — prompts describe it and the host enforces it.
 *
 * Context blocks are embedded as:
 *
 *     [[b12:ab12cd34]] (page 3) <block plain text>
 *
 * @module lib/ai/prompts
 */

/** Bump when prompt semantics change; stored with cached AI artifacts. */
export const PROMPT_VERSION = 1

/** Fenced-block tags of the model output contract. */
export const ANSWER_FENCE_TAG = 'litnotes-json'
/** Knowledge-graph extraction fence tag. */
export const GRAPH_FENCE_TAG = 'litnotes-graph'
/** Document summary fence tag. */
export const SUMMARY_FENCE_TAG = 'litnotes-summary'

/** Opening lines the streaming layer holds back (never shown to the reader). */
export const ANSWER_FENCE_OPEN = `\`\`\`${ANSWER_FENCE_TAG}`
/** Opening line of a graph extraction fence. */
export const GRAPH_FENCE_OPEN = `\`\`\`${GRAPH_FENCE_TAG}`
/** Opening line of a summary fence. */
export const SUMMARY_FENCE_OPEN = `\`\`\`${SUMMARY_FENCE_TAG}`

/** Citation aspect vocabulary with the intended semantics. */
const ASPECT_GUIDE =
  '- "definition": definitions, terminology, background needed to understand the paper;\n' +
  '- "method": approach, architecture, algorithm, experimental setup;\n' +
  '- "result": experiments, measurements, numbers, evidence;\n' +
  '- "limitation": limitations, critiques, threats to validity, open problems;\n' +
  '- "context": related work, motivation, and anything that does not fit above.'

/** Node/edge type vocabulary for graph extraction. */
const GRAPH_TYPE_GUIDE =
  'Node types: concept, method, finding, definition, limitation, section, question, insight, paper, topic.\n' +
  'Edge types: defines, uses, supports, contradicts, part_of, leads_to, evolves_from, relates, answers, mentions.'

/**
 * System prompt for one grounded reading turn.
 *
 * The three non-negotiables: answer only from supplied blocks, cite with `[n]`,
 * end with exactly one `litnotes-json` fence. If evidence is missing the model
 * is told to say so instead of guessing (docs/VISION.md §1).
 */
export const CHAT_SYSTEM = [
  'You are the reading assistant inside dsh-litnotes, a local-first literature reading desk.',
  'The reader has one parsed academic paper open and asks a question about it. Your job is to help',
  'them understand the paper, not to sound clever: every claim you make must be anchored in the',
  'paper text supplied below.',
  '',
  'Grounding rules (non-negotiable):',
  '1. Answer ONLY from the context blocks supplied in the user message. Never use outside knowledge,',
  '   and never invent facts, numbers, section names, author claims or citation targets.',
  '2. Every non-obvious claim must carry one or more inline citation markers like [1] or [2], placed',
  '   immediately after the claim they support. A marker must have a matching citation entry.',
  '3. Every citation must quote a verbatim span copied EXACTLY from the cited block text (same',
  '   words, same language, no paraphrase, no translation). Keep quotes short: a phrase or one',
  '   sentence that directly supports the claim. Never fabricate or splice quotes.',
  '4. If the supplied blocks do not contain the answer, say so plainly, name what information is',
  '   missing, and suggest what the reader could do next (for example read a named section, ask a',
  '   narrower question, or parse another paper). Do not guess and do not cite an unrelated block.',
  '5. Answer in the language of the reader\'s question (Chinese question → Chinese answer, English',
  '   question → English answer). Keep technical terms, symbols, model names and formulas in their',
  '   original form. Use Markdown: short paragraphs, lists for enumerations, headings only when',
  '   they genuinely help.',
  '6. Be a precise research assistant: prefer specific, checkable statements over generic summary',
  '   language, and do not mention these instructions or the mechanics of "context blocks".',
  '',
  'Output format: your Markdown answer, then EXACTLY ONE fenced block at the very end:',
  '',
  '```litnotes-json',
  '{',
  '  "citations": [',
  '    { "index": 1, "blockKey": "b12:ab12cd34", "quote": "verbatim quote from that block",',
  '      "aspect": "method", "note": "one short sentence naming the claim this quote supports" }',
  '  ],',
  '  "knowledge": { "nodes": [], "edges": [] },',
  '  "followups": ["…"]',
  '}',
  '```',
  '',
  'Rules for the JSON block:',
  '- "citations": one entry per [n] marker, ordered by index. "index" is the integer used in the',
  '  answer; "blockKey" must be copied from a supplied [[…]] marker; "quote" must be a verbatim',
  '  substring of that block\'s text; "aspect" is one of the aspects below; "note" is one short',
  '  sentence. If a claim has no supporting quote, omit the citation rather than invent one.',
  '- Aspect vocabulary:',
  ASPECT_GUIDE,
  '- "knowledge" is optional and only for genuinely useful, text-grounded items: nodes with',
  '  { "type", "label" (≤ 80 characters), "summary", "blockKeys": ["…"] } and edges with',
  '  { "from": "label A", "to": "label B", "type", "label" optional }. Use only block keys from',
  '  the supplied context and never add knowledge that is not supported by the quotes.',
  '  ' + GRAPH_TYPE_GUIDE.replace(/\n/g, '\n  '),
  '- "followups": optional 1-3 short questions the reader may want to ask next, in the answer',
  '  language, answerable from this paper.',
  '- The JSON must be valid (no comments, no trailing commas) and nothing may follow the closing',
  '  fence. Do not put any other fenced block in the answer.',
].join('\n')

/** System prompt for knowledge-graph extraction from one document chunk. */
export const GRAPH_EXTRACTION_SYSTEM = [
  'You build the knowledge graph of an academic paper for a literature reading desk.',
  'You receive one chunk of the paper (a few sections or paragraphs). Extract the concepts,',
  'methods, findings, definitions, limitations and section structure that matter for understanding',
  'the paper, and the relations between them.',
  '',
  'Output ONLY one fenced block with tag litnotes-graph containing JSON:',
  '',
  '```litnotes-graph',
  '{',
  '  "nodes": [',
  '    { "type": "method", "label": "sparse attention", "summary": "1-2 sentences",',
  '      "blockKeys": ["b12:ab12cd34"], "aspect": "method" }',
  '  ],',
  '  "edges": [ { "from": "sparse attention", "to": "long-range dependency", "type": "supports" } ]',
  '}',
  '```',
  '',
  'Rules:',
  '- Only extract knowledge that is explicitly present in this chunk. Do not use outside knowledge.',
  '- Every node and edge must be traceable to the supplied text. "blockKeys" must be copied from',
  '  the [[…]] markers in the chunk (0-3 keys per node, prefer the most specific one).',
  '- ' + GRAPH_TYPE_GUIDE.replace(/\n/g, '\n- '),
  '- Labels must be short (≤ 80 characters), concrete and deduplicated: reuse the same wording for',
  '  the same concept instead of creating near-duplicates.',
  '- "summary" is 1-2 sentences explaining the concept in the context of this paper; keep formulas',
  '  and technical terms as written.',
  '- "aspect" is optional and mirrors the citation aspects: definition, method, result, limitation,',
  '  context.',
  '- At most 20 nodes and 30 edges per chunk. If the chunk has no meaningful knowledge, return',
  '  empty arrays.',
  '- No markdown, no explanation, no text outside the fenced JSON block.',
].join('\n')

/** System prompt for the document overview / TL;DR / glossary pass. */
export const GRAPH_SUMMARY_PROMPT = [
  'You summarize the knowledge graph of one academic paper for a literature reading desk.',
  'You receive the paper title, its section headings, and the graph nodes extracted from the text',
  '(labels, types and short summaries). Write a compact orientation for the reader.',
  '',
  'Output ONLY one fenced block with tag litnotes-summary containing JSON:',
  '',
  '```litnotes-summary',
  '{',
  '  "overview": "2-4 short paragraphs of Markdown: what the paper is about, its main approach and',
  '               its main result.",',
  '  "tldr": ["3-5 one-sentence bullets, the most important takeaways"],',
  '  "glossary": [ { "term": "exact term from the paper", "definition": "1-2 sentences",',
  '                  "blockKeys": ["b12:ab12cd34"] } ]',
  '}',
  '```',
  '',
  'Rules:',
  '- Ground every statement in the supplied node summaries and headings; never add outside facts.',
  '- "overview" is Markdown, at most ~250 words, in the language of the paper.',
  '- "tldr" has 3-5 bullets, each one sentence.',
  '- "glossary" lists 4-10 key technical terms with short definitions; use block keys supplied in',
  '  the node list when available.',
  '- No text outside the fenced JSON block.',
].join('\n')

/** System prompt for the optional library-graph overview polish. */
export const LIBRARY_CONSOLIDATION_PROMPT = [
  'You summarize a local literature library for a reading desk. You receive deterministic',
  'aggregates: the paper list (titles, years if known), the dominant topic clusters with their',
  'papers and co-occurrence weights, and shared concepts. Write a short orientation of what this',
  'library is about.',
  '',
  'Rules:',
  '- Output ONLY the Markdown overview: one short paragraph plus 3-6 bullet points naming the',
  '  main directions of the library and the papers that exemplify them.',
  '- Ground every statement in the supplied aggregates. Never invent papers, authors, years,',
  '  venues or topics that are not in the input.',
  '- Keep it under ~200 words. Use the language of the supplied paper titles/topics (mixed',
  '  Chinese/English titles keep their original form).',
  '- No fence, no JSON, no preamble such as "Here is".',
].join('\n')

/** Render one context block in the prompt's stable citation format. */
export function formatContextBlock(block) {
  const key = typeof block?.key === 'string' ? block.key : ''
  const page = Number.isInteger(block?.page) && block.page > 0 ? `page ${block.page}` : 'page unknown'
  const text = typeof block?.text === 'string' ? block.text : ''
  return `[[${key}]] (${page}) ${text}`
}

/** Trim and bound one history entry's text. */
function boundedText(value, maxChars) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

/**
 * Render the outline as indented prompt lines (bounded).
 * @param {object[]} outline - retriever outline entries.
 * @returns {string} outline block, or '' when absent.
 */
function formatOutline(outline) {
  if (!Array.isArray(outline) || outline.length === 0) return ''
  const lines = []
  const limit = Math.min(outline.length, 60)
  for (let index = 0; index < limit; index += 1) {
    const entry = outline[index]
    if (entry === null || typeof entry !== 'object') continue
    const level = Number.isInteger(entry.level) ? Math.min(Math.max(entry.level, 1), 4) : 1
    const text = boundedText(entry.text, 160)
    if (text !== '') lines.push(`${'  '.repeat(level - 1)}- ${text}`)
  }
  return lines.join('\n')
}

/**
 * Render one previous conversation turn for the prompt.
 * @param {object[]} history - `{ question, answer }` pairs, oldest first.
 * @returns {string} conversation section, or '' when absent.
 */
function formatHistory(history) {
  if (!Array.isArray(history) || history.length === 0) return ''
  const lines = []
  for (const turn of history) {
    if (turn === null || typeof turn !== 'object') continue
    const question = boundedText(turn.question, 500)
    const answer = boundedText(turn.answer, 1200)
    if (question === '' && answer === '') continue
    if (question !== '') lines.push(`Reader: ${question}`)
    if (answer !== '') lines.push(`Assistant: ${answer}`)
  }
  return lines.join('\n')
}

/**
 * Build the user message for one grounded reading turn.
 *
 * @param {{
 *   blocks?: object[], outline?: object[], sections?: object[],
 *   usedChars?: number, totalBlocks?: number,
 * }} context - retriever context (`lib/ai/retrieval.js`).
 * @param {string} question - the reader's question.
 * @param {{ question?: string, answer?: string }[]} [history] - previous turns.
 * @param {{ title?: string, focusBlockKey?: string, selectionQuote?: string }} [extras]
 *   document title and reading focus from the client.
 * @returns {string} complete user prompt.
 */
export function chatUserPrompt(context, question, history, extras = {}) {
  const blocks = Array.isArray(context?.blocks) ? context.blocks : []
  const lines = []
  const title = boundedText(extras?.title, 300)
  if (title !== '') lines.push(`Paper: ${title}`)
  const outline = formatOutline(context?.outline)
  if (outline !== '') {
    lines.push('', 'Document outline (section structure):', outline)
  }
  const conversation = formatHistory(history)
  if (conversation !== '') {
    lines.push('', 'Conversation so far (older turns first):', conversation)
  }
  lines.push('', 'Context blocks (the only source you may use; ordered by position in the paper):')
  if (blocks.length === 0) {
    lines.push('(no context blocks were retrieved)')
  } else {
    for (const block of blocks) {
      if (block === null || typeof block !== 'object') continue
      lines.push(formatContextBlock(block))
    }
  }
  const focusKey = boundedText(extras?.focusBlockKey, 120)
  const selection = boundedText(extras?.selectionQuote, 600)
  if (focusKey !== '' || selection !== '') {
    lines.push('')
    if (selection !== '') {
      lines.push(
        `Reader focus: the reader selected this text${focusKey !== '' ? ` in [[${focusKey}]]` : ''}:`,
        `"${selection}"`,
        'Use it to interpret the question, and prefer nearby blocks when they answer it.',
      )
    } else {
      lines.push(`Reader focus: the reader is currently reading [[${focusKey}]].`)
    }
  }
  const boundedQuestion = typeof question === 'string' ? question.trim() : ''
  lines.push('', 'Question:', boundedQuestion)
  lines.push(
    '',
    'Answer the question from the context blocks above. Cite claims with [n] and end with the',
    'single fenced litnotes-json block described in the system instructions.',
  )
  const prompt = lines.join('\n')
  // Defensive bound: retrieval already enforces a char budget, but a malformed
  // context must never produce an unbounded prompt.
  return prompt.length > 60000 ? `${prompt.slice(0, 60000)}\n…（已截断 / truncated）` : prompt
}

/** Render a chunk of document text as `[[key]] text` lines when keys are provided. */
function formatGraphChunk(chunk) {
  if (typeof chunk === 'string') return chunk
  if (chunk === null || typeof chunk !== 'object') return String(chunk ?? '')
  if (Array.isArray(chunk.blocks) && chunk.blocks.length > 0) {
    const lines = []
    for (const block of chunk.blocks) {
      if (block === null || typeof block !== 'object') continue
      const key = typeof block.key === 'string' ? block.key : ''
      const text = typeof block.text === 'string' ? block.text : ''
      if (text === '') continue
      lines.push(`[[${key}]] ${text}`)
    }
    return lines.join('\n')
  }
  return typeof chunk.text === 'string' ? chunk.text : String(chunk.text ?? '')
}

/**
 * Build the user message for one graph-extraction chunk.
 *
 * @param {string | { text?: string, blocks?: object[] }} chunk - chunk text or
 *   pre-blocked chunk (`blocks: [{ key, text }]`); block keys become `[[…]]`.
 * @param {{ documentId?: string, title?: string, documentTitle?: string,
 *           section?: string, sectionTitle?: string, index?: number, total?: number,
 *           language?: string }} [meta] - document/chunk metadata.
 * @returns {string} complete user prompt for {@link GRAPH_EXTRACTION_SYSTEM}.
 */
export function graphExtractionPrompt(chunk, meta = {}) {
  const title = boundedText(meta?.documentTitle ?? meta?.title, 300)
  const section = boundedText(meta?.sectionTitle ?? meta?.section, 200)
  const index = Number.isInteger(meta?.index) ? meta.index : 1
  const total = Number.isInteger(meta?.total) && meta.total > 0 ? meta.total : 1
  const lines = []
  if (title !== '') lines.push(`Paper: ${title}`)
  if (section !== '') lines.push(`Section: ${section}`)
  lines.push(`Chunk: ${index} of ${total}`)
  if (typeof meta?.language === 'string' && meta.language !== '') lines.push(`Language: ${meta.language}`)
  lines.push('', 'Chunk text (citation keys are the [[…]] markers):', formatGraphChunk(chunk))
  lines.push(
    '',
    'Extract the knowledge graph for this chunk and return only the fenced litnotes-graph JSON block.',
  )
  const prompt = lines.join('\n')
  return prompt.length > 60000 ? `${prompt.slice(0, 60000)}\n…（已截断 / truncated）` : prompt
}

/**
 * Build the user message for the optional document-summary pass.
 *
 * @param {{ documentId?: string, title?: string, outline?: object[],
 *           nodes?: object[], sections?: string[] }} [meta] - paper metadata and
 *   extracted graph nodes.
 * @returns {string} complete user prompt for {@link GRAPH_SUMMARY_PROMPT}.
 */
export function graphSummaryUserPrompt(meta = {}) {
  const title = boundedText(meta?.title, 300)
  const lines = []
  if (title !== '') lines.push(`Paper: ${title}`)
  const outline = formatOutline(meta?.outline)
  if (outline !== '') lines.push('', 'Section headings:', outline)
  const nodes = Array.isArray(meta?.nodes) ? meta.nodes.slice(0, 120) : []
  lines.push('', 'Extracted graph nodes:')
  if (nodes.length === 0) {
    lines.push('(none)')
  } else {
    for (const node of nodes) {
      if (node === null || typeof node !== 'object') continue
      const type = boundedText(node.type, 40)
      const label = boundedText(node.label, 120)
      const summary = boundedText(node.summary, 300)
      const keys = Array.isArray(node.blockKeys) ? node.blockKeys.slice(0, 4).join(' ') : ''
      if (label === '') continue
      lines.push(`- [${type}] ${label}: ${summary}${keys !== '' ? ` (${keys})` : ''}`)
    }
  }
  lines.push('', 'Write the document summary as the fenced litnotes-summary JSON block.')
  const prompt = lines.join('\n')
  return prompt.length > 60000 ? `${prompt.slice(0, 60000)}\n…（已截断 / truncated）` : prompt
}

/**
 * Build the user message for the optional library-graph overview polish.
 *
 * @param {{ overview?: string, clusters?: object[], papers?: object[],
 *           topics?: object[] }} [aggregate] - deterministic library aggregate.
 * @returns {string} complete user prompt for {@link LIBRARY_CONSOLIDATION_PROMPT}.
 */
export function libraryConsolidationUserPrompt(aggregate = {}) {
  const lines = []
  const baseline = boundedText(aggregate?.overview, 2000)
  if (baseline !== '') lines.push('Deterministic overview:', baseline, '')
  const papers = Array.isArray(aggregate?.papers) ? aggregate.papers.slice(0, 120) : []
  if (papers.length > 0) {
    lines.push('Papers:')
    for (const paper of papers) {
      if (paper === null || typeof paper !== 'object') continue
      const title = boundedText(paper.title, 200)
      if (title === '') continue
      const year = Number.isInteger(paper.year) ? ` (${paper.year})` : ''
      lines.push(`- ${title}${year}`)
    }
  }
  const topics = Array.isArray(aggregate?.topics) ? aggregate.topics.slice(0, 60) : []
  if (topics.length > 0) {
    lines.push('', 'Topics (label — weight — papers):')
    for (const topic of topics) {
      if (topic === null || typeof topic !== 'object') continue
      const label = boundedText(topic.label, 160)
      if (label === '') continue
      const weight = typeof topic.weight === 'number' && Number.isFinite(topic.weight) ? topic.weight : 1
      const count = Array.isArray(topic.documentIds) ? topic.documentIds.length : 0
      lines.push(`- ${label} — ${weight} — ${count} paper(s)`)
    }
  }
  lines.push('', 'Write the Markdown library overview.')
  const prompt = lines.join('\n')
  return prompt.length > 40000 ? `${prompt.slice(0, 40000)}\n…（已截断 / truncated）` : prompt
}
