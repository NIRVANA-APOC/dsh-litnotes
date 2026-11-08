/**
 * Unit tests for the AI 精读 close-reading engine (`src/host/ai/deepread.ts`)
 * and its prompts (`src/host/ai/prompts.ts` deep-read section).
 *
 * The injected gateway and store are fakes: the gateway dispatches scripted
 * model outputs by system prompt, the store keeps aux JSON / annotations in
 * memory and exposes the documented aux + annotation API.
 *
 * Coverage follows the design's test list (`.agents/plan/DEEPREAD.md` §7):
 * cached replay, map fallback, chunk selection, quote verification and the
 * metadata/quality gate, coverage pass, judge drop/fail-open, dedupe/cap,
 * report validation and fallback, progress order, abort/no-write, persistence,
 * language and corrupt-record normalization.
 */

import { describe, expect, test } from 'vitest'
import { createDeepReadService, type DeepReadLlmApi, type DeepReadStoreApi } from '../../src/host/ai/deepread.ts'
import type { LlmCompleteRequest } from '../../src/host/ai/llm.ts'
import {
  DEEPREAD_GAP_SYSTEM,
  DEEPREAD_JUDGE_SYSTEM,
  DEEPREAD_MAP_FENCE_TAG,
  DEEPREAD_MAP_SYSTEM,
  DEEPREAD_POINT_KINDS,
  DEEPREAD_PROMPT_VERSION,
  DEEPREAD_REPORT_FENCE_TAG,
  DEEPREAD_REPORT_SYSTEM,
  DEEPREAD_ROLE_LENSES,
  DEEPREAD_SECTION_FENCE_TAG,
  DEEPREAD_SECTION_ROLES,
  DEEPREAD_SECTION_SYSTEM,
  PROMPT_VERSION,
  deepReadJudgeUserPrompt,
  deepReadMapUserPrompt,
  deepReadReportUserPrompt,
  deepReadSectionUserPrompt,
  normalizeDeepReadRole,
  parseDeepReadJudgeOutput,
  parseDeepReadMapOutput,
  parseDeepReadReportOutput,
  parseDeepReadSectionOutput,
} from '../../src/host/ai/prompts.ts'
import {
  deepReadJudgeText,
  deepReadMapText,
  deepReadReportText,
  deepReadSectionText,
} from '../helpers/fake-llm.ts'
import { appendPageMarks, parseMarkdown } from '../../src/shared/markdown/parse.ts'
import { plainTextOfBlock } from '../../src/shared/markdown/model.ts'
import { locateQuote, normalizeQuoteText } from '../../src/shared/annotate/anchors.ts'
import type {
  Annotation,
  AnnotationEnvelope,
  DeepReadFrame,
  DeepReadRecord,
  DocumentMeta,
  ParsedDocument,
} from '../../src/shared/model.ts'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A small but structurally complete empirical paper. */
const PAPER = [
  '# Permissioned Agents for Safe Tool Use',
  '',
  'Alice Zhang, Bob Li, Carol Wu',
  '',
  'Department of Computer Science, Example University',
  '',
  '## Abstract',
  '',
  'Model Context Protocol servers give language models powerful tools, but they also create a permission boundary that is hard to audit. We study how agent manifests constrain tool access across twelve MCP servers. Manifest-based checks block ninety-four percent of injected tool calls while preserving eighty-seven percent of benign calls. We argue that permission checks must move from prompts into the execution layer.',
  '',
  '## 1 Introduction',
  '',
  'Large language models increasingly act through tool protocols. A prompt injection can turn a benign assistant into an exfiltration tool. Prior work recommends careful prompting, but prompts are not an enforcement boundary. We propose an execution-layer permission checker driven by AgentManifest declarations, and we show that enforcement at the tool boundary is both necessary and practical.',
  '',
  '## 2 Related Work',
  '',
  'Tool sandboxing has a long history in operating systems. Recent agent frameworks rely on prompt-level constraints, which are not enforceable against an adversarial model. Our work differs by moving the check into the protocol implementation itself.',
  '',
  '## 3 Method',
  '',
  '### 3.1 Agent Manifests',
  '',
  'An AgentManifest declares the capabilities an agent may use, including network destinations and file paths. The runtime checks every tool call against the manifest before execution and rejects undeclared capabilities. Because the manifest is data, it can be audited and diffed like any other configuration artifact.',
  '',
  '### 3.2 Enforcement',
  '',
  'The checker intercepts tool invocations at the MCP boundary and rejects any call whose capability is not declared. Decisions are logged with the manifest version, the requested capability and the resulting verdict, which gives operators a complete audit trail.',
  '',
  '## 4 Experiments',
  '',
  'We evaluate on twelve open MCP servers with eighteen hundred tool calls. Baselines include prompt-only guards and static allowlists. We measure attack success rate and benign task completion rate under identical injection prompts.',
  '',
  '## 5 Results',
  '',
  'Manifest-based enforcement blocks ninety-four percent of injected tool calls and preserves eighty-seven percent of benign calls, compared with forty-one percent blocked by prompt-only guards. False positives concentrate on file-system tools that request paths outside the manifest.',
  '',
  '## 6 Discussion',
  '',
  'Our results suggest that execution-layer enforcement is necessary for adversarial settings. The eighty point nine percent manifest auto-generation accuracy reported in the appendix is the main limitation: a wrong manifest silently widens the permission boundary. Operators must therefore review generated manifests.',
  '',
  '## 7 Limitations',
  '',
  'We do not evaluate multi-agent delegation, where manifests may be composed across agents. Our dataset is limited to twelve servers and one tool protocol, so generalization to other ecosystems is untested.',
  '',
  '## 8 Conclusion',
  '',
  'Manifest-based permission checks turn prompt policy into enforceable execution policy. Future work should study manifest composition across agents and the review workflow for generated manifests.',
  '',
  '## References',
  '',
  '[1] Smith et al. Prompting is not a boundary. 2023.',
].join('\n')

/** One-section paper used by the quote-verification / metadata tests. */
const ONE_SECTION_PAPER = [
  '## Method',
  '',
  'An AgentManifest declares the capabilities an agent may use, including network destinations and file paths. The runtime checks every tool call against the manifest before execution and rejects undeclared capabilities.',
].join('\n')

/** Paper with two paragraphs per chunk (dedupe test). */
const TWO_PARAGRAPH_PAPER = [
  '## Method',
  '',
  'An AgentManifest declares the capabilities an agent may use, including network destinations and file paths. The runtime checks every tool call against the manifest before execution.',
  '',
  'Decisions are logged with the manifest version and the requested capability, which gives operators a complete audit trail during incident review.',
].join('\n')

/** Paper carrying title/author/acknowledgement/figure metadata inside a chunk. */
const METADATA_PAPER = [
  '## Method',
  '',
  'An AgentManifest declares the capabilities an agent may use, including network destinations and file paths. The runtime checks every tool call against the manifest before execution.',
  '',
  'We thank the anonymous reviewers for their careful reading of this work.',
  '',
  'Figure 3',
  '',
  'Alice Zhang, Bob Li, Carol Wu',
].join('\n')

/** Reader-language note the default section script uses (deliberately interpretive). */
const NOTE_ZH =
  '这一处把论证从动机推进到执行机制：它说明了检查为何必须发生在工具边界，并暴露出结论依赖清单质量这一尚未展开的前提。'
/** English interpretive note (restatement heuristics are language sensitive). */
const NOTE_EN =
  'This passage moves the argument from motivation to mechanism: enforcement must live at the tool boundary, and the conclusion still rests on manifest quality.'

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

/** One recorded gateway call. */
interface GatewayCall {
  purpose: string
  system: string
  prompt: string
}

/** Scripted model outputs, dispatched by system prompt. */
interface GatewayScripts {
  available?: boolean
  map?: (prompt: string) => string
  section?: (prompt: string, index: number) => string
  gap?: (prompt: string, index: number) => string
  judge?: (prompt: string) => string
  report?: (prompt: string) => string
}

/** Fake gateway surface used by the tests. */
interface FakeGateway extends DeepReadLlmApi {
  calls: GatewayCall[]
  counts: { map: number; section: number; gap: number; judge: number; report: number }
  state: { available: boolean }
}

/** Flatten one completion request into its prompt text. */
function promptOf(request: LlmCompleteRequest): string {
  const parts: string[] = []
  if (typeof request.system === 'string') parts.push(request.system)
  for (const message of Array.isArray(request.messages) ? request.messages : []) {
    if (message === null || typeof message !== 'object') continue
    const content = message.content
    if (typeof content === 'string') parts.push(content)
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part !== null && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text)
      }
    }
  }
  return parts.join('\n\n')
}

