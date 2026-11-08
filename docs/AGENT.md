# dsh-litnotes — agent tools (1.1.0-alpha.1)

The DSH agent can operate the same literature library the browser uses through **eight focused
tools**: `library_search`, `library_read`, `library_ask`, `library_deepread`,
`library_annotate`, `library_translate`, `library_graph`, `library_manage`. Every tool returns JSON-serializable results with
citation-ready coordinates so the agent can point the user at the exact paper text.

Code: `src/host/agent-tools.ts` (definitions), `src/host/service.ts` (`ServiceApi`, the operations
layer), `src/host/ai/prompt-section.ts` (agent-context hint), `src/shared/model.ts` (result
shapes).

## 1. Design rules

- **One operation, two callers.** The tools call the same `ServiceApi` methods as the HTTP
  routes — no duplicated business logic, limits, error codes or anchor rules. An annotation
  created by the agent appears in the margin; a user annotation is visible to the agent.
- **Behaviour, not implementation.** Descriptions state what a tool does and returns; internal
  mechanisms are not exposed. Parameter rules (defaults, ranges, enums, when to set) live on the
  parameters themselves. Every fact is stated once.
- **Bounded outputs.** A rendered tool result is a text block capped at 16 000 characters
  (further capped by `toolMaxChars`); truncated results say so. Reads return slices with
  `nextOffset`, graphs return the highest-weight nodes plus aggregate stats, searches return short
  snippets. The agent narrows the request instead of pulling whole documents.
- **Coordinates everywhere.** Any result that points into a document carries `documentId` and,
  where meaningful, `blockKey`, `page` and `quote`.
- **Discoverable names.** Tools register through `ctx.get('tools').register(definition)` when the
  profile mounts the tools service; without it they are disabled with an info log. Registration is
  owned by a `ctx.effect`, so the tools disappear with the plugin.
- **Agent awareness.** The plugin registers one static system-prompt section
  (`litnotes-library`, order 55) telling the agent the library exists, which tool family to use,
  that results carry `documentId/blockKey/page/quote`, and to stay silent when a request is
  unrelated. It contains no per-turn or library-state text; absence of the `systemPrompt` service
  is a safe no-op.

## 2. Shared conventions

| convention | meaning |
|---|---|
| `documentId` | document UUID from `library_manage list` / `library_search` |
| `blockKey` | reader block anchor `b<index>:<8-hex hash>`, e.g. `b12:ab12cd34` |
| `page` | 1-based display page, or `null` when page marks are unavailable |
| `quote` | verbatim text from the block's plain text; annotations can be created from it |
| `aspect` | `definition \| method \| result \| limitation \| context` (colors: yellow/sage/sky/rose/yellow) |
| `color` | `yellow \| sage \| sky \| rose` |
| `offset` | character offset into the parsed markdown for `library_read` text slices |
| `limit` | result bound; server clamps search to 1–100 (default 20) |
| whole-library scope | `library_search` without `documentId` searches parsed documents (up to 200) |

Failed operations surface as tool errors whose message is the bilingual wire message (for example
"文档尚未解析完成" or "引文为空"). The agent should report the failure rather than retry blindly.

## 3. Tool reference

### 3.1 `library_search`

Search parsed passages across the library or one document.

| parameter | type | notes |
|---|---|---|
| `query` | string (required) | words or phrases (English or Chinese) |
| `scope` | `library \| document` | default `library`; `document` requires `documentId` |
| `documentId` | string | target document when scope is `document` |
| `limit` | integer | maximum passages, 1–100 (default 20) |

Returns `{query, scope, matches[], scanned:{documents, blocks}, truncated}` where each match is
`{documentId, title, blockKey, page, kind, score, snippet}` sorted by score. Use it to find the
paper for a topic or locate evidence, then continue with `library_read` / `library_ask`.

### 3.2 `library_read`

Read one parsed document in four views.

| parameter | type | notes |
|---|---|---|
| `documentId` | string (required) | |
| `view` | `meta \| text \| block \| page` | default `text` |
| `offset` | integer | character offset for `text` (default 0) |
| `maxChars` | integer | slice size for `text` (default 12 000, host-capped by `toolMaxChars`) |
| `blockKey` | string | required for `block` |
| `page` | integer ≥ 1 | required for `page` |

Returns by view:

- `meta` — `{documentId, title, status, pages, parse, stats:{blocks, headings, chars, words}, outline[], blocks, graph|null}`;
- `text` — `{documentId, title, offset, markdown, nextOffset, totalChars, truncated}` (call again
  with `offset: nextOffset` while `truncated`);
