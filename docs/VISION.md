# dsh-litnotes — product vision: the AI-native reading desk

`dsh-litnotes` turns a local literature library into a **reading and understanding environment**,
not a document viewer with a chatbot bolted on. The unit of work is the reading session: a paper
on the desk, a margin that talks back, and a knowledge map that quietly accumulates what was read,
asked and concluded.

In the AI era the bottleneck is no longer "can the model read the paper" — it is **trust,
orientation and memory**:

- **Trust** — every AI statement points at the exact sentence it rests on.
- **Orientation** — the reader never loses where they are, what was discussed, what matters.
- **Memory** — a reading session produces knowledge; without a place to put it, it evaporates.

## 1. Trust: citations as a visible line

- **Block-anchored citations.** Answers cite reader block keys; citations render as numbered chips
  inside the answer. Hovering shows the quoted sentence and page; clicking moves the paper to the
  block and pulses the highlight.
- **Quote-first grounding.** The model returns a verbatim quote with each citation; the host
  verifies the quote occurs in the cited block, computes offsets against the reader's plain text
  and rejects unverifiable citations (shown dimmed, never annotated).
- **A second, cheap entailment pass** asks whether the quote actually supports the claim.
  `partial` stays visible but flagged; `unsupported` is dimmed like an unverifiable citation and
  never becomes an annotation or a graph edge.
- **No answer without evidence.** If retrieval finds nothing, the assistant says what is missing
  instead of inventing. Model, route and validation state stay visible.
- **Provenance everywhere.** AI annotations record the question, model, message id and quote; the
  margin note links back to the conversation turn.
- **Tethering is the promise.** A hairline in the annotation's aspect color physically connects
  every margin slip — AI answer, citation, user note — to the sentence it rests on. Provenance is
  a line you can see, not a tooltip you have to hunt for.

## 2. Orientation: the page is the interface

- **The margin is the conversation.** AI lives beside the page, not on a separate screen:
  scrolling the paper keeps the conversation in view; clicking a citation moves the page.
- **Answers leave marks.** Every verified citation becomes an aspect-colored highlight
  (definition yellow, method sage, result sky, limitation rose), so after ten questions the
  margin history shows which parts were discussed and why.
- **A stable desk.** A persistent frame with the library rail, a scene context bar and a quiet
  status bar; the same control keeps the same position in every scene. Reading position, mode,
  widths and the last conversation are restored on return.
- **Reading comfort first.** Serif English original with a quieter translation column, original /
  bilingual / translated modes, page marks, outline and scale, formulas
  rendered locally (vendored KaTeX).
- **Control over the stream.** Stop, regenerate, follow-ups, quick prompts where the eye is, and
  one-click Markdown export of a conversation.

## 3. Memory: knowledge graphs that maintain themselves

- **Per-paper graph** built by one action: nodes are concepts, methods, findings, definitions,
  limitations and sections; edges carry meaning (`defines`, `uses`, `supports`, `contradicts`,
  `part_of`, `leads_to`, …). Every node keeps block provenance and jumps back into the text.
- **Q&A enriches the graph.** Each grounded answer can add question/insight nodes and their
  relations, so the graph grows as a by-product of reading.
- **Graph as navigation.** Click a concept to see its evidence and jump; ask a grounded question
  about it; filter by type/aspect; collapse to the interesting subgraph.
- **Library graph** aggregates papers and topics deterministically: topic co-occurrence,
  shared-concept edges, clusters, TL;DR — the shape of the library, not a hairball.
- **The reader stays in charge.** Rename, merge, pin and curate nodes; user edits are marked and
  survive a rebuild. The map is a reading aid, never a black box.

## 4. The agent shares the library

The DSH agent gets the same operations through seven focused tools (search, read, ask, annotate,
translate, graph, manage) that return citation-ready coordinates. It can answer from the library
with the citations the reader can click, create annotations that appear in the margin, and read or
propose graph edits. One operations layer serves both surfaces, so UI and agent can never drift.

## 5. Non-goals

- Not a generic chat page: no answer without document context and citations.
- Not a dashboard of AI cards: AI appears exactly where reading happens.
- Not an unreadable hairball graph: curated views first, the full map one toggle away.
- Not a black box: model, citations, provenance and validation state are visible.
- Not a dependency farm: no embeddings, vector database or CDN; offline-friendly, vendored
  runtimes only, and no runtime npm dependencies shipped with the plugin.

---

Implementation contracts: [`ARCH.md`](ARCH.md) (architecture and data formats),
[`PARSING.md`](PARSING.md) (parse engines), [`AGENT.md`](AGENT.md) (agent tools),
[`AI-SPEC.md`](AI-SPEC.md) (AI contracts), [`UI-SPEC.md`](UI-SPEC.md) (reading desk).