/** Create a fake gateway dispatching by the documented system prompts. */
function createGateway(scripts: GatewayScripts = {}): FakeGateway {
  const calls: GatewayCall[] = []
  const counts = { map: 0, section: 0, gap: 0, judge: 0, report: 0 }
  const state = { available: scripts.available !== false }
  const gateway: FakeGateway = {
    calls,
    counts,
    state,
    available: () => state.available,
    route: () => ({ provider: 'fake-provider', model: 'fake-model' }),
    async completeText(request: LlmCompleteRequest): Promise<string> {
      const prompt = promptOf(request)
      const system = typeof request.system === 'string' ? request.system : ''
      calls.push({ purpose: String(request.purpose ?? ''), system, prompt })
      if (system === DEEPREAD_MAP_SYSTEM) {
        counts.map += 1
        if (scripts.map === undefined) throw new Error('fake gateway: no map script')
        return scripts.map(prompt)
      }
      if (system === DEEPREAD_SECTION_SYSTEM) {
        counts.section += 1
        if (scripts.section === undefined) throw new Error('fake gateway: no section script')
        return scripts.section(prompt, counts.section)
      }
      if (system === DEEPREAD_GAP_SYSTEM) {
        counts.gap += 1
        if (scripts.gap === undefined) throw new Error('fake gateway: no gap script')
        return scripts.gap(prompt, counts.gap)
      }
      if (system === DEEPREAD_JUDGE_SYSTEM) {
        counts.judge += 1
        if (scripts.judge === undefined) throw new Error('fake gateway: no judge script')
        return scripts.judge(prompt)
      }
      if (system === DEEPREAD_REPORT_SYSTEM) {
        counts.report += 1
        if (scripts.report === undefined) throw new Error('fake gateway: no report script')
        return scripts.report(prompt)
      }
      throw new Error(`fake gateway: unexpected system prompt ${system.slice(0, 60)}`)
    },
  }
  return gateway
}

/** Parse the chunk block lines out of a section/gap prompt. */
function promptBlocks(prompt: string): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = []
  const pattern = /^\[\[(b\d+:[0-9a-f]{8})\]\] \(page [^)]*\) (.*)$/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(prompt)) !== null) {
    out.push({ key: match[1] ?? '', text: match[2] ?? '' })
  }
  return out
}

/** Parse the section name out of a section/gap prompt. */
function promptSection(prompt: string): string {
  const match = /Chunk \d+ of \d+ — section: (.+)/.exec(prompt)
  return (match?.[1] ?? '').trim()
}

/** Parse candidate ids out of a judge prompt. */
function judgeIds(prompt: string): number[] {
  const ids: number[] = []
  const pattern = /^\[(\d+)\] aspect:/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(prompt)) !== null) {
    const id = Number(match[1])
    if (Number.isInteger(id) && id > 0) ids.push(id)
  }
  return ids
}

/** Parse the citable evidence keys out of a report prompt (evidence line only). */
function reportKeys(prompt: string): string[] {
  const line = /Evidence block keys you may cite[^\n]*\n([^\n]+)/.exec(prompt)
  if (line === null) return []
  return (line[1] ?? '').split(/\s+/).filter((key) => /^b\d+:[0-9a-f]{8}$/.test(key))
}

/** Default reading-map script. */
function defaultMap(): string {
  return deepReadMapText({
    kind: 'empirical',
    problem: 'How can tool permissions be enforced against an adversarial model?',
    gap: 'Prompt-level guardrails cannot be enforced.',
    contributions: ['Manifest-based execution-layer permission checks.'],
    methodFamily: 'runtime capability checking',
    evaluation: 'twelve MCP servers, 1800 tool calls',
    keyTerms: ['AgentManifest', 'MCP server', 'capability'],
    sectionRoles: [],
  })
}

/** Build one interpretive annotation for a prompt block line. */
function annotationFor(
  block: { key: string; text: string },
  aspect: string,
  note: string,
  options: { quote?: string; importance?: number } = {},
): Record<string, unknown> {
  return {
    blockKey: block.key,
    quote: options.quote ?? block.text.slice(0, 120),
    aspect,
    note,
    importance: options.importance ?? 4,
  }
}

/** Default close-reading script: a few interpretive annotations per chunk. */
function defaultSection(prompt: string, index: number): string {
  const blocks = promptBlocks(prompt)
  const annotations: Record<string, unknown>[] = []
  const aspects = ['definition', 'method', 'result']
  for (let blockIndex = 0; blockIndex < Math.min(3, blocks.length); blockIndex += 1) {
    const block = blocks[blockIndex]
    if (block === undefined) continue
    annotations.push(annotationFor(block, aspects[blockIndex] ?? 'context', NOTE_ZH))
  }
  const firstKey = blocks[0]?.key ?? ''
  return deepReadSectionText({
    role: 'other',
    summary: `第 ${index} 节说明了执行层检查为什么必要。`,
    annotations,
    points:
      firstKey !== ''
        ? [{ kind: 'claim', text: '执行层检查比提示约束更可靠。', blockKeys: [firstKey] }]
        : [],
  })
}

/** Default gap script: annotate the last block of the chunk (never a heading). */
function defaultGap(prompt: string, index: number): string {
  const blocks = promptBlocks(prompt)
  const block = blocks[blocks.length - 1]
  return deepReadSectionText({
    role: 'other',
    summary: `补读 ${index} 找到该节独有的证据。`,
    annotations: block !== undefined ? [annotationFor(block, 'result', NOTE_ZH)] : [],
    points: [],
  })
}

/** Default judge script: keep everything as "strong". */
function defaultJudge(prompt: string): string {
  return deepReadJudgeText(judgeIds(prompt).map((id) => ({ id, score: 2, reason: 'adds interpretation' })))
}

/** Default report script: a complete model report. */
function defaultReport(prompt: string): string {
  const keys = reportKeys(prompt)
  const key = keys[0] ?? ''
  return deepReadReportText({
    tldr: ['执行层权限检查把提示策略变成可审计的执行策略。'],
    problem: { label: '研究问题', detail: '提示层约束无法在对抗性模型下强制执行。', blockKeys: key !== '' ? [key] : [] },
    gap: { label: '研究空白', detail: '已有工作依赖提示约束，缺少执行层检查。', blockKeys: [] },
    contributions: [
      {
        label: '执行层清单检查',
        detail: '提出基于 AgentManifest 的执行层权限检查，并在真实 MCP 服务器上评测。',
        blockKeys: key !== '' ? [key] : [],
        evidence: 'strong',
      },
    ],
    method: [{ label: '方法', detail: '在 MCP 边界拦截工具调用并按清单判定。', blockKeys: [] }],
    evaluation: [{ label: '实验', detail: '十二个服务器、一千八百次工具调用。', blockKeys: [] }],
    findings: [{ label: '发现', detail: '拦截百分之九十四的注入调用，保留百分之八十七的正常调用。', blockKeys: [] }],
    limitations: [{ label: '局限', detail: '清单自动生成准确率有限，错误清单会静默放宽权限边界。', blockKeys: [] }],
    openQuestions: [{ label: '开放问题', detail: '多智能体委派时清单如何组合仍未被评测。', blockKeys: [] }],
    argumentMap: [{ from: '清单声明能力', to: '未声明调用被拒绝', relation: 'supports' }],
    glossary: [
      { term: 'AgentManifest', definition: '声明智能体可用能力的数据结构。', blockKeys: key !== '' ? [key] : [] },
    ],
    readingPath: ['3 Method'],
    verdict: { strengths: ['形式化边界清晰'], weaknesses: ['清单质量依赖人工审核'], confidence: 'medium' },
  })
}

/** All default scripts. */
function defaultScripts(overrides: GatewayScripts = {}): GatewayScripts {
  return {
    map: () => defaultMap(),
    section: (prompt, index) => defaultSection(prompt, index),
    gap: (prompt, index) => defaultGap(prompt, index),
    judge: (prompt) => defaultJudge(prompt),
    report: (prompt) => defaultReport(prompt),
    ...overrides,
  }
}

/** In-memory store exposing the documented aux + annotation API. */
interface FakeEnv {
  store: DeepReadStoreApi
  aux: Map<string, unknown>
  annotations: Map<string, Annotation[]>
  markdowns: Map<string, string>
  calls: { mutate: number; save: number; load: number }
}

