# dsh-litnotes — AI features architecture & contracts

This document is the implementation contract for the AI-native upgrade: grounded Q&A with
citations that jump and auto-annotate, per-paper and library-wide knowledge graphs, and multiple
DSH agent tools over the library. Read it together with `docs/VISION.md` (product detail),
`docs/RESEARCH.md` (external landscape, supplementary), `docs/ARCH.md` (existing host/client
architecture) and `docs/UI-SPEC.md` (existing reading-desk design contract).

The plugin is `dsh-litnotes` (renamed from `dsh-mineru`; package name is the single source of
identity). Every new route lives under `/dsh-litnotes/api/*`; the client bundle id is
`dsh-litnotes`; locale namespace `dsh-litnotes`; panel id `litnotes`; data dir
`~/.dsh/litnotes`.

---

## 1. Product principles for the AI layer

1. **Answers live in the margin, on the page.** The AI panel is the reading desk's right margin,
   not a separate chat app. Every claim it makes is anchored to reader blocks.
2. **Citation-first, then words.** The model must cite existing parser block keys with verbatim
   quotes. The host re-validates every citation; unverifiable citations are marked and never
   turned into annotations.
3. **Every answer leaves a trace on the text.** Valid citations become highlights/annotations in
   the document (aspect-colored), so multi-turn reading visibly fills the paper with knowledge.
4. **The graph maintains itself.** AI reading comprehension builds a per-paper knowledge graph;
   Q&A adds question/insight nodes and links; the library graph aggregates papers and topics.
   Users curate by clicking, not by writing JSON.
5. **One knowledge base, two views.** Annotations, notes, chat answers and graph nodes share
   block-key provenance. Clicking anything (citation, node, annotation) jumps to the same place.
6. **The agent is a first-class reader too.** DSH chat can search, read, annotate, translate,
   graph and question the library through focused tools that return citation-ready coordinates.

---

## 2. Data model

Everything below is JSON on disk under the existing data dir. All writes go through the store's
new aux APIs (atomic tmp+rename, per-document queues):

```
documents/<docId>/chat.json      # { version:1, messages: ChatMessage[] }
documents/<docId>/graph.json     # doc knowledge graph (KG shape below)
library-graph.json               # library knowledge graph
```

### ChatMessage

```jsonc
{
  "id": "uuid",
  "role": "user" | "assistant",
  "question": "…",                    // assistant messages keep their question for context
  "answer": "markdown with [1] markers",
  "citations": [Citation],
  "unverified": [Citation],           // failed validation; shown dimmed in the UI
  "followups": ["…"],
  "model": { "provider": "…", "model": "…" },
  "usage": { "inputTokens": 0, "outputTokens": 0 },
  "annotationIds": ["…"],             // annotations created from this answer
  "knowledge": { "nodeIds": [], "edgeIds": [] },
  "createdAt": "ISO"
}
```

### Citation

```jsonc
{
  "index": 1,                          // [n] in the answer markdown
  "blockKey": "b12:ab12cd34",          // reader parser block key
  "quote": "exact substring of the block plain text",
  "start": 34, "end": 78,              // computed by the host (not the model)
  "page": 3,
  "aspect": "definition|method|result|limitation|context",
  "note": "one-sentence claim this citation supports",
  "verified": true
}
```

Aspect → annotation color mapping (single source of truth in the host, `lib/ai/aspects.js`):

| aspect | meaning | annotation color |
|---|---|---|
| definition | definition/background/terminology | `yellow` |
| method | approach, architecture, algorithm | `sage` |
| result | experiments, numbers, evidence | `sky` |
| limitation | limitation, critique, open problem | `rose` |
| context | related work, motivation, anything else | `yellow` |

### Annotation extension (existing `annotations.json` items)

New optional fields: `origin: "user" | "ai"`, `aspect`, `chatId`, `messageId`, `model`.
The client normalizer (`ui/highlight.js normalizeAnnotation`) and the store both preserve these
fields across the whole-list save round-trip; a regression test covers it.

**Reparse re-anchoring.** Block keys and offsets can change when a document is parsed again
(full reparse or page-scoped repair). After every successful parse the host
`lib/reanchor.js` relocates each annotation by its verbatim `quote` (same block → offsets fixed;
another block → `blockKey` + offsets fixed, preferring the block nearest the old page; quote
gone → annotation kept with `stale: true` and `staleReason`). The store and the client
normalizer preserve `stale`/`staleReason`/`reanchored`, so a stale annotation is displayed in the
margin as “位置已变化” and is never erased by a whole-list save.
The client keeps rendering existing annotations unchanged; AI annotations get a small sparkle
marker in the margin list and in the note editor. Deduping rule: a new AI annotation is skipped
(and reported) when an existing annotation on the same block covers an overlapping range with
the same aspect.

