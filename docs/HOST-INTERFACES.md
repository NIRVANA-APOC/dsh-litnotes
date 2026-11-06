# Host module interfaces (exact signatures)

`host-core` implements these; `index.js` (Lead) imports exactly these names. Keep them stable.
All modules are plain ESM under `lib/`, use only `node:` builtins, and never import each other
in a cycle (dependency direction: `wire/mime/config` ← `store/mineru/unzip` ← `parse-manager` ←
`service` ← `routes/agent-tool`).

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
export const TOKEN_KEY = 'dsh-litnotes/api-token'
export const DEFAULT_PREFERENCES
// { targetLanguage:'zh', translationProvider:'auto', readingMode:'original',
//   readingScale:1, defaultEngine:'auto', defaultModelVersion:'vlm',
//   defaultLanguage:'ch', defaultIsOcr:false, defaultEnableFormula:true,
//   defaultEnableTable:true, showPageMarks:true }
export function resolveConfig(rawConfig) // { dataDir, apiBase, maxUploadBytes,
  // maxConcurrentParses, pollIntervalMs, parseTimeoutMs, toolMaxChars, hostVersion }
  // dataDir: '~' expanded, $DSH_HOME respected, default '~/.dsh/mineru'
export async function getToken(credentials)          // string | undefined
export async function setToken(credentials, token)   // stores ApiKeyRecord
export async function clearToken(credentials)        // deleteRecord
export async function loadPreferences(dataDir)       // merged with defaults
export async function savePreferences(dataDir, prefs) // validated+merged, returns full prefs
```

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
  // ctxInfo: { hasToken, maxUploadBytes }
  // returns { engine, params } or throws WireError (token-missing/too-large/unsupported-type/bad-request)
export function describeMineruError(error) // human message (zh+en short), never leaks token
```

## lib/unzip.js

```js
export function unzip(buffer, { filter, maxEntries = 5000, maxTotalBytes = 512 * 1024 * 1024,
  maxEntryBytes = 128 * 1024 * 1024 } = {})
// → { entries: [{ name, data: Buffer }], skipped: number, warnings: string[] }
// name is normalized with '/' separators; path traversal → entry skipped + warning
```

## lib/parse-manager.js

```js
export function createParseManager({ store, config, getToken, logger, fetchImpl })
  .start(id, options)   // validates via service-level preconditions done by caller; starts async task
                        // returns meta immediately (status 'parsing')
  .cancel(id)           // abort; meta → status 'uploaded', parse.phase null
  .resume()             // resume polling for persisted 'parsing' docs, or mark failed
  .dispose()            // abort all tasks (sync-ish; returns Promise)
```

## lib/service.js

```js
export function createService({ store, manager, config, logger,
  getCredentials, getTranslator, getLlm, getDefaultModel, hostVersion })
// Every method returns JSON-serializable data or throws WireError.
  .healthPing(payload)                    // { ok:true, hostVersion, receivedAt }
  .getStatus()                            // { version, dataDirDisplay, tokenConfigured,
                                          //   tokenPersistent, translatorAvailable,
                                          //   modelAvailable, counts, preferences, versionInfo }
  .listDocuments()                        // { documents: DocSummary[] }
  .getDocument(id)                        // { document, annotations, translations }
  .updateDocument(id, patch)              // { document }
  .removeDocument(id)                     // { removed:true }
  .importUrl({ url, title })              // { document }  (downloads via fetch, size-capped)
  .startParse(id, options)                // { document }
  .cancelParse(id)                        // { document }
  .readMarkdown(id)                       // { markdown, contentList, pages }
  .saveAnnotations(id, annotations)       // { saved:true }
  .saveTranslations(id, targetLanguage, entries) // { saved:true }
  .translate({ text, targetLanguage, sourceLanguage, provider }) // { translation, provider, targetLanguage }
  .getSettings()                          // { tokenConfigured, preferences, providers, defaults }
  .setToken(token)                        // { tokenConfigured:true }
  .clearToken()                           // { tokenConfigured:false }
  .updatePreferences(prefs)               // { preferences }
  // tool helpers (operate on the library; no HTTP concerns):
  .toolList() .toolGet(id) .toolRead(id, { offset, maxChars })
  .toolAnnotations(id) .toolAnnotate(id, annotation) .toolUnannotate(id, annotationId)
```

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
