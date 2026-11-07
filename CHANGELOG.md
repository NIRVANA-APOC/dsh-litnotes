# Changelog

## 2.0.0 — refactor (in progress)

- Full TypeScript rewrite of the Host and Client halves with a typed wire contract.
- New reading-desk UI/UX (design system, persistent frame, integrated AI margin, graph
  interactions) — see `docs/UI-SPEC.md`.
- Mature algorithms replace hand-rolled ones (ZIP via fflate, markdown via markdown-it,
  force layout via d3-force, retrieval via MiniSearch).
- Runtime performance rework: smaller bundles, on-demand work, no library-entry jank.
- Reuses DSH platform services (llm, tools, credentials, translator, officeToPdf, tokenMeter,
  systemPrompt) instead of private implementations.
- Clean documentation set; no legacy identity or compatibility fields.

## 1.0.0 — frozen feature baseline

The complete 0.3.0 feature set, frozen as the behavioural contract for the 2.0 refactor:

- Local literature library with MinerU standard/agent parsing and a token-free local engine
  (pdf.js text layer; optional Office→PDF conversion).
- Bilingual reading desk: serif original, quiet translation, reading modes, outline, page marks,
  four-ink highlights and margin annotations; position restore.
- Grounded AI reading conversation: citation-first answers validated against parser blocks, a
  quote–claim entailment pass, auto-annotations, regenerate/stop, follow-ups, Markdown export.
- Per-paper and library knowledge graphs: AI extraction, Q&A enrichment, curated library
  aggregation, infinite canvas, rename/merge/pin curation, auto-build switch.
- Seven DSH agent tools over the library, all returning citation-ready coordinates.
- i18n (zh/en), diagnostics, credential storage.
