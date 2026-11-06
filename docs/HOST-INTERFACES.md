# Host module interfaces (exact signatures)

`host-core` implements these; `index.js` (Lead) imports exactly these names. Keep them stable.
All modules are plain ESM under `lib/`, use only `node:` builtins, and never import each other
in a cycle (dependency direction: `wire/mime/config` ← `store/mineru/unzip` ←
`local-pdf/local-synth/local-office` ← `local-engine` ← `parse-manager` ← `service` ←
`routes/agent-tool`). The local engine is independent of the MinerU client: `local-engine`
imports the three local helpers plus `wire`, and `parse-manager`/`service` consume it as an
injected facade.

## lib/wire.js

```js
export class WireError extends Error {
  constructor(code, message, status = 400, meta)
}
export async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) // object
export async function readTextBody(req, maxBytes)                  // utf8 string
export function writeJson(res, status, value)                      // JSON body, content-type
export function writeOk(res, value)                                // 200 {ok:true,value}
export function writeError(res, error)                             // maps WireError; unknown → 500
export function requireString(payload, key)                        // trimmed non-empty string
export function safeDecode(value)                                  // decodeURIComponent, fallback raw
```

## lib/mime.js

```js
export const SUPPORTED_EXTENSIONS // Set: .pdf .doc .docx .ppt .pptx .xls .xlsx .png .jpg
                                  // .jpeg .jp2 .webp .gif .bmp .html .htm
export const IMAGE_EXTENSIONS     // Set of image extensions (.svg too, for assets)
export function extOf(fileName)   // '.pdf' lowercased, '' when none
export function mimeForPath(path) // content type; unknown → application/octet-stream
export function isSupportedSource(fileName) // boolean
```

## lib/config.js

```js
export const TOKEN_KEY = 'dsh-litnotes/mineru-token'
export const DEFAULT_PREFERENCES
// { targetLanguage:'zh', translationProvider:'auto', readingMode:'original',
//   readingScale:1, defaultEngine:'auto', defaultModelVersion:'vlm',
//   defaultLanguage:'ch', defaultIsOcr:false, defaultEnableFormula:true,
//   defaultEnableTable:true, showPageMarks:true, autoAllowAgentFallback:true }
export function resolveConfig(rawConfig) // { dataDir, apiBase, maxUploadBytes,
  // maxConcurrentParses, pollIntervalMs, parseTimeoutMs, toolMaxChars, local, hostVersion }
  // dataDir: '~' expanded, $DSH_HOME respected, default '~/.dsh/litnotes'
  // local: { enabled, maxPages, maxPdfBytes, maxTextBytes, minCharsPerPage,
  //          maxParagraphChars, keepContentList, timeoutMs, maxOfficePdfBytes }
export const PACKAGE_VERSION
export async function getToken(credentials)          // string | undefined
export async function setToken(credentials, token)   // stores ApiKeyRecord
export async function clearToken(credentials)        // deleteRecord
export async function isTokenPersistent(credentials) // boolean
export function normalizeToken(token)                // string; throws WireError('bad-request')
export function normalizePreferences(prefs)          // validated, merged with defaults
export async function loadPreferences(dataDir)       // merged with defaults
export async function savePreferences(dataDir, prefs) // validated+merged, returns full prefs
```

`defaultEngine` (`auto|standard|agent|local`) and `autoAllowAgentFallback` (boolean) are
validated preferences; the local block is validated/clamped in `lib/config.js` (defaults mirror
`DEFAULT_LOCAL_CONFIG` in `lib/local-engine.js`, docs/ARCH.md §5.5).

`credentials` is `ctx.get('credentials')` (may be undefined; then getToken reads a module-level
in-memory fallback, setToken stores it there, status reports `tokenPersistent:false`).

## lib/store.js

```js
export function createStore({ dataDir, logger })
// All methods below may be called before init() resolves: they await the same init promise.
  .init()                    // mkdirs, clean stale tmp, scan documents/*/meta.json
  .list()                    // meta[] newest first (in-memory copies)
  .get(id)                   // meta | undefined
  .docDir(id)                // absolute path (id validated UUID)
  .sourcePath(id)            // absolute path to source.<ext> (throws not-found)
  .parsedDir(id)             // absolute path <docDir>/parsed
  .createFromFile({ id, tempPath, originalName, title? })
                             // stream sha256+size, move into place, write meta; returns meta
  .newTempPath(id)           // <dataDir>/tmp/<id>.part
  .update(id, patch)         // shallow-merge top-level + merge patch.parse if present; persists; meta
  .remove(id)                // rm -rf doc dir; removes from memory
  .readMarkdown(id)          // { markdown, contentList, pages } ; throws WireError('not-parsed')
  .loadAnnotations(id)       // { version:1, items:[] }
  .saveAnnotations(id, data) // validates shape minimally; persists; returns data
  .loadTranslations(id)      // { version:1, targetLanguage, entries:{} }
  .saveTranslations(id, data)
  .stats()                   // { total, parsed, parsing, failed }
  .appendDiagnostic(entry)   // one JSON line, cap 200 lines, never throws
  .dispose()                 // await pending writes; idempotent
```

