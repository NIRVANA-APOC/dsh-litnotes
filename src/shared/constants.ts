/**
 * Shared constants for both halves of the dsh-litnotes plugin.
 *
 * This module is imported by the Host bundle (`index.js`) and by the Client
 * bundle (`lib/client.js`), so it must stay dependency-free, side-effect free
 * and environment-neutral (no `node:` imports, no DOM access).
 */

/** Cordis plugin name; also the client module id and the locale namespace. */
export const NS = 'dsh-litnotes'

/** Keyed `main` slot id and sidebar panel id. */
export const PANEL_ID = 'litnotes'

/** Route mount points served by the Host half (no trailing slash). */
export const API_PREFIX = '/dsh-litnotes/api'
export const ASSETS_PREFIX = '/dsh-litnotes/assets'

/** JSON API body cap (bytes); mirrors the Host reader. */
export const MAX_JSON_BODY = 2 * 1024 * 1024

/** Concurrency baseline cap for `annotations.save` (ids the client had loaded). */
export const MAX_BASE_IDS = 5000

/** Upload headers (raw body stream, no multipart). */
export const UPLOAD_HEADERS = {
  fileName: 'x-file-name',
  docTitle: 'x-doc-title',
} as const

/** Aspect vocabulary shared by citations, annotations and graph nodes. */
export const ASPECTS = ['definition', 'method', 'result', 'limitation', 'context'] as const
export type Aspect = (typeof ASPECTS)[number]

/** Aspect → annotation ink colour (`context` shares the definition ink). */
export const ASPECT_COLORS: Record<Aspect, 'yellow' | 'sage' | 'sky' | 'rose'> = {
  definition: 'yellow',
  method: 'sage',
  result: 'sky',
  limitation: 'rose',
  context: 'yellow',
}

/** Annotation ink colours, in swatch order. */
export const ANNOTATION_COLORS = ['yellow', 'sage', 'sky', 'rose'] as const
export type AnnotationColor = (typeof ANNOTATION_COLORS)[number]

/** Reading modes: original English, stacked bilingual, translated only. */
export const READING_MODES = ['original', 'bilingual', 'translated'] as const
export type ReadingMode = (typeof READING_MODES)[number]

/** Allowed reading scales (body size multipliers). */
export const READING_SCALES = [0.9, 1, 1.12] as const

/** Reading measure presets in CSS px (narrow / standard / wide / full). */
export const READING_MEASURES = [500, 560, 700, 840] as const

/** Document-width presets for the shared reading/graph column. */
export const DOC_WIDTHS = [720, 880, 1040, 1200] as const

/** Parse engines. */
export const PARSE_ENGINES = ['auto', 'standard', 'agent', 'local'] as const
export type ParseEngine = (typeof PARSE_ENGINES)[number]

/** Local parse providers. */
export const LOCAL_PROVIDERS = ['auto', 'builtin', 'system:officeToPdf'] as const
export type LocalProvider = (typeof LOCAL_PROVIDERS)[number]

/** MinerU standard-API model versions. */
export const MODEL_VERSIONS = ['pipeline', 'vlm'] as const
export type ModelVersion = (typeof MODEL_VERSIONS)[number]

/** MinerU document languages (value → locale key). */
export const LANGUAGE_OPTIONS = [
  ['ch', 'setup.langCh'],
  ['en', 'setup.langEn'],
  ['japan', 'setup.langJapan'],
  ['korean', 'setup.langKorean'],
  ['fr', 'setup.langFr'],
  ['de', 'setup.langDe'],
  ['ru', 'setup.langRu'],
  ['es', 'setup.langEs'],
  ['ar', 'setup.langAr'],
] as const

/** Target languages offered for translation (value → label). */
export const TARGET_LANGUAGE_OPTIONS = [
  ['zh', '中文'],
  ['en', 'English'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['ru', 'Русский'],
  ['es', 'Español'],
] as const

/** Supported source extensions (lowercase, with dot). */
export const SUPPORTED_EXTENSIONS: readonly string[] = [
  '.pdf',
  '.doc',
  '.docx',
  '.ppt',
  '.pptx',
  '.xls',
  '.xlsx',
  '.png',
  '.jpg',
  '.jpeg',
  '.jp2',
  '.webp',
  '.gif',
  '.bmp',
  '.html',
  '.htm',
]

/** Extensions rendered as images inside the reader. */
export const IMAGE_EXTENSIONS: readonly string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.jp2',
  '.webp',
  '.gif',
  '.bmp',
  '.svg',
]

/** Office extensions handled by the local T0.5 path. */
export const OFFICE_EXTENSIONS: readonly string[] = ['.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx']

/** `<input accept>` string for the file picker. */
export const ACCEPT_ATTR = SUPPORTED_EXTENSIONS.join(',')

/** Credential record key for the MinerU token (namespaced by this plugin). */
export const TOKEN_KEY = 'dsh-litnotes/mineru-token'

/** Default data directory (`$DSH_HOME` respected by the Host). */
export const DEFAULT_DATA_DIR = '~/.dsh/litnotes'

/** Legacy data directory of the pre-1.0 plugin. Never read; kept only to reject config. */
export const LEGACY_DATA_DIR_HINT = '.dsh/mineru'

/** Knowledge-graph node and edge vocabularies. */
export const GRAPH_NODE_TYPES = [
  'concept',
  'method',
  'finding',
  'definition',
  'limitation',
  'section',
  'question',
  'insight',
  'paper',
  'topic',
] as const
export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number]

export const GRAPH_EDGE_TYPES = [
  'defines',
  'uses',
  'supports',
  'contradicts',
  'part_of',
  'leads_to',
  'evolves_from',
  'relates',
  'answers',
  'mentions',
  'shares',
] as const
export type GraphEdgeType = (typeof GRAPH_EDGE_TYPES)[number]

/** Answer aspects used by citations (subset of `ASPECTS`). */
export const CITATION_ASPECTS = ['definition', 'method', 'result', 'limitation', 'context'] as const

/** Wire error codes shared by Host responses and Client branches. */
export const WIRE_ERROR_CODES = [
  'bad-request',
  'bad-upload',
  'forbidden',
  'not-found',
  'not-parsed',
  'unsupported-type',
  'too-large',
  'token-missing',
  'token-persist-failed',
  'local-unsupported',
  'local-missing-tool',
  'local-empty-text',
  'local-encrypted',
  'local-failed',
  'translate-unavailable',
  'llm-unavailable',
  'llm-failed',
  'context-too-large',
  'ai-failed',
  'aborted',
  'conflict',
  'method-not-allowed',
  'internal',
] as const
export type WireErrorCode = (typeof WIRE_ERROR_CODES)[number]