### Knowledge graph (KG) shape

Used for both per-doc (`graph.json`) and library (`library-graph.json`) graphs:

```jsonc
{
  "version": 1,
  "scope": "document" | "library",
  "documentId": "…",                   // document scope only
  "generatedAt": "ISO",
  "model": { "provider": "…", "model": "…" },
  "overview": "markdown summary of the graph",
  "tldr": "3-5 bullet TL;DR (document scope)",
  "glossary": [{ "term": "…", "definition": "…", "blockKeys": [] }],
  "nodes": [{
    "id": "n-uuid",
    "type": "concept|method|finding|definition|limitation|section|question|insight|paper|topic",
    "label": "short name",
    "summary": "1-2 sentences",
    "blockKeys": ["b12:ab12cd34"],     // provenance in the document
    "documentIds": ["…"],              // library scope: papers this node came from
    "aspect": "method",               // optional, mirrors citation aspects
    "source": "ai-summary|qa|user|aggregate",
    "weight": 1,                       // importance, used for layout/filtering
    "createdAt": "ISO", "updatedAt": "ISO"
  }],
  "edges": [{
    "id": "e-uuid",
    "from": "n-…", "to": "n-…",
    "type": "defines|uses|supports|contradicts|part_of|leads_to|evolves_from|relates|answers|mentions|shares",
    "label": "optional edge label",
    "source": "ai-summary|qa|user|aggregate",
    "weight": 1
  }],
  "stats": { "nodes": 0, "edges": 0, "builtAtSeq": null }
}
```

Node id rules: AI returns stable-ish ids per call; the host merges by normalized label + type
(case-folded, punctuation-stripped) and keeps the existing id. Host caps: document graph 120
nodes / 400 edges; library graph 600 nodes / 2000 edges as a safety cap, with a curation
budget of 28 representative topics (each paper keeps ≥2). `shares` is library-only.

---

## 3. Host modules & interfaces

New files, plain ESM, `node:` builtins only, no imports outside `lib/` + `ui/markdown.js`:

### lib/ai/aspects.js
```js
export const ASPECTS = ['definition','method','result','limitation','context']
export const ASPECT_COLORS = { definition:'yellow', method:'sage', result:'sky', limitation:'rose', context:'yellow' }
export function normalizeAspect(value) // unknown → 'context'
export function aspectColor(aspect)
```

### lib/ai/llm.js — model gateway over the Host `llm` service
```js
export function createLlmGateway({ getLlm, getDefaultModel, logger, config })
  .available()                                  // boolean
  .route()                                      // { provider, model } | null (config override → default selection)
  .async *streamText({ system, messages, signal, maxTokens, temperature, purpose })
      // yields { type:'delta', text } then { type:'usage', usage } /
      // { type:'finish', reason }; throws LlmUnavailableError / LlmFailureError
  .completeText(request)                        // collected string (bounded)
export class AiError extends Error { code, detail }   // codes: llm-unavailable, llm-failed,
                                                      //        context-too-large, aborted
```
Uses `ctx.get('llm').stream({ provider, model, system, messages:[{role:'user',content:[{type:'text',text}]}], maxTokens, temperature, signal })`
and `ctx.get('agentDefaultModel')?.currentSelection()` for the default route. Config override:
`config.ai.provider`, `config.ai.model`.

### lib/ai/retrieval.js — lexical context builder over parsed blocks
```js
export function createRetriever({ parseMarkdown, plainTextOfBlock, logger })
  .buildIndex({ documentId, markdown, contentList, outline })   // cached by markdown length+hash
  .context({ documentId, markdown, contentList, question, focusBlockKey, selection, topK = 12, budgetChars = 9000 })
      // → { blocks:[{ key, page, index, text, kind, score, section }],
      //     outline:[{key,level,text}], sections, usedChars, totalBlocks }
  .search({ ...same }, query, limit = 20)     // → blocks[] for agent tools (snippets)
  .invalidate(documentId)
```
Implementation: split the parser model's blocks into token sets (ASCII words + CJK bigrams);
BM25-ish scoring, neighbours of top hits, always include title/abstract head, focus block and
selection block; deterministic ordering by document index for prompt stability. No dependencies,
no embeddings.

