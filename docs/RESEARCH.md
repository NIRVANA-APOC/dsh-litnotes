# AI-native reading: research & build notes for dsh-scholar

> **Snapshot:** 2026-11-06. Sources are product help pages, papers and 2026 reviews; numbers are vendor/paper claims.
> **Current product:** workspace still ships as `dsh-mineru` (rename in flight); reading desk + MinerU parse + bilingual/annotations are done.
> **Next goal:** right-AI-panel grounded Q&A, per-paper KG auto-built + Q&A enrichment, library-wide KG, multiple DSH agent tools.
> **Hard constraints** (see [ARCH](ARCH.md), [UI-SPEC](UI-SPEC.md)): host is plain Node ESM, no npm deps; client is React `createElement` only; JSON HTTP routes + same-origin fence; block anchors are `blockKey` + plain-text offsets; annotations live in `annotations.json` and the client owns the merge.
> **Extra lever we actually have:** host `ctx.get('llm')` (optional) exposes `stream({provider, model, system, messages, temperature, maxTokens, signal})`; default route via `ctx.get('agentDefaultModel').currentSelection()` → `{provider, model, reasoningEffort}`. There is no citations feature, no JSON-schema mode: citation grounding and JSON validation are ours to implement. `ctx.get('translator')` is available for cross-lingual retrieval.

## 0. TL;DR — what actually decides success

