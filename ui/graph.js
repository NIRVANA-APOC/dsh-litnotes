/**
 * dsh-litnotes client: knowledge-graph view module.
 *
 * Delivered as plain ES2022 (no JSX, no imports) and concatenated between
 * ui/chat.js and ui/app.js by scripts/build-client.mjs. React, `h` and the
 * shared glyph/formatting helpers are provided by the bundle factory; the
 * guards in this file keep the pure helpers testable on their own with Node.
 *
 * Public surface (all top-level exports; build-client strips `export `):
 *   normalizeGraph(graph)            dedupe nodes/links, drop dangling edges
 *   visibleGraph(graph, options)     type/query filtering + progressive collapse
 *   layoutGraph(graph, options)      deterministic seeded force layout
 *   mruGraphActivePath(graph, id)    root-to-selected highlight path
 *   MruGraphView(props)              doc/library SVG knowledge-graph view
 *
 * Contract: docs/AI-SPEC.md §2 (KG shape), §6 (props) and §8 (.mru-graph-*).
 * The component deliberately has no canvas and no third-party layout engine.
 */

// ===========================================================================
// 1. Constants and fallback copy
// ===========================================================================

/** Canonical node order for legends and filters (AI-SPEC §2). */
const MRU_GRAPH_NODE_TYPES = [
  'concept', 'method', 'finding', 'definition', 'limitation',
  'section', 'question', 'insight', 'paper', 'topic',
];

/** Canonical edge types (AI-SPEC §2); used only for label fallbacks. */
const MRU_GRAPH_EDGE_TYPES = [
  'defines', 'uses', 'supports', 'contradicts', 'part_of',
  'leads_to', 'evolves_from', 'relates', 'answers', 'mentions',
];

/** Fixed SVG user-space; the DOM canvas scales this with preserveAspectRatio. */
const MRU_GRAPH_CANVAS_WIDTH = 1000;
const MRU_GRAPH_CANVAS_HEIGHT = 680;
const MRU_GRAPH_CANVAS_PADDING = 56;
const MRU_GRAPH_DEFAULT_SEED = 0x1f2e3d4c;

/** Library scale thresholds for progressive disclosure. */
const MRU_GRAPH_COLLAPSE_THRESHOLD = 160;
const MRU_GRAPH_COLLAPSE_KEEP = 120;

const MRU_GRAPH_MIN_ZOOM = 0.35;
const MRU_GRAPH_MAX_ZOOM = 3.2;
const MRU_GRAPH_WHEEL_ZOOM_SPEED = 0.0014;

/**
 * Standalone copy. In the bundle app.js registers the real `graph.*` locale
 * keys, so `t()` wins; this table only covers the keys app.js does not know
 * (edge types, source labels, status hints) and keeps the module readable in
 * unit tests. Keep zh/en in sync when adding a key.
 */
const MRU_GRAPH_TEXT = {
  zh: {
    'graph.titleDoc': '本文知识图谱',
    'graph.titleLibrary': '全景图谱',
    'graph.build': 'AI 精读全文',
    'graph.rebuild': '重建图谱',
    'graph.refresh': '刷新',
    'graph.building': '正在生成图谱…',
    'graph.progress': '正在生成 · {done} / {total}',
    'graph.reading': '正在阅读…',
    'graph.extracting': '正在抽取概念…',
    'graph.merging': '正在合并…',
    'graph.emptyDoc': '这篇论文还没有知识图谱。',
    'graph.emptyLibrary': '文献库还没有全景图谱。',
    'graph.emptyHint': 'AI 精读全文后，会自动抽取概念、方法与结论。',
    'graph.jump': '跳转到原文',
    'graph.ask': '问 AI 关于此概念',
    'graph.search': '搜索节点',
    'graph.legend': '节点类型',
    'graph.aspectLegend': '批注颜色',
    'graph.aspect.definition': '定义/背景',
    'graph.aspect.method': '方法',
    'graph.aspect.result': '结果',
    'graph.aspect.limitation': '局限',
    'graph.aspectHint': '黄色=定义/背景 · 绿色=方法 · 蓝色=结果 · 红色=局限',
    'graph.filters': '筛选',
    'graph.nodes': '{count} 个节点',
    'graph.edges': '{count} 条关系',
    'graph.loading': '正在载入图谱…',
    'graph.close': '关闭',
    'graph.collapseClusters': '折叠次要节点',
    'graph.expandAll': '展开全部',
    'graph.error': '知识图谱载入失败。',
    'graph.retry': '重试',
    'graph.unavailable': '知识图谱引擎不可用。',
    'graph.concept': '概念',
    'graph.method': '方法',
    'graph.finding': '发现',
    'graph.definition': '定义',
    'graph.limitation': '局限',
    'graph.section': '章节',
    'graph.question': '问题',
    'graph.insight': '洞见',
    'graph.paper': '论文',
    'graph.topic': '主题',
    // graph-view-only copy
    'graph.canvas': '知识图谱画布',
    'graph.sources': '原文来源',
    'graph.documents': '相关文献',
    'graph.relations': '关系',
    'graph.noSummary': '暂无摘要',
    'graph.noSources': '暂无原文坐标',
    'graph.noRelations': '暂无关系',
    'graph.more': '还有 {count} 个',
    'graph.filtered': '显示 {shown} / {total} 个节点',
    'graph.collapsed': '已折叠 {count} 个节点',
    'graph.zoom': '缩放 {percent}%',
    'graph.zoomIn': '放大',
    'graph.zoomOut': '缩小',
    'graph.resetView': '重置视图',
    'graph.hint': '滚轮缩放 · 拖动节点固定位置',
    'graph.noMatches': '没有匹配的节点',
    'graph.noMatchesHint': '换个关键词，或清除筛选条件。',
    'graph.clearFilters': '清除筛选',
    'graph.unavailableHint': '配置可用的模型后，即可生成和浏览知识图谱。',
    'graph.clusterSummary': '{count} 个「{type}」节点折叠在这里',
    'graph.members': '成员',
    'graph.expandCluster': '展开这组节点',
    'graph.degree': '{count} 条关系',
    'graph.source.ai-summary': 'AI 精读',
    'graph.source.qa': '问答补充',
    'graph.source.user': '手动添加',
    'graph.source.aggregate': '聚合',
    'graph.edge.defines': '定义',
    'graph.edge.uses': '使用',
    'graph.edge.supports': '支持',
    'graph.edge.contradicts': '反驳',
    'graph.edge.part_of': '属于',
    'graph.edge.leads_to': '引出',
    'graph.edge.evolves_from': '演化自',
    'graph.edge.relates': '相关',
    'graph.edge.answers': '回答',
    'graph.edge.mentions': '提及',
  },
  en: {
    'graph.titleDoc': 'Paper knowledge graph',
    'graph.titleLibrary': 'Library graph',
    'graph.build': 'Build with AI',
    'graph.rebuild': 'Rebuild graph',
    'graph.refresh': 'Refresh',
    'graph.building': 'Building the graph…',
    'graph.progress': 'Building · {done} / {total}',
    'graph.reading': 'Reading…',
    'graph.extracting': 'Extracting concepts…',
    'graph.merging': 'Merging…',
    'graph.emptyDoc': 'This paper has no knowledge graph yet.',
    'graph.emptyLibrary': 'The library graph is empty.',
    'graph.emptyHint': 'Building the graph extracts concepts, methods, and findings automatically.',
    'graph.jump': 'Jump to source',
    'graph.ask': 'Ask AI about this concept',
    'graph.search': 'Search nodes',
    'graph.legend': 'Node types',
    'graph.aspectLegend': 'Annotation colours',
    'graph.aspect.definition': 'definition/context',
    'graph.aspect.method': 'method',
    'graph.aspect.result': 'result',
    'graph.aspect.limitation': 'limitation',
    'graph.aspectHint': 'yellow=definition/context · green=method · blue=result · red=limitation',
    'graph.filters': 'Filters',
    'graph.nodes': '{count} nodes',
    'graph.edges': '{count} edges',
    'graph.loading': 'Loading graph…',
    'graph.close': 'Close',
    'graph.collapseClusters': 'Collapse minor nodes',
    'graph.expandAll': 'Expand all',
    'graph.error': 'The knowledge graph failed to load.',
    'graph.retry': 'Retry',
    'graph.unavailable': 'The knowledge-graph engine is unavailable.',
    'graph.concept': 'Concept',
    'graph.method': 'Method',
    'graph.finding': 'Finding',
    'graph.definition': 'Definition',
    'graph.limitation': 'Limitation',
    'graph.section': 'Section',
    'graph.question': 'Question',
    'graph.insight': 'Insight',
    'graph.paper': 'Paper',
    'graph.topic': 'Topic',
    // graph-view-only copy
    'graph.canvas': 'Knowledge graph canvas',
    'graph.sources': 'Sources',
    'graph.documents': 'Papers',
    'graph.relations': 'Connections',
    'graph.noSummary': 'No summary',
    'graph.noSources': 'No source location',
    'graph.noRelations': 'No connections',
    'graph.more': '{count} more',
    'graph.filtered': 'Showing {shown} / {total} nodes',
    'graph.collapsed': '{count} nodes folded',
    'graph.zoom': 'Zoom {percent}%',
    'graph.zoomIn': 'Zoom in',
    'graph.zoomOut': 'Zoom out',
    'graph.resetView': 'Reset view',
    'graph.hint': 'Scroll to zoom · drag a node to pin it',
    'graph.noMatches': 'No matching nodes',
    'graph.noMatchesHint': 'Try another keyword, or clear the filters.',
    'graph.clearFilters': 'Clear filters',
    'graph.unavailableHint': 'Set up an available model to build and explore knowledge graphs.',
    'graph.clusterSummary': '{count} {type} nodes are folded here',
    'graph.members': 'Members',
    'graph.expandCluster': 'Expand this group',
    'graph.degree': '{count} connections',
    'graph.source.ai-summary': 'AI reading',
    'graph.source.qa': 'Q&A',
    'graph.source.user': 'Manual',
    'graph.source.aggregate': 'Aggregate',
    'graph.edge.defines': 'defines',
    'graph.edge.uses': 'uses',
    'graph.edge.supports': 'supports',
    'graph.edge.contradicts': 'contradicts',
    'graph.edge.part_of': 'part of',
    'graph.edge.leads_to': 'leads to',
    'graph.edge.evolves_from': 'evolves from',
    'graph.edge.relates': 'relates',
    'graph.edge.answers': 'answers',
    'graph.edge.mentions': 'mentions',
  },
};

// ===========================================================================
// 2. Small pure helpers (values, ids, copy)
// ===========================================================================