### lib/ai/chat.js — grounded reading conversation
```js
export function createChatService({ llm, retriever, store, config, logger,
                                    loadAnnotations, saveAnnotations, onGraphDelta })
  .async history(documentId)                   // ChatMessage[]
  .async clear(documentId)
  .async *stream(request)                      // NDJSON frame objects (see §4)
```
Request:
```jsonc
{ "documentId": "…", "question": "…",
  "focus": { "blockKey": "b12:…", "selectionQuote": "…" },
  "mode": "doc",                               // reserved: "library" later
  "regenerateOf": "messageId?" }
```
Flow: load history (last 6 turns) → retrieval.context() → build system+user prompt (§5) →
stream model deltas → split answer from trailing structured JSON → validate block keys and
quote containment (normalize whitespace; allow first 40 chars prefix fallback; offsets computed
against block plainText) → persist ChatMessage → create annotations for verified citations via
injected `saveAnnotations` (dedupe rule §2) → optional graph delta via `onGraphDelta` (knowledge
from the answer) → emit final frames.
Frames:
```jsonc
{ "type": "start", "messageId": "…", "model": { … } }
{ "type": "delta", "text": "…" }                     // answer markdown streamed
{ "type": "answer", "messageId": "…", "markdown": "…",
  "citations": [Citation], "unverified": [Citation],
  "followups": ["…"], "annotationIds": ["…"] }
{ "type": "graph", "delta": { "nodes": [...], "edges": [...] } }
{ "type": "usage", "usage": { … } }
{ "type": "done" }
{ "type": "error", "code": "…", "message": "…" }
```

### lib/ai/graph.js — knowledge graph service
```js
export function createGraphService({ llm, store, config, logger, readMarkdown })
  .async docGraph(documentId)                  // KG
  .async *buildDocGraph(documentId, { signal, force })   // NDJSON frames:
      { "type":"progress", "phase":"reading|extracting|merging|done", "done":n, "total":m, "chunk":i }
      { "type":"graph", "graph": KG }
      { "type":"error", "code":"…", "message":"…" }
  .async mergeDocKnowledge(documentId, delta)  // nodes/edges from Q&A; returns KG
  .async updateDocGraph(documentId, { nodes, edges })   // user/AI edits
  .async libraryGraph()                        // KG (aggregates doc graphs + paper nodes)
  .async *rebuildLibraryGraph({ signal })      // aggregate deterministically; LLM consolidation optional
```
Doc build: chunk the document into ~3500-char section groups → for each chunk ask the model for
`{nodes,edges}` JSON (schema in §5) → host normalizes/merges → after all chunks, one lightweight
call for `overview` + `tldr` + `glossary` (bounded by `config.ai.graphSummaryChars`) → persist.
Progress frames make the UI live. Cancellation via AbortSignal. Cost caps: `config.ai.maxGraphChunks`
(default 12), ignore documents over `config.ai.maxGraphSourceChars` (default 160k chars) by
reading the first N + section headings.

Library aggregation: for each parsed doc ensure a doc graph (read from disk; if missing, create a
lightweight graph from headings + annotations only, no LLM); create `paper` nodes; create `topic`
nodes by normalized label across docs. It is **curated, not a union**: each paper contributes at
most 10 nodes chosen by an importance score (type, weight, degree, evidence blockKeys, provenance),
concepts appearing in ≥2 papers are always kept, near-duplicate labels (word-set aliases such as
"spectral dominance" / "full spectral dominance") merge into one concept, and the total is capped at
28 topics. Edges are
value-bearing only: paper→topic `mentions`, topic→topic relations propagated from the real document
graphs (typed, weight = number of papers), and paper↔paper `shares` edges weighted by shared
concept count. There are no "any two co-occurring topics" edges. Clusters = connected components of
the topic-topic relation graph; overview
computed deterministically (top topics, paper list) with an optional LLM polish call.