- **Trust is claim-anchored, not bibliography.** 2026's best citation UIs attach a chip to the claim, preview the quote on hover, deep-link into the exact passage and visibly degrade when evidence is missing ([AYDesign patterns](https://www.aydesign.ai/blog/ai-citation-source-ui-patterns-2026); [Anthropic Citations API](https://platform.claude.com/docs/en/build-with-claude/citations)).
- **Best grounding architecture = retrieve → enumerate evidence → model may only cite enumerated IDs → host verification.** Anthropic makes invalid pointers impossible by construction (sentence chunks + `cited_text`/`start_char_index`/`end_char_index`); Google AGREE and OpenScholar show a post-hoc entailment/verification pass fixes what prompting cannot ([Anthropic](https://www.anthropic.com/news/introducing-citations-api), [AGREE](https://research.google/blog/effective-large-language-model-adaptation-for-improved-grounding/), [OpenScholar, Nature 2026](https://www.nature.com/articles/s41586-025-10072-4)).
- **Hallucinated citations are still the default failure in 2026.** In OpenScholar's tests GPT-4o fabricated 78–90% of recent-literature citations; GPT-5 (Aug 2025) was still 39% fabricated at title level with common fabrication below that. Never let the model write a free-form reference list; never cite papers outside the library ([OpenScholar](https://www.nature.com/articles/s41586-025-10072-4), [ALCE](https://ar5iv.labs.arxiv.org/html/2305.14627), [L-CiteEval](https://ar5iv.labs.arxiv.org/html/2410.02115)).
- **The reading-assistant converged UX is a right rail scoped to the document** with per-passage citations, source scope controls, save-to-note, suggested follow-ups and Fast/Thinking tiers ([Readwise Global Ghostreader](https://docs.readwise.io/reader/guides/ghostreader/global), [Gemini Notebook chat](https://support.google.com/notebooklm/answer/16179559?hl=en), [SciSpace](https://scispace.com/guides/how-to-chat-with-pdf), [Zotero Agent](https://pypi.org/project/zotero-mcp-server/0.14.1/)).
- **Our unfair advantages:** local-first data (vs cloud notebooks), existing exact-span anchors (`blockKey`+offsets → a citation can flash the exact sentence, not a page), bilingual context, and one library shared by UI *and* DSH agent tools.
- **Graphs fail two ways: hairball and no-provenance.** Citation graphs are for *exploration* (Connected Papers similarity, Litmaps date axis, ResearchRabbit chaining); entity/claim graphs are for *comprehension* (GraphRAG/PaperQA2). Render typed, evidence-scoped ego slices, never the whole library ([Semantic Bundling](https://arxiv.org/abs/2608.04002)).
- **Auto-artifacts must be produced at parse-complete and cached** (TL;DR, glossary, section summaries, graph), while chat streams live. Readwise/Elicit/Perplexity all make latency/cost legible with a Fast/Deep or fast/balanced/comprehensive choice.
- **Answer → annotation must be explicit, batchable and reversible.** MarginNote's "one excerpt = highlight = mind-map node = flashcard" is the right atomic unit; silent auto-highlighting is an anti-pattern ([MarginNote 4](https://apps.apple.com/us/app/marginnote-4-ai-notes-mindmap/id1531657269)).
- **Q&A should enrich the KG, not just answer.** Each accepted answer is evidence-linked (question, claim, evidence spans) and merged into the per-paper graph; this is how the graph improves with use instead of existing only at parse time.
- **The agent-tool opportunity is our moat:** text tools alone can't do this. Expose search/read/ask/graph over the same service, with `docId#blockKey` handles and bounded outputs, so an agent can `ask → read around citation → annotate`.

## 1. Landscape, 2026-11

| Product | What it does | Steal | Avoid / critique |
|---|---|---|---|
| **Gemini Notebook** (NotebookLM until Jul 2026) | Source-grounded notebook: chat cites sources; hover shows full quote; click jumps to quote; choose which sources are active; save answer to note preserving clickable citations; audio/video/mind-map/report outputs; 2026 agentic chat with skills/code ([help](https://support.google.com/notebooklm/answer/16179559?hl=en), [2026 guide](https://apidog.com/blog/how-to-use-notebooklm/), [Jun 2026 upgrade](https://blog.google/innovation-and-ai/products/notebooklm/better-research-notebooklm/)) | Hover-quote + click-to-source; source checkboxes; save-to-note with live citations; explicit "can't answer from your sources"; mind map as navigation | Notebook/cloud model; no reading-position awareness; free-tier source caps; answers only from selected sources (fine for trust, weak for "compare to outside literature") |
| **Elicit** | Research agent + systematic-review workflow: search → screen → extract into columns → cited report; click report text to see supporting quotes/reasoning; report templates + fast/balanced/comprehensive ([columns](https://support.elicit.com/en/articles/14758162-create-and-save-columns-in-elicit), [reports](https://support.elicit.com/en/articles/14756862-get-a-research-report-to-generate-in-depth-answers-automatically-in-elicit)) | Plain-language column spec (name + instructions + output format + examples) as a reusable preset; report templates; step sidebar; "supporting quote" reveal | Extraction tables ≠ reading; per-column LLM runs are pricey; weak single-paper reading UX |
| **SciSpace / Copilot** | Chat with paper with citations; highlight math/text/table → simplify/explain; follow-ups; literature-review workspace; page-anchored answers ([Chrome store](https://chromewebstore.google.com/detail/scispace-do-hours-of-rese/cipccbpjpemcnijhjcdjmkjhmhniiick), [chat guide](https://scispace.com/guides/how-to-chat-with-pdf), [lit-review workspace](https://scispace.com/resources/scispace-literature-review-workspace/)) | Selection-first actions ("explain this math/table"); page-anchored citations; follow-up suggestions | Chat is detached from the reading surface; PDF-first, no structured blocks |
| **Consensus** | Academic search + Consensus Meter (Yes/No/Mixed across top ~20 papers, weighted by study quality since 2.0); Deep search/review agentic modes ([meter](https://help.consensus.app/en/articles/10069920-the-consensus-meter), [Meter 2.0](https://consensus.app/home/blog/new-consensus-meter/), [Deep Search](https://docs.consensus.app/core-features/deep-search), [Deep review](https://help.consensus.app/en/articles/11740827-how-to-use-deep-review)) | Evidence-strength badge with breakdown (not a fake %); "no studies found" explicit; deep mode showing its steps | Aggregation over results, not your library; can flatten nuance |
| **Semantic Scholar** | 200M+ paper graph API: TLDRs, citation contexts, influential-citation counts, citation intents ([API](https://api.semanticscholar.org/api-docs/graph), [product](https://www.semanticscholar.org/product/api)) | TLDR-per-paper as cheap cache; citation contexts as edge evidence; influential-citation filtering | Not a reader; API rate limits; no annotations |
| **Perplexity** | Answer engine: numbered inline chips, hover preview, source cards, follow-ups, focus modes, model picker, "show uncertainty" ([features](https://www.gend.co/blog/perplexity-hidden-features); [citation UI analysis](https://www.aydesign.ai/blog/ai-citation-source-ui-patterns-2026)) | Numbered chips ↔ source rail; visible focus/scope; follow-up chips; inline disagreement prompts | Web sources, not user-owned papers; citation reliability varies |
| **Readwise Reader + Global Ghostreader** | Library-wide Q&A with per-passage citations (hover exact line, click jumps); Fast/Thinking models; *skills* (reusable scoped prompts) and *tools* (read=always allow, write=confirm each time); per-doc chat can pull related library docs; conversation history ([docs](https://docs.readwise.io/reader/guides/ghostreader/global)) | Permissioned agent tools; skills vs tools split; per-passage citation hover/jump; expand sidebar chat; conversation management | Notes-centric; PDF experience weaker; AI outputs not graph-structured |
| **Zotero + AI plugins** | PDF Translate: selection popup, annotation-comment translation, add-to-note, standalone compare window, concat mode ([repo](https://github.com/windingwind/zotero-pdf-translate)); Zotero-MCP: `search_items`, `get_item_fulltext` (bounded page cap), `get_annotations`, `synthesize_annotations`, page-layout/area annotations; Zotero Agent click citation → opens page and flashes sentence ([pypi 0.14.1](https://pypi.org/project/zotero-mcp-server/0.14.1/)) | The exact tool set we need; citation→page-flash; bounded read; annotation digest; translate-into-annotation | Plugin soup; no built-in grounded synthesis; AI is bolt-on |
| **ChatPDF / Humata** | Chat with PDF, page-level citations, 1000-page docs, multi-doc compare ([ChatPDF](https://www.chatpdf.com), [Humata review](https://toolpilot.tools/tools/humata-ai)) | Page-level citation targets; "jump to page" mental model | Page-level is too coarse for annotations; generic chat UX |
| **Scholarcy** | Auto summary flashcards, key-point highlights, comparative-analysis view, "Enhance" summary styles, browser extension ([site](https://www.scholarcy.com/), [extension](https://chromewebstore.google.com/detail/scholarcy-browser-extensi/oekgknkmgmaehhpegfeioenikocgbcib)) | Summary hierarchy as flashcards; key points as navigation; comparative table | Summary-only, no reading desk, no chat |
| **Litmaps** | Seed map (papers by citations), date-vs-citations visualization, monitor/alert, Zotero sync ([features](https://www.litmaps.com/features)) | Time axis in graph; seed → expand; alerts | Not a reader; external corpus |
| **Connected Papers** | Similarity graph (co-citation + bibliographic coupling, not a citation tree), force-directed, shortest-path-to-origin highlight ([about](https://www.connectedpapers.com/about)) | "Similar but not citing" edges; path highlight; force layout | Single seed; no evidence on edges |
| **ResearchRabbit** | Collections, iterative citation chaining, configurable graph, author/topic recommendations ([site](https://www.researchrabbit.ai)) | Chaining as workflow; collections as context | Cluttered graphs; external only |
| **MarginNote 4** | "Card Axis": one excerpt = PDF highlight = mind-map node = flashcard; Title Link resurfaces past notes when a concept reappears; extended notes ([App Store](https://apps.apple.com/us/app/marginnote-4-ai-notes-mindmap/id1531657269)) | Excerpt→node→card pipeline; cross-document concept surfacing | Dense UI, steep learning curve; iPad-centric |
| **Heptabase** | Whiteboard + cards; AI actions on cards (translate/summarize/mind-map) + custom actions; MCP save-to/consult-KB ([newsletter](https://wiki.heptabase.com/newsletters/2025-12-30)) | AI actions as named, repeatable operations; two-way MCP (save + consult) | Spatial tool, not a paper reader; manual card making |
| **Obsidian / Logseq AI** | Smart Connections: local-embedding related notes, inline passage matches with scores, local-by-default privacy panel ([Smart Connections](https://smartconnections.app/smart-connections/)); Copilot-style vault chat ([Copilot](https://github.com/logancyang/obsidian-copilot)) | Related-passage popover w/ score + source; local-first positioning; "you choose what to link" | No paper structure/annotations; plugin quality varies |
| **Mem** | AI notes: Mem Chat knows all notes, can create/update notes on command ([App Store](https://apps.apple.com/sa/app/mem-your-ai-thought-partner/id1578757028)) | "Ask + it updates the KB" write-back loop | Notes, not literature; auto-updates can surprise |
| **Recall** | Self-organising knowledge base: auto-summary, related items auto-connected/visualized in a graph, spaced-repetition quizzes ([profile](https://profiles.crustdata.com/company/recall-wiki-inc)) | Auto-link graph + resurfacing + active recall | Auto-clutter risk; not paper-deep |
| **Undermind** | Literature agent: asks clarifying questions, follows citation trails, reports saturation ("whether more remain"), MCP access ([site](https://www.undermind.ai/), [review](https://theaiagentindex.com/agents/undermind)) | Saturation/coverage statement; citation-trail traversal; clarifying question before search | Search, not reading; external corpus |
| **OpenScholar / PaperQA2** (research systems) | Agentic scientific RAG: rerank → generate cited answer → self-feedback → citation verification; PaperQA2 adds contextual summarization, contradiction detection, media enrichment ([OpenScholar](https://www.nature.com/articles/s41586-025-10072-4), [PaperQA2](https://github.com/Future-House/paper-qa)) | The ground-truth architecture for our answer pipeline; evidence budgets `k`/`max_sources`; contradiction mode | Heavy infra; PaperQA2 high precision but low coverage on multi-paper synthesis |

## 2. Concrete details worth stealing

### 2.1 Grounded-answer surface (trust layer)

- **Chip per claim, not per paragraph.** Superscript `[E#]` after the supported clause; step/claim-level attribution is what separates trustworthy products from "footnote dump" ([AYDesign](https://www.aydesign.ai/blog/ai-citation-source-ui-patterns-2026)). Our answer markdown can carry `[E1]` markers that the client renders as `<button class="mru-cite">`.
- **Hover = quote card, click = exact-span jump.** NotebookLM: hover shows full quoted text, click navigates to the quote in context ([help](https://support.google.com/notebooklm/answer/16179559?hl=en)). Readwise: hover previews the exact cited line, click jumps. Zotero Agent: click opens the page and flashes the cited sentence ([zotero-mcp](https://pypi.org/project/zotero-mcp-server/0.14.1/)). We can do better: jump to `blockKey` + pulse the `start/end` span, then offer "return to answer".
- **Evidence rail, not a source dump.** A collapsible "依据 N 段" list under the answer, numbered consistently with chips, each row = paper · section · quote · action (划线 / 定位). A separate "检索了 24 段，采用 6 段" line makes the pipeline auditable.
- **Missing-source disclosure.** Unsupported claims get a visible `无出处` / `AI 推断` badge, never the same style as cited claims ([AYDesign pattern 7](https://www.aydesign.ai/blog/ai-citation-source-ui-patterns-2026)). Insufficient retrieval returns an explicit state: 「这两篇论文没有覆盖这个问题」+ buttons 「改为整库提问」/「换个问法」 — NotebookLM refuses instead of guessing ([2026 guide](https://apidog.com/blog/how-to-use-notebooklm/)).
- **Confidence from evidence, not vibes.** `strong | mixed | weak | unsupported` derived from # corroborating passages and whether passages disagree; click expands which evidence supports/contradicts. Consensus's meter 2.0 weights study quality; scite classifies citing statements into supporting/contrasting/mentioning ([Consensus](https://help.consensus.app/en/articles/10069920-the-consensus-meter), [scite](https://scite.ai/blog/a-citation-count-is-not-a-verdict), [classification](https://help.researchsolutions.com/hc/en-us/articles/31949617584148-How-are-citations-classified)). No fake percentage.
- **Scope always visible.** Chips above the input: 选中文本 / 本节 · 3.2 / 整篇论文 / 整库. NotebookLM has per-source checkboxes; Perplexity has Focus modes; Readwise scopes doc vs library ([NotebookLM](https://support.google.com/notebooklm/answer/16179559?hl=en), [Perplexity](https://www.gend.co/blog/perplexity-hidden-features), [Readwise](https://docs.readwise.io/reader/guides/ghostreader/global)). Echo the active scope in the answer header.
- **Provenance footer:** model name, evidence count, papers touched, generated-at, and「基于本机解析稿」. Never list a source that was not in the prompt.

### 2.2 Answer → highlight / annotation

- **Per-citation "划线" action** on the chip/evidence row; **answer footer "保存为批注"** creates one note anchored at the first evidence span with note = claim; `origin: "ai"`, `threadId` retained. NotebookLM's "Save to note" preserves inline clickable citations; Elicit lets you click report text to see the supporting quote; MarginNote makes one excerpt a highlight, a mind-map node and a flashcard simultaneously ([NotebookLM](https://support.google.com/notebooklm/answer/16179559?hl=en), [Elicit](https://support.elicit.com/en/articles/14756862-get-a-research-report-to-generate-in-depth-answers-automatically-in-elicit), [MarginNote](https://apps.apple.com/us/app/marginnote-4-ai-notes-mindmap/id1531657269)).
- **Batch save with undo, capped.** "保存全部引用" creates ≤6 annotations in one click + one undo toast; never silently highlight a page.
- **Color semantics using the existing 4 inks:** yellow = finding/claim, sage = method/definition, sky = context/limitation, rose = critique/contradiction. AI-created notes carry an "AI" dot + filter in the margin; user can recolor. Zotero PDF Translate already writes translations into annotation comments/notes ([repo](https://github.com/windingwind/zotero-pdf-translate)) — treat AI-added note text as normal editable note text.
- **Reparse/anchoring:** annotations are `blockKey`+offsets; a reparse changes `blockKey` (hash of plain text). AI notes must be re-anchored by quote search on load and never dropped silently; show「3 条 AI 批注因重新解析失效」with a review action. Existing client drops missing-block annotations — extend that path before shipping AI notes.
- **Schema warning:** `normalizeAnnotation` in `ui/highlight.js` returns only `{id, blockKey, start, end, quote, color, note, createdAt, updatedAt}` — unknown fields are stripped. `origin`/`threadId` need a small coordinated schema extension (highlight.js + UI-SPEC + annotations.json), otherwise AI provenance disappears on first reload.
- **Thread link:** AI note footer shows a `问` chip that reopens the source Q&A thread. Heptabase MCP's two-way "save to KB / consult KB" shows this is the expected loop ([Heptabase](https://wiki.heptabase.com/newsletters/2025-12-30)).

### 2.3 Conversation, context and latency

- **Selection bar gets a fifth action: 问 AI.** Plus per-block hover quick actions: 解释本段 / 追问方法 / 找相关段落 / 记一条笔记. SciSpace's core interaction is highlight → explain math/text/table ([SciSpace](https://scispace.com/guides/how-to-chat-with-pdf)).
- **Context chips are editable and automatic:** opening the panel defaults to 整篇 + current section (当前段落 when the caret is in a block); selecting text flips to 选中; chip removal is explicit. This fixes "chat detached from the reading position", the main weakness of ChatPDF-style tools.
- **Streaming with phases and stop.** `检索中 · 24 段 → 生成中 → 核对引用`; Stop keeps the partial answer marked 未完成; Regenerate; edit the last question. NotebookLM's Stop → revise prompt / keep generating is the reference behavior ([help](https://support.google.com/notebooklm/answer/16179559?hl=en)); Elicit shows a step sidebar for long jobs.
- **Fast / Deep toggle** (Readwise Fast/Thinking; Elicit fast/balanced/comprehensive; Perplexity model picker). Fast = no rerank + no verification + fewer evidence; Deep = rerank + verification + follow-ups. Store per-thread so results are reproducible.
- **Suggested follow-ups** (3 chips) after each answer, generated from the evidence/paper; quick prompts on the empty panel: 「这篇论文的贡献是什么？」「方法的关键假设？」「和哪篇相关？」.
- **Thread management:** per-paper and library threads, rename/copy/delete, recent list, expand panel to a wide sheet (Readwise behavior). Persist host-side (same JSON pattern as annotations) so reloads keep history.
- **Keyboard:** `Cmd/Ctrl+J` focus AI input, `Cmd/Ctrl+Enter` send, `Esc` close popovers/stop streaming, `↑` edit last question, `[`/`]` jump between citations.

### 2.4 Bilingual reading aids (we already have the base; AI must not break it)

- **Keep paragraph-pair translation as the primary mode**; AI answers can quote English evidence and explain in Chinese, but the evidence quote stays original (never translate the citation silently).
- **Glossary-aware translation:** auto-extract per-paper terms at enrich time (`term_en`, `term_zh`, definition, evidence block); inject the glossary into translation prompts so terms stay consistent; glossary chips jump to source. Immersive Translate markets "AI terminology libraries"; Zotero PDF Translate offers dictionary mode for single words ([Immersive](https://immersivetranslate.com/en/), [Zotero](https://github.com/windingwind/zotero-pdf-translate)).
- **Translation queue behavior worth copying** (bilingual-reader): cache per block, controlled concurrency + throttle + timeout, cancel/re-translate, skip the references section by default ([bilingual-reader](https://github.com/quillamio/bilingual-reader)).
- **Selection translation card:** keep provider label, one-click copy, retry; add "术语加进词汇表" as a secondary action.
- **Read-aloud / TTS** is out of scope for v1 (NotebookLM audio overview is a different product; not a reading-desk need).

### 2.5 Knowledge-graph UX (the part most products get wrong)

- **Two separate graphs.** (a) *Discovery graph*: paper nodes linked by citation/similarity — Connected Papers uses co-citation + bibliographic coupling so non-citing papers can be adjacent, force layout, select highlights shortest path to origin ([Connected Papers](https://www.connectedpapers.com/about)); Litmaps adds a date axis; ResearchRabbit does iterative chaining ([Litmaps](https://www.litmaps.com/features), [ResearchRabbit](https://www.researchrabbit.ai)). (b) *Comprehension graph*: concepts/methods/claims inside a paper, each with evidence. Mixing them is the hairball.
- **Provenance on every node and edge.** GraphRAG's knowledge model links Entities/Relationships/Covariates back to TextUnits; its docs call provenance their purpose ([GraphRAG dataflow](https://microsoft.github.io/graphrag/index/default_dataflow/)). Our equivalent: every node/edge stores `{blockKey, quote}` evidence; nodes without evidence are hidden by default (or dimmed as "推断").
- **Adopt LightRAG's incremental discipline, not GraphRAG's batch pipeline:** GraphRAG does entity/relationship extraction → summarisation → hierarchical Leiden communities → community reports (expensive to rebuild); LightRAG keeps a dual KG+vector store, supports incremental updates and skips community reports for cost/latency ([GraphRAG](https://microsoft.github.io/graphrag/index/default_dataflow/), [LightRAG](https://github.com/HKUDS/LightRAG)). Per-paper graphs must merge incrementally as Q&A adds knowledge.
- **Per-paper default view = typed ego.** Paper node at centre, rings by type (method · dataset · metric · claim · limitation · concept), 1-hop default, node size by degree/confidence, labels on hover (or degree ≥2), type-filter chips, 2-hop toggle, double-click to re-focus. Click a node/edge → evidence list (≤5 quotes) → jump to source and pulse span. This is the "node → source jump" detail every graph tool needs.
- **Library default view = timeline + citation edges.** Paper cards as nodes positioned by year/added-at (Litmaps' date-vs-cite view is the most legible citation visualization), edges = resolved citations (thick) / shared concepts (thin), seed ego + 1–2 hops, unmatched external refs hidden with a count. If >300 nodes, cluster by concept type into labelled supernodes — Semantic Bundling shows LLM-labelled supernodes/superedges with links back to underlying triples and source documents solve the hairball while staying grounded ([Semantic Bundling](https://arxiv.org/abs/2608.04002)).
- **Q&A enrichment:** after an answer, extract 0–3 new nodes/edges from (question, answer claims, evidence) with `source:"qa"`; dedupe by normalized label+type; add edges only when a quote supports them; cap +10% graph growth per answer; UI badge "AI 补充".
- **Cross-paper surfacing:** MarginNote's Title Link lights up past annotations when a familiar concept reappears; Smart Connections shows an inline popover with matched line ranges, source and relative score ([MarginNote](https://apps.apple.com/us/app/marginnote-4-ai-notes-mindmap/id1531657269), [Smart Connections](https://smartconnections.app/smart-connections/)). Our version: margin hint「你在《X》§3.2 也高亮过这个概念」+ hover snippet, never auto-expanded.
- **Edge semantics from citation intelligence:** scite's supporting/contrasting/mentioning classification and S2's citation contexts/intents/influential counts are the labels to aim for on paper→paper edges ([scite](https://scite.ai/blog/a-citation-count-is-not-a-verdict), [S2 API](https://api.semanticscholar.org/api-docs/graph)). Locally we can only classify edges from our own parsed text (citation context in a citing paper), so ship "cites (unlabelled)" first and label later.
- **Graph interactions are questions:** right-click a node → 「用它追问 AI」「展开邻居」「只看矛盾边」「加入笔记」; edge click → quotes from both papers. Every graph view has a list fallback for keyboard/screen readers.

### 2.6 Agent tools over the library

- **zotero-mcp is the closest prior art and the naming bar.** Tools are verbs: `search_items`, `get_item_fulltext` (bounded by a configurable page cap, 10 in the 0.8 docs — "reading is bounded by the assistant's context"), `get_annotations`, `synthesize_annotations` (a per-paper annotation digest), `get_page_layout` ([pypi 0.14.1](https://pypi.org/project/zotero-mcp-server/0.14.1/)). Keep results compact; actions, not product nouns.
- **Permission model from Readwise Ghostreader:** read tools default "always allow", write tools default "confirm each time", per-tool setting, inline approval card with Remember ([Readwise](https://docs.readwise.io/reader/guides/ghostreader/global)). DSH tools can't show cards unless wired to the approval service — at minimum mark writes `origin:"agent"`, make them undoable and off by default from the UI's perspective.
- **Skills vs tools:** Readwise separates reusable plain-language *skills* (Universal / Document / Passage / Word scopes, slash commands, custom instructions) from *tools* (actions with permissions). Copy this in our AI panel: built-in skills + P1 custom skills; pre-set quick actions are the seed.
- **Both directions matter:** Heptabase MCP offers "save to KB" and "consult KB" ([Heptabase](https://wiki.heptabase.com/newsletters/2025-12-30)); we need read tools (search/read/ask/graph) and a write path (annotate/import) for agent workflows.
- **Handle chaining:** every tool result carries `docId#blockKey` (and span) so the agent can immediately call `scholar_read` around a citation to verify — the same "retrieve → read → verify" loop OpenScholar/PaperQA2 use. Tool descriptions must state this flow in one sentence.
- **Output budgets:** search ≤8 rows with 160-char quotes; read ≤8k chars + `nextOffset`; ask ≤6 evidence excerpts (~2.5k chars) + answer; graph ≤40 nodes/80 edges. DSH prunes tool results anyway; small results improve reasoning and cost.
- **One service, two callers:** UI routes and tools both call `lib/ai.js` + `lib/graph.js`; prompts live in one module with a `PROMPT_VERSION` stored in artifacts so caching invalidates on prompt changes.

### 2.7 Summary hierarchy, export, performance

- **Hierarchy:** TL;DR (2–3 bullets + one-sentence contribution) → per-section summaries attached to headings → glossary → claims/limitations table → follow-up questions. Scholarcy's summary flashcards + key points and Elicit's report templates (General Review / 1-Page Overview / Research Gap Analysis) are the templates to copy ([Scholarcy](https://www.scholarcy.com/), [Elicit reports](https://support.elicit.com/en/articles/14756862-get-a-research-report-to-generate-in-depth-answers-automatically-in-elicit)).
- **Mind map = navigation, not decoration:** NotebookLM's mind map lets you click a branch and ask about it ([2026 guide](https://apidog.com/blog/how-to-use-notebooklm/)); our graph should have the same "click → focus → ask" loop.
- **Export:** extend the existing 导出 Markdown with a "阅读笔记" export (paper + annotations with quotes/colors/notes + AI threads with citations) and a "graph JSON". Readwise/Heptabase/Zotero all treat export as the escape hatch users check before trusting a tool.
- **Perf:** paper open must not wait for AI; enrich runs after `status: parsed` and fills in (`AI 准备中` chip). Graph renders a static SVG after ≤120 layout frames (respect `prefers-reduced-motion`), labels only when zoomed; AI threads capped (e.g., 100/doc); blocks are already parsed client-side, so citation jumps are O(1) via `blockKey`.
- **Mobile:** the AI tab and graph become a full-height sheet (same `.mru-scrim` pattern as the rail drawer); citation jumps offset the scroll so the passage is not hidden behind the sheet; the graph gets a list view on narrow screens.
- **Large docs:** chunk by section headings (never by fixed characters) and pass section titles + block ids into prompts; GraphRAG's 1200-token TextUnit default is a useful chunk-size prior; PaperQA2's contextual summarisation (score each chunk in the context of the query before answering) is cheap and effective for long papers ([GraphRAG](https://microsoft.github.io/graphrag/index/default_dataflow/), [PaperQA2](https://github.com/Future-House/paper-qa)).

### 2.8 Quality floor for the AI surface

- Citation chip is a real `<button>` with `aria-label="引用 3：论文标题 §3.2"`; hover card reachable by keyboard focus, `Escape` closes ([AYDesign accessibility notes](https://www.aydesign.ai/blog/ai-citation-source-ui-patterns-2026)).
- Streaming text uses `aria-live="polite"` throttled (not per token); evidence rail is a real list; graph has a text alternative.
- All AI copy goes through `t()`; answer language follows harness locale (zh default), technical terms stay English on first use — mirrors the reading desk's bilingual voice.
- Never render model markdown as raw HTML: parse with the existing `ui/markdown.js` (headings/paragraphs/lists/code/formula only) so citations and formulas are safe and styled like the paper.

## 3. Anti-patterns, with mitigations

- **Citation hallucination.** Prompt-only citations are unreliable: ALCE showed even strong LLMs cite poorly; L-CiteEval finds long-context models not faithful to context; OpenScholar measured 78–90% fabricated citations from GPT-4o and 39% title-level from GPT-5 ([ALCE](https://ar5iv.labs.arxiv.org/html/2305.14627), [L-CiteEval](https://ar5iv.labs.arxiv.org/html/2410.02115), [OpenScholar](https://www.nature.com/articles/s41586-025-10072-4)). Mitigate by construction: numbered evidence envelope; answer only cites `[E#]`; host drops unknown ids; each claim verified by an entailment call (`supported/partial/unsupported`); unsupported claims get a badge; no bibliography, no paper names outside evidence; if nothing retrieved, say so. OpenScholar's ablation also shows **reranking is the single biggest quality lever**, so don't skip it in Deep mode. ([AGREE](https://research.google/blog/effective-large-language-model-adaptation-for-improved-grounding/) uses NLI post-hoc + explicitly no citation when unsupported; Anthropic guarantees pointers by chunking documents and parsing citation blocks ([docs](https://platform.claude.com/docs/en/build-with-claude/citations)).)
- **Over-annotation / margin clutter.** Silent auto-highlighting turns the margin into noise and is easy to undo only in theory. Save only on explicit action, batch + undo, color by role, show an AI filter, never create more than 6 annotations per answer, and keep AI note text editable.
- **Graph hairball.** Full-library force graphs are unreadable ("hairball problem", [Semantic Bundling](https://arxiv.org/abs/2608.04002)). Defaults: typed ego, 1 hop, ≤60 nodes/paper, ≤300 nodes library, evidence-less nodes hidden, concept supernodes only when shared by ≥2 papers, collapse clusters into labelled supernodes at zoom-out. Never mix citation and concept edges in one view without filters.
- **Context and cost blowups.** Stuffing the whole paper/library every turn is slow and degrades smaller models (OpenScholar: smaller LMs improve from N=5→10 passages then degrade; larger N hurts citation accuracy, while the trained 8B stays strong to N=20). Order of magnitude for planning: a 15-page paper ≈ 9–12k tokens; enrich ≈ 2 calls / 25–40k input tokens once; one Deep question ≈ 10k input tokens. Use 6–12 reranked evidence spans, cached TL;DRs instead of raw context, section-scoped prompts, and hard `maxTokens` caps ([OpenScholar](https://www.nature.com/articles/s41586-025-10072-4)).
- **Latency.** Retrieval + generation + verification is 2–4 model calls; hide it with phases, streaming, precomputed artifacts and Fast mode. Don't block paper opening on AI jobs; show a chip when enrich is ready.
- **Fake certainty.** Never show a numeric confidence or "verified" badge without the evidence list behind it; label `推断` claims explicitly.
- **Chat detached from reading.** A generic chat sidebar ignores what the user is reading. Default context = current paper + visible section; selection flows into context; citations jump back into the paper; the panel keeps reading position.
- **Privacy and trust.** Local-first is our differentiator vs NotebookLM/cloud readers: send only scoped blocks, show which model/provider receives them, make enrich opt-in, delete AI caches with the document, no telemetry. NotebookLM's "not used for training" assurance is table stakes, not an advantage ([NotebookLM FAQ](https://apidog.com/blog/how-to-use-notebooklm/)).
- **Stale AI artifacts.** Cache TL;DR/graph per parsed-content hash + `PROMPT_VERSION`; show「基于 2026-11-06 解析稿」; regenerate button. A reparse must invalidate AI artifacts but preserve user annotations.
- **Bilingual pitfalls.** Machine translation of formulas/terms is lossy; keep original citations, glossary-driven term consistency, skip references in translate-all, and don't translate UI copy via the same pipeline as paper text.

## 4. Recommendations for dsh-scholar (triaged)

### P0 — v1, build now

1. **Grounding contract + `ai.ask` pipeline (host).** Host block index built with the *same* `parseMarkdown` the client uses (already imported by `lib/service.js`), so `blockKey` and plain-text offsets are identical; split paragraphs into 1–3-sentence passages with `{docId, blockKey, start, end, quote, section, score}`. Retrieve: cross-lingual query (translator or LLM rewrite) → BM25 over passages + heading boost → LLM rerank of top 24 excerpts → 6–10 evidence spans. Generate with numbered `E1..En`; answer markdown may only cite `[E#]`; post-stream verification call returns `supported/partial/unsupported` per claim; host strips invalid ids. Add an SSE route `POST /dsh-scholar/api/ai/ask` (Node `res.write`, same `requestRejection` fence) with `phase`/`delta`/`done` events. Use the existing LLM call shape from `lib/service.js` (`ctx.get('llm').stream({provider, model, system, messages, temperature, maxTokens, signal})`) and `agentDefaultModel.currentSelection()`; degrade with a clear `llm-unavailable` error if absent. No npm deps.
2. **AI panel in the margin (client).** Extend the existing margin tabs to `大纲 | 批注 | AI | 图谱` (`.mru-tab`), root modifier `mru-root--margin-wide` (≈380px) when AI/graph is active; `.mru-ai` chat: context chips (选中/当前段落/本节/整篇/整库), quick actions (解释本段, 方法假设, 贡献, 找相关段落), phase line + Stop, streamed answer with citation chips, evidence rail (依据 N 段: quote + 划线/定位), confidence/missing-source badges, follow-ups, footer 保存为批注/复制/重新生成, thread list. SSE via `fetch` reader; no new dependency.
3. **Citation UX in the reader.** Render `[E#]` as `.mru-cite` buttons; hover card with quote + paper + section; click calls the existing jump machinery (scroll to `blockKey` + flash `start/end` span using `.mru-hl--active`-style pulse without saving); "返回回答" affordance; evidence rail rows do the same. This is the single highest-trust feature — ship it before graph.
4. **Answer → annotation.** Chip-hover and evidence-row actions create highlights at the exact evidence span; footer 保存为批注 creates one note with `note = answer claim`, `color` by role (yellow finding / sage method / sky context / rose critique), `origin:'ai'`, `threadId`; batch save ≤6 + undo toast; margin filter「AI 批注」. Extend `normalizeAnnotation` + UI-SPEC + `annotations.json` schema for `origin`/`threadId` (coordinated with client-reader; otherwise provenance is stripped).
5. **Parse-complete AI enrich job.** On `status: parsed`, queued host job writes `documents/<id>/ai/summary.json` (atomic): `{contentHash, promptVersion, model, tldr, contributions:[{text, blockKey}], sections:[{blockKey, heading, summary}], glossary:[{en, zh, def, blockKey}], limitations, followups}`. Two calls: per-section map (batch by heading, JSON array) + global reduce (TL;DR/glossary/questions); cap output; mark `aiReady` in meta. Client shows TL;DR card above the paper + glossary chips + section summary in margin; never blocks reading.
6. **Per-paper knowledge graph.** Same enrich job (or a second call): `{nodes:[{id,type,label,aliases,description,blockKeys:[],confidence}], edges:[{source,target,type,evidence:{blockKey,quote},confidence}]}` with types `method|dataset|metric|claim|concept|limitation` and edge types `proposes|uses|evaluates_on|reports|supports|contradicts|refines|limitation_of`. Host validates every `blockKey` against the index and quote substring (drop or mark unverified); dedupe label+type; caps 60 nodes/120 edges; store `ai/graph.json`. Q&A enrichment after each accepted answer: extract ≤3 nodes/edges from (question, answer, evidence) with `source:'qa'`, merge incrementally, cap growth.
7. **Per-paper graph UI.** Hand-rolled SVG (no npm): deterministic seeded force or radial ego layout; paper root + type rings; type-filter chips; 1/2-hop toggle; node→evidence drawer→source jump; edge→evidence; "AI 补充" badge; >60 nodes collapse by type; static after settle + reduced-motion; text-list fallback. Place in the 图谱 margin tab (compact) with expand-to-sheet for exploration.
8. **Agent tools.** Split `mineru` into four model-facing read tools + one manage tool, all over a shared service: `scholar_search {query, scope?, docId?, limit=8}` → rows with `docId#blockKey`, quote, section; `scholar_read {docId, anchor? | offset+maxChars, contextBlocks=1}` → slice + `nextOffset`; `scholar_ask {question, docId?|scope}` → grounded answer + evidence handles + `insufficient`; `scholar_graph {docId?, nodeId?, op:'overview'|'neighbors'|'evidence', types?, depth}` → bounded JSON; `scholar_manage` (import/parse/annotate/translate/delete) marked `deferLoading` where the registry allows it. Tool descriptions state the `search → read around citation → ask` loop; writes get `origin:'agent'` and are undoable.
9. **Library graph data layer + minimal view.** Resolve reference entries in each `full.md` against library titles (normalize case/punctuation, exact or ≥0.8 token Jaccard); materialize `dataDir/ai/library-graph.json`: paper nodes, `cites` edges (unlabelled first), concept nodes merged across papers only when shared by ≥2 papers. View v0: seed paper ego + 1 hop on a year-ordered timeline, type filters, click paper→open, click concept→evidence list; hide unmatched refs with count. Full force/bundled view is P1.

### P1 — next cycle

- **Library-wide ask** (`scope:'library'`): BM25 over cached TL;DR/section summaries → top 3–5 papers → per-paper evidence; answer header shows papers used; insufficient state suggests importing more papers. (the P0 library-graph data layer makes this cheap.)
- **Fast/Deep modes + model picker** with stored thread metadata; Deep adds rerank + verification + follow-ups; show token usage/latency in a collapsible "pipeline" line.
- **Skills/presets:** named prompts with scope (Universal/Document/Passage/Word), custom instructions, slash commands in the input; ship 6 built-ins (解释, 方法假设, 贡献, 局限, 相关概念, 与另一篇比较). Readwise/Ghostreader pattern.
- **Glossary-aware translation** and "add term to glossary" from the selection card; feed glossary into `translate` prompts; show term chips in the margin.
- **Citation-intent edge labels:** classify library citation edges `background|method|result|support|contrast` from the citing paper's reference context with an LLM pass; show in edge drawer (scite/S2 semantics).
- **Graph polish:** concept supernodes with LLM labels (semantic bundling), cluster summaries, "ask about this cluster", save subgraph as a collection/tag, timeline playback.
- **Cross-paper resurfacing:** margin hint when a concept is annotated in another paper; "related passages" list in the AI panel (Smart Connections style with score + source).
- **Export:** Markdown "阅读笔记" (paper meta + annotations + threads + citations) and graph JSON; copy-with-citations button.
- **Write-tool permissions:** if the approval service is available, route `scholar_manage` writes through confirmation; otherwise UI undo + agent-origin filter.
- **Flashcards/quiz** generated from annotations + claims (Scholarcy/MarginNote/Recall) — retention feature, cheap once enrich exists.
- **External citation expansion via S2/OpenAlex** in the host `web`/fetch service, explicitly opt-in (import candidate papers, expand graph with external nodes marked `外部`).

### P2 — later, only if pull exists

- Community detection / GraphRAG-style community reports for the library graph; contradictions view across papers (PaperQA2 `contracrow` style).
- Agentic deep-research over the library with a saturation statement (Undermind pattern) and citation-trail traversal.
- Custom user-defined graph schemas/tags; shared/exported graphs; multi-device sync.
- Audio/video overviews (not a reading-desk need); OCR'd figure understanding (PaperQA2 media enrichment suggests synthetic captions for figure/table retrieval — useful but expensive).
- Embedding-based semantic search if the harness ever exposes an embeddings service; until then BM25 + LLM rerank is enough.

## 5. Implementation contracts (paste-ready shapes)

**5.1 Evidence & answer payloads**
```json
// evidence item (host-generated; never model-generated)
{ "eid":"E3", "docId":"uuid", "title":"Attention Is All You Need",
  "blockKey":"b12:9fa2", "start":41, "end":178, "section":"3.2",
  "quote":"Scaled dot-product attention ...", "page":4, "score":0.81 }

// SSE events
{"type":"phase","phase":"retrieving","detail":{"passages":24}}
{"type":"phase","phase":"generating"}
{"type":"delta","text":"答案 markdown …"}
{"type":"phase","phase":"verifying"}
{"type":"done","answer":{ "markdown":"…[E3]…", "citations":[{"eid":"E3"}],
  "confidence":"high|medium|low", "unsupported":[{"claim":"…","reason":"no-evidence"}],
  "followups":["…"], "insufficient":false, "usage":{"inputTokens":0,"outputTokens":0},
  "model":"deepseek-chat", "evidence":[ /* E1..En */ ] }}
```

**5.2 Prompt skeleton (answer)**
```text
SYSTEM: Answer questions about the user's own papers using ONLY the evidence blocks below.
Cite with [E#] immediately after each supported clause; one claim may cite several blocks.
Never cite anything that is not an evidence block; never output a bibliography or paper list.
If the evidence is insufficient, set insufficient=true and say what is missing.
Answer in {locale}; keep technical terms in English on first mention ("注意力机制 (attention)").
Keep quotes exact; do not translate quoted evidence.
USER: <question> · scope=<selection|section|paper|library> · reading position=<blockKey/section>
EVIDENCE:
[E1] title=… section=… quote=…
[E2] …
```
**Structured output vs streaming (design fork).** Anthropic's docs note citations cannot be combined with strict structured outputs — the same tension applies here, because DSH's LLM API has neither citations nor JSON-schema mode. So: stream prose with `[E#]` markers for perceived latency, then run a separate extraction/verification pass over the finished text; never ask one generation to emit both polished prose and a strict claim graph. If a later feature needs claim JSON, derive it from the validated answer, don't regenerate it.

**5.3 Prompt skeleton (verification)**
```text
For each claim below, decide whether its cited evidence entails it:
supported (directly stated) | partial (implied/needs context) | unsupported (no entailment).
Return JSON only: [{"i":1,"verdict":"supported","missing":""}]
CLAIMS: 1) "<claim>" cites [E2] 2) …
EVIDENCE: [E2] "<quote>" …
```
**5.4 Graph schema & extraction constraints**
```json
{ "version":1, "promptVersion":"g1", "contentHash":"sha256:…", "generatedAt":"…",
  "nodes":[{"id":"n1","type":"method|dataset|metric|claim|concept|limitation",
            "label":"scaled dot-product attention","aliases":["SDPA"],
            "description":"≤160 chars","blockKeys":["b12:9fa2"],"confidence":"high|medium|low",
            "source":"parse|qa"}],
  "edges":[{"id":"e1","source":"n1","target":"n2",
            "type":"proposes|uses|evaluates_on|reports|supports|contradicts|refines|limitation_of",
            "evidence":{"blockKey":"b12:9fa2","quote":"…"},"confidence":"…","source":"parse|qa"}]}
```
Extraction prompt rules: input = section headings + numbered blocks (`b#` + 300-char preview); every blockKey/quote must come from the input; ≤40 nodes / ≤80 edges in one extraction (merge later); prefer results/method sections for claims; mark missing evidence nodes `confidence:"low"`. Host rejects unknown blockKeys and quotes not found (case/space-insensitive substring).

**5.5 Routes / methods (all fenced)**
| surface | shape | notes |
|---|---|---|
| `POST /dsh-scholar/api/ai/ask` | SSE (above) | request: `{docId?, scope, question, context?, threadId?, mode, locale}`; abort via `AbortSignal` on disconnect |
| `POST /dsh-scholar/api/ai/thread` | JSON | rename/delete/list threads; `{docId?, threads}` |
| `GET /dsh-scholar/api/ai/artifact?id&kind=summary|graph` | JSON | cached, versioned by contentHash |
| `POST /dsh-scholar/api/ai/enrich` | `{id, force?}` | enqueue/regenerate; status via `library.get` `aiReady` |
| `POST /dsh-scholar/api/graph` | `{scope:'paper'|'library', docId?, seed?, depth=1, types?}` | returns ≤300 nodes + `truncated` |
| `POST /dsh-scholar/api/ai/annotation-draft` | `{docId, threadId, eids}` | returns annotation drafts for client merge |
**5.6 Files & tool surface**
```text
documents/<id>/ai/summary.json · graph.json · threads.json
dataDir/ai/library-graph.json · library-threads.json
```
Tools: `scholar_search`, `scholar_read`, `scholar_ask`, `scholar_graph`, `scholar_manage` (deferred) — shared `lib/ai.js`, `lib/graph.js`, `lib/retrieval.js`; prompts in `lib/prompts.js` with `PROMPT_VERSION`.
**5.7 UI-SPEC additions to coordinate with design/client-ui**
Tabs `大纲|批注|AI|图谱`; `.mru-root--margin-wide`; `.mru-ai`, `.mru-ai__chips`, `.mru-chip-context`, `.mru-ai__phase`, `.mru-ai__answer`, `.mru-cite`, `.mru-evidence`, `.mru-evidence__row`, `.mru-ai__badge`, `.mru-graph`, `.mru-graph__svg`, `.mru-graph__node[data-type]`, `.mru-graph__filter`, `.mru-graph__drawer`; AI note marker `.mru-note--ai`; all inheriting host tokens (only ink colors reused for annotation roles).

## Top priorities for v1 (15 lines, in order; Lead can start now)
1. **Grounding contract first:** host-side passage index from the same `parseMarkdown` (blockKey + sentence offsets), evidence `{eid,docId,blockKey,start,end,quote}`, `[E#]`-only citations, host validator + verification pass — everything else depends on it.
2. **`ai.ask` SSE route** (`phase`/`delta`/`done`, abortable, fenced) using `ctx.get('llm').stream` + `agentDefaultModel.currentSelection()`, with a clear `llm-unavailable` fallback.
3. **Retrieval without embeddings:** translate question → BM25 over passages + heading boost → LLM rerank top 24 → 6–10 evidence spans; cap tokens and pass section context.
4. **Prompt + verification:** cite only `[E#]`, refuse when insufficient, answer in locale with English quotes; per-claim entailment verdicts; merge `unsupported`/`无出处` into the done payload.
5. **AI margin tab** next to 大纲/批注: context chips (选中/当前段落/本节/整篇/整库), quick actions, streaming phases + Stop, regenerate, follow-up chips, editable question.
6. **Citation UX:** hover quote card, click → scroll to block + flash exact span, "返回回答"; evidence rail rows mirror it — ship before the graph because this is the trust feature.
7. **Answer→annotation:** per-citation 划线, footer 保存为批注 (note=claim, color by role, `origin:'ai'`, `threadId`), batch ≤6 + undo, margin「AI 批注」filter; extend `normalizeAnnotation`/schema first.
8. **Parse-complete `enrich` job:** cached `summary.json` (TL;DR, contributions, section summaries, glossary, limitations, follow-ups) with contentHash + promptVersion; non-blocking chip "AI 准备中" → card above paper.
9. **Per-paper graph extraction:** `graph.json` nodes/edges with `{blockKey,quote}` evidence; validate blockKeys/quote substrings; dedupe label+type; caps 60/120; Q&A enrichment adds ≤3 evidence-backed nodes/edges per answer.
10. **Graph UI v0:** hand-rolled SVG radial ego (paper root + type rings), type filters, 1/2-hop, node/edge → evidence drawer → span jump, "AI 补充" badge, >60 nodes collapse; text fallback.
11. **Library graph data layer:** fuzzy-resolve references against library titles; `library-graph.json` with `cites` edges + shared concepts (≥2 papers); minimal year-timeline ego view; hide unmatched refs with count.
12. **Agent tools + one shared service:** `scholar_search` / `scholar_read` (anchor + context + nextOffset) / `scholar_ask` (answer + evidence handles + insufficient) / `scholar_graph` (overview/neighbors/evidence) + deferred `scholar_manage`; compact results with `docId#blockKey` handles; UI routes and tools share `lib/ai.js` / `lib/graph.js` / `lib/retrieval.js`, prompts + `PROMPT_VERSION` in `lib/prompts.js`, artifacts keyed by contentHash.
13. **Cost/privacy guardrails:** settings AI section (enrich on/off, Fast/Deep, provider shown), only scoped blocks leave the machine, token caps, evidence preview "本次发送 N 段", delete AI caches with the doc, no telemetry.
14. **Gate it:** extend `docs/UI-SPEC.md` + `scripts/check.mjs` tests for evidence validation, citation stripping, graph caps, reparse re-anchoring; end-to-end test that a fabricated `[E9]` never reaches the client.