## lib/mineru.js

```js
export class MineruError extends Error { code; httpStatus; detail }
export function createMineruClient({ getToken, apiBase, fetchImpl, logger })
  // all methods throw MineruError; fetchImpl defaults to globalThis.fetch
  .standardCreateBatch({ fileName, dataId, options }) // → { batchId, uploadUrl }
  .putBytes(uploadUrl, bytes)                         // PUT, no content-type
  .standardBatchResult(batchId)                       // → { results:[{data_id,file_name,state,
                                                      //     fullZipUrl,errMsg,progress}] }
  .agentCreateTask({ fileName, options })             // → { taskId, uploadUrl }
  .agentTaskResult(taskId)                            // → { state, markdownUrl, errMsg, errCode }
  .downloadBytes(url, { maxBytes })                   // → Buffer (follows redirects, caps size)
export function normalizeParseOptions(options, meta, ctxInfo)
  // ctxInfo: { hasToken, maxUploadBytes, localSupported, localReason, localMaxBytes,
  //            autoAllowAgentFallback }
  // returns { engine: 'standard'|'agent'|'local', params } or throws WireError
  // (token-missing/too-large/unsupported-type/bad-request/local-unsupported/local-missing-tool)
  // auto policy: token → standard; else local when localSupported; else agent when
  // autoAllowAgentFallback !== false; else token-missing. local params: { fileName, language,
  // localProvider: 'auto'|'builtin'|'system:officeToPdf' }.
export function describeMineruError(error) // human message (zh+en short), never leaks token
```

## lib/unzip.js

```js
export function unzip(buffer, { filter, maxEntries = 5000, maxTotalBytes = 512 * 1024 * 1024,
  maxEntryBytes = 128 * 1024 * 1024 } = {})
// → { entries: [{ name, data: Buffer }], skipped: number, warnings: string[] }
// name is normalized with '/' separators; path traversal → entry skipped + warning
```

## lib/local-pdf.js

```js
export const PDFJS_VERSION = '5.4.449'            // must match vendor/pdfjs/
export function loadPdfjs()                        // lazily imports vendor/pdfjs/pdf.mjs;
                                                   // sets GlobalWorkerOptions.workerSrc; memoized
export async function extractPdfText({ data, maxPages = 500, maxTextBytes = 32 * 1024 * 1024,
  signal, onProgress, logger, pdfjsModule })
// → { pages: [{kind:'heading',level,text}|{kind:'paragraph',text}][], pageCount, title,
//     chars, outlineUsed }
// errors: WireError('local-encrypted'|'local-failed'|'too-large'|'bad-request').
// pdfjsModule is injectable for tests; `data` is Uint8Array/Buffer.
```

Lazy by contract: pdf.js is imported on the first local parse only; inert DOM stubs
(`DOMMatrix`/`ImageData`/`Path2D`) are installed for the legacy Node build, and extraction never
rasterizes (no canvas dependency). `loadPdfjs()` throws `local-missing-tool` when the vendored
files cannot be imported.

## lib/local-synth.js

```js
export const DEFAULT_MAX_PARAGRAPH_CHARS = 4000
export const HARD_MAX_PARAGRAPH_CHARS = 8000
export function escapeMarkdownText(text)           // deterministic, idempotent inline escaping
export function synthLocalDocument({ pages, title, maxParagraphChars, keepContentList = true })
// → { markdown, contentList, pageCount, textChars, warnings, title }
// contentList: MinerU-compatible pure array [{ page_idx, type:'text', text, text_level? }];
// warnings always includes 'no-structure'. Throws WireError('local-empty-text') on empty input.
```

Pure function (no I/O): page blocks → `full.md` + synthesized `content_list.json`. One content-list
entry per rendered Markdown block keeps page-mark alignment 1:1.

## lib/local-office.js

```js
export const OFFICE_EXTENSIONS // Set: .doc .docx .ppt .pptx .xls .xlsx
export function isOfficeExtension(ext)             // boolean
export async function convertOfficeToPdf({ officeToPdf, meta, readSource, signal,
  maxBytes = 100 * 1024 * 1024, logger })
// → { pdf: Uint8Array, missingFonts: string[] }
// officeToPdf is ctx.get('officeToPdf') ({ convert(input, signal) }); absent → local-missing-tool.
// maps OfficeToPdfError codes to too-large/local-unsupported/local-missing-tool/local-failed.
```

`meta` supplies `{ id, ext, size, sha256?, updatedAt? }`; the source is read lazily through
`readSource(reservedBytes)` so the Host never buffers an oversized Office file.

## lib/local-engine.js