/** Coerce anything to a display string without throwing. */
function mruGraphString(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/** Finite number or fallback. */
function mruGraphNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** Clamp a finite number. */
function mruGraphClamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Position the anchored node card next to a node inside the graph viewport.
 *
 * Pure and deterministic: every input is a number, so placement can be unit
 * tested without a DOM. `node` is the node box's centre plus size in container
 * coordinates; the result is clamped inside `container` with `padding` and
 * prefers the right side, flipping left when the right side cannot fit.
 *
 * @param {{node: {x: number, y: number, width?: number, height?: number},
 *   container: {width: number, height: number},
 *   card: {width: number, height?: number},
 *   gap?: number, padding?: number}} input
 * @returns {{left: number, top: number, placement: 'right' | 'left'}}
 */
export function mruGraphAnchoredCardPosition(input) {
  const data = input && typeof input === 'object' ? input : {};
  const node = data.node && typeof data.node === 'object' ? data.node : {};
  const container = data.container && typeof data.container === 'object' ? data.container : {};
  const card = data.card && typeof data.card === 'object' ? data.card : {};
  const containerWidth = Math.max(1, mruGraphNumber(container.width, 0));
  const containerHeight = Math.max(1, mruGraphNumber(container.height, 0));
  const cardWidth = mruGraphClamp(mruGraphNumber(card.width, 300), 120,
    Math.max(120, containerWidth - 16));
  const cardHeight = mruGraphClamp(mruGraphNumber(card.height, 240), 80,
    Math.max(80, containerHeight - 16));
  const gap = Math.max(0, mruGraphNumber(data.gap, 10));
  const padding = Math.max(0, mruGraphNumber(data.padding, 12));
  const nodeX = mruGraphNumber(node.x, containerWidth / 2);
  const nodeY = mruGraphNumber(node.y, containerHeight / 2);
  const nodeWidth = Math.max(0, mruGraphNumber(node.width, 0));
  const nodeHeight = Math.max(0, mruGraphNumber(node.height, 0));
  const nodeRight = nodeX + nodeWidth / 2;
  const nodeLeft = nodeX - nodeWidth / 2;
  const roomRight = containerWidth - padding - (nodeRight + gap);
  const roomLeft = (nodeLeft - gap) - padding;
  let placement = 'right';
  let left;
  if (roomRight >= cardWidth || roomRight >= roomLeft) {
    placement = 'right';
    left = nodeRight + gap;
  } else {
    placement = 'left';
    left = nodeLeft - gap - cardWidth;
  }
  left = mruGraphClamp(left, padding, Math.max(padding, containerWidth - cardWidth - padding));
  const top = mruGraphClamp(
    nodeY - cardHeight / 2,
    padding,
    Math.max(padding, containerHeight - cardHeight - padding),
  );
  return { left: Math.round(left), top: Math.round(top), placement };
}

/** Lowercase, CSS-safe-ish token used for node/edge types. */
function mruGraphTypeKey(value) {
  const key = mruGraphString(value).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return key === '' ? '' : key;
}

/** Stable, readable slug for generated node ids. */
function mruGraphSlug(value) {
  const slug = mruGraphString(value).trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug === '' ? 'node' : slug;
}

/** Unique non-empty trimmed strings, preserving order. */
function mruGraphUniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = mruGraphString(value[i]).trim();
    if (item === '' || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Truncate text for SVG/card labels (characters, not UTF-16 code units). */
function mruGraphTruncate(value, max) {
  const text = mruGraphString(value);
  const limit = Math.max(1, mruGraphNumber(max, 20));
  const chars = [...text];
  if (chars.length <= limit) return text;
  return `${chars.slice(0, Math.max(1, limit - 1)).join('')}…`;
}

/** Mirror the app's U+FFFD display fix, with a local fallback for tests. */
function mruGraphDisplay(value) {
  const text = mruGraphString(value);
  if (typeof mruDisplayText === 'function') {
    try {
      return mruDisplayText(text);
    } catch {
      /* fall through to the local implementation */
    }
  }
  return text.replace(/\ufffd/g, '□');
}

/** Locale-aware grouping, with a fallback when app.js is not in scope. */
function mruGraphFormatCount(value) {
  if (typeof mruFormatCount === 'function') {
    try {
      return mruFormatCount(value);
    } catch {
      /* fall through */
    }
  }
  return String(mruGraphNumber(value, 0));
}

/** Fill `{name}` placeholders in a locale template. */
function mruGraphInterpolate(template, params) {
  if (params === undefined || params === null) return template;
  return mruGraphString(template).replace(/\{(\w+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ));
}

/** Pick the UI language; app.js dictionaries are the reliable probe. */
function mruGraphLanguage(t) {
  try {
    if (typeof t === 'function') {
      const probe = t('panel.label');
      if (probe === 'Literature') return 'en';
      if (probe === '文献库') return 'zh';
      if (probe === '文献库 Literature') return 'zh';
    }
  } catch {
    /* ignore probe failure */
  }
  try {
    const language = typeof document !== 'undefined' && document.documentElement
      ? mruGraphString(document.documentElement.lang)
      : '';
    const navigatorLanguage = typeof navigator !== 'undefined' ? mruGraphString(navigator.language) : '';
    const tag = language || navigatorLanguage;
    if (/^en\b|^en-/i.test(tag)) return 'en';
    if (/^zh\b|^zh-/i.test(tag)) return 'zh';
  } catch {
    /* ignore environment failure */
  }
  return 'zh';
}

/** Locale text with app.js first, standalone fallback second. */
function mruGraphText(t, key, params, lang) {
  if (typeof t === 'function') {
    try {
      const value = t(key, params);
      if (typeof value === 'string' && value !== '' && value !== key) return value;
    } catch {
      /* fall back below */
    }
  }
  const language = lang === 'en' ? 'en' : 'zh';
  const table = MRU_GRAPH_TEXT[language];
  const template = Object.prototype.hasOwnProperty.call(table, key)
    ? table[key]
    : (MRU_GRAPH_TEXT.zh[key] ?? key);
  return mruGraphInterpolate(template, params);
}

/** Label for a known node type; unknown types stay verbatim. */
function mruGraphTypeLabel(t, type, lang) {
  const key = `graph.${type}`;
  if (MRU_GRAPH_NODE_TYPES.indexOf(type) === -1) return type;
  return mruGraphText(t, key, undefined, lang);
}

/** Label for an edge type (defines/uses/...). */
function mruGraphEdgeTypeLabel(t, type, lang) {
  if (MRU_GRAPH_EDGE_TYPES.indexOf(type) === -1) return type;
  return mruGraphText(t, `graph.edge.${type}`, undefined, lang);
}

/** Label for a node source (ai-summary/qa/user/aggregate). */
function mruGraphSourceLabel(t, source, lang) {
  const key = `graph.source.${source}`;
  const table = MRU_GRAPH_TEXT[lang === 'en' ? 'en' : 'zh'];
  if (!Object.prototype.hasOwnProperty.call(table, key)) return mruGraphString(source);
  return mruGraphText(t, key, undefined, lang);
}

/** `graph.reading` / `graph.extracting` / `graph.merging` / phase fallback. */
function mruGraphPhaseLabel(t, phase, lang) {
  const key = phase === 'reading' ? 'graph.reading'
    : phase === 'extracting' ? 'graph.extracting'
      : phase === 'merging' ? 'graph.merging'
        : '';
  if (key === '') return phase;
  return mruGraphText(t, key, undefined, lang);
}

/** Element factory: keeps JSX out of the source while React stays external. */
function mruGraphH(type, props) {
  const children = Array.prototype.slice.call(arguments, 2);
  return React.createElement.apply(React, [type, props].concat(children));
}

/** Hidden-but-present spinner, using the app helper when bundled. */
function mruGraphSpinner() {
  if (typeof MruSpinner === 'function') return React.createElement(MruSpinner, {});
  return React.createElement('span', { className: 'mru-spinner', 'aria-hidden': 'true' });
}

/** Shared glyph, with a text fallback for direct ESM tests. */
function mruGraphGlyph(name, size) {
  if (typeof MruGlyph === 'function') {
    return React.createElement(MruGlyph, { name, size: size || 16 });
  }
  return React.createElement('span', { className: 'mru-graph__glyph', 'aria-hidden': 'true' }, name === 'close' ? '×' : '·');
}

/** Unique DOM ref bookkeeping for arrow-key node navigation. */
function mruGraphSetNodeRef(map, id, element) {
  if (element) map.current[id] = element;
  else delete map.current[id];
}

// ===========================================================================
// 3. normalizeGraph — dedupe + dangling-edge removal
// ===========================================================================

/** Read one endpoint id (tolerates `{id}` objects from force libraries). */
function mruGraphEndpointId(value) {
  if (value && typeof value === 'object') return mruGraphString(value.id).trim();
  return mruGraphString(value).trim();
}

/**
 * Normalize one knowledge graph into the render contract.
 *
 * - nodes are deduped by id (first label/summary wins, provenance is merged)
 * - a node without an id gets a deterministic id derived from type + label
 * - links are deduped by id / endpoint+type+label and dangling links are dropped
 * - self-links are dropped: they cannot be navigated in this 2-D view
 * - `stats.nodes` / `stats.edges` are recomputed
 *
 * Pure: the input graph is never mutated.
 *
 * @param {object|null|undefined} graph
 * @returns {object}
 */
function mruGraphNormalizeGraph(graph) {
  const source = graph && typeof graph === 'object' && !Array.isArray(graph) ? graph : {};
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
  const rawEdges = Array.isArray(source.edges) ? source.edges : [];
  const nodes = [];
  const byId = new Map();

  for (let index = 0; index < rawNodes.length; index += 1) {
    const raw = rawNodes[index];
    if (!raw || typeof raw !== 'object') continue;
    const type = mruGraphTypeKey(raw.type) || 'concept';
    let id = mruGraphString(raw.id).trim();
    const label = mruGraphString(raw.label).trim();
    if (id === '') {
      if (label === '') continue;
      id = `n:${type}:${mruGraphSlug(label) || index}`;
    }
    const blockKeys = mruGraphUniqueStrings(raw.blockKeys);
    const documentIds = mruGraphUniqueStrings(raw.documentIds);
    const summary = mruGraphString(raw.summary).trim();
    const weight = Math.max(0.01, mruGraphNumber(raw.weight, 1));
    const node = {
      ...raw,
      id,
      type,
      label: label || id,
      summary,
      blockKeys,
      documentIds,
      weight,
    };
    const existing = byId.get(id);
    if (existing) {
      existing.blockKeys = mruGraphUniqueStrings(existing.blockKeys.concat(blockKeys));
      existing.documentIds = mruGraphUniqueStrings(existing.documentIds.concat(documentIds));
      existing.weight = Math.max(existing.weight, weight);
      if (existing.summary === '' && summary !== '') existing.summary = summary;
      continue;
    }
    byId.set(id, node);
    nodes.push(node);
  }

  const edges = [];
  const edgeIds = new Set();
  const edgeSignatures = new Set();
  for (let index = 0; index < rawEdges.length; index += 1) {
    const raw = rawEdges[index];
    if (!raw || typeof raw !== 'object') continue;
    const from = mruGraphEndpointId(raw.from);
    const to = mruGraphEndpointId(raw.to);
    if (from === '' || to === '' || from === to) continue;
    if (!byId.has(from) || !byId.has(to)) continue;
    const type = mruGraphTypeKey(raw.type) || 'relates';
    const label = mruGraphString(raw.label).trim();
    const signature = `${from}\u0000${to}\u0000${type}\u0000${label}`;
    if (edgeSignatures.has(signature)) continue;
    let id = mruGraphString(raw.id).trim();
    if (id === '') id = `e:${from}->${to}:${type}${label === '' ? '' : `:${mruGraphSlug(label)}`}`;
    if (edgeIds.has(id)) {
      let suffix = 2;
      while (edgeIds.has(`${id}#${suffix}`)) suffix += 1;
      id = `${id}#${suffix}`;
    }
    edgeIds.add(id);
    edgeSignatures.add(signature);
    edges.push({
      ...raw,
      id,
      from,
      to,
      type,
      label,
      weight: Math.max(0.01, mruGraphNumber(raw.weight, 1)),
    });
  }

  const stats = source.stats && typeof source.stats === 'object' ? { ...source.stats } : {};
  stats.nodes = nodes.length;
  stats.edges = edges.length;
  return {
    ...source,
    version: Number.isFinite(Number(source.version)) ? Number(source.version) : 1,
    nodes,
    edges,
    stats,
  };
}

export function normalizeGraph(graph) {
  return mruGraphNormalizeGraph(graph);
}

export const mruGraphNormalize = normalizeGraph;

// ===========================================================================
// 4. visibleGraph — type/query filtering and progressive disclosure
// ===========================================================================

/** Resolve the `types` option (null = all; array/Set/object/string supported). */
function mruGraphTypeFilter(types, nodes) {
  const all = new Set(nodes.map((node) => node.type));
  if (types === null || types === undefined) return all;
  if (types instanceof Set) return new Set(Array.from(types, (value) => mruGraphTypeKey(value)).filter(Boolean));
  if (Array.isArray(types)) {
    const out = new Set();
    for (let i = 0; i < types.length; i += 1) {
      const key = mruGraphTypeKey(types[i]);
      if (key !== '') out.add(key);
    }
    return out;
  }
  if (typeof types === 'string') {
    const key = mruGraphTypeKey(types);
    return key === '' ? new Set() : new Set([key]);
  }
  if (typeof types === 'object') {
    const out = new Set();
    for (const key of Object.keys(types)) {
      if (types[key]) {
        const normalized = mruGraphTypeKey(key);
        if (normalized !== '') out.add(normalized);
      }
    }
    return out;
  }
  return all;
}

/** True when a node matches the search query (label/summary/type/provenance). */
function mruGraphNodeMatches(node, query) {
  if (query === '') return true;
  const values = [node.label, node.summary, node.type, node.aspect];
  if (Array.isArray(node.blockKeys)) values.push(...node.blockKeys);
  if (Array.isArray(node.documentIds)) values.push(...node.documentIds);
  if (typeof node.documentId === 'string') values.push(node.documentId);
  for (let i = 0; i < values.length; i += 1) {
    if (mruGraphString(values[i]).toLowerCase().indexOf(query) !== -1) return true;
  }
  return false;
}

/** Canonical legend order: known types first, then unknown types alphabetically. */
function mruGraphOrderedTypes(nodes) {
  const present = new Set(nodes.map((node) => node.type));
  const ordered = MRU_GRAPH_NODE_TYPES.filter((type) => present.has(type));
  const unknown = [...present].filter((type) => MRU_GRAPH_NODE_TYPES.indexOf(type) === -1).sort();
  return ordered.concat(unknown);
}

/** Degree map for importance ranking and node sizing. */
function mruGraphDegrees(nodes, edges) {
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i];
    if (edge.from === edge.to) continue;
    if (degree.has(edge.from)) degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
    if (degree.has(edge.to)) degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  }
  return degree;
}

/**
 * Collapse a graph by type. In 'type' mode every multi-node type becomes one
 * cluster; in 'auto' mode only the least connected nodes beyond `keep` are
 * folded, so central concepts/papers remain individually explorable.
 *
 * @returns {{nodes: object[], edges: object[], collapsed: boolean, collapsedNodes: number}}
 */
function mruGraphCollapseByType(nodes, edges, mode, keepCount = MRU_GRAPH_COLLAPSE_KEEP) {
  const degree = mruGraphDegrees(nodes, edges);
  let keep = null;
  if (mode === 'auto') {
    const ranked = nodes.map((node, index) => ({
      node,
      index,
      score: (degree.get(node.id) || 0) * 2 + mruGraphNumber(node.weight, 1),
    }));
    ranked.sort((left, right) => (
      right.score - left.score
      || left.index - right.index
    ));
    const limit = Math.max(1, Math.floor(mruGraphNumber(keepCount, MRU_GRAPH_COLLAPSE_KEEP)));
    keep = new Set(ranked.slice(0, limit).map((entry) => entry.node.id));
  }

  const groups = new Map();
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (keep && keep.has(node.id)) continue;
    let group = groups.get(node.type);
    if (!group) {
      group = { type: node.type, members: [] };
      groups.set(node.type, group);
    }
    group.members.push(node);
  }

  const clusters = new Map();
  for (const [type, group] of groups) {
    if (group.members.length < 2) continue;
    const documentIds = [];
    let weight = 0;
    for (let i = 0; i < group.members.length; i += 1) {
      const member = group.members[i];
      weight += mruGraphNumber(member.weight, 1);
      if (Array.isArray(member.documentIds)) documentIds.push(...member.documentIds);
      if (typeof member.documentId === 'string') documentIds.push(member.documentId);
    }
    clusters.set(type, {
      id: `cluster:type:${type}`,
      type,
      label: type,
      summary: '',
      blockKeys: [],
      documentIds: mruGraphUniqueStrings(documentIds),
      weight,
      source: 'aggregate',
      cluster: true,
      count: group.members.length,
      members: group.members.map((member) => member.id),
    });
  }

  const minorIds = new Set();
  for (const group of groups.values()) {
    for (let i = 0; i < group.members.length; i += 1) minorIds.add(group.members[i].id);
  }
  const mapping = new Map();
  const outNodes = [];
  const emitted = new Set();
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (!minorIds.has(node.id)) {
      mapping.set(node.id, node.id);
      outNodes.push(node);
      continue;
    }
    const cluster = clusters.get(node.type);
    if (!cluster) {
      mapping.set(node.id, node.id);
      outNodes.push(node);
      continue;
    }
    mapping.set(node.id, cluster.id);
    if (!emitted.has(cluster.id)) {
      emitted.add(cluster.id);
      outNodes.push(cluster);
    }
  }

  const finalIds = new Set(outNodes.map((node) => node.id));
  const outEdges = [];
  const aggregates = new Map();
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i];
    const from = mapping.get(edge.from) || edge.from;
    const to = mapping.get(edge.to) || edge.to;
    if (from === to || !finalIds.has(from) || !finalIds.has(to)) continue;
    if (from === edge.from && to === edge.to) {
      outEdges.push(edge);
      continue;
    }
    const key = `${from}\u0000${to}\u0000${edge.type}`;
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = {
        id: `cluster-edge:${from}->${to}:${edge.type}`,
        from,
        to,
        type: edge.type,
        label: '',
        source: 'aggregate',
        weight: 0,
        count: 0,
        labels: new Set(),
      };
      aggregates.set(key, aggregate);
      outEdges.push(aggregate);
    }
    aggregate.weight += mruGraphNumber(edge.weight, 1);
    aggregate.count += 1;
    if (edge.label) aggregate.labels.add(edge.label);
  }
  for (const aggregate of aggregates.values()) {
    if (aggregate.labels.size === 1) aggregate.label = [...aggregate.labels][0];
    delete aggregate.labels;
  }

  let collapsedNodes = 0;
  for (const cluster of clusters.values()) collapsedNodes += cluster.count;
  return {
    nodes: outNodes,
    edges: outEdges,
    collapsed: clusters.size > 0,
    collapsedNodes,
  };
}