- `block` — `{documentId, blocks:[{blockKey, found, page, kind, text}]}` (exact block text);
- `page` — `{documentId, page, blocks:[{blockKey, kind}], text, truncated}`.

### 3.3 `library_ask`

Ask the grounded reading assistant about one document.

| parameter | type | notes |
|---|---|---|
| `documentId` | string (required) | |
| `question` | string (required) | in the user's language |
| `focusBlockKey` | string | optional block the question is about |

Returns `{documentId, title, answer, citations[], unverified[], followups[], annotationIds[],
graph, model, messageId}`. Each citation carries `blockKey, page, quote, aspect, note, verified`;
verified citations have already become aspect-colored annotations in the reading desk. Quote the
citations' `quote`/`page` back to the user.

### 3.4 `library_annotate`

List, create, update or delete highlights/notes in one document.

| parameter | type | notes |
|---|---|---|
| `action` | `list \| create \| update \| delete` | default `list` |
| `documentId` | string (required) | |
| `annotationId` | string | id for `update`/`delete` |
| `origin` | `user \| ai` | filter for `list`; provenance for `create` (default `user`) |
| `aspect` | aspect enum | for create/update, and the aspect filter for `list` |
| `annotation` | object | payload: `blockKey?`, `quote?`, `start?`, `end?`, `note?`, `color?` |

Creating accepts either an explicit `blockKey` (+ `start`/`end`) or a `quote` the Host locates in
the parsed text; the stored annotation uses the reader's exact `b<index>:<hash>` anchor. Returns
`{annotation, created}` for create/update, `{removed}` for delete, and
`{documentId, count, annotations[]}` for list (capped at 100). A stale/unknown `blockKey` is
rejected instead of saving an unrenderable note.

### 3.5 `library_translate`

Translate arbitrary text or specific parsed blocks.

| parameter | type | notes |
|---|---|---|
| `documentId` | string (required) | needed for `blockKeys` |
| `text` | string | arbitrary text; omit to translate blocks |
| `blockKeys` | string[] | up to 10 blocks (from citations) |
| `targetLanguage` | string | e.g. `zh`, `en`; defaults to the reader's preference |
| `provider` | string | optional provider id |

Returns `{translation, provider, targetLanguage, model?, documentId}` for text, or
`{documentId, translations:[{blockKey, page, source, translation, provider}]}` for blocks (missing
blocks return `{blockKey, found:false}`). Uses the host translation service with the default model
as fallback.

### 3.6 `library_graph`

Work with knowledge graphs.

| parameter | type | notes |
|---|---|---|
| `action` | `get \| search \| build \| update \| library \| rebuild` | required |
| `documentId` | string | for get/search/build/update |
| `query` | string | for `search` (labels/summaries) |
| `force` | boolean | for `build`: rebuild even if a graph exists |
| `nodes` | object[] | for `update`: node upserts |
| `edges` | object[] | for `update`: edge upserts |
| `merge` | object[] | for `update`: `[{from, to}]` node folds |

Returns a compact graph `{scope, documentId, generatedAt, overview, tldr, nodes[], edges[],
stats:{nodes, edges, shownNodes}}` with nodes carrying `id/type/label/summary/aspect/blockKeys/
documentIds/weight/curated/pinned/position`; plus `progressFrames` for `build`/`rebuild`. `build`
and `rebuild` stream internally and may take a while; `update` applies user curation (patched
nodes become `curated` and survive a rebuild).

### 3.7 `library_manage`

Manage the library.

| parameter | type | notes |
|---|---|---|
| `action` | `list \| status \| import_url \| parse \| cancel \| repair \| update \| delete` | required |
| `documentId` | string | required except list/status/import_url |
| `url` | string | http(s) file URL for `import_url` |
| `title` | string | for `import_url` / `update` |
| `parse` | object | `engine?`, `localProvider?`, `modelVersion?`, `language?`, `isOcr?`, `enableFormula?`, `enableTable?`, `pageRanges?` |
| `pages` | integer[] | 1-based pages for `repair` (omit to let the host detect unreadable pages) |

