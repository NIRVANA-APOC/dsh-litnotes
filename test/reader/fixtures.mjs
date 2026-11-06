/**
 * Reader-test fixtures. A compact, self-contained "MinerU-style" document that
 * exercises the heuristics the parser must handle: ATX headings, soft-wrapped
 * paragraphs, nested lists, quotes, fenced code, display formulas, a MinerU
 * HTML table with colspan/rowspan, a figure, a GFM pipe table, a rule and
 * references.
 *
 * Kept under test/reader/ on purpose (test/fixtures/ belongs to the e2e
 * harness). This module is a helper, not a test file.
 */

export const MINERU_MARKDOWN = [
  '# Sparse Routing for Retrieval',
  '',
  'Ada Lovelace and Grace Hopper',
  '',
  '## Abstract',
  '',
  'We study **sparse routing** for retrieval. Routing keeps $k$ of $E$ experts active,',
  'so cost grows with $k$ rather than $E$. The controller adapts $k$ per query.',
  '',
  '## 1 Introduction',
  '',
  'Passage retrieval ranks documents by an inner product $\\langle q, d \\rangle$.',
  'A one-word query and a paragraph query traverse the same encoder today.',
  '',
  '### 1.1 Motivation',
  '',
  'Mixture-of-experts layers compute',
  '',
  '$$',
  'y = \\sum_{e=1}^{E} g_e(x) f_e(x)',
  '$$',
  '',
  'and stay cheap when only the top-$k$ gates are kept.',
  '',
  '## 2 Method',
  '',
  '- A token-level router that keeps $k=2$ experts active.',
  '  - Nested details are folded into the parent item.',
  '  A continued line also belongs to the first item.',
  '- A query-adaptive controller that widens $k$ to 4.',
  '',
  '1. Encode the passage.',
  '2. Route each token.',
  '',
  '> Routing should be interpretable, not merely cheap.',
  '',
  '```python',
  'def route(x, k=2):',
  '    return topk(x, k)',
  '```',
  '',
  '## 3 Results',
  '',
  '<table><thead><tr><th rowspan="2">Model</th><th colspan="2">Recall@20</th></tr>'
    + '<tr><th>10k</th><th>1M</th></tr></thead><tbody>'
    + '<tr><td>Dense baseline</td><td>72.1</td><td>64.8</td></tr>'
    + '<tr><td>SparseRoute</td><td>71.9</td><td>64.5</td></tr></tbody></table>',
  '',
  'The sparse model matches the dense baseline.',
  '',
  '![Figure 1: Recall grows with the number of routed experts.](images/fig1.png)',
  '',
  '| Trick | Gain |',
  '|:------|-----:|',
  '| Routing | +1.8 |',
  '| Adaptive | +0.5 |',
  '',
  '---',
  '',
  '## 4 References',
  '',
  '1. Alpha, A. (2023). Synthetic Retrieval. *Journal of Tests*, 1(1):1-2.',
  '2. Beta, B. (2024). Routing at Scale. *Journal of Tests*, 2(2):3-4.',
].join('\n')

/** MinerU content_list.json equivalent for MINERU_MARKDOWN (3 pages). */
export const MINERU_CONTENT_LIST = [
  {
    type: 'title',
    text: 'Sparse Routing for Retrieval',
    text_level: 1,
    page_idx: 0,
  },
  { type: 'text', text: 'Ada Lovelace and Grace Hopper', page_idx: 0 },
  { type: 'title', text: 'Abstract', text_level: 2, page_idx: 0 },
  {
    type: 'text',
    text: 'We study sparse routing for retrieval. Routing keeps $k$ of $E$ experts active, '
      + 'so cost grows with $k$ rather than $E$. The controller adapts $k$ per query.',
    page_idx: 0,
  },
  { type: 'title', text: '1 Introduction', text_level: 2, page_idx: 0 },
  {
    // Real content lists drop inline math from the text stream; prefix matching
    // must still find the paragraph.
    type: 'text',
    text: 'Passage retrieval ranks documents by an inner product at query time. '
      + 'A one-word query and a paragraph query traverse the same encoder today.',
    page_idx: 0,
  },
  { type: 'title', text: '1.1 Motivation', text_level: 3, page_idx: 0 },
  {
    type: 'text',
    text: 'Mixture-of-experts layers replace a single feed-forward network with experts. '
      + 'For a token representation the layer computes a weighted sum.',
    page_idx: 0,
  },
  {
    type: 'equation',
    text: '$$ y = \\sum_{e=1}^{E} g_e(x) f_e(x) $$',
    page_idx: 1,
  },
  { type: 'text', text: 'When only the top gates are kept, cost scales with k rather than E.', page_idx: 1 },
  { type: 'title', text: '2 Method', text_level: 2, page_idx: 1 },
  {
    type: 'list',
    list_items: [
      'A token-level router that keeps $k=2$ experts active. Nested details are folded into '
        + 'the parent item. A continued line also belongs to the first item.',
      'A query-adaptive controller that widens $k$ to 4.',
    ],
    page_idx: 1,
  },
  { type: 'list', list_items: ['Encode the passage.', 'Route each token.'], page_idx: 1 },
  { type: 'text', text: 'Routing should be interpretable, not merely cheap.', page_idx: 1 },
  { type: 'text', text: 'def route(x, k=2): return topk(x, k)', page_idx: 1 },
  { type: 'title', text: '3 Results', text_level: 2, page_idx: 2 },
  {
    type: 'table',
    table_body: '<table><thead><tr><th rowspan="2">Model</th><th colspan="2">Recall@20</th></tr>'
      + '<tr><th>10k</th><th>1M</th></tr></thead><tbody>'
      + '<tr><td>Dense baseline</td><td>72.1</td><td>64.8</td></tr>'
      + '<tr><td>SparseRoute</td><td>71.9</td><td>64.5</td></tr></tbody></table>',
    table_caption: ['Table 1: Recall of the dense and sparse models.'],
    page_idx: 2,
  },
  { type: 'text', text: 'The sparse model matches the dense baseline.', page_idx: 2 },
  {
    type: 'image',
    img_path: 'images/fig1.png',
    image_caption: ['Figure 1: Recall grows with the number of routed experts.'],
    page_idx: 2,
  },
  {
    type: 'table',
    table_body: '<table><tr><th>Trick</th><th>Gain</th></tr>'
      + '<tr><td>Routing</td><td>+1.8</td></tr>'
      + '<tr><td>Adaptive</td><td>+0.5</td></tr></table>',
    page_idx: 2,
  },
  { type: 'title', text: '4 References', text_level: 2, page_idx: 2 },
  {
    type: 'list',
    list_items: [
      'Alpha, A. (2023). Synthetic Retrieval. Journal of Tests, 1(1):1-2.',
      'Beta, B. (2024). Routing at Scale. Journal of Tests, 2(2):3-4.',
    ],
    page_idx: 2,
  },
]