/**
 * Filter and progressively disclose a knowledge graph.
 *
 * Options:
 *   types: null (all) | array | Set | object map | string
 *   query: node label/summary/type/provenance substring (case-insensitive)
 *   collapse: 'none' | 'type' | 'auto' (auto folds minor nodes above the
 *             library-scale threshold); true = 'type'
 *
 * Pure and deterministic. Returned edges never reference hidden nodes.
 */
function mruGraphVisibleGraph(graph, options) {
  const normalized = mruGraphNormalizeGraph(graph);
  const opts = options && typeof options === 'object' ? options : {};
  const filter = mruGraphTypeFilter(opts.types, normalized.nodes);
  const query = mruGraphString(opts.query).trim().toLowerCase();
  const rawNodes = normalized.nodes.filter((node) => filter.has(node.type) && mruGraphNodeMatches(node, query));
  const rawIds = new Set(rawNodes.map((node) => node.id));
  const rawEdges = normalized.edges.filter((edge) => rawIds.has(edge.from) && rawIds.has(edge.to));
  const typeCounts = {};
  for (let i = 0; i < normalized.nodes.length; i += 1) {
    const type = normalized.nodes[i].type;
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  }

  let collapse = opts.collapse === true ? 'type' : mruGraphString(opts.collapse || 'none').toLowerCase();
  if (collapse !== 'type' && collapse !== 'auto') collapse = 'none';
  const threshold = Math.max(1, mruGraphNumber(opts.collapseThreshold, MRU_GRAPH_COLLAPSE_THRESHOLD));
  let nodes = rawNodes;
  let edges = rawEdges;
  let collapsed = false;
  let collapsedNodes = 0;
  const explicitThreshold = mruGraphNumber(opts.collapseThreshold, NaN);
  const forcedAuto = collapse === 'auto' && Number.isFinite(explicitThreshold);
  const keepCount = collapse === 'auto'
    ? (Number.isFinite(explicitThreshold) ? threshold : MRU_GRAPH_COLLAPSE_KEEP)
    : Infinity;
  if (rawNodes.length > 0 && (collapse === 'type' || (collapse === 'auto' && rawNodes.length > threshold))) {
    const result = mruGraphCollapseByType(rawNodes, rawEdges, forcedAuto ? 'type' : collapse, keepCount);
    nodes = result.nodes;
    edges = result.edges;
    collapsed = result.collapsed;
    collapsedNodes = result.collapsedNodes;
  }

  return {
    nodes,
    edges,
    collapsed,
    collapsedNodes,
    typeCounts,
    query,
    totalNodes: normalized.nodes.length,
    totalEdges: normalized.edges.length,
    filteredNodes: rawNodes.length,
    filteredEdges: rawEdges.length,
    hiddenNodes: normalized.nodes.length - rawNodes.length,
    hiddenEdges: normalized.edges.length - rawEdges.length,
    nodeCount: nodes.length,
    edgeCount: edges.length,
  };
}

export function visibleGraph(graph, options) {
  return mruGraphVisibleGraph(graph, options);
}

export const mruGraphVisible = visibleGraph;

// ===========================================================================
// 5. layoutGraph — deterministic seeded force layout
// ===========================================================================

/** Hash any seed (number or string) into a uint32. */
function mruGraphSeedValue(value) {
  if (value === null || value === undefined) return MRU_GRAPH_DEFAULT_SEED >>> 0;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const seed = Math.trunc(value) >>> 0;
    return seed === 0 ? 1 : seed;
  }
  const text = mruGraphString(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) || 1;
}

/** Mulberry32 PRNG: small, fast, deterministic for a given seed. */
function mruGraphRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Accept a positions map from a previous layout (or a Map/array of {id,x,y}). */
function mruGraphPositionLookup(value) {
  const out = Object.create(null);
  if (!value || typeof value !== 'object') return out;
  if (value.positions && typeof value.positions === 'object') return mruGraphPositionLookup(value.positions);
  if (typeof value.forEach === 'function' && typeof value.get === 'function') {
    value.forEach((position, id) => {
      const key = mruGraphString(id).trim();
      if (key === '' || !position || typeof position !== 'object') return;
      const x = mruGraphNumber(position.x, NaN);
      const y = mruGraphNumber(position.y, NaN);
      if (Number.isFinite(x) && Number.isFinite(y)) out[key] = { x, y };
    });
    return out;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const item = value[i];
      if (!item || typeof item !== 'object') continue;
      const key = mruGraphString(item.id).trim();
      const x = mruGraphNumber(item.x, NaN);
      const y = mruGraphNumber(item.y, NaN);
      if (key !== '' && Number.isFinite(x) && Number.isFinite(y)) out[key] = { x, y };
    }
    return out;
  }
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i += 1) {
    const item = value[keys[i]];
    if (!item || typeof item !== 'object') continue;
    const x = mruGraphNumber(item.x, NaN);
    const y = mruGraphNumber(item.y, NaN);
    if (Number.isFinite(x) && Number.isFinite(y)) out[keys[i]] = { x, y };
  }
  return out;
}

/** Deterministic starting point for a node not covered by a previous layout. */
function mruGraphInitialPoint(index, count, width, height, rand) {
  const angle = index * 2.399963229728653 + (rand() - 0.5) * 0.7;
  const radius = Math.sqrt((index + 0.5) / Math.max(1, count)) * Math.min(width, height) * 0.34;
  return {
    x: width / 2 + Math.cos(angle) * radius,
    y: height / 2 + Math.sin(angle) * radius,
  };
}

/** Fit a laid-out cloud into the canvas with uniform scale, preserving shape. */
function mruGraphFitPositions(xs, ys, width, height, padding) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < xs.length; i += 1) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    for (let i = 0; i < xs.length; i += 1) {
      xs[i] = width / 2;
      ys[i] = height / 2;
    }
    return;
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  if (spanX < 1 && spanY < 1) {
    for (let i = 0; i < xs.length; i += 1) {
      xs[i] = width / 2;
      ys[i] = height / 2;
    }
    return;
  }
  const usableWidth = Math.max(1, width - padding * 2);
  const usableHeight = Math.max(1, height - padding * 2);
  const scale = Math.min(
    spanX > 0 ? usableWidth / spanX : Infinity,
    spanY > 0 ? usableHeight / spanY : Infinity,
  );
  const finalScale = Number.isFinite(scale) ? scale : 1;
  const offsetX = (width - spanX * finalScale) / 2 - minX * finalScale;
  const offsetY = (height - spanY * finalScale) / 2 - minY * finalScale;
  for (let i = 0; i < xs.length; i += 1) {
    xs[i] = mruGraphClamp(xs[i] * finalScale + offsetX, padding, width - padding);
    ys[i] = mruGraphClamp(ys[i] * finalScale + offsetY, padding, height - padding);
  }
}

/** Round to two decimals so equivalent layouts compare cleanly. */
function mruGraphRound(value) {
  return Math.round(mruGraphNumber(value, 0) * 100) / 100;
}

/**
 * Deterministic seeded force layout.
 *
 * @param {object} graph knowledge graph (raw or already normalized)
 * @param {object} [options]
 * @param {number} [options.width=1000]
 * @param {number} [options.height=680]
 * @param {number|string} [options.seed=0x1f2e3d4c]
 * @param {number} [options.iterations] override the node-count budget
 * @param {object|Map|Array} [options.previous] positions from the last layout;
 *   by default these nodes are kept fixed and only newly added nodes are laid
 *   out, so streaming/refresh updates do not make the map jump. Pass
 *   `freezePrevious: false` for a soft anchor instead.
 * @param {object|Map|Array} [options.pinned] user-dragged positions; held fixed
 * @returns {{positions: object, links: object[], width: number, height: number, seed: number, iterations: number}}
 */