| action | returns |
|---|---|
| `list` | `{total, documents:[{documentId, title, status, pages, engine, provider, error}]}` (first 100) |
| `status` | version, token/translator/model availability, data dir, counts, AI and local-engine capabilities |
| `import_url` | compact document row + `imported:true` (download happens in the Host) |
| `parse` | compact row + `parsing:true` (asynchronous; poll `status`) |
| `repair` | compact row + `repairing:true` + `parse` state |
| `cancel` | compact row + `cancelled:true` |
| `update` | compact row with the new title |
| `delete` | `{documentId, removed:true}` |

Parsing guidance: `auto` uses the standard API when a MinerU token is configured, otherwise the
local engine when it supports the file, otherwise the token-free lightweight cloud API. A parse
start returns immediately; use `status` for progress (including `ai`, `local` and token state).

### 3.8 `library_deepread`

Read the persisted AI 精读 (close reading) of one parsed paper, or run the workflow now.

| parameter | type | notes |
|---|---|---|
| `action` | `get \| run` | `get` reads the stored record (no model calls, no tokens); `run` executes the whole workflow |
| `documentId` | string | required; a parsed document id |
| `language` | string? | reader-language id for the report and notes (`zh`, `en`, `ja`, …); omit for the reader/en default |

| action | returns |
|---|---|
| `get` | `{documentId, record}` — the compact `DeepReadRecord`, or `record: null` when the paper has never been deep-read |
| `run` | `{documentId, record, progressFrames}` — runs to completion and returns the final compact record |

The compact record keeps the whole report (`tldr`, problem, gap, contributions with evidence
strength, method, evaluation, findings, limitations, open questions, argument map, glossary,
reading path, verdict) plus `stats`, `generatedAt`, `language`, `model` and `promptVersion`.
Highlights are capped at 60 rows (`highlightCount` and `highlightsTruncated` keep the total
visible); each row carries `annotationId` (or `''` when not written), `blockKey`, `page`,
`quote`, `aspect`, `note`, `importance`, `section` and `kind`.

Guidance: `run` performs many sequential model calls (minutes) and spends tokens — prefer `get`
unless the user explicitly asks for a fresh close reading. A run needs a live model route;
cancelling the tool call aborts the run and leaves the previous record and annotations intact.
Every highlight and report point is page-anchored, so answers can cite the exact text.

## 4. Worked example: find, read, ask, cite

```text
1. library_search { "query": "block separator redundancy", "limit": 5 }
   → matches: [{ documentId:"8a79…", title:"BEE: …", blockKey:"b21:7c14a0de",
                 page:4, kind:"paragraph", score:3.5,
                 snippet:"…block-separator decomposition…" }]

2. library_read { "documentId":"8a79…", "view":"meta" }
   → { status:"parsed", pages:27, stats:{…}, outline:[{key:"b5:…", level:2, text:"3 Method"}],
       graph:{ nodes:[…] } }

3. library_read { "documentId":"8a79…", "offset":0, "maxChars":6000 }
   → { markdown:"… first 6000 chars …", nextOffset:6000, totalChars:138367, truncated:true }

4. library_ask { "documentId":"8a79…",
                 "question":"为什么 block separator 能减少冗余？",
                 "focusBlockKey":"b21:7c14a0de" }
   → { answer:"Block separators split … [1][2]",
       citations:[{ blockKey:"b21:7c14a0de", page:4,
                    quote:"the separator …", aspect:"method", note:"…", verified:true }],
       unverified:[], followups:["这与局部冗余有何关系？"],
       annotationIds:["ann-…"], messageId:"…", model:{provider:"…", model:"…"} }

5. Reply to the user with the answer and the citation coordinates, e.g.
   "BEE 用 block-separator 拆分…（原文第 4 页，blockKey b21:7c14a0de）".
```

If step 1 found nothing, widen with a shorter query or check `library_manage status`; if step 4
returns an empty/error answer, the profile's model route is likely unavailable
(`llm-unavailable`) or the question found no evidence — say so instead of inventing a citation.

## 5. Development notes

- Register every tool through the shared definition shape (`ToolDefinition` in
  `src/host/host-services.ts`): `name`, `description`, `parameters` (JSON Schema subset),
  `output {schema, render}`, `execute(args, exec)`.
- Tool output is projected by `render(args, value)` into `[{type:'text', text}]`; keep the
  projection bounded and stable (JSON for structured values).
- Never bypass `ServiceApi`: if an operation is missing, add it to the service so the browser and
  the agent keep behaving identically.
- Tests: `test/host/agent-tools.test.ts` registers the definitions on a fake registry/service and
  asserts names, schema shape, dispatch arguments, bounded rendering and error propagation;
  `test/host/service.test.ts` covers the operations themselves.