/** Create one in-memory store environment. */
function createStore(options: {
  docs?: Array<{ id: string; title: string }>
  markdown?: Record<string, string>
  annotations?: Record<string, Annotation[]>
  mutate?: boolean
} = {}): FakeEnv {
  const docList: DocumentMeta[] = (options.docs ?? []).map((doc) => createDocumentMeta(doc.id, doc.title))
  const docsById = new Map(docList.map((doc) => [doc.id, doc]))
  const markdowns = new Map<string, string>(Object.entries(options.markdown ?? {}))
  const annotations = new Map<string, Annotation[]>(
    Object.entries(options.annotations ?? {}).map(([id, items]) => [id, structuredClone(items)]),
  )
  const aux = new Map<string, unknown>()
  const calls = { mutate: 0, save: 0, load: 0 }
  const store: DeepReadStoreApi = {
    get(documentId: string): DocumentMeta | undefined {
      const meta = docsById.get(documentId)
      return meta === undefined ? undefined : structuredClone(meta)
    },
    async readMarkdown(documentId: string): Promise<ParsedDocument> {
      if (!markdowns.has(documentId)) {
        const error = new Error('Document has not been parsed yet') as Error & { code: string }
        error.code = 'not-parsed'
        throw error
      }
      return { markdown: markdowns.get(documentId) ?? '', contentList: null, pages: null }
    },
    async readAux(documentId: string, name: string): Promise<unknown> {
      const key = `${documentId}/${name}`
      return aux.has(key) ? structuredClone(aux.get(key)) : null
    },
    async writeAux(documentId: string, name: string, value: unknown): Promise<void> {
      aux.set(`${documentId}/${name}`, structuredClone(value))
    },
    async loadAnnotations(documentId: string): Promise<AnnotationEnvelope> {
      calls.load += 1
      return { version: 1, items: structuredClone(annotations.get(documentId) ?? []) }
    },
    async saveAnnotations(
      documentId: string,
      data: { items?: Annotation[]; baseIds?: string[] },
    ): Promise<AnnotationEnvelope> {
      calls.save += 1
      const items = structuredClone(Array.isArray(data.items) ? data.items : [])
      annotations.set(documentId, items)
      return { version: 1, items }
    },
  }
  if (options.mutate !== false) {
    store.mutateAnnotations = async (
      documentId: string,
      mutate: (current: Annotation[]) => Annotation[] | Promise<Annotation[]>,
    ): Promise<AnnotationEnvelope> => {
      calls.mutate += 1
      const current = structuredClone(annotations.get(documentId) ?? [])
      const next = await mutate(current)
      annotations.set(documentId, next)
      return { version: 1, items: next }
    }
  }
  return { store, aux, annotations, markdowns, calls }
}

/** One parsed document metadata row. */
function createDocumentMeta(id: string, title: string): DocumentMeta {
  return {
    schemaVersion: 1,
    id,
    title,
    originalName: `${id}.pdf`,
    ext: 'pdf',
    mime: 'application/pdf',
    size: 1024,
    sha256: 'deadbeef',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'parsed',
    error: null,
    parse: null,
  }
}

/** Build a service over the fake store/gateway. */
function makeService(env: FakeEnv, gateway: FakeGateway, ai: Record<string, unknown> = {}) {
  return createDeepReadService({
    llm: gateway,
    store: env.store,
    config: { ai: { deepReadCoveragePass: false, deepReadJudge: false, ...ai } },
    logger: { warn(): void {} },
    readMarkdown: (documentId) => env.store.readMarkdown!(documentId),
  })
}

/** Drain one frame stream. */
async function collect(frames: AsyncGenerator<DeepReadFrame>): Promise<DeepReadFrame[]> {
  const out: DeepReadFrame[] = []
  for await (const frame of frames) out.push(frame)
  return out
}

/** The record of the last `report` frame (fails when absent). */
function reportOf(frames: readonly DeepReadFrame[]): DeepReadRecord {
  const frame = [...frames].reverse().find((candidate) => candidate.type === 'report')
  expect(frame, 'expected a report frame').toBeDefined()
  if (frame === undefined || frame.type !== 'report') throw new Error('missing report frame')
  return frame.record
}

/** All error frames of one run. */
function errorsOf(frames: readonly DeepReadFrame[]): Array<{ code: string; message: string }> {
  return frames.filter((frame): frame is Extract<DeepReadFrame, { type: 'error' }> => frame.type === 'error')
}

/** All progress frames of one run. */
function progressOf(frames: readonly DeepReadFrame[]): Array<Extract<DeepReadFrame, { type: 'progress' }>> {
  return frames.filter((frame): frame is Extract<DeepReadFrame, { type: 'progress' }> => frame.type === 'progress')
}

/** Parser blocks of one markdown fixture (key → text/kind). */
function blocksOf(markdown: string): Array<{ key: string; text: string; kind: string }> {
  const model = appendPageMarks(parseMarkdown(markdown), null)
  const out: Array<{ key: string; text: string; kind: string }> = []
  for (const block of model.blocks) {
    const text = plainTextOfBlock(block)
    if (text.trim() === '' || block.key === '') continue
    out.push({ key: block.key, text, kind: block.kind })
  }
  return out
}

/** Find the first block containing `needle` (fails when absent). */
function blockByText(markdown: string, needle: string): { key: string; text: string; kind: string } {
  const block = blocksOf(markdown).find((candidate) => candidate.text.includes(needle))
  expect(block, `expected a block containing ${needle}`).toBeDefined()
  if (block === undefined) throw new Error(`missing block: ${needle}`)
  return block
}

/** Seed one user annotation covering a quote (for dedupe tests). */
function seedAnnotation(markdown: string, needle: string, aspect: string): Annotation {
  const block = blockByText(markdown, needle)
  const quote = normalizeQuoteText(block.text).slice(0, 120)
  const range = locateQuote(block.text, quote)
  if (range === null) throw new Error('seed annotation quote did not locate')
  return {
    id: 'existing-annotation',
    blockKey: block.key,
    start: range.start,
    end: range.end,
    quote,
    color: 'sage',
    aspect: aspect as Annotation['aspect'],
    note: '人工批注：这条批注由读者创建，精读不得重复。',
    origin: 'user',
  }
}

/* -------------------------------------------------------------------------- */
/* Prompt contract                                                            */
/* -------------------------------------------------------------------------- */