function mruGraphLayoutGraph(graph, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const width = Math.max(160, mruGraphNumber(opts.width, MRU_GRAPH_CANVAS_WIDTH));
  const height = Math.max(120, mruGraphNumber(opts.height, MRU_GRAPH_CANVAS_HEIGHT));
  const padding = Math.min(MRU_GRAPH_CANVAS_PADDING, Math.min(width, height) * 0.14);
  const normalized = mruGraphNormalizeGraph(graph);
  const nodes = normalized.nodes;
  const edges = normalized.edges;
  const seed = mruGraphSeedValue(opts.seed);
  const count = nodes.length;
  if (count === 0) {
    return { positions: {}, links: [], width, height, seed, iterations: 0 };
  }

  const previous = mruGraphPositionLookup(opts.previous);
  const pinned = mruGraphPositionLookup(opts.pinned);
  const hasPrevious = Object.keys(previous).length > 0;
  const hasPinned = Object.keys(pinned).length > 0;
  const freezePrevious = opts.freezePrevious !== false;
  const rand = mruGraphRandom(seed);
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const fixed = new Uint8Array(count);
  const indexById = new Map();

  for (let i = 0; i < count; i += 1) {
    const node = nodes[i];
    indexById.set(node.id, i);
    const previousPoint = previous[node.id];
    const initial = previousPoint || mruGraphInitialPoint(i, count, width, height, rand);
    xs[i] = mruGraphClamp(mruGraphNumber(initial.x, width / 2), padding, width - padding);
    ys[i] = mruGraphClamp(mruGraphNumber(initial.y, height / 2), padding, height - padding);
    if (previousPoint && freezePrevious) fixed[i] = 1;
    const pinnedPoint = pinned[node.id];
    if (pinnedPoint) {
      xs[i] = mruGraphClamp(pinnedPoint.x, padding, width - padding);
      ys[i] = mruGraphClamp(pinnedPoint.y, padding, height - padding);
      fixed[i] = 1;
    }
  }

  const links = [];
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i];
    const a = indexById.get(edge.from);
    const b = indexById.get(edge.to);
    if (a === undefined || b === undefined || a === b) continue;
    links.push({ a, b, weight: Math.max(0.01, mruGraphNumber(edge.weight, 1)) });
  }

  const defaultIterations = count > 240 ? 90 : count > 120 ? 120 : 160;
  const requestedIterations = mruGraphNumber(opts.iterations, defaultIterations);
  const iterations = mruGraphClamp(Math.round(requestedIterations), 0, 600);
  const centerX = width / 2;
  const centerY = height / 2;
  const k = Math.sqrt((width * height) / Math.max(1, count)) * 0.62;
  const kSquared = k * k;
  let temperature = Math.min(width, height) * 0.1;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const dx = new Float64Array(count);
    const dy = new Float64Array(count);

    // Repulsion (Fruchterman–Reingold k²/d). O(n²) is fine at the host caps.
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        let deltaX = xs[j] - xs[i];
        let deltaY = ys[j] - ys[i];
        let distanceSquared = deltaX * deltaX + deltaY * deltaY;
        if (distanceSquared < 1e-6) {
          const angle = ((i + 1) * 2.399963229728653 + (j + 2) * 0.61803398875) % (Math.PI * 2);
          deltaX = Math.cos(angle) * 0.01;
          deltaY = Math.sin(angle) * 0.01;
          distanceSquared = deltaX * deltaX + deltaY * deltaY;
        }
        const distance = Math.sqrt(distanceSquared) || 0.01;
        const force = kSquared / distance;
        const ux = deltaX / distance;
        const uy = deltaY / distance;
        dx[i] -= ux * force;
        dy[i] -= uy * force;
        dx[j] += ux * force;
        dy[j] += uy * force;
      }
    }

    // Attraction along links (FR d²/k), weighted by edge importance.
    for (let i = 0; i < links.length; i += 1) {
      const link = links[i];
      let deltaX = xs[link.b] - xs[link.a];
      let deltaY = ys[link.b] - ys[link.a];
      let distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      if (distance < 1e-6) {
        const angle = ((link.a + 1) * 2.399963229728653 + (link.b + 2) * 0.61803398875) % (Math.PI * 2);
        deltaX = Math.cos(angle) * 0.01;
        deltaY = Math.sin(angle) * 0.01;
        distance = 0.01;
      }
      const force = (distance * distance / k) * Math.min(2.5, 0.6 + link.weight * 0.4);
      const ux = deltaX / distance;
      const uy = deltaY / distance;
      dx[link.a] += ux * force;
      dy[link.a] += uy * force;
      dx[link.b] -= ux * force;
      dy[link.b] -= uy * force;
    }

    // Gravity + soft previous-position anchors, then a temperature-limited step.
    for (let i = 0; i < count; i += 1) {
      if (fixed[i]) continue;
      const node = nodes[i];
      let moveX = dx[i] + (centerX - xs[i]) * 0.012;
      let moveY = dy[i] + (centerY - ys[i]) * 0.012;
      const previousPoint = previous[node.id];
      if (previousPoint) {
        moveX += (previousPoint.x - xs[i]) * 0.045;
        moveY += (previousPoint.y - ys[i]) * 0.045;
      }
      const moveLength = Math.sqrt(moveX * moveX + moveY * moveY);
      if (moveLength > temperature) {
        const scale = temperature / (moveLength || 1);
        moveX *= scale;
        moveY *= scale;
      }
      if (!Number.isFinite(moveX) || !Number.isFinite(moveY)) continue;
      xs[i] = mruGraphClamp(xs[i] + moveX, padding, width - padding);
      ys[i] = mruGraphClamp(ys[i] + moveY, padding, height - padding);
    }
    temperature *= 0.97;
  }

  // The first layout uses the whole canvas; incremental updates keep prior
  // coordinates stable and only clamp new nodes inside the view. A seeded
  // rotation makes the layout depend on the seed (same seed → same layout)
  // without disturbing incremental stability.
  if (!hasPrevious && !hasPinned) {
    mruGraphFitPositions(xs, ys, width, height, padding);
    const angle = ((seed % 360) / 180) * Math.PI;
    if (angle > 1e-6) {
      const cx = width / 2;
      const cy = height / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      for (let i = 0; i < count; i += 1) {
        const dx = xs[i] - cx;
        const dy = ys[i] - cy;
        xs[i] = mruGraphClamp(cx + dx * cos - dy * sin, padding, width - padding);
        ys[i] = mruGraphClamp(cy + dx * sin + dy * cos, padding, height - padding);
      }
    }
  }

  const positions = {};
  for (let i = 0; i < count; i += 1) {
    const node = nodes[i];
    positions[node.id] = {
      x: mruGraphRound(mruGraphClamp(xs[i], padding, width - padding)),
      y: mruGraphRound(mruGraphClamp(ys[i], padding, height - padding)),
    };
  }
  const outLinks = [];
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i];
    const from = positions[edge.from];
    const to = positions[edge.to];
    if (!from || !to) continue;
    outLinks.push({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      type: edge.type,
      label: edge.label,
      weight: edge.weight,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
    });
  }
  return { positions, links: outLinks, width, height, seed, iterations };
}

export function layoutGraph(graph, options) {
  return mruGraphLayoutGraph(graph, options);
}

export const mruGraphLayout = layoutGraph;

// ===========================================================================
// 6. Active-path highlight helper
// ===========================================================================

/**
 * Highlight data for one selected node: the BFS path from the graph root to
 * the selection plus the selection's direct neighbourhood. The root is the
 * highest-degree paper node (library), else the highest-degree node overall.
 *
 * @returns {{rootId: string|null, nodeIds: string[], edgeIds: string[],
 *            relatedNodeIds: string[], relatedEdgeIds: string[]}}
 */
export function mruGraphActivePath(graph, nodeId) {
  const normalized = mruGraphNormalizeGraph(graph);
  const selectedId = mruGraphString(nodeId).trim();
  const empty = { rootId: null, nodeIds: [], edgeIds: [], relatedNodeIds: [], relatedEdgeIds: [] };
  if (selectedId === '' || !normalized.nodes.some((node) => node.id === selectedId)) return empty;
  const degree = mruGraphDegrees(normalized.nodes, normalized.edges);
  const adjacency = new Map(normalized.nodes.map((node) => [node.id, []]));
  for (let i = 0; i < normalized.edges.length; i += 1) {
    const edge = normalized.edges[i];
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from).push({ other: edge.to, edgeId: edge.id });
    adjacency.get(edge.to).push({ other: edge.from, edgeId: edge.id });
  }

  let rootId = normalized.nodes[0].id;
  let bestScore = -Infinity;
  for (let i = 0; i < normalized.nodes.length; i += 1) {
    const node = normalized.nodes[i];
    const score = (node.type === 'paper' ? 1000000 : 0)
      + (degree.get(node.id) || 0) * 100
      + mruGraphNumber(node.weight, 1);
    if (score > bestScore) {
      bestScore = score;
      rootId = node.id;
    }
  }

  // BFS from the root over undirected edges; predecessor maps reconstruct path.
  const previousNode = new Map();
  const previousEdge = new Map();
  const visited = new Set([rootId]);
  const queue = [rootId];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const neighbours = adjacency.get(current) || [];
    for (let i = 0; i < neighbours.length; i += 1) {
      const next = neighbours[i];
      if (visited.has(next.other)) continue;
      visited.add(next.other);
      previousNode.set(next.other, current);
      previousEdge.set(next.other, next.edgeId);
      queue.push(next.other);
    }
  }

  const nodeIds = [];
  const edgeIds = [];
  if (visited.has(selectedId)) {
    let cursor = selectedId;
    while (cursor !== undefined) {
      nodeIds.push(cursor);
      if (cursor === rootId) break;
      const edgeId = previousEdge.get(cursor);
      if (edgeId !== undefined) edgeIds.push(edgeId);
      cursor = previousNode.get(cursor);
    }
    nodeIds.reverse();
    edgeIds.reverse();
  } else {
    nodeIds.push(selectedId);
  }

  const relatedNodeIds = [];
  const relatedEdgeIds = [];
  const selectedNeighbours = adjacency.get(selectedId) || [];
  for (let i = 0; i < selectedNeighbours.length; i += 1) {
    const next = selectedNeighbours[i];
    if (!relatedNodeIds.includes(next.other)) relatedNodeIds.push(next.other);
    if (!relatedEdgeIds.includes(next.edgeId)) relatedEdgeIds.push(next.edgeId);
  }
  return { rootId, nodeIds, edgeIds, relatedNodeIds, relatedEdgeIds };
}

// ===========================================================================
// 7. MruGraphView component
// ===========================================================================

/** Stable signature: relayout when topology changes, not when copy streams. */
function mruGraphSignature(graph) {
  const nodePart = graph.nodes.map((node) => `${node.id}\u0000${node.type}`).join('\u0001');
  const edgePart = graph.edges.map((edge) => `${edge.from}\u0002${edge.to}\u0002${edge.type}`).join('\u0001');
  return `${nodePart}\u0003${edgePart}`;
}

/** Normalize the streaming progress prop into numbers the UI can render. */
function mruGraphProgress(value) {
  const source = value && typeof value === 'object' ? value : {};
  const done = Math.max(0, Math.round(mruGraphNumber(source.done, 0)));
  const total = Math.max(0, Math.round(mruGraphNumber(source.total, 0)));
  let percent = null;
  if (total > 0) percent = mruGraphClamp((done / total) * 100, 0, 100);
  else if (source.percent !== undefined) percent = mruGraphClamp(mruGraphNumber(source.percent, 0), 0, 100);
  else if (source.progress !== undefined) {
    const raw = mruGraphNumber(source.progress, NaN);
    if (Number.isFinite(raw)) percent = mruGraphClamp(raw <= 1 ? raw * 100 : raw, 0, 100);
  }
  return {
    done,
    total,
    percent,
    phase: mruGraphString(source.phase || source.stage).trim().toLowerCase(),
  };
}

/** First document id carried by a node (library provenance). */
function mruGraphNodeDocumentId(node) {
  if (!node) return '';
  if (typeof node.documentId === 'string' && node.documentId !== '') return node.documentId;
  if (Array.isArray(node.documentIds)) {
    for (let i = 0; i < node.documentIds.length; i += 1) {
      if (typeof node.documentIds[i] === 'string' && node.documentIds[i] !== '') return node.documentIds[i];
    }
  }
  return '';
}