```js
export const BUILTIN_PROVIDER = 'builtin'
export const OFFICE_PROVIDER = 'system:officeToPdf'
export const DEFAULT_LOCAL_CONFIG // enabled, maxPages, maxPdfBytes, maxTextBytes,
  // minCharsPerPage, maxParagraphChars, keepContentList, timeoutMs, maxOfficePdfBytes
export function createLocalEngine({ config, logger, officeToPdf, now, readSource,
  readSourceCapped, pdfExtractor, officeConverter } = {})
  .snapshot()      // { enabled, available, recommended, providers:[{id,available,version,reason?}],
                   //   capabilities:{textLayerPdf, office, images:false, html:false} }
  .supports(meta)  // { supported, provider, reason? } — never throws
  .plan(meta, { localProvider } = {})
                   // { provider, params } or throws local-unsupported/local-missing-tool/too-large
  .extract({ id, meta, sourcePath, params, signal, onProgress })
                   // → { markdown, contentList, pages, provider, title, warnings,
                   //     stats:{pageCount,textChars,extractMs,toolVersion,provider} }
  .config          // resolved local config block
  .providers       // { BUILTIN_PROVIDER, OFFICE_PROVIDER }
```

The facade owns validation, size caps, the `timeoutMs` deadline (linked with the caller's
`AbortSignal`), warnings (`no-structure` / `no-outline` / `missing-fonts`) and `local-*` error
mapping; `parse-manager` calls only `supports/extract`. Unit tests inject `pdfExtractor` /
`officeConverter` / `readSourceCapped` to avoid pdf.js and any Office service.

## lib/parse-manager.js

```js
export function createParseManager({ store, config, getToken, logger, fetchImpl, localEngine })
  .start(id, options)   // validates via service-level preconditions done by caller; starts async task
                        // returns meta immediately (status 'parsing')
  .cancel(id)           // abort; meta → status 'uploaded', parse.phase null
  .resume()             // resume polling for persisted 'parsing' docs, or mark failed
                        // (local extractions are never resumable → failed with a retry hint)
  .dispose()            // abort all tasks (sync-ish; returns Promise)
```

`localEngine` is optional (cloud-only profiles/tests); `executeTask()` forks on
`engine:'local'` → `executeLocalTask()`, which writes `parsed/full.md` +
`parsed/content_list.json` and persists `parse.provider` / `parse.local`.

## lib/service.js

```js
export function createService({ store, manager, config, logger,
  getCredentials, getTranslator, getLlm, getDefaultModel, hostVersion, localEngine })
// Every method returns JSON-serializable data or throws WireError.
  .healthPing(payload)                    // { ok:true, hostVersion, receivedAt }
  .getStatus()                            // { version, dataDirDisplay, tokenConfigured,
                                          //   tokenPersistent, translatorAvailable,
                                          //   modelAvailable, counts, preferences,
                                          //   local: LocalCapabilities|null, versionInfo }
  .listDocuments()                        // { documents: DocSummary[] }  (includes parse.engine,
                                          //   parse.provider, parse.local)
  .getDocument(id)                        // { document, annotations, translations }
  .updateDocument(id, patch)              // { document }
  .removeDocument(id)                     // { removed:true }
  .importUrl({ url, title })              // { document }  (downloads via fetch, size-capped)
  .startParse(id, options)                // { document }  (passes autoAllowAgentFallback and the
                                          //   local support probe into normalizeParseOptions)
  .cancelParse(id)                        // { document }
  .readMarkdown(id)                       // { markdown, contentList, pages }
  .saveAnnotations(id, annotations)       // { saved:true }
  .saveTranslations(id, targetLanguage, entries) // { saved:true }
  .translate({ text, targetLanguage, sourceLanguage, provider }) // { translation, provider, targetLanguage }
  .getSettings()                          // { tokenConfigured, preferences, providers, defaults,
                                          //   local: LocalCapabilities|null }
                                          // defaults: { engine, modelVersion, language, targetLanguage,
                                          //   translationProvider, autoAllowAgentFallback,
                                          //   localProvider:'auto' }
  .setToken(token)                        // { tokenConfigured:true }
  .clearToken()                           // { tokenConfigured:false }
  .updatePreferences(prefs)               // { preferences }
  // tool helpers (operate on the library; no HTTP concerns):
  .toolList() .toolGet(id) .toolRead(id, { offset, maxChars })
  .toolAnnotations(id) .toolAnnotate(id, annotation) .toolUnannotate(id, annotationId)
```

`getStatus`/`getSettings` expose the local capability snapshot through the injected engine
(`null` when the profile has no local engine); the absolute `versionInfo.dataDir` /
`configured.dataDir` fields are still present. `startParse` rejects illegal engine combinations
before any task is created (docs/ARCH.md §4.1).

## lib/routes.js

```js
export function registerRoutes({ ctx, service, store, config, logger })
// returns disposer; registers:
//   prefix '/dsh-litnotes/api'          JSON dispatch (POST only) + raw upload + asset/source GET
//   prefix '/dsh-litnotes/assets'       vendored package assets (vendor/**)
// The dispatch table maps "<method>" → service function; every request is fenced with
// ctx.connection.requestRejection(req) and method-checked.
```

## lib/agent-tool.js

```js
export function registerAgentTool({ ctx, service, config, logger })
// returns disposer; ctx.tools.register({ name:'mineru', description, parameters, output, execute })
```
