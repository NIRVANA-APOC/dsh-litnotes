# dsh-litnotes — product vision: the AI-native reading desk

`dsh-litnotes` turns a local literature library into a **reading and understanding environment**,
not a document viewer with a chatbot bolted on. The unit of work is the reading session: a paper
on the desk, a margin that talks back, and a knowledge graph that quietly accumulates what was
read, asked and concluded.

The core insight: in the AI era the bottleneck is no longer "can the model read the paper" — it is
**trust, orientation and memory**:

- **Trust**: every AI statement should point at the exact sentence it rests on.
- **Orientation**: the reader never loses where they are, what was discussed, what matters.
- **Memory**: multi-turn reading produces knowledge; without a place to put it, it evaporates.

Every feature below addresses one of these three.

---

## 1. Trust: citations as first-class UI

- **Block-anchored citations.** Answers cite parser block keys; citations render as small numbered
  chips inside the answer. Hover shows the quoted sentence (and its page); click scrolls the paper
  to the block and pulses the highlight.
- **Quote-first grounding.** The model must return verbatim quotes with each citation. The host
  verifies the quote actually occurs in the cited block. Unverifiable citations are shown dimmed
  ("未通过校验") and never become annotations. This is the difference between "the AI said it" and
  "the paper says it". A second, cheap entailment pass then checks that the quote actually supports
  the claim: `partial` is flagged, `unsupported` is dimmed like an unverifiable citation and never
  becomes an annotation or a graph edge.
- **No answer without context.** If retrieval cannot find supporting blocks, the AI says what is
  missing instead of inventing; the UI offers "扩大检索范围/换个问法".
- **Provenance everywhere.** Every AI annotation records the question, model, message id and the
  quote; the margin note shows a sparkle and links back to the conversation turn.
- **Source-first reading.** The AI can be asked about the current selection or paragraph (context
  chips), so the question is grounded in what the reader is looking at.

## 2. Orientation: the paper as a conversation

- **Right-margin AI panel** (not a separate app): conversation lives beside the page; scrolling the
  paper keeps the conversation in view; clicking citations moves the page, not the panel.
- **Answers leave marks.** Every verified citation creates a highlight in the source; aspect-based
  colors (definition=yellow, method=sage, result=sky, limitation=rose) make the paper's margin
  history legible: after ten questions you can see which parts were discussed and why.
- **Aspect legend + AI filter** in the margin: filter notes to "AI 批注" / "我的批注" / by aspect
  (implemented: origin chips with counts + the aspect legend itself acts as the aspect filter;
  AI notes carry the sparkle and their aspect label, and the origin filter is remembered
  host-side).
- **Reading memory**: the app returns to the last paper, scroll offset, reading mode, margin tab
  and AI conversation — switching to a chat with the agent no longer loses the place.
- **Streaming with control**: tokens stream in; stop, regenerate, edit-and-rerun; suggested
  follow-ups from the model; previous questions are one click away.
- **Quick actions where the eye is**: selection toolbar gets "问 AI / 解释 / 翻译"; block hover gets
  "问 AI（这段）"; composer has quick prompts (总结全文 / 这篇解决了什么 / 方法是什么 / 局限 / 解释术语).
- **Bilingual by default**: answers in the reader's language, technical terms kept in English;
  citations jump to the original English text so the reader learns from the source.

## 3. Memory: knowledge graphs that maintain themselves

- **Per-paper graph** built by one click ("AI 精读全文"): nodes = concepts, methods, findings,
  definitions, limitations, sections; edges = defines/uses/supports/contrasts/part_of/leads_to.
  Every node keeps block provenance and is a one-click jump into the text.
- **Q&A enriches the graph**: each answer adds a question node, an insight node and links to the
  concepts it referenced. The graph grows as a by-product of reading.
- **Graph as navigation**: click a concept → see its quotes and jump; "问 AI 关于此概念" starts a
  grounded question; filter by type/aspect; collapse to the top-N interesting nodes to avoid hairballs.
- **Library graph**: papers and topics as nodes; topic co-occurrence and shared-concept edges;
  clusters reveal the shape of your library ("我的文献库有 3 个方向：图匹配 / 检索 / 高效推理").
  Click a topic → the papers and evidence behind it. Rebuild incrementally as papers are added.
- **User curation**: rename/merge nodes, pin important ones, add manual edges; AI suggestions are
  proposals, the user's edits win. Implemented for the per-paper graph: inline rename, 2-step
  merge (relations and provenance are kept), persisted pin positions, and edited nodes survive a
  forced rebuild (`curated:true`). The library map stays a deterministic aggregation.

## 4. The agent shares the same knowledge

- DSH chat gets **library tools** (search, read, annotate, translate, graph, ask, manage) that return
  citation-ready coordinates; the agent can answer using the library with the same citations the UI uses.
- Agent-created annotations appear in the reading desk; user annotations are visible to the agent.
- Knowledge graphs are readable and writable through tools, so the agent can summarize a paper,
  propose graph edits, or compare two papers by traversing the library graph.

## 5. Detail checklist (the "next-gen" difference is here)

| area | detail |
|---|---|
| citations | numbered chips, hover preview, click jump+flash, page number, dimmed unverified, aggregation footer "3 条引用" |
| annotations | aspect colors, sparkle origin marker, dedupe overlapping AI highlights, "AI 批注" filter, note shows the claim not the whole answer |
| conversation | per-paper history, regenerate, stop, follow-ups, context chips (selection/visible paragraph), optional "仅根据全文回答" notice, **export conversation as Markdown** |
| reading | last-position restore, page marks, bilingual mode, formula rendering in answers, copy answer as Markdown, export conversation |
| graphs | seeded force layout that keeps node positions stable across updates, progressive disclosure by type, cluster collapse, node→source jump, graph→ask, build progress with cancel, **rename/merge/pin curation with edits surviving rebuilds**, and an **auto-build-after-parse switch** |
| agent | 7 focused tools with discoverable descriptions, outputs always carry `documentId/blockKey/page/quote` |
| trust | citation validation, explicit "insufficient evidence" answers, no silent fallbacks, model/route shown |
| performance | retrieval is lexical and local; context budget enforced; graphs cached on disk; streaming everywhere; no per-keystroke API calls |

## 6. Anti-goals

- Not a generic chat page: no answer without document context and citations.
- Not a dashboard of AI cards: AI appears exactly where reading happens.
- Not an unreadable hairball graph: default views are curated; the full graph is one toggle away.
- Not a black box: model, citations, provenance and validation state are visible.
- Not a dependency farm: no embeddings/vector DB/CDN; offline-friendly, vendored KaTeX only.

---

*Implementation contracts: `docs/AI-SPEC.md`. External product research: `docs/RESEARCH.md`.
Previous architecture/design: `docs/ARCH.md`, `docs/UI-SPEC.md`.*