/** World-space point from a pointer event (undoes viewBox letterboxing + pan/zoom). */
function mruGraphEventWorldPoint(event, svg, view) {
  try {
    if (!svg || typeof svg.getBoundingClientRect !== 'function') {
      return { x: MRU_GRAPH_CANVAS_WIDTH / 2, y: MRU_GRAPH_CANVAS_HEIGHT / 2 };
    }
    const rect = svg.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return { x: MRU_GRAPH_CANVAS_WIDTH / 2, y: MRU_GRAPH_CANVAS_HEIGHT / 2 };
    }
    const scale = Math.min(rect.width / MRU_GRAPH_CANVAS_WIDTH, rect.height / MRU_GRAPH_CANVAS_HEIGHT);
    if (!Number.isFinite(scale) || scale <= 0) {
      return { x: MRU_GRAPH_CANVAS_WIDTH / 2, y: MRU_GRAPH_CANVAS_HEIGHT / 2 };
    }
    const offsetX = (rect.width - MRU_GRAPH_CANVAS_WIDTH * scale) / 2;
    const offsetY = (rect.height - MRU_GRAPH_CANVAS_HEIGHT * scale) / 2;
    const clientX = mruGraphNumber(event && event.clientX, rect.left + rect.width / 2);
    const clientY = mruGraphNumber(event && event.clientY, rect.top + rect.height / 2);
    const viewX = (clientX - rect.left - offsetX) / scale;
    const viewY = (clientY - rect.top - offsetY) / scale;
    const zoom = view && mruGraphNumber(view.k, 1) > 0 ? view.k : 1;
    return { x: (viewX - (view ? view.x : 0)) / zoom, y: (viewY - (view ? view.y : 0)) / zoom };
  } catch {
    return { x: MRU_GRAPH_CANVAS_WIDTH / 2, y: MRU_GRAPH_CANVAS_HEIGHT / 2 };
  }
}

/** ViewBox-space point (used for panning, where the view transform is preserved). */
function mruGraphEventViewPoint(event, svg) {
  try {
    if (!svg || typeof svg.getBoundingClientRect !== 'function') return null;
    const rect = svg.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const scale = Math.min(rect.width / MRU_GRAPH_CANVAS_WIDTH, rect.height / MRU_GRAPH_CANVAS_HEIGHT);
    if (!Number.isFinite(scale) || scale <= 0) return null;
    const offsetX = (rect.width - MRU_GRAPH_CANVAS_WIDTH * scale) / 2;
    const offsetY = (rect.height - MRU_GRAPH_CANVAS_HEIGHT * scale) / 2;
    const clientX = mruGraphNumber(event && event.clientX, rect.left + rect.width / 2);
    const clientY = mruGraphNumber(event && event.clientY, rect.top + rect.height / 2);
    return { x: (clientX - rect.left - offsetX) / scale, y: (clientY - rect.top - offsetY) / scale };
  } catch {
    return null;
  }
}

/** Node radius from type/weight/degree; clusters grow with their member count. */
function mruGraphNodeRadius(node, degree, selected) {
  if (node.cluster) {
    const count = Math.max(1, mruGraphNumber(node.count, 1));
    return mruGraphClamp(10 + Math.sqrt(count) * 2.6, 12, 26);
  }
  const weight = Math.max(0.01, mruGraphNumber(node.weight, 1));
  const base = 5.2 + Math.min(5.5, Math.sqrt(weight) * 1.6) + Math.min(4.5, Math.sqrt(Math.max(0, degree)) * 1.4);
  return mruGraphClamp(selected ? base + 1.2 : base, 5.5, 15);
}

/** Nearest node in an arrow-key direction, for keyboard graph navigation. */
function mruGraphNearestNode(nodes, positions, fromId, key) {
  const from = positions[fromId];
  if (!from) return null;
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
  const vertical = key === 'ArrowUp' || key === 'ArrowDown';
  if (!horizontal && !vertical) return null;
  const direction = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1;
  let best = null;
  let bestScore = Infinity;
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node.id === fromId) continue;
    const point = positions[node.id];
    if (!point) continue;
    const primary = horizontal ? point.x - from.x : point.y - from.y;
    const secondary = horizontal ? Math.abs(point.y - from.y) : Math.abs(point.x - from.x);
    if (primary * direction <= 2) continue;
    if (secondary > Math.abs(primary) * 1.8) continue;
    const score = Math.abs(primary) + secondary * 2;
    if (score < bestScore) {
      bestScore = score;
      best = node;
    }
  }
  return best;
}

/**
 * Knowledge-graph view for one paper (`mode="doc"`) or the whole library
 * (`mode="library"`). Props per AI-SPEC §6 plus the optional state props the
 * app surface already passes:
 *
 *   t, mode, graph, building, progress, error, available, loading,
 *   onJump(documentId?, blockKey), onAsk(node), onBuild(), onRefresh(),
 *   onUpdateGraph(nodes, edges)?
 */