### lib/ai/prompts.js
All prompt text in one module (English instructions, answer language follows the user's question):
`CHAT_SYSTEM`, `chatUserPrompt(context, question, history)`, `GRAPH_EXTRACTION_SYSTEM`,
`graphExtractionPrompt(chunk, meta)`, `GRAPH_SUMMARY_PROMPT`, `LIBRARY_CONSOLIDATION_PROMPT`.
The chat prompt embeds each context block as:
```
[[b12:ab12cd34]] (page 3) <block plain text>
```
and instructs: answer only from these blocks; cite every non-obvious claim with [n]; provide a
trailing fenced ```litnotes-json block with citations/quotes/aspects/notes, optional knowledge
nodes/edges and followups; if the context is insufficient say so and name what is missing.
Host strips the fenced block from the streamed answer (the streamer holds back the tail once it
sees the fence delimiter).

### lib/ai/index.js
`createAiServices({ ctx, store, config, logger, loadAnnotations, saveAnnotations, readMarkdown })`
→ `{ llm, retriever, chat, graph, available }` used by service/routes/tools wiring (Lead-owned).

---

## 4. HTTP API (Lead-owned wiring; module behavior above)

All routes under `/dsh-litnotes/api`, existing fence and envelope for JSON; streaming routes are
raw NDJSON over POST (each line one JSON frame; `Content-Type: application/x-ndjson`).

| method | route | body | response |
|---|---|---|---|
| POST | `/chat` | see §3 chat request | NDJSON stream |
| POST | `/chat.history` | `{ documentId }` | `{ messages: ChatMessage[] }` |
| POST | `/chat.clear` | `{ documentId }` | `{ cleared: true }` |
| POST | `/graph.doc` | `{ documentId }` | `{ graph: KG }` |
| POST | `/graph.build` | `{ documentId, force? }` | NDJSON stream (progress/graph/error) |
| POST | `/graph.update` | `{ documentId, nodes?, edges? }` | `{ graph: KG }` |
| POST | `/graph.library` | `{}` | `{ graph: KG }` |
| POST | `/graph.library.rebuild` | `{}` | NDJSON stream |

Streaming implementation notes: `ctx.webServer.register({ kind:'exact', path:'/dsh-litnotes/api/chat', handler })`;
fence first; `res.writeHead(200, {'content-type':'application/x-ndjson','cache-control':'no-store','x-accel-buffering':'no'})`;
write frames with `res.write(JSON.stringify(frame)+'\n')`; `req` close aborts the AbortController;
never throw after headers (emit an error frame). Client uses `fetch` with `ReadableStream` +
`TextDecoder` + line splitter.

---

## 5. Model output contract

Single-shot answer (chat): the model returns markdown, then exactly one fenced block:

````
…answer markdown with [1] and [2] citations…

```litnotes-json
{
  "citations": [
    { "index": 1, "blockKey": "b12:ab12cd34", "quote": "exact quote from that block",
      "aspect": "method", "note": "claim supported by this quote" }
  ],
  "knowledge": {
    "nodes": [{ "type": "insight", "label": "…", "summary": "…", "blockKeys": ["b12:…"] }],
    "edges": [{ "from": "label A", "to": "label B", "type": "supports" }]
  },
  "followups": ["…", "…"]
}
```
````

Rules the host enforces: quote must be a substring of the block plain text after whitespace
normalization (or a ≥ 20-char prefix); `blockKey` must exist; `index` must appear as `[n]` in the
answer; knowledge node labels must be ≤ 80 chars; unknown graph node references create the node
first. The streaming layer buffers once it sees `litnotes-json` so the raw JSON never reaches the
answer UI.

Graph extraction contract (one chunk): fenced ```litnotes-graph block with
`{ "nodes":[{type,label,summary,blockKeys[],aspect?}], "edges":[{from,to,type,label?}] }`.
Summary contract: ```litnotes-summary with `{ "overview": "markdown", "tldr": ["…"], "glossary":[{term,definition,blockKeys}] }`.

---

## 6. Client modules & UI contract

New UI source files (concatenated into the bundle in this order: markdown, highlight, chat,
graph, app):

### ui/chat.js
```js
function MruAiPanel(props)   // React component; full chat UI for one document
```
Props from app.js:
```js
{
  t,                                  // locale translate (props.t of the app)
  documentId, documentTitle,
  modelLabel,                         // e.g. "deepseek-flash" or ""
  available,                          // false → setup hint instead of composer
  katexReady,
  context,                            // { visibleBlockKey, visibleText, selection: {quote, blockKey} | null }
  onJump(blockKey),                   // scroll+flash a block
  onAnnotationsChanged(),             // app reloads annotations
  onGraphDelta(delta),                // app refreshes doc graph state
  onOpenGraph(),                      // switch the main view to the doc graph
  post(method, payload, options),     // app JSON helper (returns value or throws MruApiError-like)
  streamChat(request, handlers),      // app NDJSON helper: handlers {onFrame(frame), signal}
}
```
Component responsibilities: load history via `post('chat.history',{documentId})`; render messages
(user question, assistant markdown through `MruRichText`, inline `[n]` citation chips with hover
preview + click `onJump`), streaming answer with stop button, regenerate, suggested follow-ups,
context chips (visible block / selection) with clear buttons, composer (Cmd/Ctrl+Enter send,
Shift+Enter newline), empty state with quick prompts (总结全文 / 这篇论文解决了什么 / 方法是什么 /
有什么局限 / 解释这个概念), error states, "N 条引用未通过校验" notice, annotations-created toast via
`props.onNotify?`. It must never write to `document.body`; fixed overlays are rendered inside the
component tree. All classes `.mru-ai-*` per §8.

### ui/graph.js
```js
function MruGraphView(props) // doc or library knowledge graph
```
Props: `{ t, mode: 'doc'|'library', graph, building, progress, onJump(documentId?, blockKey), onAsk(node), onBuild(), onRefresh(), onUpdateGraph(nodes, edges)? }`.
Responsibilities: layout computation (deterministic seeded force simulation, SVG), pan/zoom,
drag node pinning, node type filter chips + legend, search box, cluster collapse at library scale,
details card on click (label/summary/sources/edges, 跳转到原文, 问 AI 关于此概念), build/refresh
buttons with progress, empty state (AI 精读全文生成图谱). Pure SVG + React, no canvas, no deps.
Classes `.mru-graph-*` per §8.

### app.js integration (client-ui owns app.js)
- Margin tabs become `大纲 | 批注 | AI`; AI tab renders `MruAiPanel` (keep graph entry point as a
  runhead toggle instead of a fourth tab to save width).
- Paper runhead segmented control gains a document view switch `阅读 | 图谱`; in graph mode the
  main column renders `MruGraphView mode="doc"` for the selected parsed document (with a build
  CTA when the graph is empty).
- Library topbar gains a view switch `文献库 | 全景图谱`; library graph mode renders
  `MruGraphView mode="library"`.
- Selection toolbar gains `问 AI` (send selection as context, switch to AI tab); block tools gain
  a sparkle `问 AI` action (ask about this paragraph).
- Streaming plumbing: `mruStreamNdjson(path, payload, onFrame, {signal})` helper next to `mruPost`.
- Citation jump uses the existing scroll/flash helpers (`mruScrollToElement`, `flashAnnotation`).
- AI annotations refresh via existing annotations loader; graph state fetched via `post('graph.doc')`
  /`post('graph.library')` lazily when a graph view opens; `graph.build` streams progress.
- Contract markers: app.js must expose the following top-level functions for ui/chat.js and
  ui/graph.js (function declarations, hoisted across the concatenated bundle):
  `mruScrollToElement`, `mruFormatCount`, `mruDisplayText`, `mruErrorText`, `MruRichText`,
  `MruFormula`, `MruGlyph`, `MruSpinner`, `mruOverlayPos`.

---

## 7. DSH agent tools (multiple, focused)

Names are global; each returns citation-ready identifiers (`documentId`, `blockKey`, `page`,
`quote`) so the agent can point the user at exact text. Full tool definitions live in
`lib/ai/tools.js` (Lead-owned) with descriptions written per the agent-experience skill.

| tool | purpose | core params |
|---|---|---|
| `library_search` | search titles, parsed text, annotations, translations and graph nodes | `query`, `documentId?`, `scope?: 'library'|'document'`, `limit?` |
| `library_read` | read a document: metadata, markdown slice by offset/block/page, or summary | `documentId`, `offset?`/`blockKey?`/`page?`, `maxChars?`, `view?: 'text'|'tldr'` |
| `library_annotate` | list/create/update/delete annotations | `action`, `documentId`, `annotation?`, `annotationId?`, `aspect?` |
| `library_translate` | translate text or blocks into the user's target language | `documentId`, `text?`/`blockKeys?`, `targetLanguage?` |
| `library_graph` | read/query/update per-paper or library knowledge graphs; build with AI | `action: 'get'|'search'|'build'|'update'|'library'`, `documentId?`, `query?`, `nodes?`, `edges?` |
| `library_ask` | ask the grounded reading AI about one paper; returns answer + citations + created annotations | `documentId`, `question`, `focusBlockKey?` |
| `library_manage` | list/import/parse/cancel/repair/delete/status | `action`, `documentId?`, `url?`, `parse?` |

Tool surface stays at 7 focused tools; descriptions must teach the workflow: search → read →
ask/annotate/graph → manage. Existing `mineru` tool is replaced by these tools (no alias).

---

## 8. CSS class contract (design owns styles; names are stable)

Chat (`.mru-ai-*`): root/panel `.mru-ai`, `.mru-ai__head`, `.mru-ai__title`, `.mru-ai__model`,
`.mru-ai__messages`, `.mru-ai__empty`, `.mru-ai__empty-title`, `.mru-ai__empty-text`,
`.mru-ai__prompts`, `.mru-ai__prompt`, `.mru-ai__msg`, `.mru-ai__msg--user`,
`.mru-ai__msg--assistant`, `.mru-ai__bubble`, `.mru-ai__question`, `.mru-ai__answer`,
`.mru-ai__citations`, `.mru-ai__citation`, `.mru-ai__citation--unverified`,
`.mru-ai__citation-card`, `.mru-ai__actions`, `.mru-ai__action`, `.mru-ai__followups`,
`.mru-ai__followup`, `.mru-ai__context`, `.mru-ai__chip`, `.mru-ai__chip-label`,
`.mru-ai__composer`, `.mru-ai__input`, `.mru-ai__send`, `.mru-ai__stop`, `.mru-ai__hint`,
`.mru-ai__error`, `.mru-ai__notice`, `.mru-ai__streaming`, `.mru-ai__spark`.

Graph (`.mru-graph-*`): `.mru-graph`, `.mru-graph__head`, `.mru-graph__title`,
`.mru-graph__actions`, `.mru-graph__canvas` (SVG), `.mru-graph__edge`, `.mru-graph__edge-label`,
`.mru-graph__node`, `.mru-graph__node--concept|--method|--finding|--definition|--limitation|--section|--question|--insight|--paper|--topic`,
`.mru-graph__node--active`, `.mru-graph__node-label`, `.mru-graph__legend`, `.mru-graph__legend-item`,
`.mru-graph__filters`, `.mru-graph__search`, `.mru-graph__progress`, `.mru-graph__card`,
`.mru-graph__card-title`, `.mru-graph__card-summary`, `.mru-graph__card-meta`, `.mru-graph__empty`,
`.mru-graph__toolbar`, `.mru-graph__status`.

States are expressed with modifier classes and `data-*` attributes; all chrome must stay on
`--dsw-alias-*` / existing `.mru-*` tokens. Motion is limited to node/edge fades on layout change
(reduced-motion aware) and the streaming caret.

---

## 9. Config additions (raw row config, defaults in lib/config.js)

```yaml
ai:
  provider: ""            # empty = agent default model
  model: ""
  maxContextChars: 9000
  historyTurns: 6
  answerMaxTokens: 2048
  graphMaxTokens: 3000
  maxGraphChunks: 12
  maxGraphSourceChars: 160000
  autoBuildGraph: false   # if true, build doc graph after a successful parse
```

Preferences additions (client-owned, persisted host-side): `aiPanelOpen`, `libraryView`,
`docView`, `graphAutoBuild`.

---

## 10. Testing & gates

- Engines are unit-tested with an injected fake LLM (async generator emitting scripted JSON) and
  a fake llm gateway: retrieval ranking, citation validation/dedupe, annotation creation, chat
  persistence, graph build/merge/dedupe, library aggregation, streaming frame sequence.
- Routes/streaming get e2e tests with fake services (NDJSON splitting, abort, error frame before
  headers vs after).
- Client modules: build + `node --check`; client-ui maintains its fake-React render harness under
  `test/client/` (not shipped) to smoke the chat/graph components against fake props.
- `node scripts/check.mjs` remains the gate: manifest, syntax, build, all tests.
- Live verification: after install/reload, diagnostics ping, slot inspection, agent tool calls
  (search/read/ask/graph) against the real library, and one real AI answer with citations on the
  BEE paper (user has a valid MinerU token; LLM is the profile's default model).

---

## 11. Non-goals for this iteration

- Embeddings/vector DB: lexical retrieval only (no new npm dependencies, offline-friendly).
- Library-wide conversational RAG (cross-paper Q&A) — later; graph view + search cover the first
  needs. `mode:"library"` is reserved in the chat request.
- Audio overview, mobile apps, collaboration, external citation-network import (Semantic Scholar).
- Multi-document comparison UI; agent tools can approximate it via search/read.