describe('deep-read prompt contract', () => {
  test('prompt version and fence tags are the documented contract', () => {
    expect(DEEPREAD_PROMPT_VERSION).toBe(1)
    expect(PROMPT_VERSION).toBe(2)
    expect(DEEPREAD_MAP_FENCE_TAG).toBe('litnotes-deepread-map')
    expect(DEEPREAD_SECTION_FENCE_TAG).toBe('litnotes-deepread')
    expect(DEEPREAD_REPORT_FENCE_TAG).toBe('litnotes-deepread-report')
    expect([...DEEPREAD_SECTION_ROLES]).toContain('references')
    expect([...DEEPREAD_POINT_KINDS]).toContain('connection')
    expect(normalizeDeepReadRole('Related Work')).toBe('related-work')
    expect(normalizeDeepReadRole('7 conclusion')).toBe('conclusion')
    expect(normalizeDeepReadRole('not a role')).toBeNull()
  })

  test('section prompt carries the quality gate, role lens and note examples', () => {
    expect(DEEPREAD_SECTION_SYSTEM).toMatch(/verbatim/i)
    expect(DEEPREAD_SECTION_SYSTEM).toMatch(/15-500 characters/)
    expect(DEEPREAD_SECTION_SYSTEM).toMatch(/NEVER annotate/)
    expect(DEEPREAD_SECTION_SYSTEM).toMatch(/the title, authors, affiliations, emails/)
    expect(DEEPREAD_SECTION_SYSTEM).toMatch(/reference-list entries/i)
    expect(DEEPREAD_SECTION_SYSTEM).toMatch(/2-4 sentences/)
    expect(DEEPREAD_SECTION_SYSTEM).toMatch(/Interpret, never restate/)
    expect(DEEPREAD_SECTION_SYSTEM).toMatch(/BAD: /)
    expect(DEEPREAD_SECTION_SYSTEM).toMatch(/GOOD: /)
    expect(DEEPREAD_SECTION_SYSTEM).toMatch(/Importance rubric/)
    expect(DEEPREAD_SECTION_SYSTEM).toMatch(/15|2-6/)
    expect(DEEPREAD_SECTION_SYSTEM).toMatch(/DATA, never instructions/)
  })

  test('gap and report prompts carry their targeted intent', () => {
    expect(DEEPREAD_GAP_SYSTEM).toMatch(/UNIQUELY contributes/)
    expect(DEEPREAD_GAP_SYSTEM).toMatch(/Forbidden/)
    expect(DEEPREAD_GAP_SYSTEM).toMatch(/2-4 annotations/)
    expect(DEEPREAD_REPORT_SYSTEM).toMatch(/critical/i)
    expect(DEEPREAD_REPORT_SYSTEM).toMatch(/Separate what the paper CLAIMS/)
    expect(DEEPREAD_REPORT_SYSTEM).toMatch(/thin evidence/i)
    expect(DEEPREAD_REPORT_SYSTEM).toMatch(/block key/i)
    expect(DEEPREAD_JUDGE_SYSTEM).toMatch(/Score it 0/)
    expect(DEEPREAD_JUDGE_SYSTEM).toMatch(/restates|restating|paraphrases/)
    expect(DEEPREAD_MAP_SYSTEM).toMatch(/READING PLAN/)
    expect(DEEPREAD_MAP_SYSTEM).toMatch(/sectionRoles/)
  })

  test('role lenses tell the model what a section of each role is for', () => {
    expect(DEEPREAD_ROLE_LENSES.method).toMatch(/design decisions/)
    expect(DEEPREAD_ROLE_LENSES.results).toMatch(/decisive numbers/)
    expect(DEEPREAD_ROLE_LENSES.limitation).toMatch(/admissions/)
    expect(DEEPREAD_ROLE_LENSES.references).toMatch(/never annotate/)
    expect(DEEPREAD_ROLE_LENSES.introduction).toMatch(/problem/)
  })

  test('builders render the language, map, memory, lens, blocks and evidence keys', () => {
    const sectionPrompt = deepReadSectionUserPrompt({
      title: 'T',
      language: 'zh',
      paperMap: 'Problem: P',
      readingMemory: '- §Abstract [abstract]: summary',
      role: 'method',
      section: '3 Method',
      index: 2,
      total: 9,
      lines: ['[[b1:0000abcd]] (page 2) text'],
      targetAnnotations: 4,
    })
    expect(sectionPrompt).toMatch(/Reader language: zh/)
    expect(sectionPrompt).toMatch(/Paper map \(reading plan/)
    expect(sectionPrompt).toMatch(/Problem: P/)
    expect(sectionPrompt).toMatch(/Reading memory/)
    expect(sectionPrompt).toMatch(/Method lens/)
    expect(sectionPrompt).toMatch(/Chunk 2 of 9 — section: 3 Method/)
    expect(sectionPrompt).toContain('[[b1:0000abcd]] (page 2) text')

    const judgePrompt = deepReadJudgeUserPrompt({
      candidates: [{ id: 1, aspect: 'method', quote: 'q', note: 'n' }],
    })
    expect(judgePrompt).toContain('[1] aspect: method')
    expect(judgePrompt).toMatch(/litnotes-deepread-judge/)

    const mapPrompt = deepReadMapUserPrompt({
      title: 'T',
      language: 'zh',
      outline: ['Abstract', '3 Method'],
      head: 'head text',
      sectionPreviews: [{ heading: '3 Method', role: 'method', preview: 'preview' }],
      truncated: true,
    })
    expect(mapPrompt).toMatch(/Reader language: zh/)
    expect(mapPrompt).toMatch(/Heading outline/)
    expect(mapPrompt).toMatch(/the paper is longer than the source budget/)
    expect(mapPrompt).toMatch(/section previews/i)

    const reportPrompt = deepReadReportUserPrompt({
      title: 'T',
      language: 'en',
      paperMap: 'Problem: P',
      digest: '## 3 Method\nSummary: s',
      annotations: [{ aspect: 'method', quote: 'q', note: 'n', blockKey: 'b1:0000abcd' }],
      knownBlockKeys: ['b1:0000abcd'],
    })
    expect(reportPrompt).toMatch(/Verified annotations kept on the page/)
    expect(reportPrompt).toMatch(/Evidence block keys you may cite/)
    expect(reportPrompt).toContain('[[b1:0000abcd]]')
  })

  test('parsers normalize and bound model outputs', () => {
    expect(parseDeepReadMapOutput('not json')).toBeNull()
    const map = parseDeepReadMapOutput(
      deepReadMapText({
        kind: 'weird',
        problem: '  the problem  ',
        contributions: ['a'],
        keyTerms: ['Term', 'term', 'Second'],
        sectionRoles: [{ heading: ' 3 Method ', role: 'Method' }, { heading: '', role: 'method' }],
      }),
    )
    expect(map).not.toBeNull()
    expect(map?.kind).toBe('other')
    expect(map?.problem).toBe('the problem')
    expect(map?.keyTerms).toEqual(['Term', 'Second'])
    expect(map?.sectionRoles).toEqual([{ heading: '3 Method', role: 'method' }])

    const section = parseDeepReadSectionOutput(
      deepReadSectionText({
        role: 'nope',
        summary: 'summary',
        annotations: Array.from({ length: 10 }, (_, index) => ({
          blockKey: `b${index}:0000abcd`,
          quote: `quote number ${index}`,
          aspect: index === 0 ? 'weird' : 'method',
          note: 'note',
          importance: 9,
        })),
        points: [
          { kind: 'findings', text: 'result point', blockKeys: ['b1:0000abcd'] },
          { kind: 'claim', text: '', blockKeys: [] },
        ],
      }),
    )
    expect(section?.role).toBeNull()
    expect(section?.annotations.length).toBe(6)
    expect(section?.annotations[0]?.aspect).toBe('context')
    expect(section?.annotations[0]?.importance).toBe(5)
    expect(section?.points[0]?.kind).toBe('result')

    expect(parseDeepReadJudgeOutput(deepReadJudgeText([{ id: 1, score: 2 }, { id: 2, score: 5 }]))).toEqual({
      results: [{ id: 1, score: 2, reason: '' }],
    })
    expect(parseDeepReadJudgeOutput('nothing')).toBeNull()

    const report = parseDeepReadReportOutput(
      deepReadReportText({
        tldr: ['x'.repeat(500)],
        problem: { label: 'L'.repeat(300), detail: 'D'.repeat(900), blockKeys: ['b1:0000abcd', 'b999:deadbeef'] },
        contributions: [{ label: 'c', detail: 'd', blockKeys: [], evidence: 'nonsense' }],
        glossary: Array.from({ length: 20 }, (_, index) => ({ term: `t${index}`, definition: 'd' })),
        readingPath: ['a', 'b', 'c', 'd'],
        verdict: { confidence: 'certain' },
      }),
      { knownBlockKeys: new Set(['b1:0000abcd']) },
    )
    expect(report?.tldr[0]?.length).toBe(200)
    expect(report?.problem.label.length).toBe(90)
    expect(report?.problem.detail.length).toBe(500)
    expect(report?.problem.blockKeys).toEqual(['b1:0000abcd'])
    expect(report?.contributions[0]?.evidence).toBe('partial')
    expect(report?.glossary.length).toBe(12)
    expect(report?.readingPath.length).toBe(3)
    expect(report?.verdict.confidence).toBe('medium')
  })
})

/* -------------------------------------------------------------------------- */
/* Workflow                                                                   */
/* -------------------------------------------------------------------------- */

describe('deep-read workflow', () => {
  test('runs the full workflow, persists the record and annotations, and replays the cache', async () => {
    const documentId = 'doc-happy'
    const env = createStore({ docs: [{ id: documentId, title: 'Permissioned Agents' }], markdown: { [documentId]: PAPER } })
    const gateway = createGateway(defaultScripts())
    const service = makeService(env, gateway, { deepReadJudge: true, deepReadCoveragePass: true })

    const frames = await collect(service.run(documentId, { language: 'en' }))
    expect(errorsOf(frames)).toEqual([])
    expect(frames[0]?.type).toBe('start')
    expect(frames[frames.length - 1]?.type).toBe('done')

    // Phase order: mapping → reading → gaps → judging → synthesizing → annotating → done.
    const phases = progressOf(frames).map((frame) => frame.phase)
    const firstIndex = (phase: string): number => phases.indexOf(phase as (typeof phases)[number])
    expect(firstIndex('mapping')).toBeGreaterThanOrEqual(0)
    expect(firstIndex('reading')).toBeGreaterThan(firstIndex('mapping'))
    expect(firstIndex('synthesizing')).toBeGreaterThan(firstIndex('reading'))
    expect(firstIndex('annotating')).toBeGreaterThan(firstIndex('synthesizing'))
    expect(phases[phases.length - 1]).toBe('done')
    const readingProgress = progressOf(frames).filter((frame) => frame.phase === 'reading')
    expect(readingProgress[0]?.done).toBe(0)
    expect(readingProgress[readingProgress.length - 1]?.done).toBe(readingProgress[0]?.total ?? -1)
    expect(readingProgress.every((frame) => frame.total === readingProgress[0]?.total)).toBe(true)

    // Frame order after the phases: report → annotations → usage → done.
    const reportIndex = frames.findIndex((frame) => frame.type === 'report')
    const annotationsIndex = frames.findIndex((frame) => frame.type === 'annotations')
    const usageIndex = frames.findIndex((frame) => frame.type === 'usage')
    expect(reportIndex).toBeGreaterThan(0)
    expect(annotationsIndex).toBeGreaterThan(reportIndex)
    expect(usageIndex).toBeGreaterThan(annotationsIndex)
    expect(frames[frames.length - 1]?.type).toBe('done')

    const record = reportOf(frames)
    expect(record.version).toBe(1)
    expect(record.documentId).toBe(documentId)
    expect(record.language).toBe('en')
    expect(record.model).toEqual({ provider: 'fake-provider', model: 'fake-model' })
    expect(record.promptVersion).toBe(DEEPREAD_PROMPT_VERSION)
    expect(record.highlights.length).toBeGreaterThan(0)
    expect(record.highlights.length).toBe(record.stats.kept)
    expect(record.stats.candidates).toBeGreaterThanOrEqual(record.stats.kept)
    expect(record.stats.skipped).toBe(record.stats.candidates - record.stats.kept)
    expect(record.stats.calls).toBeGreaterThan(0)
    expect(record.stats.inputTokens).toBeGreaterThan(0)
    expect(record.stats.outputTokens).toBeGreaterThan(0)
    expect(record.stats.truncated).toBe(false)
    expect(record.stats.coverage).toBe(1)
    expect(record.stats.sectionsRead).toBeGreaterThan(0)
    expect(record.report.tldr.length).toBeGreaterThan(0)

    // The record is persisted and every highlight is well formed.
    const stored = env.aux.get(`${documentId}/deepread.json`)
    expect(stored).toEqual(record)
    for (const highlight of record.highlights) {
      expect(highlight.blockKey).toMatch(/^b\d+:[0-9a-f]{8}$/)
      expect(highlight.start).toBeGreaterThanOrEqual(0)
      expect(highlight.end).toBeGreaterThan(highlight.start)
      expect(highlight.note.length).toBeGreaterThanOrEqual(30)
      expect(highlight.importance).toBeGreaterThanOrEqual(1)
      expect(highlight.importance).toBeLessThanOrEqual(5)
      expect(highlight.annotationId).not.toBe('')
    }

    // Annotations carry provenance and the aspect ink colour.
    const annotations = env.annotations.get(documentId) ?? []
    expect(annotations.length).toBe(record.highlights.length)
    const byId = new Map(annotations.map((annotation) => [annotation.id, annotation]))
    for (const highlight of record.highlights) {
      const annotation = byId.get(highlight.annotationId)
      expect(annotation).toBeDefined()
      expect(annotation?.origin).toBe('ai')
      expect(annotation?.chatId).toBe(`deepread:${documentId}`)
      expect(annotation?.aspect).toBe(highlight.aspect)
      expect(annotation?.color).toBe(
        highlight.aspect === 'method' ? 'sage' : highlight.aspect === 'result' ? 'sky' : highlight.aspect === 'limitation' ? 'rose' : 'yellow',
      )
      expect(annotation?.model).toEqual({ provider: 'fake-provider', model: 'fake-model' })
    }
    expect(env.calls.mutate).toBe(1)

    // Cached replay: no model call, same record, no newly created annotations.
    const cached = await collect(service.run(documentId))
    expect(errorsOf(cached)).toEqual([])
    expect(cached[0]?.type).toBe('progress')
    expect(cached[0]?.type === 'progress' ? cached[0].phase : '').toBe('mapping')
    const cachedReport = reportOf(cached)
    expect(cachedReport).toEqual(record)
    const cachedAnnotations = cached.find((frame) => frame.type === 'annotations')
    expect(cachedAnnotations?.type === 'annotations' ? cachedAnnotations.created : -1).toBe(0)
    expect(gateway.counts).toEqual({ map: 1, section: 11, gap: 0, judge: 1, report: 1 })

    // get() returns the persisted record.
    expect(await service.get(documentId)).toEqual(record)
    expect(await service.get('missing-document')).toBeNull()
    expect(await service.get('')).toBeNull()
  })

  test('applies map-refined section roles and falls back deterministically on a malformed map', async () => {
    const documentId = 'doc-map'
    const env = createStore({ docs: [{ id: documentId, title: 'Map Paper' }], markdown: { [documentId]: PAPER } })
    const gateway = createGateway(
      defaultScripts({
        map: () =>
          deepReadMapText({
            kind: 'empirical',
            problem: 'How can permissions be enforced?',
            gap: 'Prompts are not enforceable.',
            contributions: ['Execution-layer checks.'],
            keyTerms: ['AgentManifest'],
            sectionRoles: [{ heading: '6 Discussion', role: 'limitation' }],
          }),
      }),
    )
    const service = makeService(env, gateway)
    const frames = await collect(service.run(documentId, { language: 'zh' }))
    expect(errorsOf(frames)).toEqual([])
    const sectionCalls = gateway.calls.filter((call) => call.system === DEEPREAD_SECTION_SYSTEM)
    const discussion = sectionCalls.find((call) => promptSection(call.prompt) === '6 Discussion')
    expect(discussion).toBeDefined()
    expect(discussion?.prompt).toMatch(/Section role lens \(limitation\)/)
    expect(discussion?.prompt).toMatch(/Reader language: zh/)
    expect(reportOf(frames).report.problem.detail.length).toBeGreaterThan(0)

    // Malformed map output → deterministic map from the title/outline/abstract.
    const env2 = createStore({ docs: [{ id: documentId, title: 'Map Paper' }], markdown: { [documentId]: PAPER } })
    const gateway2 = createGateway(defaultScripts({ map: () => 'I cannot produce that map.' }))
    const service2 = makeService(env2, gateway2)
    const frames2 = await collect(service2.run(documentId))
    expect(errorsOf(frames2)).toEqual([])
    expect(gateway2.counts.map).toBe(1)
    const sectionPrompts = gateway2.calls
      .filter((call) => call.system === DEEPREAD_SECTION_SYSTEM)
      .map((call) => call.prompt)
    expect(sectionPrompts.some((prompt) => prompt.includes('Problem: Model Context Protocol servers give'))).toBe(true)
  })

  test('section prompts carry the map, rolling memory and role lens; references are never read', async () => {
    const documentId = 'doc-prompts'
    const env = createStore({ docs: [{ id: documentId, title: 'Prompt Paper' }], markdown: { [documentId]: PAPER } })
    const gateway = createGateway(defaultScripts())
    const service = makeService(env, gateway)
    const frames = await collect(service.run(documentId, { language: 'zh' }))
    expect(errorsOf(frames)).toEqual([])
    const sectionCalls = gateway.calls.filter((call) => call.system === DEEPREAD_SECTION_SYSTEM)
    expect(sectionCalls.length).toBe(11)
    for (const call of sectionCalls) {
      expect(call.prompt).toMatch(/Paper map \(reading plan/)
      expect(call.prompt).toMatch(/Reader language: zh/)
      expect(call.prompt).toMatch(/Section role lens \(/)
      expect(call.prompt).not.toContain('Smith et al. Prompting is not a boundary')
      expect(promptSection(call.prompt)).not.toBe('References')
    }
    // The first read section updates the memory the next prompt receives.
    expect(sectionCalls[1]?.prompt).toMatch(/Reading memory/)
    expect(sectionCalls[1]?.prompt).toContain('第 1 节说明了')
    // The method section gets the method lens.
    const method = sectionCalls.find((call) => promptSection(call.prompt).includes('Agent Manifests'))
    expect(method?.prompt).toMatch(/Method lens|Unclassified section/)
    expect(method?.prompt).toMatch(/Section role lens/)

    // Deterministic and capped selection: same paper, max 4 chunks, no gap pass.
    const runs: string[][] = []
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const attemptEnv = createStore({ docs: [{ id: documentId, title: 'Prompt Paper' }], markdown: { [documentId]: PAPER } })
      const attemptGateway = createGateway(defaultScripts())
      const attemptService = makeService(attemptEnv, attemptGateway, { deepReadMaxChunks: 4 })
      const attemptFrames = await collect(attemptService.run(documentId))
      expect(errorsOf(attemptFrames)).toEqual([])
      const selected = attemptGateway.calls
        .filter((call) => call.system === DEEPREAD_SECTION_SYSTEM)
        .map((call) => promptSection(call.prompt))
      expect(selected.length).toBe(4)
      runs.push(selected)
    }
    expect(runs[0]).toEqual(runs[1])
    expect(runs[0]).toEqual(['4 Experiments', '5 Results', '6 Discussion', '7 Limitations'])
  })

  test('verifies quotes and rejects metadata, trivial notes and quote restatements', async () => {
    const documentId = 'doc-verify'
    const env = createStore({ docs: [{ id: documentId, title: 'Verify Paper' }], markdown: { [documentId]: ONE_SECTION_PAPER } })
    const blocks = blocksOf(ONE_SECTION_PAPER)
    const paragraph = blocks.find((block) => block.kind === 'paragraph')
    expect(paragraph).toBeDefined()
    const quote = paragraph !== undefined ? normalizeQuoteText(paragraph.text).slice(0, 120) : ''
    const drifted = quote.replace(/ /g, '  ')
    const longNote = `${NOTE_EN} `.repeat(30)
    const gateway = createGateway(
      defaultScripts({
        section: (prompt) => {
          const lines = promptBlocks(prompt)
          const target = lines.find((line) => line.text.startsWith('An AgentManifest')) ?? lines[lines.length - 1]
          if (target === undefined) return deepReadSectionText({})
          const headingLine = lines[0]
          return deepReadSectionText({
            summary: '摘要',
            annotations: [
              // 1. valid quote with whitespace drift → accepted (normalized).
              { blockKey: target.key, quote: drifted, aspect: 'method', note: NOTE_EN, importance: 4 },
              // 2. unknown block key → rejected.
              { blockKey: 'b999:deadbeef', quote: quote, aspect: 'method', note: NOTE_EN, importance: 4 },
              // 3. quote not found in the block → rejected.
              {
                blockKey: target.key,
                quote: 'completely absent sentence about quantum computing',
                aspect: 'method',
                note: NOTE_EN,
                importance: 4,
              },
              // 4. too-short note → rejected.
              { blockKey: target.key, quote, aspect: 'result', note: '太短了', importance: 4 },
              // 5. note merely restates the quote → rejected.
              { blockKey: target.key, quote, aspect: 'result', note: quote, importance: 4 },
              // 6. overlong note → accepted, bounded to 700 chars.
              { blockKey: target.key, quote, aspect: 'limitation', note: longNote, importance: 9 },
              // 7. heading block quote → rejected.
              {
                blockKey: headingLine?.key ?? target.key,
                quote: headingLine?.text ?? 'Method',
                aspect: 'context',
                note: NOTE_EN,
                importance: 3,
              },
            ],
            points: [
              { kind: 'claim', text: '执行层检查必要。', blockKeys: [target.key, 'b999:deadbeef'] },
              { kind: 'question', text: '清单由谁审核？', blockKeys: [] },
            ],
          })
        },
      }),
    )
    const service = makeService(env, gateway)
    const frames = await collect(service.run(documentId))
    expect(errorsOf(frames)).toEqual([])
    const record = reportOf(frames)
    expect(record.stats.candidates).toBe(4)
    expect(record.highlights.length).toBe(2)
    const aspects = record.highlights.map((highlight) => highlight.aspect).sort()
    expect(aspects).toEqual(['limitation', 'method'])
    const normalized = record.highlights.find((highlight) => highlight.aspect === 'method')
    expect(normalized?.quote).toBe(quote.trim())
    const long = record.highlights.find((highlight) => highlight.aspect === 'limitation')
    expect(long?.note.length).toBeLessThanOrEqual(700)
    expect(long?.note.length).toBeGreaterThan(700 / 2)
    expect(long?.importance).toBe(5)

    // Metadata paper: title line, acknowledgement sentence, figure label and
    // an author line are all rejected even though the quotes verify.
    const metaId = 'doc-metadata'
    const metaEnv = createStore({ docs: [{ id: metaId, title: 'Metadata Paper' }], markdown: { [metaId]: METADATA_PAPER } })
    const metaGateway = createGateway(
      defaultScripts({
        section: (prompt) => {
          const lines = promptBlocks(prompt)
          const annotations: Record<string, unknown>[] = []
          for (const line of lines) {
            if (!line.text.includes('An AgentManifest')) continue
            annotations.push(annotationFor(line, 'method', NOTE_EN))
          }
          for (const line of lines) {
            if (line.text.startsWith('We thank')) annotations.push(annotationFor(line, 'context', NOTE_EN))
            if (line.text.startsWith('Figure 3')) annotations.push(annotationFor(line, 'context', NOTE_EN))
            if (line.text.startsWith('Alice Zhang')) annotations.push(annotationFor(line, 'context', NOTE_EN))
          }
          return deepReadSectionText({ summary: '元数据测试', annotations, points: [] })
        },
      }),
    )
    const metaFrames = await collect(makeService(metaEnv, metaGateway).run(metaId))
    expect(errorsOf(metaFrames)).toEqual([])
    const metaRecord = reportOf(metaFrames)
    expect(metaRecord.stats.candidates).toBe(3)
    expect(metaRecord.highlights.length).toBe(1)
    expect(metaRecord.highlights[0]?.quote).toContain('An AgentManifest')
  })

  test('malformed chunk JSON is skipped and a total failure answers llm-failed', async () => {
    const documentId = 'doc-malformed'
    const env = createStore({ docs: [{ id: documentId, title: 'Malformed' }], markdown: { [documentId]: PAPER } })
    let callIndex = 0
    const gateway = createGateway(
      defaultScripts({
        section: (prompt, index) => {
          callIndex += 1
          if (callIndex === 1) return 'I am afraid I cannot return JSON for this chunk.'
          return defaultSection(prompt, index)
        },
      }),
    )
    const service = makeService(env, gateway)
    const frames = await collect(service.run(documentId))
    expect(errorsOf(frames)).toEqual([])
    const record = reportOf(frames)
    expect(record.stats.chunksRead).toBeLessThan(record.stats.chunks)
    expect(record.stats.chunksRead).toBeGreaterThan(0)

    const failingEnv = createStore({ docs: [{ id: documentId, title: 'Malformed' }], markdown: { [documentId]: PAPER } })
    const failingGateway = createGateway(defaultScripts({ section: () => 'still not json' }))
    const failingFrames = await collect(makeService(failingEnv, failingGateway).run(documentId))
    const errors = errorsOf(failingFrames)
    expect(errors.length).toBe(1)
    expect(errors[0]?.code).toBe('llm-failed')
    expect(failingEnv.aux.get(`${documentId}/deepread.json`)).toBeUndefined()
    expect(failingEnv.annotations.get(documentId) ?? []).toEqual([])
  })

  test('coverage pass re-reads only uncovered content sections and is capped at four', async () => {
    const documentId = 'doc-gaps'
    const env = createStore({ docs: [{ id: documentId, title: 'Gap Paper' }], markdown: { [documentId]: PAPER } })
    const gateway = createGateway(
      defaultScripts({
        section: (prompt) => {
          const section = promptSection(prompt)
          if (section === 'Abstract' || section === '1 Introduction') return defaultSection(prompt, 0)
          return deepReadSectionText({ summary: '第一次阅读没有留下批注。', annotations: [], points: [] })
        },
      }),
    )
    const service = makeService(env, gateway, { deepReadCoveragePass: true })
    const frames = await collect(service.run(documentId))
    expect(errorsOf(frames)).toEqual([])
    expect(gateway.counts.gap).toBe(4)
    const gapSections = gateway.calls
      .filter((call) => call.system === DEEPREAD_GAP_SYSTEM)
      .map((call) => promptSection(call.prompt))
    expect(gapSections).toEqual(['4 Experiments', '5 Results', '7 Limitations', '6 Discussion'])
    expect(gapSections).not.toContain('Abstract')
    expect(gapSections).not.toContain('1 Introduction')
    const gapProgress = progressOf(frames).filter((frame) => frame.phase === 'gaps')
    expect(gapProgress[0]?.done).toBe(0)
    expect(gapProgress[gapProgress.length - 1]?.done).toBe(4)
    expect(gapProgress[gapProgress.length - 1]?.total).toBe(4)
    expect(reportOf(frames).stats.coverage).toBeGreaterThan(0)

    // Disabled: no gap call at all.
    const offGateway = createGateway(
      defaultScripts({
        section: (prompt) => {
          const section = promptSection(prompt)
          if (section === 'Abstract') return defaultSection(prompt, 0)
          return deepReadSectionText({})
        },
      }),
    )
    const offFrames = await collect(makeService(env, offGateway, { deepReadCoveragePass: false }).run(documentId, { force: true }))
    expect(errorsOf(offFrames)).toEqual([])
    expect(offGateway.counts.gap).toBe(0)
  })

  test('judge drops score-0 candidates and fails open on model errors', async () => {
    const documentId = 'doc-judge'
    const env = createStore({ docs: [{ id: documentId, title: 'Judge Paper' }], markdown: { [documentId]: PAPER } })
    const gateway = createGateway(
      defaultScripts({
        judge: (prompt) =>
          deepReadJudgeText(
            judgeIds(prompt).map((id) => ({
              id,
              score: id === 1 ? 2 : 0,
              reason: id === 1 ? 'adds interpretation' : 'no new reading',
            })),
          ),
      }),
    )
    const frames = await collect(makeService(env, gateway, { deepReadJudge: true }).run(documentId))
    expect(errorsOf(frames)).toEqual([])
    const record = reportOf(frames)
    expect(record.stats.candidates).toBeGreaterThan(1)
    expect(record.highlights.length).toBe(1)
    expect(record.stats.kept).toBe(1)
    expect(record.stats.skipped).toBe(record.stats.candidates - 1)

    // A throwing judge keeps every candidate (fail open).
    const openEnv = createStore({ docs: [{ id: documentId, title: 'Judge Paper' }], markdown: { [documentId]: PAPER } })
    const openGateway = createGateway(
      defaultScripts({
        judge: () => {
          throw new Error('judge model down')
        },
      }),
    )
    const openFrames = await collect(makeService(openEnv, openGateway, { deepReadJudge: true }).run(documentId))
    expect(errorsOf(openFrames)).toEqual([])
    expect(reportOf(openFrames).highlights.length).toBeGreaterThan(1)
    expect(openEnv.calls.mutate).toBe(1)

    // An unparsable judge answer is also a failure: keep every candidate.
    const garbageEnv = createStore({ docs: [{ id: documentId, title: 'Judge Paper' }], markdown: { [documentId]: PAPER } })
    const garbageGateway = createGateway(defaultScripts({ judge: () => 'I think they are all fine.' }))
    const garbageFrames = await collect(makeService(garbageEnv, garbageGateway, { deepReadJudge: true }).run(documentId))
    expect(errorsOf(garbageFrames)).toEqual([])
    expect(reportOf(garbageFrames).highlights.length).toBeGreaterThan(1)
  })

  test('dedupes against existing annotations and caps the kept annotations', async () => {
    const documentId = 'doc-dedupe'
    const existing = seedAnnotation(TWO_PARAGRAPH_PAPER, 'An AgentManifest declares', 'method')
    const env = createStore({ docs: [{ id: documentId, title: 'Dedupe Paper' }], markdown: { [documentId]: TWO_PARAGRAPH_PAPER } })
    env.annotations.set(documentId, [existing])
    const gateway = createGateway(defaultScripts())
    const frames = await collect(makeService(env, gateway).run(documentId))
    expect(errorsOf(frames)).toEqual([])
    const record = reportOf(frames)
    expect(record.stats.candidates).toBe(2)
    expect(record.highlights.length).toBe(1)
    const stored = env.annotations.get(documentId) ?? []
    expect(stored.some((annotation) => annotation.id === existing.id)).toBe(true)
    expect(stored.length).toBe(2)
    expect(env.calls.mutate).toBe(1)

    // Cap: an annotation-rich paper with deepReadMaxAnnotations = 8 yields 8.
    const capEnv = createStore({ docs: [{ id: documentId, title: 'Cap Paper' }], markdown: { [documentId]: PAPER } })
    const capGateway = createGateway(defaultScripts())
    const capFrames = await collect(makeService(capEnv, capGateway, { deepReadMaxAnnotations: 8 }).run(documentId))
    expect(errorsOf(capFrames)).toEqual([])
    const capRecord = reportOf(capFrames)
    expect(capRecord.stats.candidates).toBeGreaterThan(8)
    expect(capRecord.highlights.length).toBe(8)
    expect(capRecord.stats.kept).toBe(8)
  })

  test('annotation persistence falls back to load/save when mutateAnnotations is missing', async () => {
    const documentId = 'doc-fallback-save'
    const env = createStore({
      docs: [{ id: documentId, title: 'Fallback Paper' }],
      markdown: { [documentId]: ONE_SECTION_PAPER },
      mutate: false,
    })
    const gateway = createGateway(defaultScripts())
    const frames = await collect(makeService(env, gateway).run(documentId))
    expect(errorsOf(frames)).toEqual([])
    expect(env.calls.save).toBe(1)
    const record = reportOf(frames)
    expect(record.highlights.length).toBeGreaterThan(0)
    expect(record.highlights.every((highlight) => highlight.annotationId !== '')).toBe(true)
    expect(env.annotations.get(documentId)?.length).toBe(record.highlights.length)
  })

  test('validates the report bounds/keys and falls back to a deterministic report', async () => {
    const documentId = 'doc-report'
    const env = createStore({ docs: [{ id: documentId, title: 'Report Paper' }], markdown: { [documentId]: PAPER } })
    const gateway = createGateway(
      defaultScripts({
        report: (prompt) => {
          const key = reportKeys(prompt)[0] ?? ''
          return deepReadReportText({
            tldr: Array.from({ length: 8 }, (_, index) => `takeaway ${index} ${'x'.repeat(400)}`),
            problem: {
              label: 'L'.repeat(300),
              detail: 'D'.repeat(900),
              blockKeys: [key, 'b999:deadbeef'],
            },
            gap: { label: 'gap', detail: 'gap detail' },
            contributions: [
              { label: 'c', detail: 'contribution detail', blockKeys: [key], evidence: 'amazing' },
            ],
            method: [],
            evaluation: [],
            findings: [],
            limitations: [],
            openQuestions: [],
            argumentMap: Array.from({ length: 12 }, (_, index) => ({
              from: `from ${index}`,
              to: `to ${index}`,
              relation: 'supports',
            })),
            glossary: Array.from({ length: 20 }, (_, index) => ({ term: `term ${index}`, definition: 'd' })),
            readingPath: ['a', 'b', 'c', 'd', 'e'],
            verdict: { strengths: ['s'], weaknesses: ['w'], confidence: 'certain' },
          })
        },
      }),
    )
    const frames = await collect(makeService(env, gateway).run(documentId))
    expect(errorsOf(frames)).toEqual([])
    const record = reportOf(frames)
    const knownKeys = new Set(blocksOf(PAPER).map((block) => block.key))
    expect(record.report.tldr.length).toBe(5)
    expect(record.report.tldr.every((item) => item.length <= 200)).toBe(true)
    expect(record.report.problem.label.length).toBe(90)
    expect(record.report.problem.detail.length).toBe(500)
    expect(record.report.problem.blockKeys.length).toBe(1)
    expect(record.report.problem.blockKeys.every((key) => knownKeys.has(key))).toBe(true)
    expect(record.report.contributions[0]?.evidence).toBe('partial')
    expect(record.report.argumentMap.length).toBe(8)
    expect(record.report.glossary.length).toBe(12)
    expect(record.report.readingPath.length).toBe(3)
    expect(record.report.verdict.confidence).toBe('medium')

    // Malformed synthesis → deterministic fallback report built from the map,
    // section summaries and selected annotations.
    const fallbackEnv = createStore({ docs: [{ id: documentId, title: 'Report Paper' }], markdown: { [documentId]: PAPER } })
    const fallbackGateway = createGateway(defaultScripts({ report: () => 'sorry, no report today' }))
    const fallbackFrames = await collect(makeService(fallbackEnv, fallbackGateway).run(documentId))
    expect(errorsOf(fallbackFrames)).toEqual([])
    const fallback = reportOf(fallbackFrames)
    expect(fallback.report.tldr.length).toBeGreaterThan(0)
    expect(fallback.report.problem.detail).toBe('How can tool permissions be enforced against an adversarial model?')
    expect(fallback.report.gap.detail).toBe('Prompt-level guardrails cannot be enforced.')
    expect(fallback.report.contributions[0]?.detail).toContain('Manifest-based execution-layer')
    expect(fallback.report.contributions[0]?.evidence).toBe('partial')
    expect(fallback.report.verdict.confidence).toBe('medium')
    expect(fallback.report.limitations.length).toBeGreaterThanOrEqual(0)
    expect(fallback.report.glossary.length).toBe(3)
    expect(fallback.report.readingPath.length).toBeGreaterThan(0)
  })

  test('aborts before and during a run without writing anything', async () => {
    const documentId = 'doc-abort'
    const env = createStore({ docs: [{ id: documentId, title: 'Abort Paper' }], markdown: { [documentId]: PAPER } })
    const gateway = createGateway(defaultScripts())
    const service = makeService(env, gateway)

    const before = new AbortController()
    before.abort()
    const abortedFrames = await collect(service.run(documentId, { signal: before.signal }))
    expect(errorsOf(abortedFrames).length).toBe(1)
    expect(errorsOf(abortedFrames)[0]?.code).toBe('aborted')
    expect(env.aux.get(`${documentId}/deepread.json`)).toBeUndefined()
    expect(env.calls.mutate).toBe(0)

    const during = new AbortController()
    const duringGateway = createGateway(
      defaultScripts({
        section: (prompt, index) => {
          during.abort()
          return defaultSection(prompt, index)
        },
      }),
    )
    const duringEnv = createStore({ docs: [{ id: documentId, title: 'Abort Paper' }], markdown: { [documentId]: PAPER } })
    const duringService = makeService(duringEnv, duringGateway)
    const duringFrames = await collect(duringService.run(documentId, { signal: during.signal }))
    const duringErrors = errorsOf(duringFrames)
    expect(duringErrors.length).toBe(1)
    expect(duringErrors[0]?.code).toBe('aborted')
    expect(duringEnv.aux.get(`${documentId}/deepread.json`)).toBeUndefined()
    expect(duringEnv.calls.mutate).toBe(0)
    expect(duringEnv.annotations.get(documentId) ?? []).toEqual([])
  })

  test('language flows into prompts, invalid ids default to en, and corrupt records normalize to null', async () => {
    const documentId = 'doc-language'
    const env = createStore({ docs: [{ id: documentId, title: 'Language Paper' }], markdown: { [documentId]: PAPER } })
    const gateway = createGateway(defaultScripts())
    const service = makeService(env, gateway)
    const frames = await collect(service.run(documentId, { language: 'zh' }))
    expect(errorsOf(frames)).toEqual([])
    expect(reportOf(frames).language).toBe('zh')
    const promptCalls = gateway.calls.filter((call) => call.system !== DEEPREAD_JUDGE_SYSTEM)
    expect(promptCalls.length).toBeGreaterThan(0)
    for (const call of promptCalls) expect(call.prompt).toMatch(/Reader language: zh/)

    const invalid = await collect(service.run(documentId, { force: true, language: 'EN_US!' }))
    expect(errorsOf(invalid)).toEqual([])
    const forcedRecord = reportOf(invalid)
    expect(forcedRecord.language).toBe('en')
    expect(forcedRecord.generatedAt).not.toBe('')
    // The forced re-run dedupes against the annotations the first run created.
    const forcedAnnotations = invalid.find((frame) => frame.type === 'annotations')
    expect(forcedAnnotations?.type === 'annotations' ? forcedAnnotations.created : -1).toBe(0)
    expect(forcedRecord.highlights.length).toBe(0)
    expect(forcedRecord.stats.kept).toBe(0)
    expect(await service.get(documentId)).toEqual(forcedRecord)

    // Corrupt / mismatched records read as "never deep-read".
    const corruptEnv = createStore({ docs: [{ id: documentId, title: 'Language Paper' }], markdown: { [documentId]: PAPER } })
    const corruptService = makeService(corruptEnv, createGateway(defaultScripts()))
    corruptEnv.aux.set(`${documentId}/deepread.json`, { version: 2, documentId, report: { tldr: ['x'] } })
    expect(await corruptService.get(documentId)).toBeNull()
    corruptEnv.aux.set(`${documentId}/deepread.json`, { version: 1, documentId: 'other-doc', report: { tldr: ['x'] } })
    expect(await corruptService.get(documentId)).toBeNull()
    corruptEnv.aux.set(`${documentId}/deepread.json`, { version: 1, documentId, report: {} })
    expect(await corruptService.get(documentId)).toBeNull()
    // A corrupt record forces a fresh run instead of a broken replay.
    const freshGateway = createGateway(defaultScripts())
    const freshService = makeService(corruptEnv, freshGateway)
    const fresh = await collect(freshService.run(documentId))
    expect(errorsOf(fresh)).toEqual([])
    expect(freshGateway.counts.map).toBe(1)
    expect(await freshService.get(documentId)).not.toBeNull()
  })

  test('truncates oversized papers, reports it in stats and maps the tail outline', async () => {
    const documentId = 'doc-truncated'
    const tailSection = `## Late Section\n\n${'Additional prose about manifest review. '.repeat(2000)}`
    const huge = `${PAPER}\n\n## Appendix A\n\n${'Extended results and additional experiments. '.repeat(500)}\n\n${tailSection}`
    const env = createStore({ docs: [{ id: documentId, title: 'Huge Paper' }], markdown: { [documentId]: huge } })
    const gateway = createGateway(defaultScripts())
    const frames = await collect(
      makeService(env, gateway, { deepReadMaxSourceChars: 20000, deepReadMaxChunks: 8 }).run(documentId),
    )
    expect(errorsOf(frames)).toEqual([])
    const record = reportOf(frames)
    expect(record.stats.truncated).toBe(true)
    const mapCall = gateway.calls.find((call) => call.system === DEEPREAD_MAP_SYSTEM)
    expect(mapCall).toBeDefined()
    expect(mapCall?.prompt).toMatch(/the paper is longer than the source budget/)
    expect(mapCall?.prompt).toContain('Late Section')
  })

  test('supports a gateway exposing only streamText (collected with usage)', async () => {
    const documentId = 'doc-stream'
    const env = createStore({ docs: [{ id: documentId, title: 'Stream Paper' }], markdown: { [documentId]: ONE_SECTION_PAPER } })
    const counters = { map: 0, section: 0, gap: 0, judge: 0, report: 0 }
    const gateway: DeepReadLlmApi = {
      available: () => true,
      route: () => ({ provider: 'stream-provider', model: 'stream-model' }),
      streamText: (request) => {
        const system = typeof request.system === 'string' ? request.system : ''
        const text =
          system === DEEPREAD_MAP_SYSTEM
            ? defaultMap()
            : system === DEEPREAD_SECTION_SYSTEM
              ? defaultSection(promptOf(request as LlmCompleteRequest), ++counters.section)
              : system === DEEPREAD_REPORT_SYSTEM
                ? defaultReport(promptOf(request as LlmCompleteRequest))
                : system === DEEPREAD_GAP_SYSTEM
                  ? defaultGap(promptOf(request as LlmCompleteRequest), 1)
                  : ''
        async function* frames(): AsyncGenerator<unknown> {
          yield { type: 'delta', text: text.slice(0, 20) }
          yield { type: 'delta', text: text.slice(20) }
          yield { type: 'usage', usage: { inputTokens: 123, outputTokens: 45 } }
        }
        return frames()
      },
    }
    const service = createDeepReadService({
      llm: gateway,
      store: env.store,
      config: { ai: { deepReadCoveragePass: false, deepReadJudge: false } },
      logger: { warn(): void {} },
      readMarkdown: (id) => env.store.readMarkdown!(id),
    })
    const frames = await collect(service.run(documentId))
    expect(errorsOf(frames)).toEqual([])
    const record = reportOf(frames)
    expect(record.model).toEqual({ provider: 'stream-provider', model: 'stream-model' })
    expect(record.highlights.length).toBeGreaterThan(0)
    expect(record.stats.inputTokens).toBeGreaterThan(0)
    expect(record.stats.outputTokens).toBeGreaterThan(0)
  })
})