export function MruGraphView(props) {
  const rawProps = props && typeof props === 'object' ? props : {};
  const {
    t: translate,
    mode: rawMode,
    graph: rawGraph,
    building: rawBuilding,
    progress: rawProgress,
    error: rawError,
    available: rawAvailable,
    loading: rawLoading,
    onJump,
    onAsk,
    onBuild,
    onRefresh,
  } = rawProps;

  const mode = rawMode === 'library' ? 'library' : 'doc';
  const building = rawBuilding === true;
  const loading = rawLoading === true;
  const available = rawAvailable !== false;
  const error = mruGraphString(rawError).trim();
  const t = typeof translate === 'function' ? translate : null;
  const lang = mruGraphLanguage(t);
  const tr = (key, params) => mruGraphText(t, key, params, lang);
  const initialCollapse = mode === 'library' ? 'auto' : 'none';

  const [selectedId, setSelectedId] = React.useState(null);
  const [query, setQuery] = React.useState('');
  const [typeFilter, setTypeFilter] = React.useState(null);
  const [collapseMode, setCollapseMode] = React.useState(initialCollapse);
  const [view, setView] = React.useState({ x: 0, y: 0, k: 1 });
  const [pins, setPins] = React.useState({});
  const [hoverEdgeId, setHoverEdgeId] = React.useState(null);
  const [cardPos, setCardPos] = React.useState(null);

  const svgRef = React.useRef(null);
  const rootRef = React.useRef(null);
  const cardRef = React.useRef(null);
  const nodeRefs = React.useRef({});
  const pinsRef = React.useRef({});
  const layoutCacheRef = React.useRef(null);
  const panRef = React.useRef(null);
  const dragRef = React.useRef(null);

  pinsRef.current = pins;

  const normalized = React.useMemo(() => mruGraphNormalizeGraph(rawGraph), [rawGraph]);
  const signature = React.useMemo(() => mruGraphSignature(normalized), [normalized]);

  const layout = React.useMemo(() => {
    const cache = layoutCacheRef.current;
    if (cache && cache.signature === signature) return cache.layout;
    const next = mruGraphLayoutGraph(normalized, {
      width: MRU_GRAPH_CANVAS_WIDTH,
      height: MRU_GRAPH_CANVAS_HEIGHT,
      seed: MRU_GRAPH_DEFAULT_SEED,
      previous: cache && cache.layout ? cache.layout.positions : null,
      pinned: pinsRef.current,
    });
    layoutCacheRef.current = { signature, layout: next };
    return next;
  }, [normalized, signature]);

  const visible = React.useMemo(() => mruGraphVisibleGraph(normalized, {
    types: typeFilter,
    query,
    collapse: collapseMode,
  }), [normalized, typeFilter, query, collapseMode]);

  const types = React.useMemo(() => mruGraphOrderedTypes(normalized.nodes), [normalized]);
  const degree = React.useMemo(() => mruGraphDegrees(visible.nodes, visible.edges), [visible]);

  const positions = React.useMemo(() => {
    const out = {};
    const base = layout.positions || {};
    for (let i = 0; i < visible.nodes.length; i += 1) {
      const node = visible.nodes[i];
      if (node.cluster) continue;
      const pinned = pins[node.id];
      const point = pinned || base[node.id];
      out[node.id] = point && Number.isFinite(point.x) && Number.isFinite(point.y)
        ? { x: point.x, y: point.y }
        : mruGraphFallbackPoint(node.id, i);
    }
    for (let i = 0; i < visible.nodes.length; i += 1) {
      const node = visible.nodes[i];
      if (!node.cluster) continue;
      const members = Array.isArray(node.members) ? node.members : [];
      let sumX = 0;
      let sumY = 0;
      let seen = 0;
      for (let j = 0; j < members.length; j += 1) {
        const point = pins[members[j]] || base[members[j]];
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
        sumX += point.x;
        sumY += point.y;
        seen += 1;
      }
      out[node.id] = seen > 0
        ? { x: mruGraphRound(sumX / seen), y: mruGraphRound(sumY / seen) }
        : mruGraphFallbackPoint(node.id, i);
    }
    return out;
  }, [visible, layout, pins]);

  const selected = selectedId ? visible.nodes.find((node) => node.id === selectedId) || null : null;

  /**
   * Measure the selected node on screen and place its card next to it.
   * The card flips side near edges and is clamped to the graph viewport.
   */
  const placeCard = React.useCallback(() => {
    if (!selectedId) {
      setCardPos((previous) => (previous === null ? previous : null));
      return;
    }
    const root = rootRef.current;
    const nodeElement = nodeRefs.current[selectedId];
    if (!root || !nodeElement
      || typeof root.getBoundingClientRect !== 'function'
      || typeof nodeElement.getBoundingClientRect !== 'function') return;
    const rootRect = root.getBoundingClientRect();
    if (!(rootRect.width > 0) || !(rootRect.height > 0)) return;
    // Anchor on the node dot, not on the whole <g>: the label text widens
    // the group box and would push the card too far away.
    const dotElement = typeof nodeElement.querySelector === 'function'
      ? nodeElement.querySelector('circle')
      : null;
    const nodeRect = dotElement !== null && typeof dotElement.getBoundingClientRect === 'function'
      ? dotElement.getBoundingClientRect()
      : nodeElement.getBoundingClientRect();
    if (!(nodeRect.width > 0) && !(nodeRect.height > 0)) return;
    const cardElement = cardRef.current;
    const cardWidth = cardElement && cardElement.offsetWidth > 0
      ? cardElement.offsetWidth
      : Math.min(300, rootRect.width - 24);
    const cardHeight = cardElement && cardElement.offsetHeight > 0 ? cardElement.offsetHeight : 240;
    const next = mruGraphAnchoredCardPosition({
      node: {
        x: nodeRect.left - rootRect.left + nodeRect.width / 2,
        y: nodeRect.top - rootRect.top + nodeRect.height / 2,
        width: nodeRect.width,
        height: nodeRect.height,
      },
      container: { width: rootRect.width, height: rootRect.height },
      card: { width: cardWidth, height: cardHeight },
      gap: 10,
      padding: 12,
    });
    setCardPos((previous) => (
      previous !== null
      && previous.left === next.left
      && previous.top === next.top
      && previous.placement === next.placement
        ? previous
        : next
    ));
  }, [selectedId]);

  const highlight = React.useMemo(() => {
    if (!selected) {
      return {
        pathNodes: new Set(),
        pathEdges: new Set(),
        relatedNodes: new Set(),
        relatedEdges: new Set(),
      };
    }
    const path = mruGraphActivePath(visible, selected.id);
    return {
      pathNodes: new Set(path.nodeIds),
      pathEdges: new Set(path.edgeIds),
      relatedNodes: new Set(path.relatedNodeIds),
      relatedEdges: new Set(path.relatedEdgeIds),
    };
  }, [visible, selected]);

  const edgeGeometry = React.useMemo(() => {
    const out = [];
    for (let i = 0; i < visible.edges.length; i += 1) {
      const edge = visible.edges[i];
      const from = positions[edge.from];
      const to = positions[edge.to];
      if (!from || !to) continue;
      const fromRadius = mruGraphNodeRadius(
        visible.nodes.find((node) => node.id === edge.from) || { weight: 1 },
        degree.get(edge.from) || 0,
        selectedId === edge.from,
      );
      const toRadius = mruGraphNodeRadius(
        visible.nodes.find((node) => node.id === edge.to) || { weight: 1 },
        degree.get(edge.to) || 0,
        selectedId === edge.to,
      );
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / length;
      const uy = dy / length;
      const trim = 2;
      const x1 = from.x + ux * (fromRadius + trim);
      const y1 = from.y + uy * (fromRadius + trim);
      const x2 = to.x - ux * (toRadius + trim);
      const y2 = to.y - uy * (toRadius + trim);
      const labelX = (x1 + x2) / 2 - uy * 9;
      const labelY = (y1 + y2) / 2 + ux * 9;
      out.push({ edge, x1, y1, x2, y2, labelX, labelY });
    }
    return out;
  }, [visible, positions, degree, selectedId]);

  const progress = mruGraphProgress(rawProgress);
  const progressPercent = progress.percent;
  const phaseLabel = building && progress.phase !== '' ? mruGraphPhaseLabel(t, progress.phase, lang) : '';
  let progressText = '';
  if (building) {
    const baseProgress = progress.total > 0
      ? tr('graph.progress', { done: progress.done, total: progress.total })
      : tr('graph.building');
    progressText = phaseLabel !== '' && baseProgress.indexOf(phaseLabel) === -1
      ? `${phaseLabel} · ${baseProgress}`
      : baseProgress;
  }

  const allActiveTypes = typeFilter === null;
  const activeTypeSet = new Set(allActiveTypes ? types : (Array.isArray(typeFilter) ? typeFilter : []));
  const typeCounts = visible.typeCounts || {};
  const totalNodes = normalized.nodes.length;
  const hasNodes = totalNodes > 0;
  const canvasShown = visible.nodes.length > 0;
  const hasSelection = Boolean(selected);
  const zoomPercent = Math.round(view.k * 100);

  React.useEffect(() => {
    setCollapseMode(mode === 'library' ? 'auto' : 'none');
  }, [mode]);

  // Keep the anchored card glued to its node while panning, zooming, resizing
  // or re-laying out; cardPos in the deps re-measures once the card has size.
  React.useLayoutEffect(() => {
    placeCard();
  }, [placeCard, view.x, view.y, view.k, layout, visible.nodes.length, cardPos]);

  React.useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => placeCard());
    observer.observe(root);
    return () => observer.disconnect();
  }, [placeCard]);

  // Clicking outside the graph closes the popover (Esc and the close button
  // still work; clicks on other nodes/edges are handled by the canvas).
  React.useEffect(() => {
    if (!selectedId || typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
      return undefined;
    }
    const onPointerDown = (event) => {
      const target = event && event.target;
      if (!target || typeof target.closest !== 'function') return;
      if (target.closest('.mru-graph__card')) return;
      if (!target.closest('.mru-graph')) setSelectedId(null);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [selectedId]);

  React.useEffect(() => {
    if (!canvasShown) return undefined;
    const svg = svgRef.current;
    if (!svg || typeof svg.addEventListener !== 'function') return undefined;
    const onWheel = (event) => {
      const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
      const delta = mruGraphNumber(event.deltaY, 0) * multiplier;
      if (delta === 0) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      const point = mruGraphEventViewPoint(event, svg);
      if (!point) return;
      setView((previous) => {
        const nextK = mruGraphClamp(
          previous.k * Math.exp(-delta * MRU_GRAPH_WHEEL_ZOOM_SPEED),
          MRU_GRAPH_MIN_ZOOM,
          MRU_GRAPH_MAX_ZOOM,
        );
        if (Math.abs(nextK - previous.k) < 1e-5) return previous;
        const worldX = (point.x - previous.x) / previous.k;
        const worldY = (point.y - previous.y) / previous.k;
        return { k: nextK, x: point.x - worldX * nextK, y: point.y - worldY * nextK };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [canvasShown]);

  const zoomBy = (factor) => {
    setView((previous) => {
      const nextK = mruGraphClamp(previous.k * factor, MRU_GRAPH_MIN_ZOOM, MRU_GRAPH_MAX_ZOOM);
      const centerX = MRU_GRAPH_CANVAS_WIDTH / 2;
      const centerY = MRU_GRAPH_CANVAS_HEIGHT / 2;
      const worldX = (centerX - previous.x) / previous.k;
      const worldY = (centerY - previous.y) / previous.k;
      return { k: nextK, x: centerX - worldX * nextK, y: centerY - worldY * nextK };
    });
  };

  const resetView = () => {
    setView({ x: 0, y: 0, k: 1 });
    setPins({});
    pinsRef.current = {};
    setSelectedId(null);
    setHoverEdgeId(null);
  };

  const clearFilters = () => {
    setQuery('');
    setTypeFilter(null);
  };

  const toggleType = (type) => {
    const current = new Set(typeFilter === null ? types : typeFilter);
    if (current.has(type)) current.delete(type);
    else current.add(type);
    if (current.size === types.length) {
      setTypeFilter(null);
      return;
    }
    setTypeFilter(types.filter((item) => current.has(item)));
  };

  const toggleCollapse = () => {
    if (visible.collapsed) setCollapseMode('none');
    else setCollapseMode('auto');
  };

  const expandCluster = (node) => {
    if (!node || !node.cluster) return;
    setCollapseMode('none');
    setQuery('');
    setTypeFilter(null);
    const members = Array.isArray(node.members) ? node.members : [];
    if (members.length > 0) setSelectedId(members[0]);
    else setSelectedId(null);
  };

  const jumpToBlock = (node, blockKey) => {
    if (typeof onJump !== 'function' || typeof blockKey !== 'string' || blockKey === '') return;
    const documentId = mruGraphNodeDocumentId(node);
    if (documentId !== '') onJump(documentId, blockKey);
    else onJump(blockKey);
  };

  const jumpToDocument = (node, documentId) => {
    if (typeof onJump !== 'function' || typeof documentId !== 'string' || documentId === '') return;
    const blockKey = Array.isArray(node && node.blockKeys) && node.blockKeys.length > 0 ? node.blockKeys[0] : '';
    if (blockKey !== '') onJump(documentId, blockKey);
    else onJump(documentId);
  };

  const selectNode = (node) => {
    if (!node) return;
    setSelectedId(node.id);
  };

  const onCanvasPointerDown = (event) => {
    if (event && event.button !== undefined && event.button !== 0) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    setSelectedId(null);
    setHoverEdgeId(null);
    if (!event) return;
    const point = mruGraphEventViewPoint(event, svgRef.current);
    if (!point) return;
    panRef.current = {
      pointerId: event.pointerId,
      start: point,
      origin: view,
    };
    try {
      if (event.currentTarget && typeof event.currentTarget.setPointerCapture === 'function') {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    } catch {
      /* pointer capture is best effort */
    }
  };

  const onCanvasPointerMove = (event) => {
    const pan = panRef.current;
    if (!pan || !event) return;
    const point = mruGraphEventViewPoint(event, svgRef.current);
    if (!point) return;
    setView({
      k: pan.origin.k,
      x: pan.origin.x + (point.x - pan.start.x),
      y: pan.origin.y + (point.y - pan.start.y),
    });
  };

  const onCanvasPointerUp = (event) => {
    const pan = panRef.current;
    if (!pan) return;
    panRef.current = null;
    try {
      if (event && event.currentTarget && typeof event.currentTarget.releasePointerCapture === 'function') {
        event.currentTarget.releasePointerCapture(pan.pointerId);
      }
    } catch {
      /* ignore */
    }
  };

  const onNodePointerDown = (event, node) => {
    if (event && event.button !== undefined && event.button !== 0) return;
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    setSelectedId(node.id);
    if (node.cluster) return;
    if (!event) return;
    const origin = positions[node.id];
    if (!origin) return;
    if (event.currentTarget && typeof event.currentTarget.focus === 'function') {
      try {
        event.currentTarget.focus({ preventScroll: true });
      } catch {
        /* focus is best effort */
      }
    }
    const start = mruGraphEventWorldPoint(event, svgRef.current, view);
    dragRef.current = {
      id: node.id,
      pointerId: event.pointerId,
      origin,
      start,
      moved: false,
    };
    try {
      if (event.currentTarget && typeof event.currentTarget.setPointerCapture === 'function') {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    } catch {
      /* pointer capture is best effort */
    }
  };

  const onNodePointerMove = (event, node) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== node.id || !event) return;
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    const point = mruGraphEventWorldPoint(event, svgRef.current, view);
    const deltaX = point.x - drag.start.x;
    const deltaY = point.y - drag.start.y;
    if (!drag.moved && Math.sqrt(deltaX * deltaX + deltaY * deltaY) > 2) drag.moved = true;
    if (!drag.moved) return;
    setPins((previous) => ({
      ...previous,
      [node.id]: {
        x: mruGraphClamp(drag.origin.x + deltaX, MRU_GRAPH_CANVAS_PADDING, MRU_GRAPH_CANVAS_WIDTH - MRU_GRAPH_CANVAS_PADDING),
        y: mruGraphClamp(drag.origin.y + deltaY, MRU_GRAPH_CANVAS_PADDING, MRU_GRAPH_CANVAS_HEIGHT - MRU_GRAPH_CANVAS_PADDING),
      },
    }));
  };

  const onNodePointerUp = (event, node) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== node.id) return;
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    dragRef.current = null;
    try {
      if (event && event.currentTarget && typeof event.currentTarget.releasePointerCapture === 'function') {
        event.currentTarget.releasePointerCapture(drag.pointerId);
      }
    } catch {
      /* ignore */
    }
  };

  const onNodeKeyDown = (event, node) => {
    if (!event) return;
    const key = event.key;
    if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      selectNode(node);
      return;
    }
    if (key === 'Escape') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      setSelectedId(null);
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
      const next = mruGraphNearestNode(visible.nodes, positions, node.id, key);
      if (!next) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      const element = nodeRefs.current[next.id];
      if (element && typeof element.focus === 'function') element.focus();
    }
  };

  const onCanvasKeyDown = (event) => {
    if (!event) return;
    const key = event.key;
    if (key === 'Escape') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      setSelectedId(null);
      return;
    }
    if (key === '+' || key === '=') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      zoomBy(1.2);
      return;
    }
    if (key === '-' || key === '_') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      zoomBy(0.83);
      return;
    }
    if (key === '0') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      resetView();
    }
  };

  const onCardKeyDown = (event) => {
    if (event && event.key === 'Escape') {
      if (typeof event.preventDefault === 'function') event.preventDefault();
      setSelectedId(null);
    }
  };

  // --- header -------------------------------------------------------------
  const buildLabel = building
    ? tr('graph.building')
    : mode === 'library' || hasNodes
      ? tr('graph.rebuild')
      : tr('graph.build');
  const buildDisabled = building || loading || !available;
  const refreshDisabled = loading || building;
  const headerActions = [];
  if (typeof onRefresh === 'function') {
    headerActions.push(mruGraphH('button', {
      key: 'refresh',
      type: 'button',
      className: 'mru-btn mru-btn--ghost mru-btn--sm',
      'data-action': 'graph-refresh',
      disabled: refreshDisabled,
      onClick: () => onRefresh(),
    }, tr('graph.refresh')));
  }
  if (typeof onBuild === 'function') {
    headerActions.push(mruGraphH('button', {
      key: 'build',
      type: 'button',
      className: 'mru-btn mru-btn--primary mru-btn--sm',
      'data-action': 'graph-build',
      disabled: buildDisabled,
      onClick: () => onBuild(),
    }, buildLabel));
  }
  const header = mruGraphH('div', { className: 'mru-graph__head' },
    mruGraphH('h2', { className: 'mru-graph__title' }, tr(mode === 'library' ? 'graph.titleLibrary' : 'graph.titleDoc')),
    headerActions.length > 0
      ? mruGraphH('div', { className: 'mru-graph__actions' }, headerActions)
      : null);

  // --- progress strip -----------------------------------------------------
  const progressElement = building || loading
    ? mruGraphH('div', {
      className: 'mru-graph__progress',
      role: 'progressbar',
      'aria-label': building ? tr('graph.building') : tr('graph.loading'),
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': progressPercent === null ? undefined : Math.round(progressPercent),
      'data-indeterminate': progressPercent === null ? 'true' : undefined,
    }, mruGraphH('span', { style: { width: `${progressPercent === null ? 38 : progressPercent}%` } }))
    : null;

  // --- toolbar ------------------------------------------------------------
  const searchInput = mruGraphH('input', {
    type: 'search',
    className: 'mru-graph__search',
    value: query,
    placeholder: tr('graph.search'),
    'aria-label': tr('graph.search'),
    onChange: (event) => setQuery(mruGraphString(event && event.target ? event.target.value : '').slice(0, 160)),
    onKeyDown: (event) => {
      if (event && event.key === 'Escape' && query !== '') {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        setQuery('');
      }
    },
  });
  const legendItems = types.map((type) => {
    const active = activeTypeSet.has(type);
    const count = typeCounts[type] || 0;
    return mruGraphH('button', {
      key: type,
      type: 'button',
      className: 'mru-graph__legend-item',
      'data-type': type,
      'aria-pressed': active ? 'true' : 'false',
      title: `${mruGraphTypeLabel(t, type, lang)} · ${mruGraphFormatCount(count)}`,
      onClick: () => toggleType(type),
    },
    mruGraphH('span', { key: 'label' }, mruGraphTypeLabel(t, type, lang)),
    mruGraphH('span', { key: 'count', className: 'mru-graph__legend-count' }, mruGraphFormatCount(count)));
  });
  const showCollapseToggle = visible.filteredNodes > MRU_GRAPH_COLLAPSE_THRESHOLD || visible.collapsed;
  const legend = mruGraphH('div', { className: 'mru-graph__legend', role: 'group', 'aria-label': tr('graph.legend') },
    legendItems,
    showCollapseToggle
      ? mruGraphH('button', {
        key: 'collapse',
        type: 'button',
        className: 'mru-link-btn',
        'data-action': 'graph-collapse',
        'aria-pressed': visible.collapsed ? 'true' : 'false',
        onClick: toggleCollapse,
      }, visible.collapsed ? tr('graph.expandAll') : tr('graph.collapseClusters'))
      : null);
  const toolbar = hasNodes
    ? mruGraphH('div', { className: 'mru-graph__toolbar' },
      searchInput,
      mruGraphH('div', { className: 'mru-graph__filters' }, legend))
    : null;

  // Colour meanings must never rely on colour alone: every dot carries a text
  // label (WCAG 1.4.1) and the exact mapping is repeated in the AI panel and
  // the margin notes header.
  const aspectLegendItems = ['definition', 'method', 'result', 'limitation'].map((aspect) => mruGraphH('span', {
    key: aspect,
    className: 'mru-aspect-legend__item',
    'data-aspect': aspect,
  },
  mruGraphH('span', {
    className: `mru-aspect-legend__dot mru-aspect-legend__dot--${aspect}`,
    'aria-hidden': 'true',
  }),
  mruGraphH('span', { className: 'mru-aspect-legend__label' }, tr(`graph.aspect.${aspect}`))));

  const aspectLegend = canvasShown && hasNodes
    ? mruGraphH('div', {
      className: 'mru-graph__aspect-legend',
      role: 'group',
      'aria-label': tr('graph.aspectLegend'),
      title: tr('graph.aspectHint'),
    },
    mruGraphH('span', { className: 'mru-graph__aspect-legend-label' }, tr('graph.aspectLegend')),
    aspectLegendItems)
    : null;

  // --- canvas -------------------------------------------------------------
  const nodeElements = visible.nodes.map((node, index) => {
    const point = positions[node.id] || mruGraphFallbackPoint(node.id, index);
    const nodeDegree = degree.get(node.id) || 0;
    const isSelected = selectedId === node.id;
    const inPath = highlight.pathNodes.has(node.id);
    const related = highlight.relatedNodes.has(node.id);
    const dimmed = hasSelection && !isSelected && !inPath && !related;
    const radius = mruGraphNodeRadius(node, nodeDegree, isSelected);
    const typeClass = MRU_GRAPH_NODE_TYPES.indexOf(node.type) === -1 ? 'unknown' : node.type;
    const typeLabel = mruGraphTypeLabel(t, node.type, lang);
    const label = node.cluster
      ? `${typeLabel} · ${mruGraphFormatCount(node.count || 0)}`
      : mruGraphDisplay(node.label || node.id);
    const showLabel = node.cluster
      || visible.nodes.length <= 70
      || view.k >= 1.05
      || isSelected
      || inPath
      || related;
    const className = 'mru-graph__node mru-graph__node--' + typeClass
      + (isSelected ? ' mru-graph__node--active' : '');
    const clusterCount = node.cluster ? String(mruGraphFormatCount(node.count || 0)) : '';
    return mruGraphH('g', {
      key: node.id,
      ref: (element) => mruGraphSetNodeRef(nodeRefs, node.id, element),
      className,
      transform: `translate(${point.x} ${point.y})`,
      tabIndex: 0,
      role: 'button',
      'aria-label': `${label} · ${typeLabel} · ${tr('graph.degree', { count: mruGraphFormatCount(nodeDegree) })}`,
      'aria-pressed': isSelected ? 'true' : 'false',
      'data-node-id': node.id,
      'data-type': node.type,
      'data-cluster': node.cluster ? 'true' : undefined,
      'data-pinned': pins[node.id] ? 'true' : undefined,
      'data-active': isSelected ? 'true' : undefined,
      'data-path': inPath ? 'true' : undefined,
      'data-related': related ? 'true' : undefined,
      'data-dimmed': dimmed ? 'true' : undefined,
      style: dimmed ? { opacity: 0.28 } : undefined,
      onPointerDown: (event) => onNodePointerDown(event, node),
      onPointerMove: (event) => onNodePointerMove(event, node),
      onPointerUp: (event) => onNodePointerUp(event, node),
      onPointerCancel: (event) => onNodePointerUp(event, node),
      onLostPointerCapture: () => {
        if (dragRef.current && dragRef.current.id === node.id) dragRef.current = null;
      },
      onKeyDown: (event) => onNodeKeyDown(event, node),
    },
    mruGraphH('title', { key: 'title' }, `${label} · ${typeLabel}`),
    node.cluster
      ? mruGraphH('text', {
        key: 'count',
        className: 'mru-graph__node-count',
        textAnchor: 'middle',
        y: 4,
        fontSize: Math.max(8, Math.min(11, radius * 0.6)),
        fill: 'currentColor',
        'aria-hidden': 'true',
      }, clusterCount)
      : null,
    mruGraphH('circle', { key: 'dot', r: radius, ...(node.cluster ? { strokeDasharray: '3 2' } : {}) }),
    showLabel
      ? mruGraphH('text', {
        key: 'label',
        className: 'mru-graph__node-label',
        textAnchor: 'middle',
        y: radius + 13,
      }, mruGraphTruncate(label, node.cluster ? 18 : 24))
      : null);
  });

  const edgeElements = edgeGeometry.map((geometry) => {
    const edge = geometry.edge;
    const activeEdge = highlight.pathEdges.has(edge.id) || highlight.relatedEdges.has(edge.id);
    const dimmed = hasSelection && !activeEdge;
    const hovered = hoverEdgeId === edge.id;
    const fromNode = visible.nodes.find((node) => node.id === edge.from);
    const toNode = visible.nodes.find((node) => node.id === edge.to);
    const fromLabel = fromNode ? (fromNode.cluster ? mruGraphTypeLabel(t, fromNode.type, lang) : fromNode.label) : edge.from;
    const toLabel = toNode ? (toNode.cluster ? mruGraphTypeLabel(t, toNode.type, lang) : toNode.label) : edge.to;
    const edgeLabel = edge.label || mruGraphEdgeTypeLabel(t, edge.type, lang);
    const hoverLabel = mruGraphTruncate(
      mruGraphNumber(edge.count, 0) > 1 ? `${edgeLabel} ×${edge.count}` : edgeLabel,
      28,
    );
    const groupClass = 'mru-graph__edge-group'
      + (activeEdge ? ' mru-graph__edge-group--active' : '')
      + (dimmed ? ' mru-graph__edge-group--dim' : '');
    return mruGraphH('g', {
      key: edge.id,
      className: groupClass,
      'data-edge-id': edge.id,
      'data-type': edge.type,
      'aria-hidden': 'true',
      onPointerEnter: () => setHoverEdgeId(edge.id),
      onPointerLeave: () => setHoverEdgeId((previous) => (previous === edge.id ? null : previous)),
      onPointerDown: (event) => {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      },
    },
    mruGraphH('title', { key: 'title' }, `${fromLabel} → ${toLabel} · ${edgeLabel}`),
    mruGraphH('line', {
      key: 'line',
      className: 'mru-graph__edge'
        + (activeEdge ? ' mru-graph__edge--active' : '')
        + (dimmed ? ' mru-graph__edge--dim' : ''),
      'data-active': activeEdge ? 'true' : undefined,
      'data-dimmed': dimmed ? 'true' : undefined,
      x1: geometry.x1,
      y1: geometry.y1,
      x2: geometry.x2,
      y2: geometry.y2,
      vectorEffect: 'non-scaling-stroke',
    }),
    mruGraphH('line', {
      key: 'hit',
      className: 'mru-graph__edge-hit',
      x1: geometry.x1,
      y1: geometry.y1,
      x2: geometry.x2,
      y2: geometry.y2,
      stroke: 'transparent',
      strokeWidth: 14,
      vectorEffect: 'non-scaling-stroke',
    }),
    hovered
      ? mruGraphH('text', {
        key: 'label',
        className: 'mru-graph__edge-label',
        x: geometry.labelX,
        y: geometry.labelY,
        textAnchor: 'middle',
      }, hoverLabel)
      : null);
  });

  const canvas = mruGraphH('svg', {
    ref: svgRef,
    className: 'mru-graph__canvas',
    viewBox: `0 0 ${MRU_GRAPH_CANVAS_WIDTH} ${MRU_GRAPH_CANVAS_HEIGHT}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'group',
    'aria-label': tr('graph.canvas'),
    'data-zoom': view.k,
    onPointerDown: onCanvasPointerDown,
    onPointerMove: onCanvasPointerMove,
    onPointerUp: onCanvasPointerUp,
    onPointerCancel: onCanvasPointerUp,
    onLostPointerCapture: () => {
      if (panRef.current) panRef.current = null;
    },
    onKeyDown: onCanvasKeyDown,
  },
  mruGraphH('rect', {
    key: 'bg',
    className: 'mru-graph__canvas-bg',
    x: 0,
    y: 0,
    width: MRU_GRAPH_CANVAS_WIDTH,
    height: MRU_GRAPH_CANVAS_HEIGHT,
    fill: 'transparent',
  }),
  mruGraphH('g', {
    key: 'viewport',
    className: 'mru-graph__viewport',
    transform: `translate(${view.x} ${view.y}) scale(${view.k})`,
  }, edgeElements, nodeElements));

  // --- empty / loading / error states ------------------------------------
  let emptyElement = null;
  if (!hasNodes || !canvasShown) {
    let title = mode === 'library' ? tr('graph.emptyLibrary') : tr('graph.emptyDoc');
    let text = tr('graph.emptyHint');
    let icon = null;
    let action = null;
    if (!available) {
      title = tr('graph.unavailable');
      text = tr('graph.unavailableHint');
    } else if (loading) {
      title = tr('graph.loading');
      icon = mruGraphSpinner();
    } else if (building) {
      title = tr('graph.building');
      text = progressText || tr('graph.emptyHint');
      icon = mruGraphSpinner();
    } else if (error !== '') {
      title = tr('graph.error');
      text = mruGraphDisplay(error);
      const retry = typeof onRefresh === 'function' ? onRefresh : (typeof onBuild === 'function' ? onBuild : null);
      if (retry) {
        action = mruGraphH('button', {
          type: 'button',
          className: 'mru-btn mru-btn--primary mru-btn--sm',
          'data-action': 'graph-retry',
          onClick: () => retry(),
        }, tr('graph.retry'));
      }
    } else if (hasNodes) {
      title = tr('graph.noMatches');
      text = tr('graph.noMatchesHint');
      action = mruGraphH('button', {
        type: 'button',
        className: 'mru-btn mru-btn--ghost mru-btn--sm',
        'data-action': 'graph-clear-filters',
        onClick: clearFilters,
      }, tr('graph.clearFilters'));
    } else if (typeof onBuild === 'function' && available) {
      action = mruGraphH('button', {
        type: 'button',
        className: 'mru-btn mru-btn--primary mru-btn--sm',
        'data-action': 'graph-build',
        onClick: () => onBuild(),
      }, mode === 'library' ? tr('graph.rebuild') : tr('graph.build'));
    }
    emptyElement = mruGraphH('div', { className: 'mru-graph__empty' },
      icon,
      mruGraphH('h3', null, title),
      mruGraphH('p', null, text),
      action);
  }

  // --- status line --------------------------------------------------------
  const statusBits = [];
  if (hasNodes) {
    statusBits.push(tr('graph.nodes', { count: mruGraphFormatCount(totalNodes) }));
    statusBits.push(tr('graph.edges', { count: mruGraphFormatCount(normalized.edges.length) }));
  }
  if (hasNodes && visible.filteredNodes !== totalNodes) {
    statusBits.push(tr('graph.filtered', {
      shown: mruGraphFormatCount(visible.filteredNodes),
      total: mruGraphFormatCount(totalNodes),
    }));
  }
  if (visible.collapsed) {
    statusBits.push(tr('graph.collapsed', { count: mruGraphFormatCount(visible.collapsedNodes) }));
  }
  if (building) statusBits.push(progressText);
  else if (loading) statusBits.push(tr('graph.loading'));
  else if (!available) statusBits.push(tr('graph.unavailable'));
  else if (error !== '') statusBits.push(mruGraphDisplay(error));
  else if (hasNodes) statusBits.push(tr('graph.hint'));
  const zoomControls = canvasShown
    ? mruGraphH('span', {
      className: 'mru-graph__zoom',
      style: { display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 'auto' },
    },
    mruGraphH('button', {
      key: 'out',
      type: 'button',
      className: 'mru-link-btn',
      'data-action': 'graph-zoom-out',
      'aria-label': tr('graph.zoomOut'),
      title: tr('graph.zoomOut'),
      onClick: () => zoomBy(0.8),
    }, '−'),
    mruGraphH('span', { key: 'level' }, tr('graph.zoom', { percent: zoomPercent })),
    mruGraphH('button', {
      key: 'in',
      type: 'button',
      className: 'mru-link-btn',
      'data-action': 'graph-zoom-in',
      'aria-label': tr('graph.zoomIn'),
      title: tr('graph.zoomIn'),
      onClick: () => zoomBy(1.25),
    }, '+'),
    (view.k !== 1 || view.x !== 0 || view.y !== 0 || Object.keys(pins).length > 0)
      ? mruGraphH('button', {
        key: 'reset',
        type: 'button',
        className: 'mru-link-btn',
        'data-action': 'graph-reset-view',
        onClick: resetView,
      }, tr('graph.resetView'))
      : null)
    : null;
  const status = hasNodes || building || loading || error !== '' || !available
    ? mruGraphH('div', { className: 'mru-graph__status' },
      statusBits.map((text, index) => mruGraphH('span', { key: `status-${index}` }, text)),
      zoomControls)
    : null;
  const liveText = building ? progressText : selected ? (selected.cluster ? `${mruGraphTypeLabel(t, selected.type, lang)} ×${selected.count || 0}` : selected.label) : '';
  const live = mruGraphH('span', { className: 'mru-sr-only', 'aria-live': 'polite' }, liveText);

  // --- details card -------------------------------------------------------
  let card = null;
  if (selected) {
    const typeLabel = mruGraphTypeLabel(t, selected.type, lang);
    const nodeDegree = degree.get(selected.id) || 0;
    const title = selected.cluster
      ? `${typeLabel} × ${mruGraphFormatCount(selected.count || 0)}`
      : mruGraphDisplay(selected.label || selected.id);
    const summary = selected.cluster
      ? tr('graph.clusterSummary', { count: mruGraphFormatCount(selected.count || 0), type: typeLabel })
      : (selected.summary ? mruGraphDisplay(selected.summary) : tr('graph.noSummary'));
    const blockKeys = !selected.cluster && Array.isArray(selected.blockKeys) ? selected.blockKeys : [];
    const documentIds = Array.isArray(selected.documentIds) ? selected.documentIds : [];
    const paperByDocument = new Map();
    for (let i = 0; i < normalized.nodes.length; i += 1) {
      const node = normalized.nodes[i];
      if (node.type !== 'paper') continue;
      if (typeof node.documentId === 'string' && node.documentId !== '') paperByDocument.set(node.documentId, node.label);
      if (Array.isArray(node.documentIds)) {
        for (let j = 0; j < node.documentIds.length; j += 1) paperByDocument.set(node.documentIds[j], node.label);
      }
    }
    const neighbours = [];
    for (let i = 0; i < visible.edges.length; i += 1) {
      const edge = visible.edges[i];
      if (edge.from !== selected.id && edge.to !== selected.id) continue;
      const otherId = edge.from === selected.id ? edge.to : edge.from;
      if (otherId === selected.id) continue;
      const other = visible.nodes.find((node) => node.id === otherId);
      if (!other) continue;
      neighbours.push({
        edge,
        other,
        direction: edge.from === selected.id ? 'out' : 'in',
      });
    }
    const meta = [];
    meta.push(mruGraphH('span', { key: 'type' }, typeLabel));
    if (!selected.cluster && selected.source) {
      meta.push(mruGraphH('span', { key: 'source' }, mruGraphSourceLabel(t, selected.source, lang)));
    }
    meta.push(mruGraphH('span', { key: 'degree' }, tr('graph.degree', { count: mruGraphFormatCount(nodeDegree) })));
    if (selected.aspect) meta.push(mruGraphH('span', { key: 'aspect' }, mruGraphDisplay(selected.aspect)));

    const cardChildren = [
      mruGraphH('button', {
        key: 'close',
        type: 'button',
        className: 'mru-icon-btn',
        'data-action': 'graph-card-close',
        'aria-label': tr('graph.close'),
        title: tr('graph.close'),
        style: { position: 'absolute', top: 8, right: 8 },
        onClick: () => setSelectedId(null),
      }, mruGraphGlyph('close', 14)),
      mruGraphH('div', { key: 'title', className: 'mru-graph__card-title' }, title),
      mruGraphH('p', { key: 'summary', className: 'mru-graph__card-summary' }, summary),
      mruGraphH('div', { key: 'meta', className: 'mru-graph__card-meta' }, meta),
    ];

    if (selected.cluster) {
      const members = Array.isArray(selected.members) ? selected.members : [];
      const memberNodes = members
        .map((id) => visible.nodes.find((node) => node.id === id) || normalized.nodes.find((node) => node.id === id))
        .filter(Boolean);
      if (memberNodes.length > 0) {
        const memberButtons = memberNodes.slice(0, 8).map((member) => mruGraphH('button', {
          key: member.id,
          type: 'button',
          className: 'mru-link-btn',
          'data-member-id': member.id,
          onClick: () => {
            setCollapseMode('none');
            setQuery('');
            setTypeFilter(null);
            setSelectedId(member.id);
          },
        }, mruGraphTruncate(mruGraphDisplay(member.label || member.id), 20)));
        cardChildren.push(mruGraphH('div', { key: 'members', className: 'mru-graph__card-meta' },
          mruGraphH('span', { key: 'label' }, tr('graph.members')),
          memberButtons,
          memberNodes.length > 8
            ? mruGraphH('span', { key: 'more' }, tr('graph.more', { count: memberNodes.length - 8 }))
            : null));
      }
      cardChildren.push(mruGraphH('button', {
        key: 'expand',
        type: 'button',
        className: 'mru-btn mru-btn--primary mru-btn--sm',
        'data-action': 'graph-expand-cluster',
        onClick: () => expandCluster(selected),
      }, tr('graph.expandCluster')));
    } else {
      if (blockKeys.length > 0) {
        const sourceButtons = blockKeys.slice(0, 6).map((blockKey) => mruGraphH('button', {
          key: blockKey,
          type: 'button',
          className: 'mru-link-btn',
          'data-block-key': blockKey,
          title: `${tr('graph.jump')} · ${blockKey}`,
          onClick: () => jumpToBlock(selected, blockKey),
        }, mruGraphTruncate(blockKey, 24)));
        cardChildren.push(mruGraphH('div', { key: 'sources', className: 'mru-graph__card-meta' },
          mruGraphH('span', { key: 'label' }, tr('graph.sources')),
          sourceButtons,
          blockKeys.length > 6
            ? mruGraphH('span', { key: 'more' }, tr('graph.more', { count: blockKeys.length - 6 }))
            : null));
      }
      if (documentIds.length > 0) {
        const documentButtons = documentIds.slice(0, 4).map((documentId) => mruGraphH('button', {
          key: documentId,
          type: 'button',
          className: 'mru-link-btn',
          'data-document-id': documentId,
          title: documentId,
          onClick: () => jumpToDocument(selected, documentId),
        }, mruGraphTruncate(paperByDocument.get(documentId) || documentId, 20)));
        cardChildren.push(mruGraphH('div', { key: 'documents', className: 'mru-graph__card-meta' },
          mruGraphH('span', { key: 'label' }, tr('graph.documents')),
          documentButtons,
          documentIds.length > 4
            ? mruGraphH('span', { key: 'more' }, tr('graph.more', { count: documentIds.length - 4 }))
            : null));
      }
      if (blockKeys.length === 0 && documentIds.length === 0) {
        cardChildren.push(mruGraphH('div', { key: 'no-sources', className: 'mru-graph__card-meta' },
          mruGraphH('span', { key: 'label' }, tr('graph.noSources'))));
      }
      if (neighbours.length > 0) {
        const neighbourButtons = neighbours.slice(0, 8).map((entry) => mruGraphH('button', {
          key: entry.edge.id,
          type: 'button',
          className: 'mru-link-btn',
          'data-neighbor-id': entry.other.id,
          title: entry.other.label || entry.other.id,
          onClick: () => setSelectedId(entry.other.id),
        }, `${entry.direction === 'out' ? '→' : '←'} ${mruGraphEdgeTypeLabel(t, entry.edge.type, lang)} · ${mruGraphTruncate(entry.other.cluster ? mruGraphTypeLabel(t, entry.other.type, lang) : (entry.other.label || entry.other.id), 16)}`));
        cardChildren.push(mruGraphH('div', { key: 'relations', className: 'mru-graph__card-meta' },
          mruGraphH('span', { key: 'label' }, tr('graph.relations')),
          neighbourButtons,
          neighbours.length > 8
            ? mruGraphH('span', { key: 'more' }, tr('graph.more', { count: neighbours.length - 8 }))
            : null));
      } else {
        cardChildren.push(mruGraphH('div', { key: 'no-relations', className: 'mru-graph__card-meta' },
          mruGraphH('span', { key: 'label' }, tr('graph.noRelations'))));
      }
      if (typeof onAsk === 'function') {
        cardChildren.push(mruGraphH('button', {
          key: 'ask',
          type: 'button',
          className: 'mru-btn mru-btn--primary mru-btn--sm',
          'data-action': 'graph-ask',
          onClick: () => onAsk(selected),
        }, tr('graph.ask')));
      }
    }
    card = mruGraphH('div', {
      ref: cardRef,
      className: 'mru-graph__card' + (cardPos !== null ? ' mru-graph__card--anchored' : ''),
      style: cardPos !== null
        ? { left: `${cardPos.left}px`, top: `${cardPos.top}px`, right: 'auto', bottom: 'auto' }
        : undefined,
      'data-placement': cardPos !== null ? cardPos.placement : undefined,
      role: 'region',
      'aria-label': title,
      'data-node-id': selected.id,
      onKeyDown: onCardKeyDown,
    }, cardChildren);
  }

  const root = mruGraphH('div', {
    ref: rootRef,
    className: 'mru-graph',
    'data-mode': mode,
    'data-building': building ? 'true' : undefined,
    'data-loading': loading ? 'true' : undefined,
    'data-available': available ? 'true' : 'false',
    'data-collapsed': visible.collapsed ? 'true' : undefined,
    'data-selected-id': selected ? selected.id : undefined,
    'aria-busy': building || loading ? 'true' : undefined,
  },
  header,
  progressElement,
  toolbar,
  aspectLegend,
  emptyElement || canvas,
  status,
  card,
  live);
  return root;
}

// ---------------------------------------------------------------------------
// Component-local helpers (kept below the component so top-level functions
// read in the order the file is consumed; declarations are hoisted anyway).
// ---------------------------------------------------------------------------

/** Deterministic fallback point when a node appears in a filtered layout. */
function mruGraphFallbackPoint(id, index) {
  const hash = mruGraphSeedValue(id);
  const angle = ((index + 1) * 2.399963229728653 + (hash % 360) * (Math.PI / 180)) % (Math.PI * 2);
  const radius = Math.min(MRU_GRAPH_CANVAS_WIDTH, MRU_GRAPH_CANVAS_HEIGHT)
    * (0.18 + ((hash >>> 8) % 40) / 200);
  return {
    x: mruGraphRound(MRU_GRAPH_CANVAS_WIDTH / 2 + Math.cos(angle) * radius),
    y: mruGraphRound(MRU_GRAPH_CANVAS_HEIGHT / 2 + Math.sin(angle) * radius),
  };
}
