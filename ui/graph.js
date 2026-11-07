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

/** Known node provenance values (AI-SPEC §2); unknown sources stay verbatim. */
const MRU_GRAPH_SOURCES = ['ai-summary', 'qa', 'user', 'aggregate'];

/** Curation contract (PLAN C1): rename label cap and position precision/range. */
const MRU_GRAPH_RENAME_MAX = 80;
/**
 * Pinned positions are world pixels on the infinite canvas, so they may be
 * negative and far outside the old 1000×680 sheet. ±100000 (0.1 precision) is
 * a finite ceiling that comfortably covers any reachable drag.
 */
const MRU_GRAPH_POSITION_MAX = 100000;

/**
 * Initial layout sheet. A seeded force layout still arranges a fresh graph
 * inside this box, but the interactive canvas around it is unbounded: the
 * camera pans/zooms anywhere and dragged nodes may leave the sheet (see the
 * infinite-canvas camera helpers below).
 */
const MRU_GRAPH_CANVAS_WIDTH = 1000;
const MRU_GRAPH_CANVAS_HEIGHT = 680;
const MRU_GRAPH_CANVAS_PADDING = 56;
const MRU_GRAPH_DEFAULT_SEED = 0x1f2e3d4c;

/** Library scale thresholds for progressive disclosure. */
const MRU_GRAPH_COLLAPSE_THRESHOLD = 160;
const MRU_GRAPH_COLLAPSE_KEEP = 120;
/** Library graphs are much denser: fold minor topics earlier (progressive disclosure). */
const MRU_GRAPH_LIBRARY_COLLAPSE_THRESHOLD = 46;
const MRU_GRAPH_LIBRARY_COLLAPSE_KEEP = 28;
/** Upper bound on relation lines drawn at once (dense library graphs are hairballs). */
const MRU_GRAPH_MAX_RENDER_EDGES = 180;

/**
 * Infinite-canvas camera. `view` maps world → screen: `screen = world * k +
 * (x, y)`. The zoom range is deliberately wide so even a map whose nodes were
 * dragged thousands of pixels apart can be fitted back into view; the fit
 * helper adds margins and caps the initial magnification.
 */
const MRU_GRAPH_MIN_ZOOM = 0.02;
const MRU_GRAPH_MAX_ZOOM = 4;
const MRU_GRAPH_FIT_PADDING = 40;
const MRU_GRAPH_FIT_MARGIN = 32;
const MRU_GRAPH_FIT_MAX_ZOOM = 1;
const MRU_GRAPH_GRID_STEP = 22;
const MRU_GRAPH_GRID_MIN_STEP = 10;
const MRU_GRAPH_GRID_MAX_STEP = 44;
const MRU_GRAPH_WHEEL_ZOOM_SPEED = 0.0014;

/**
 * All `graph.*` copy lives in the app dictionaries (`ZH`/`EN` in ui/app.js);
 * `mruGraphText` interpolates `{param}` placeholders and falls back to the
 * key itself, so a missing key shows the key instead of crashing the view.
 */

// ===========================================================================
// 2. Small pure helpers (values, ids, copy)
// ===========================================================================

/** Coerce anything to a display string without throwing. */
function mruGraphString(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/** Whether the user prefers reduced motion (safe outside a browser/test env). */
function mruGraphReducedMotion() {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
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

/** Locale text from the app dictionaries: `t()` first, key-as-fallback last. */
function mruGraphText(t, key, params) {
  let template = key;
  if (typeof t === 'function') {
    try {
      const value = t(key, params);
      if (typeof value === 'string' && value !== '') template = value;
    } catch {
      /* fall back to the key below */
    }
  }
  return mruGraphInterpolate(template, params);
}

/** Label for a known node type; unknown types stay verbatim. */
function mruGraphTypeLabel(t, type) {
  if (MRU_GRAPH_NODE_TYPES.indexOf(type) === -1) return type;
  return mruGraphText(t, `graph.${type}`);
}

/** Label for an edge type (defines/uses/…). */
function mruGraphEdgeTypeLabel(t, type) {
  if (MRU_GRAPH_EDGE_TYPES.indexOf(type) === -1) return type;
  return mruGraphText(t, `graph.edge.${type}`);
}

/** Label for a node source (ai-summary/qa/user/aggregate). */
function mruGraphSourceLabel(t, source) {
  if (MRU_GRAPH_SOURCES.indexOf(source) === -1) return mruGraphString(source);
  return mruGraphText(t, `graph.source.${source}`);
}

/** `graph.reading` / `graph.extracting` / `graph.merging` / phase fallback. */
function mruGraphPhaseLabel(t, phase) {
  const key = phase === 'reading' ? 'graph.reading'
    : phase === 'extracting' ? 'graph.extracting'
      : phase === 'merging' ? 'graph.merging'
        : '';
  if (key === '') return phase;
  return mruGraphText(t, key);
}

// ===========================================================================
// 2b. Curation helpers — user rename / merge / pin (PLAN C1/C2)
// ===========================================================================

/** Stable node id from a node object, an id string or `{ id }`. */
function mruGraphCurationId(value) {
  if (value !== null && value !== undefined && typeof value === 'object') {
    return mruGraphString(value.id).trim();
  }
  return mruGraphString(value).trim();
}

/** Round to the 0.1 position precision persisted in graph.json (C1). */
function mruGraphRound10(value) {
  return Math.round(mruGraphNumber(value, 0) * 10) / 10;
}

/** Trim + cap a rename label to the C1 contract (80 characters). */
export function mruGraphCurationLabel(value) {
  const chars = [...mruGraphString(value).trim()];
  return chars.slice(0, MRU_GRAPH_RENAME_MAX).join('');
}

/**
 * Validate and round a canvas/world position for the C1 node upsert:
 * finite `x`/`y` clamped to `[−100000, 100000]` and rounded to 0.1, matching
 * the host sanitizer. Returns `null` when the value cannot be a position.
 *
 * @param {{x?: number, y?: number}} value
 * @returns {{x: number, y: number} | null}
 */
export function mruGraphCurationPosition(value) {
  const point = value !== null && typeof value === 'object' ? value : {};
  // Strict numbers only: the positions come from the layout/simulation (or
  // from JSON) and a coercible string would silently become (0, 0)-ish.
  const x = typeof point.x === 'number' && Number.isFinite(point.x) ? point.x : NaN;
  const y = typeof point.y === 'number' && Number.isFinite(point.y) ? point.y : NaN;
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return {
    x: mruGraphRound10(mruGraphClamp(x, -MRU_GRAPH_POSITION_MAX, MRU_GRAPH_POSITION_MAX)),
    y: mruGraphRound10(mruGraphClamp(y, -MRU_GRAPH_POSITION_MAX, MRU_GRAPH_POSITION_MAX)),
  };
}

/**
 * Build the `onUpdateGraph(patch)` payload for one curation action (C1/C2).
 *
 * - `rename` → `{ nodes: [{ id, label }] }` (label trimmed, capped by C1)
 * - `pin`    → `{ nodes: [{ id, pinned: true, position: { x, y } }] }`
 * - `unpin`  → `{ nodes: [{ id, pinned: false }] }`
 * - `merge`  → `{ merge: [{ from, into }] }`
 *
 * Pure and defensive: invalid input (missing ids, empty label, same-node
 * merge, non-finite position) returns `null` so the component can refuse the
 * action and show a localized error instead of calling the host.
 *
 * @param {'rename'|'pin'|'unpin'|'merge'} action
 * @param {{node?: object|string, id?: string, label?: string,
 *          position?: {x: number, y: number}, from?: object|string,
 *          into?: object|string}} input
 * @returns {object | null}
 */
export function mruGraphCurationPatch(action, input) {
  const data = input !== null && typeof input === 'object' ? input : {};
  const kind = mruGraphString(action).trim().toLowerCase();
  if (kind === 'rename') {
    const id = mruGraphCurationId(data.node !== undefined ? data.node : data.id);
    const label = mruGraphCurationLabel(data.label);
    if (id === '' || label === '') return null;
    return { nodes: [{ id, label }] };
  }
  if (kind === 'pin') {
    const id = mruGraphCurationId(data.node !== undefined ? data.node : data.id);
    const position = mruGraphCurationPosition(data.position);
    if (id === '' || position === null) return null;
    return { nodes: [{ id, pinned: true, position }] };
  }
  if (kind === 'unpin') {
    const id = mruGraphCurationId(data.node !== undefined ? data.node : data.id);
    if (id === '') return null;
    return { nodes: [{ id, pinned: false }] };
  }
  if (kind === 'merge') {
    const from = mruGraphCurationId(data.from !== undefined ? data.from : data.node);
    const into = mruGraphCurationId(data.into !== undefined ? data.into : data.target);
    if (from === '' || into === '' || from === into) return null;
    return { merge: [{ from, into }] };
  }
  return null;
}

/** Whether a persisted node carries a pin (C1: strict boolean `true`). */
export function mruGraphNodeIsPinned(node) {
  return Boolean(node !== null && typeof node === 'object' && node.pinned === true);
}

/**
 * Pin map seeded from persisted `node.pinned` + `node.position` fields when a
 * document graph loads (C1). Only pinned nodes with a valid position are kept;
 * positions are validated/rounded like a curation patch.
 *
 * @param {object[]} nodes normalized KG nodes
 * @returns {Record<string, {x: number, y: number}>}
 */
export function mruGraphStoredPins(nodes) {
  const out = {};
  if (!Array.isArray(nodes)) return out;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!mruGraphNodeIsPinned(node)) continue;
    const id = mruGraphCurationId(node);
    if (id === '' || id === '__proto__') continue;
    const position = mruGraphCurationPosition(node.position);
    if (position === null) continue;
    out[id] = position;
  }
  return out;
}

/**
 * Merge targets for `fromId`: every real (non-cluster) node except the source,
 * in graph order and deduped by id. Empty/unknown input yields `[]`.
 *
 * @param {object[]} nodes visible/normalized KG nodes
 * @param {object|string} fromId source node or its id
 * @returns {object[]}
 */
export function mruGraphMergeCandidates(nodes, fromId) {
  const list = Array.isArray(nodes) ? nodes : [];
  const sourceId = mruGraphCurationId(fromId);
  const seen = new Set();
  const out = [];
  for (let index = 0; index < list.length; index += 1) {
    const node = list[index];
    if (!node || typeof node !== 'object' || node.cluster) continue;
    const id = mruGraphString(node.id).trim();
    if (id === '' || id === sourceId || seen.has(id)) continue;
    seen.add(id);
    out.push(node);
  }
  return out;
}

/** Run `onUpdateGraph(patch)` tolerantly: sync throws become rejections. */
function mruGraphCurationRun(update, patch) {
  if (patch === null || patch === undefined) return Promise.resolve(null);
  if (typeof update !== 'function') return Promise.reject(new Error('graph curation unavailable'));
  try {
    return Promise.resolve(update(patch));
  } catch (error) {
    return Promise.reject(error);
  }
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
  const explicitKeep = mruGraphNumber(opts.collapseKeep, NaN);
  // A caller-provided keep count selects progressive disclosure (top-K kept,
  // the rest folded into type clusters); a bare threshold keeps the legacy
  // "force type collapse" behaviour used by the tests and the toggle.
  const forcedAuto = collapse === 'auto' && Number.isFinite(explicitThreshold)
    && !Number.isFinite(explicitKeep);
  const keepCount = collapse === 'auto'
    ? (Number.isFinite(explicitKeep)
      ? explicitKeep
      : (Number.isFinite(explicitThreshold) ? threshold : MRU_GRAPH_COLLAPSE_KEEP))
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

/**
 * Keep a readable number of relation lines for very dense graphs.
 *
 * All edges incident to the selected node are kept; the rest are ranked by
 * weight, cluster size and endpoint degree so the strongest structure stays
 * visible. Pure and deterministic.
 *
 * @param {object[]} edges visible edges.
 * @param {object[]} nodes visible nodes.
 * @param {string|null} selectedId currently selected node.
 * @param {number} max maximum number of returned edges.
 * @returns {{ edges: object[], total: number, trimmed: boolean }}
 */
export function mruGraphLimitRenderEdges(edges, nodes, selectedId = null, max = MRU_GRAPH_MAX_RENDER_EDGES) {
  const list = Array.isArray(edges) ? edges : []
  const nodeList = Array.isArray(nodes) ? nodes : []
  const limit = Math.max(1, Math.floor(mruGraphNumber(max, MRU_GRAPH_MAX_RENDER_EDGES)))
  if (list.length <= limit) return { edges: list, total: list.length, trimmed: false }
  const nodeById = new Map(nodeList.map((node) => [node.id, node]))
  const degree = new Map()
  for (const edge of list) {
    degree.set(edge.from, (degree.get(edge.from) || 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1)
  }
  const selected = typeof selectedId === 'string' && selectedId !== '' ? selectedId : null
  const pinned = []
  const rest = []
  for (const edge of list) {
    if (selected !== null && (edge.from === selected || edge.to === selected)) pinned.push(edge)
    else rest.push(edge)
  }
  const rankOf = (edge) => {
    const from = nodeById.get(edge.from)
    const to = nodeById.get(edge.to)
    const clusterBonus = (from && from.cluster ? 2 : 0) + (to && to.cluster ? 2 : 0)
    const degreeBonus = (degree.get(edge.from) || 0) + (degree.get(edge.to) || 0)
    return (mruGraphNumber(edge.weight, 1) * 6)
      + (mruGraphNumber(edge.count, 0) * 4)
      + clusterBonus * 2
      + Math.min(60, degreeBonus) * 0.05
  }
  rest.sort((left, right) => rankOf(right) - rankOf(left))
  const keep = Math.max(0, limit - pinned.length)
  const edgesOut = pinned.concat(rest.slice(0, keep))
  return { edges: edgesOut, total: list.length, trimmed: edgesOut.length < list.length }
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

/**
 * Stretch an already-fitted cloud horizontally so a roughly circular force
 * layout still uses the wide canvas instead of leaving empty side margins.
 * Distances along x grow, overlaps are fixed afterwards by the relaxation.
 */
function mruGraphStretchToAspect(xs, ys, width, height, padding) {
  const usableWidth = Math.max(1, width - padding * 2);
  const usableHeight = Math.max(1, height - padding * 2);
  if (xs.length < 2) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < xs.length; i += 1) {
    if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue;
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  if (!(spanX > 1) || !(spanY > 1)) return;
  const canvasAspect = usableWidth / usableHeight;
  const cloudAspect = spanX / spanY;
  if (cloudAspect >= canvasAspect * 0.92) return;
  const factor = mruGraphClamp(canvasAspect / cloudAspect, 1, 1.85);
  const centerX = width / 2;
  for (let i = 0; i < xs.length; i += 1) {
    xs[i] = mruGraphClamp(centerX + (xs[i] - centerX) * factor, padding, width - padding);
  }
}

/** Round to two decimals so equivalent layouts compare cleanly. */
function mruGraphRound(value) {
  return Math.round(mruGraphNumber(value, 0) * 100) / 100;
}

/** Minimum centre distance for a node count/canvas (also used by tests). */
export function mruGraphNodeSeparation(width, height, count, padding = 0) {
  const usableWidth = Math.max(1, mruGraphNumber(width, 0) - padding * 2);
  const usableHeight = Math.max(1, mruGraphNumber(height, 0) - padding * 2);
  const countSafe = Math.max(1, mruGraphNumber(count, 1));
  const ideal = Math.sqrt((usableWidth * usableHeight) / countSafe);
  return mruGraphClamp(ideal * 0.52, 24, 66);
}

/**
 * Push overlapping nodes apart until most pairs respect `minSeparation`.
 *
 * A cheap, deterministic position-based relaxation: unlike a force field it
 * cannot be overpowered by edge attraction, so a dense graph unfolds into an
 * even sheet instead of collapsing into one blob. Pairs closer than the
 * separation are split symmetrically; fixed nodes keep their position and
 * push the other side only. Runs after the force pass in final canvas pixels.
 *
 * @param {Float64Array} xs - x coordinates (mutated).
 * @param {Float64Array} ys - y coordinates (mutated).
 * @param {Uint8Array} fixed - 1 when the node must not move.
 * @param {number} width canvas width.
 * @param {number} height canvas height.
 * @param {number} padding canvas padding.
 * @param {number} minSeparation desired centre distance.
 * @param {number} iterations relaxation rounds.
 * @returns {void}
 */
function mruGraphRelaxOverlaps(xs, ys, fixed, width, height, padding, minSeparation, iterations) {
  const count = xs.length;
  const separation = Math.max(16, mruGraphNumber(minSeparation, 40));
  const minX = padding;
  const maxX = Math.max(minX, width - padding);
  const minY = padding;
  const maxY = Math.max(minY, height - padding);
  let maxMotion = 0;
  for (let round = 0; round < iterations; round += 1) {
    maxMotion = 0;
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        const dxRaw = xs[j] - xs[i];
        const dyRaw = ys[j] - ys[i];
        const distanceSquared = dxRaw * dxRaw + dyRaw * dyRaw;
        if (distanceSquared >= separation * separation) continue;
        let dx = dxRaw;
        let dy = dyRaw;
        let distance = Math.sqrt(distanceSquared);
        if (distance < 1e-6) {
          const angle = ((i + 1) * 2.399963229728653 + (j + 2) * 0.61803398875) % (Math.PI * 2);
          dx = Math.cos(angle);
          dy = Math.sin(angle);
          distance = 1;
        } else {
          dx /= distance;
          dy /= distance;
        }
        const overlap = separation - (distance < 1e-6 ? 0 : Math.sqrt(distanceSquared));
        const active = (fixed[i] ? 0 : 1) + (fixed[j] ? 0 : 1);
        if (active === 0) continue;
        const step = (overlap * (round < iterations * 0.6 ? 0.9 : 0.55)) / active;
        if (!Number.isFinite(step) || step <= 0) continue;
        if (!fixed[i]) {
          xs[i] = mruGraphClamp(xs[i] - dx * step, minX, maxX);
          ys[i] = mruGraphClamp(ys[i] - dy * step, minY, maxY);
        }
        if (!fixed[j]) {
          xs[j] = mruGraphClamp(xs[j] + dx * step, minX, maxX);
          ys[j] = mruGraphClamp(ys[j] + dy * step, minY, maxY);
        }
        if (step > maxMotion) maxMotion = step;
      }
    }
    if (maxMotion < 0.12) break;
  }
}

/**
 * Deterministic seeded force layout.
 *
 * Repulsion is the dominant force (FR k²/d boosted, plus a hard collision
 * term), edge attraction is damped and normalised by node degree, and a
 * position-based overlap relaxation runs after the canvas fit. The result is
 * a sheet of evenly spaced nodes instead of one dense blob.
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
 *   and kept verbatim, even outside the layout sheet (infinite canvas).
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
    const pinnedPoint = pinned[node.id];
    // Frozen/previously laid out nodes are anchored to their exact world
    // coordinates: on an infinite canvas a node dragged outside the layout
    // sheet must not snap back when the graph is filtered, rebuilt or refreshed.
    const anchored = Boolean(pinnedPoint) || (Boolean(previousPoint) && freezePrevious);
    if (anchored) {
      const point = pinnedPoint || previousPoint;
      xs[i] = mruGraphNumber(point.x, width / 2);
      ys[i] = mruGraphNumber(point.y, height / 2);
      fixed[i] = 1;
    } else {
      const initial = previousPoint || mruGraphInitialPoint(i, count, width, height, rand);
      xs[i] = mruGraphClamp(mruGraphNumber(initial.x, width / 2), padding, width - padding);
      ys[i] = mruGraphClamp(mruGraphNumber(initial.y, height / 2), padding, height - padding);
    }
  }

  let links = [];
  const degrees = new Float64Array(count);
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i];
    const a = indexById.get(edge.from);
    const b = indexById.get(edge.to);
    if (a === undefined || b === undefined || a === b) continue;
    const weight = Math.max(0.01, mruGraphNumber(edge.weight, 1));
    links.push({ a, b, weight });
    degrees[a] += weight;
    degrees[b] += weight;
  }
  // Dense library graphs (topic webs can be near-complete) would overpower
  // repulsion with thousands of springs. Keep the full edge list for output,
  // but attract along a deterministic sample capped at ~5n springs.
  let attractionLinks = links;
  if (links.length > count * 5) {
    const stride = Math.ceil(links.length / (count * 5));
    attractionLinks = links.filter((_, index) => index % stride === 0);
  }

  const defaultIterations = count > 240 ? 90 : count > 120 ? 120 : 160;
  const requestedIterations = mruGraphNumber(opts.iterations, defaultIterations);
  const iterations = mruGraphClamp(Math.round(requestedIterations), 0, 600);
  const centerX = width / 2;
  const centerY = height / 2;
  const usableWidth = width - padding * 2;
  const usableHeight = height - padding * 2;
  const k = Math.sqrt((usableWidth * usableHeight) / Math.max(1, count)) * 0.66;
  const kSquared = k * k;
  // A hard floor keeps labels/dots from stacking even when edges are dense.
  const collision = mruGraphNodeSeparation(width, height, count, padding);
  const collisionSquared = collision * collision;
  // Attraction is damped and degree-normalised so hubs do not pull their whole
  // neighbourhood into a ball; central gravity is only a gentle tether.
  const attractionScale = 0.4;
  const gravity = 0.0035;
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
        let force = (kSquared / distance) * 1.18;
        if (distanceSquared < collisionSquared) {
          const overlap = collision - distance;
          force += overlap * overlap * 0.55;
        }
        const ux = deltaX / distance;
        const uy = deltaY / distance;
        dx[i] -= ux * force;
        dy[i] -= uy * force;
        dx[j] += ux * force;
        dy[j] += uy * force;
      }
    }

    // Attraction along links (FR d²/k), weighted by edge importance.
    for (let i = 0; i < attractionLinks.length; i += 1) {
      const link = attractionLinks[i];
      let deltaX = xs[link.b] - xs[link.a];
      let deltaY = ys[link.b] - ys[link.a];
      let distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
      if (distance < 1e-6) {
        const angle = ((link.a + 1) * 2.399963229728653 + (link.b + 2) * 0.61803398875) % (Math.PI * 2);
        deltaX = Math.cos(angle) * 0.01;
        deltaY = Math.sin(angle) * 0.01;
        distance = 0.01;
      }
      const degreeScale = 1 / Math.max(1, Math.sqrt(Math.max(1, degrees[link.a]) * Math.max(1, degrees[link.b])));
      const force = (distance * distance / k)
        * attractionScale
        * Math.min(2.2, 0.6 + link.weight * 0.35)
        * Math.max(0.3, Math.min(1.3, degreeScale * 2.4));
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
      let moveX = dx[i] + (centerX - xs[i]) * gravity;
      let moveY = dy[i] + (centerY - ys[i]) * gravity;
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
    // Seed-dependent orientation first (rigid, distance-preserving), then fit
    // the cloud to the canvas and only then spread overlaps — clamping after
    // the relaxation would squeeze nodes back together at the borders.
    const angle = ((seed % 360) / 180) * Math.PI;
    if (angle > 1e-6) {
      const cx = width / 2;
      const cy = height / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      for (let i = 0; i < count; i += 1) {
        const dx = xs[i] - cx;
        const dy = ys[i] - cy;
        xs[i] = cx + dx * cos - dy * sin;
        ys[i] = cy + dx * sin + dy * cos;
      }
    }
    mruGraphFitPositions(xs, ys, width, height, padding);
    mruGraphStretchToAspect(xs, ys, width, height, padding);
    // Spread overlapping dots after fitting: this is what turns a tight
    // centre blob into an even sheet on sparse/hub-heavy graphs.
    mruGraphRelaxOverlaps(xs, ys, fixed, width, height, padding, collision, 90);
  } else {
    // Incremental refresh: keep previously laid-out nodes (fixed) but spread
    // the newly arrived ones instead of stacking them on top of each other.
    mruGraphRelaxOverlaps(xs, ys, fixed, width, height, padding, collision, 50);
  }

  const positions = {};
  for (let i = 0; i < count; i += 1) {
    const node = nodes[i];
    positions[node.id] = {
      // Anchored nodes keep their exact world position (possibly far outside
      // the layout sheet); newly laid-out nodes stay on the sheet.
      x: mruGraphRound(fixed[i] ? xs[i] : mruGraphClamp(xs[i], padding, width - padding)),
      y: mruGraphRound(fixed[i] ? ys[i] : mruGraphClamp(ys[i], padding, height - padding)),
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

/* -------------------------------------------------------------------------- */
/* Interactive force simulation (dragging a node moves its neighbours)        */
/* -------------------------------------------------------------------------- */

/** Tuning constants for the live drag simulation (velocity units are px/s). */
const MRU_GRAPH_SIM_REPULSION = 5200;
const MRU_GRAPH_SIM_DRAG_BOOST = 2.2;
const MRU_GRAPH_SIM_SPRING = 5.2;
const MRU_GRAPH_SIM_COLLISION = 26;
const MRU_GRAPH_SIM_GRAVITY = 0.5;
const MRU_GRAPH_SIM_DAMPING = 4.2;
const MRU_GRAPH_SIM_MAX_SPEED = 1100;

/**
 * Advance one deterministic step of the interactive force simulation.
 *
 * While the user drags a node, every other node is subject to:
 *  - pairwise repulsion that grows as nodes get close (so a dragged node
 *    pushes nearby nodes away instead of passing through them),
 *  - spring attraction along graph edges (connected nodes follow the drag),
 *  - a hard collision floor, a very soft centre pull (bounded mode only) and
 *    velocity damping.
 *
 * The dragged node follows its target exactly; pinned nodes never move.
 * With `bounds: false` positions are not clamped to the layout sheet, so a
 * node can be dragged out into the infinite canvas and its neighbours follow.
 * Pure: input positions/velocities are not mutated.
 *
 * @param {{
 *   nodes: object[],
 *   links: Array<{from: string, to: string, weight?: number}>,
 *   positions: Record<string, {x: number, y: number}>,
 *   velocities?: Record<string, {x: number, y: number}>,
 *   dragged?: {id: string, x: number, y: number} | null,
 *   pinned?: string[],
 *   width?: number,
 *   height?: number,
 *   padding?: number,
 *   bounds?: boolean,
 *   dt?: number,
 * }} input
 * @returns {{
 *   positions: Record<string, {x: number, y: number}>,
 *   velocities: Record<string, {x: number, y: number}>,
 *   maxSpeed: number,
 * }} next positions, velocities and the fastest node speed.
 */
export function mruGraphSimulationStep(input) {
  const data = input !== null && typeof input === 'object' ? input : {};
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const links = Array.isArray(data.links) ? data.links : [];
  const positionsIn = data.positions !== null && typeof data.positions === 'object' ? data.positions : {};
  const velocitiesIn = data.velocities !== null && typeof data.velocities === 'object' ? data.velocities : {};
  const count = nodes.length;
  const width = Math.max(160, mruGraphNumber(data.width, MRU_GRAPH_CANVAS_WIDTH));
  const height = Math.max(120, mruGraphNumber(data.height, MRU_GRAPH_CANVAS_HEIGHT));
  const padding = Math.max(0, mruGraphNumber(data.padding, MRU_GRAPH_CANVAS_PADDING));
  const bounded = data.bounds !== false;
  const dt = mruGraphClamp(mruGraphNumber(data.dt, 1 / 60), 1 / 240, 1 / 20);
  const separation = mruGraphNodeSeparation(width, height, count, padding);
  const radius = Math.max(170, separation * 3.4);
  const dragged = data.dragged !== null && typeof data.dragged === 'object'
    && typeof data.dragged.id === 'string'
    ? data.dragged
    : null;
  const pinned = new Set(Array.isArray(data.pinned) ? data.pinned.filter((id) => typeof id === 'string') : []);
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const draggedIndex = dragged !== null ? (indexById.get(dragged.id) ?? -1) : -1;

  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const vx = new Float64Array(count);
  const vy = new Float64Array(count);
  const ax = new Float64Array(count);
  const ay = new Float64Array(count);
  const fixed = new Uint8Array(count);
  const minX = bounded ? padding : -Infinity;
  const maxX = bounded ? Math.max(minX, width - padding) : Infinity;
  const minY = bounded ? padding : -Infinity;
  const maxY = bounded ? Math.max(minY, height - padding) : Infinity;
  for (let index = 0; index < count; index += 1) {
    const node = nodes[index];
    const point = positionsIn[node.id];
    xs[index] = mruGraphClamp(mruGraphNumber(point?.x, width / 2), minX, maxX);
    ys[index] = mruGraphClamp(mruGraphNumber(point?.y, height / 2), minY, maxY);
    const velocity = velocitiesIn[node.id];
    vx[index] = mruGraphNumber(velocity?.x, 0);
    vy[index] = mruGraphNumber(velocity?.y, 0);
    if (pinned.has(node.id) && index !== draggedIndex) fixed[index] = 1;
  }

  // Pairwise repulsion (+ hard collision floor) — the core of the dynamic feel.
  for (let left = 0; left < count; left += 1) {
    for (let right = left + 1; right < count; right += 1) {
      let deltaX = xs[right] - xs[left];
      let deltaY = ys[right] - ys[left];
      let distance = Math.sqrt((deltaX * deltaX) + (deltaY * deltaY));
      if (distance < 1e-3) {
        const angle = ((left + 1) * 2.399963229728653 + (right + 2) * 0.61803398875) % (Math.PI * 2);
        deltaX = Math.cos(angle) * 0.01;
        deltaY = Math.sin(angle) * 0.01;
        distance = 0.01;
      }
      const boost = (left === draggedIndex || right === draggedIndex) ? MRU_GRAPH_SIM_DRAG_BOOST : 1;
      const ux = deltaX / distance;
      const uy = deltaY / distance;
      let force = 0;
      if (distance < radius) {
        const falloff = 1 - (distance / radius);
        const proximity = (separation * 1.1) / (distance + (separation * 0.35));
        force += MRU_GRAPH_SIM_REPULSION * boost * falloff * proximity * proximity;
      }
      if (distance < separation * 0.86) {
        force += MRU_GRAPH_SIM_COLLISION * (separation - distance);
      }
      if (force <= 0) continue;
      if (fixed[left] === 0) {
        ax[left] -= ux * force;
        ay[left] -= uy * force;
      }
      if (fixed[right] === 0) {
        ax[right] += ux * force;
        ay[right] += uy * force;
      }
    }
  }

  // Springs along edges: connected nodes follow the dragged node.
  for (const link of links) {
    const left = indexById.get(link.from);
    const right = indexById.get(link.to);
    if (left === undefined || right === undefined || left === right) continue;
    let deltaX = xs[right] - xs[left];
    let deltaY = ys[right] - ys[left];
    let distance = Math.sqrt((deltaX * deltaX) + (deltaY * deltaY));
    if (distance < 1e-3) {
      const angle = ((left + 1) * 2.399963229728653 + (right + 2) * 0.61803398875) % (Math.PI * 2);
      deltaX = Math.cos(angle) * 0.01;
      deltaY = Math.sin(angle) * 0.01;
      distance = 0.01;
    }
    const rest = separation * 0.92;
    const stretch = mruGraphClamp(distance - rest, -separation, separation * 2.4);
    const weight = Math.max(0.2, mruGraphNumber(link.weight, 1));
    const force = MRU_GRAPH_SIM_SPRING * stretch * Math.min(1.6, 0.6 + (weight * 0.4));
    const ux = deltaX / distance;
    const uy = deltaY / distance;
    if (fixed[left] === 0) {
      ax[left] += ux * force;
      ay[left] += uy * force;
    }
    if (fixed[right] === 0) {
      ax[right] -= ux * force;
      ay[right] -= uy * force;
    }
  }

  // Soft centre tether + integration (semi-implicit Euler with exponential
  // damping). Unbounded mode has no centre: pulling free nodes back to the
  // layout sheet would make a far-dragged cluster snap home on release.
  const damping = Math.exp(-MRU_GRAPH_SIM_DAMPING * dt);
  const centerX = width / 2;
  const centerY = height / 2;
  let maxSpeed = 0;
  const nextPositions = {};
  const nextVelocities = {};
  for (let index = 0; index < count; index += 1) {
    const node = nodes[index];
    if (index === draggedIndex) {
      const targetX = mruGraphClamp(mruGraphNumber(dragged.x, xs[index]), minX, maxX);
      const targetY = mruGraphClamp(mruGraphNumber(dragged.y, ys[index]), minY, maxY);
      xs[index] = targetX;
      ys[index] = targetY;
      vx[index] = 0;
      vy[index] = 0;
    } else if (fixed[index] === 0) {
      vx[index] = (vx[index] + (ax[index] * dt)) * damping;
      vy[index] = (vy[index] + (ay[index] * dt)) * damping;
      if (bounded) {
        vx[index] += (centerX - xs[index]) * MRU_GRAPH_SIM_GRAVITY * dt;
        vy[index] += (centerY - ys[index]) * MRU_GRAPH_SIM_GRAVITY * dt;
      }
      const speed = Math.sqrt((vx[index] * vx[index]) + (vy[index] * vy[index]));
      if (speed > MRU_GRAPH_SIM_MAX_SPEED) {
        const scale = MRU_GRAPH_SIM_MAX_SPEED / speed;
        vx[index] *= scale;
        vy[index] *= scale;
      }
      if (Number.isFinite(vx[index]) && Number.isFinite(vy[index])) {
        xs[index] = mruGraphClamp(xs[index] + (vx[index] * dt), minX, maxX);
        ys[index] = mruGraphClamp(ys[index] + (vy[index] * dt), minY, maxY);
      } else {
        vx[index] = 0;
        vy[index] = 0;
      }
    } else {
      vx[index] = 0;
      vy[index] = 0;
    }
    const speed = Math.sqrt((vx[index] * vx[index]) + (vy[index] * vy[index]));
    if (speed > maxSpeed) maxSpeed = speed;
    nextPositions[node.id] = { x: mruGraphRound(xs[index]), y: mruGraphRound(ys[index]) };
    nextVelocities[node.id] = { x: mruGraphRound(vx[index]), y: mruGraphRound(vy[index]) };
  }
  return { positions: nextPositions, velocities: nextVelocities, maxSpeed: mruGraphRound(maxSpeed) };
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
// 6b. Infinite-canvas camera (world ⇄ screen)
// ===========================================================================

/**
 * A camera is `{x, y, k}`: `screen = world * k + (x, y)`. Screen coordinates
 * are the SVG viewBox / CSS pixels of the canvas element (the viewBox mirrors
 * the measured element size, so no fixed 1000×680 window exists at render
 * time). Panning is unbounded on purpose — that is what makes the canvas
 * infinite — while zoom stays within [MIN_ZOOM, MAX_ZOOM] for usability.
 */

/** Canvas size fallback used until the DOM element has been measured. */
function mruGraphViewportOrFallback(viewport) {
  const source = viewport && typeof viewport === 'object' ? viewport : {};
  return {
    width: Math.max(1, mruGraphNumber(source.width, MRU_GRAPH_CANVAS_WIDTH)),
    height: Math.max(1, mruGraphNumber(source.height, MRU_GRAPH_CANVAS_HEIGHT)),
  };
}

/** Coerce any camera-like value to finite numbers inside the zoom limits. */
function mruGraphCamera(view) {
  const source = view && typeof view === 'object' ? view : {};
  return {
    x: mruGraphNumber(source.x, 0),
    y: mruGraphNumber(source.y, 0),
    k: mruGraphClamp(mruGraphNumber(source.k, 1), MRU_GRAPH_MIN_ZOOM, MRU_GRAPH_MAX_ZOOM),
  };
}

/** Pan the camera by a screen-space delta. Deliberately unbounded. */
export function mruGraphCameraPan(view, deltaX, deltaY) {
  const camera = mruGraphCamera(view);
  return {
    k: camera.k,
    x: camera.x + mruGraphNumber(deltaX, 0),
    y: camera.y + mruGraphNumber(deltaY, 0),
  };
}

/**
 * Zoom to `nextK` while keeping the world point under `anchor` fixed.
 * `anchor` is in screen pixels (viewBox coordinates of the canvas element).
 */
export function mruGraphCameraZoom(view, nextK, anchorX, anchorY) {
  const camera = mruGraphCamera(view);
  const k = mruGraphClamp(mruGraphNumber(nextK, camera.k), MRU_GRAPH_MIN_ZOOM, MRU_GRAPH_MAX_ZOOM);
  const ax = mruGraphNumber(anchorX, 0);
  const ay = mruGraphNumber(anchorY, 0);
  const worldX = (ax - camera.x) / camera.k;
  const worldY = (ay - camera.y) / camera.k;
  return { k, x: ax - worldX * k, y: ay - worldY * k };
}

/** Screen point of a world point. */
export function mruGraphWorldToScreen(point, view) {
  const camera = mruGraphCamera(view);
  const x = mruGraphNumber(point && point.x, 0);
  const y = mruGraphNumber(point && point.y, 0);
  return { x: x * camera.k + camera.x, y: y * camera.k + camera.y };
}

/** World point under a screen point. */
export function mruGraphScreenToWorld(point, view) {
  const camera = mruGraphCamera(view);
  return {
    x: (mruGraphNumber(point && point.x, 0) - camera.x) / camera.k,
    y: (mruGraphNumber(point && point.y, 0) - camera.y) / camera.k,
  };
}

/**
 * Camera that centres a set of node positions inside a viewport, scaled to fit
 * with `padding` screen pixels of breathing room plus a world-space `margin`
 * for node labels. The resulting zoom is capped at `maxZoom` so a tiny graph
 * is not blown up; it is clamped to the global zoom limits so a graph whose
 * nodes were dragged far outside the layout sheet can still be fitted.
 *
 * @param {object|Map|Array} positions node positions by id (or a list/map)
 * @param {{width: number, height: number}} viewport canvas CSS pixel size
 * @param {{padding?: number, margin?: number, maxZoom?: number, minZoom?: number}} [options]
 * @returns {{x: number, y: number, k: number}}
 */
export function mruGraphFitView(positions, viewport, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const size = mruGraphViewportOrFallback(viewport);
  const padding = mruGraphClamp(
    mruGraphNumber(opts.padding, MRU_GRAPH_FIT_PADDING),
    0,
    Math.max(0, Math.min(size.width, size.height) / 3),
  );
  const margin = Math.max(0, mruGraphNumber(opts.margin, MRU_GRAPH_FIT_MARGIN));
  const maxZoom = mruGraphClamp(
    mruGraphNumber(opts.maxZoom, MRU_GRAPH_FIT_MAX_ZOOM),
    MRU_GRAPH_MIN_ZOOM,
    MRU_GRAPH_MAX_ZOOM,
  );
  const minZoom = mruGraphClamp(
    mruGraphNumber(opts.minZoom, MRU_GRAPH_MIN_ZOOM),
    MRU_GRAPH_MIN_ZOOM,
    MRU_GRAPH_MAX_ZOOM,
  );
  const lookup = mruGraphPositionLookup(positions);
  const ids = Object.keys(lookup);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ids.length; i += 1) {
    const point = lookup[ids[i]];
    if (!point) continue;
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { x: mruGraphRound(size.width / 2), y: mruGraphRound(size.height / 2), k: 1 };
  }
  const spanX = Math.max(1, (maxX - minX) + margin * 2);
  const spanY = Math.max(1, (maxY - minY) + margin * 2);
  const usableWidth = Math.max(1, size.width - padding * 2);
  const usableHeight = Math.max(1, size.height - padding * 2);
  const rawZoom = Math.min(usableWidth / spanX, usableHeight / spanY);
  const k = mruGraphClamp(Number.isFinite(rawZoom) ? rawZoom : 1, minZoom, maxZoom);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    x: mruGraphRound(size.width / 2 - centerX * k),
    y: mruGraphRound(size.height / 2 - centerY * k),
    k: mruGraphRound(k),
  };
}

/** Whether at least one node position is visible inside the viewport. */
export function mruGraphViewShowsAny(positions, view, viewport, margin) {
  const size = mruGraphViewportOrFallback(viewport);
  const pad = Math.max(0, mruGraphNumber(margin, 0));
  const lookup = mruGraphPositionLookup(positions);
  const ids = Object.keys(lookup);
  for (let i = 0; i < ids.length; i += 1) {
    const screen = mruGraphWorldToScreen(lookup[ids[i]], view);
    if (screen.x >= -pad && screen.x <= size.width + pad
      && screen.y >= -pad && screen.y <= size.height + pad) {
      return true;
    }
  }
  return false;
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

/**
 * Map a pointer event to the canvas' viewBox space (CSS pixels of the element).
 * The viewBox mirrors the measured element size, so this only needs to undo
 * the rounding-level preserveAspectRatio letterboxing of the SVG element.
 */
function mruGraphEventViewPoint(event, svg, viewport) {
  try {
    if (!svg || typeof svg.getBoundingClientRect !== 'function') return null;
    const rect = svg.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const size = mruGraphViewportOrFallback(viewport);
    const scale = Math.min(rect.width / size.width, rect.height / size.height);
    if (!Number.isFinite(scale) || scale <= 0) return null;
    const offsetX = (rect.width - size.width * scale) / 2;
    const offsetY = (rect.height - size.height * scale) / 2;
    const clientX = mruGraphNumber(event && event.clientX, rect.left + rect.width / 2);
    const clientY = mruGraphNumber(event && event.clientY, rect.top + rect.height / 2);
    return { x: (clientX - rect.left - offsetX) / scale, y: (clientY - rect.top - offsetY) / scale };
  } catch {
    return null;
  }
}

/** World-space point from a pointer event (undoes the camera transform). */
function mruGraphEventWorldPoint(event, svg, view, viewport) {
  const point = mruGraphEventViewPoint(event, svg, viewport);
  if (!point) {
    const size = mruGraphViewportOrFallback(viewport);
    return mruGraphScreenToWorld({ x: size.width / 2, y: size.height / 2 }, view);
  }
  return mruGraphScreenToWorld(point, view);
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
 *   onUpdateGraph(patch)?
 *
 * `onUpdateGraph` is the C2 curation hook: doc mode only. It receives
 * `{ nodes: [...] }` / `{ merge: [{ from, into }] }` patches and returns a
 * Promise that resolves to the persisted KG (or rejects on failure). When the
 * prop is missing the view stays read-only — library graphs are never edited.
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
    onUpdateGraph,
  } = rawProps;

  const mode = rawMode === 'library' ? 'library' : 'doc';
  const building = rawBuilding === true;
  const loading = rawLoading === true;
  const available = rawAvailable !== false;
  const error = mruGraphString(rawError).trim();
  const t = typeof translate === 'function' ? translate : null;
  const tr = (key, params) => mruGraphText(t, key, params);
  const initialCollapse = mode === 'library' ? 'auto' : 'none';
  const canCurate = mode === 'doc' && typeof onUpdateGraph === 'function';

  const [selectedId, setSelectedId] = React.useState(null);
  const [query, setQuery] = React.useState('');
  const [typeFilter, setTypeFilter] = React.useState(null);
  const [collapseMode, setCollapseMode] = React.useState(initialCollapse);
  const [view, setView] = React.useState({ x: 0, y: 0, k: 1 });
  const [pins, setPins] = React.useState({});
  const [hoverEdgeId, setHoverEdgeId] = React.useState(null);
  const [cardPos, setCardPos] = React.useState(null);
  // Curation state (PLAN C1/C2): inline rename, 2-step merge, pin save.
  const [renameDraft, setRenameDraft] = React.useState(null);
  const [mergeFromId, setMergeFromId] = React.useState(null);
  const [mergeTargetId, setMergeTargetId] = React.useState(null);
  const [curationPending, setCurationPending] = React.useState(null);
  const [curationError, setCurationError] = React.useState('');
  const [curationNotice, setCurationNotice] = React.useState('');
  // Infinite canvas: the element's measured CSS size becomes the SVG viewBox,
  // so world coordinates are real screen pixels and the camera can move freely.
  const [viewport, setViewport] = React.useState(null);
  const [viewDirty, setViewDirty] = React.useState(false);

  const svgRef = React.useRef(null);
  const rootRef = React.useRef(null);
  const cardRef = React.useRef(null);
  const nodeRefs = React.useRef({});
  const pinsRef = React.useRef({});
  const layoutCacheRef = React.useRef(null);
  const panRef = React.useRef(null);
  const dragRef = React.useRef(null);
  const liveRef = React.useRef(null);
  const rafRef = React.useRef(0);
  const mountedRef = React.useRef(true);
  const updateGraphRef = React.useRef(null);
  const curationPendingRef = React.useRef(null);
  const pendingPinRef = React.useRef(null);
  const previousViewportRef = React.useRef(null);
  const fittedKeyRef = React.useRef('');
  const lastLayoutSignatureRef = React.useRef('');
  const [livePositions, setLivePositions] = React.useState(null);

  pinsRef.current = pins;
  updateGraphRef.current = canCurate ? onUpdateGraph : null;
  React.useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  /** Mirror the pending flag into state + ref (the ref guards stale closures). */
  const markCurationPending = (kind) => {
    curationPendingRef.current = kind;
    setCurationPending(kind);
  };

  /** Apply one validated curation patch, surfacing failures inline (C2). */
  const runCuration = (kind, patch, handlers) => {
    const update = updateGraphRef.current;
    const options = handlers !== null && typeof handlers === 'object' ? handlers : {};
    if (typeof update !== 'function' || patch === null || curationPendingRef.current !== null) {
      return false;
    }
    markCurationPending(kind);
    setCurationError('');
    setCurationNotice('');
    mruGraphCurationRun(update, patch).then(
      () => {
        curationPendingRef.current = null;
        if (mountedRef.current === false) return;
        setCurationPending(null);
        if (typeof options.success === 'function') options.success();
      },
      () => {
        curationPendingRef.current = null;
        if (mountedRef.current === false) return;
        setCurationPending(null);
        if (typeof options.error === 'function') options.error();
      },
    );
    return true;
  };

  /** Write one local pin (null removes it), keeping the ref in sync. */
  const writePin = (id, position) => {
    if (typeof id !== 'string' || id === '') return;
    const next = { ...pinsRef.current };
    if (position === null || position === undefined) delete next[id];
    else next[id] = position;
    pinsRef.current = next;
    setPins(next);
  };

  const normalized = React.useMemo(() => mruGraphNormalizeGraph(rawGraph), [rawGraph]);
  const signature = React.useMemo(() => mruGraphSignature(normalized), [normalized]);

  // Persisted `node.pinned` + `node.position` fields seed the local pin map
  // when a document graph loads (C1); library graphs stay read-only.
  const storedPins = React.useMemo(() => mruGraphStoredPins(normalized.nodes), [normalized]);
  const storedPinKey = React.useMemo(() => JSON.stringify(storedPins), [storedPins]);
  React.useEffect(() => {
    if (mode !== 'doc') return;
    pinsRef.current = storedPins;
    setPins(storedPins);
  }, [storedPinKey, mode, storedPins]);

  const visible = React.useMemo(() => mruGraphVisibleGraph(normalized, {
    types: typeFilter,
    query,
    collapse: collapseMode,
    ...(mode === 'library'
      ? {
        collapseThreshold: MRU_GRAPH_LIBRARY_COLLAPSE_THRESHOLD,
        collapseKeep: MRU_GRAPH_LIBRARY_COLLAPSE_KEEP,
      }
      : null),
  }), [normalized, typeFilter, query, collapseMode, mode]);

  const mergeCandidateIds = React.useMemo(() => {
    if (!canCurate || mergeFromId === null) return new Set();
    return new Set(mruGraphMergeCandidates(visible.nodes, mergeFromId).map((node) => node.id));
  }, [canCurate, visible, mergeFromId]);

  // Lay out exactly the visible subgraph: folded-in clusters get real positions
  // (instead of falling back to the canvas centre) and hidden nodes stop
  // occupying space, so a collapsed library graph reads as a clean map.
  const layoutSignature = React.useMemo(() => (
    `${signature}|${visible.nodes.map((node) => node.id).join(',')}|${visible.edges.length}`
  ), [signature, visible]);

  const layout = React.useMemo(() => {
    const cache = layoutCacheRef.current;
    if (cache && cache.signature === layoutSignature) return cache.layout;
    const next = mruGraphLayoutGraph({ nodes: visible.nodes, edges: visible.edges }, {
      width: MRU_GRAPH_CANVAS_WIDTH,
      height: MRU_GRAPH_CANVAS_HEIGHT,
      seed: MRU_GRAPH_DEFAULT_SEED,
      previous: cache && cache.layout ? cache.layout.positions : null,
      pinned: pinsRef.current,
    });
    layoutCacheRef.current = { signature: layoutSignature, layout: next };
    return next;
  }, [layoutSignature, visible]);

  // A filter/collapse change replaces the visible subgraph and its layout:
  // freeze any running simulation into the previous cache before that happens.
  React.useEffect(() => {
    return () => {
      if (liveRef.current !== null) persistSimulation();
    };
  }, [layoutSignature]);

  const types = React.useMemo(() => mruGraphOrderedTypes(normalized.nodes), [normalized]);
  const degree = React.useMemo(() => mruGraphDegrees(visible.nodes, visible.edges), [visible]);

  const positions = React.useMemo(() => {
    const out = {};
    const base = layout.positions || {};
    const live = livePositions !== null && typeof livePositions === 'object' ? livePositions : null;
    for (let i = 0; i < visible.nodes.length; i += 1) {
      const node = visible.nodes[i];
      const livePoint = live !== null ? live[node.id] : undefined;
      const point = livePoint || pins[node.id] || base[node.id];
      out[node.id] = point && Number.isFinite(point.x) && Number.isFinite(point.y)
        ? { x: point.x, y: point.y }
        : mruGraphFallbackPoint(node.id, i);
    }
    return out;
  }, [visible, layout, pins, livePositions]);

  // Very dense graphs get a focused relation layer; the full edge set still
  // powers neighbour lists and highlights.
  const renderEdges = React.useMemo(() => (
    mruGraphLimitRenderEdges(visible.edges, visible.nodes, selectedId)
  ), [visible, selectedId]);

  /** Cancel the requestAnimationFrame loop (idempotent). */
  const stopSimulationLoop = () => {
    if (rafRef.current !== 0 && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = 0;
  };

  /**
   * Freeze the live simulation: write the settled coordinates into the layout
   * cache (so a re-render does not snap nodes back) and pin the dragged node
   * exactly like a normal drag release.
   */
  const persistSimulation = () => {
    const sim = liveRef.current;
    if (sim === null) return;
    const cache = layoutCacheRef.current;
    if (cache && cache.layout && cache.layout.positions) {
      for (const [id, point] of Object.entries(sim.positions)) {
        cache.layout.positions[id] = { x: point.x, y: point.y };
      }
    }
    const draggedPoint = sim.positions[sim.draggedId];
    if (draggedPoint !== undefined) {
      const pinned = mruGraphCurationPosition(draggedPoint) || { x: draggedPoint.x, y: draggedPoint.y };
      pinsRef.current = { ...pinsRef.current, [sim.draggedId]: pinned };
      setPins((previous) => ({ ...previous, [sim.draggedId]: pinned }));
    }
    if (pendingPinRef.current !== null) {
      // A drag release persists its pin when curation is available (C1).
      const releasedId = pendingPinRef.current;
      pendingPinRef.current = null;
      const releasedPosition = mruGraphCurationPosition(sim.positions[releasedId]);
      if (releasedId === sim.draggedId && releasedPosition !== null) {
        const patch = mruGraphCurationPatch('pin', { node: releasedId, position: releasedPosition });
        if (patch !== null) {
          runCuration('pin', patch, {
            error: () => setCurationError(tr('graph.pinFailed')),
          });
        }
      }
    }
    liveRef.current = null;
    stopSimulationLoop();
    setLivePositions(null);
  };

  /** Advance the simulation `steps` times and publish positions for render. */
  const pumpSimulation = (steps) => {
    const sim = liveRef.current;
    if (sim === null) return { maxSpeed: 0 };
    let positions = sim.positions;
    let velocities = sim.velocities;
    let maxSpeed = 0;
    for (let index = 0; index < steps; index += 1) {
      const next = mruGraphSimulationStep({
        nodes: sim.nodes,
        links: sim.links,
        positions,
        velocities,
        dragged: sim.dragged,
        pinned: sim.pinned,
        width: MRU_GRAPH_CANVAS_WIDTH,
        height: MRU_GRAPH_CANVAS_HEIGHT,
        padding: MRU_GRAPH_CANVAS_PADDING,
        // Infinite canvas: neighbours follow the drag out of the layout sheet.
        bounds: false,
        dt: 1 / 120,
      });
      positions = next.positions;
      velocities = next.velocities;
      maxSpeed = next.maxSpeed;
    }
    sim.positions = positions;
    sim.velocities = velocities;
    setLivePositions(positions);
    return { maxSpeed };
  };

  /** One animation frame: two physics substeps + settle detection. */
  const runSimulationFrame = () => {
    rafRef.current = 0;
    const sim = liveRef.current;
    if (sim === null) return;
    const { maxSpeed } = pumpSimulation(2);
    sim.frames = (sim.frames ?? 0) + 1;
    const dragging = dragRef.current !== null && dragRef.current.moved === true;
    if (dragging) {
      sim.settle = 0;
    } else {
      sim.settle = (sim.settle ?? 0) + 1;
      // Stop once everything is calm, but never run the tail forever.
      if ((maxSpeed < 6 && sim.settle > 8) || sim.settle > 160) {
        persistSimulation();
        return;
      }
    }
    if (typeof requestAnimationFrame === 'function') {
      rafRef.current = requestAnimationFrame(runSimulationFrame);
    } else {
      persistSimulation();
    }
  };

  /** Enter live simulation mode for a drag (positions snapshot, zero velocity). */
  const startSimulation = (node, target) => {
    const snapshot = {};
    for (const item of visible.nodes) {
      const point = positions[item.id];
      if (point !== undefined) snapshot[item.id] = { x: point.x, y: point.y };
    }
    const velocities = {};
    for (const id of Object.keys(snapshot)) velocities[id] = { x: 0, y: 0 };
    liveRef.current = {
      nodes: visible.nodes.slice(),
      links: visible.edges.slice(),
      positions: snapshot,
      velocities,
      draggedId: node.id,
      dragged: { id: node.id, x: target.x, y: target.y },
      pinned: Object.keys(pinsRef.current),
      settle: 0,
      frames: 0,
    };
    setLivePositions({ ...snapshot });
    if (typeof requestAnimationFrame === 'function') {
      stopSimulationLoop();
      rafRef.current = requestAnimationFrame(runSimulationFrame);
    } else {
      pumpSimulation(1);
    }
  };

  /** Point the dragged node at a world-space coordinate. */
  const moveDraggedNode = (node, target) => {
    if (liveRef.current !== null) {
      liveRef.current.dragged = { id: node.id, x: target.x, y: target.y };
      if (typeof requestAnimationFrame !== 'function') pumpSimulation(1);
    }
  };

  // Never leave a physics loop running after unmount / graph replacement.
  React.useEffect(() => {
    return () => {
      stopSimulationLoop();
      liveRef.current = null;
    };
  }, []);

  const selected = selectedId ? visible.nodes.find((node) => node.id === selectedId) || null : null;
  const mergeTarget = mergeTargetId !== null
    ? normalized.nodes.find((node) => node.id === mergeTargetId) || null
    : null;
  const selectedPin = selected
    ? (mruGraphNodeIsPinned(selected) || Boolean(pins[selected.id]))
    : false;
  const cardKey = [
    selectedId || '',
    renameDraft === null ? '' : 'rename',
    mergeFromId || '',
    mergeTargetId || '',
    curationPending || '',
    curationError,
    curationNotice,
  ].join('|');

  // Merge/rename editors only exist for the selected node: leave them when the
  // selection disappears (filter/search/graph refresh) so node clicks are not
  // silently captured by a hidden merge mode.
  React.useEffect(() => {
    if (selected) return;
    if (mergeFromId !== null) {
      setMergeFromId(null);
      setMergeTargetId(null);
    }
    if (renameDraft !== null) setRenameDraft(null);
  }, [selected, mergeFromId, renameDraft]);
  React.useEffect(() => {
    if (mergeFromId === null) return;
    if (normalized.nodes.some((node) => node.id === mergeFromId)) return;
    setMergeFromId(null);
    setMergeTargetId(null);
  }, [normalized, mergeFromId]);

  // --- curation actions (rename / merge / pin, PLAN C1/C2) ----------------
  const closeCard = () => {
    setSelectedId(null);
    setRenameDraft(null);
    setMergeFromId(null);
    setMergeTargetId(null);
    setCurationError('');
    setCurationNotice('');
  };

  const startRename = () => {
    if (!selected || !canCurate || curationPendingRef.current !== null) return;
    setCurationError('');
    setCurationNotice('');
    setMergeFromId(null);
    setMergeTargetId(null);
    setRenameDraft(mruGraphString(selected.label || selected.id));
  };

  const cancelRename = () => {
    setRenameDraft(null);
    setCurationError('');
  };

  const saveRename = () => {
    if (!selected || curationPendingRef.current !== null) return;
    const label = mruGraphCurationLabel(renameDraft);
    if (label === '') {
      setCurationError(tr('graph.renameEmpty'));
      return;
    }
    const patch = mruGraphCurationPatch('rename', { node: selected.id, label });
    if (patch === null) {
      setCurationError(tr('graph.renameEmpty'));
      return;
    }
    runCuration('rename', patch, {
      success: () => {
        setRenameDraft(null);
        setCurationNotice(tr('graph.curationSaved'));
      },
      error: () => setCurationError(tr('graph.renameFailed')),
    });
  };

  const startMerge = () => {
    if (!selected || !canCurate || curationPendingRef.current !== null) return;
    setCurationError('');
    setCurationNotice('');
    setRenameDraft(null);
    setMergeFromId(selected.id);
    setMergeTargetId(null);
  };

  const pickMergeTarget = (node) => {
    if (mergeFromId === null || !node || node.cluster) return false;
    if (node.id === mergeFromId) return false;
    setMergeTargetId(node.id);
    setCurationError('');
    return true;
  };

  const cancelMerge = () => {
    setMergeFromId(null);
    setMergeTargetId(null);
    setCurationError('');
  };

  const confirmMerge = () => {
    if (mergeFromId === null || mergeTargetId === null || curationPendingRef.current !== null) return;
    const patch = mruGraphCurationPatch('merge', { from: mergeFromId, into: mergeTargetId });
    if (patch === null) {
      setCurationError(tr('graph.mergeFailed'));
      return;
    }
    const targetId = mergeTargetId;
    runCuration('merge', patch, {
      success: () => {
        setMergeFromId(null);
        setMergeTargetId(null);
        setSelectedId(targetId);
        setCurationNotice(tr('graph.merged'));
      },
      error: () => setCurationError(tr('graph.mergeFailed')),
    });
  };

  const togglePin = () => {
    if (!selected || !canCurate || curationPendingRef.current !== null) return;
    setCurationError('');
    setCurationNotice('');
    const id = selected.id;
    if (selectedPin) {
      const patch = mruGraphCurationPatch('unpin', { node: id });
      if (patch === null) return;
      const previous = mruGraphCurationPosition(storedPins[id] || positions[id]);
      writePin(id, null);
      runCuration('unpin', patch, {
        error: () => {
          if (previous !== null) writePin(id, previous);
          setCurationError(tr('graph.pinFailed'));
        },
      });
      return;
    }
    const position = mruGraphCurationPosition(positions[id] || storedPins[id]);
    if (position === null) return;
    const patch = mruGraphCurationPatch('pin', { node: id, position });
    if (patch === null) return;
    writePin(id, position);
    runCuration('pin', patch, {
      error: () => {
        writePin(id, null);
        setCurationError(tr('graph.pinFailed'));
      },
    });
  };

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
    for (let i = 0; i < renderEdges.edges.length; i += 1) {
      const edge = renderEdges.edges[i];
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
  }, [visible.nodes, renderEdges, positions, degree, selectedId]);

  const progress = mruGraphProgress(rawProgress);
  const progressPercent = progress.percent;
  const phaseLabel = building && progress.phase !== '' ? mruGraphPhaseLabel(t, progress.phase) : '';
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

  /** Fit the whole visible map into the canvas, with sane margins and zoom. */
  const fitCanvasView = () => mruGraphFitView(
    positions,
    mruGraphViewportOrFallback(viewport),
    {
      padding: MRU_GRAPH_FIT_PADDING,
      margin: MRU_GRAPH_FIT_MARGIN,
      maxZoom: MRU_GRAPH_FIT_MAX_ZOOM,
    },
  );

  // The SVG viewBox mirrors the canvas' measured CSS pixel size, so world
  // coordinates are real screen pixels and the camera is not confined to a
  // fixed drawing window. Re-measure when the canvas appears or resizes.
  React.useLayoutEffect(() => {
    if (!canvasShown) return undefined;
    const svg = svgRef.current;
    if (!svg || typeof svg.getBoundingClientRect !== 'function') return undefined;
    const measure = () => {
      let rect = null;
      try {
        rect = svg.getBoundingClientRect();
      } catch {
        rect = null;
      }
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
      setViewport((previous) => (
        previous !== null
        && Math.abs(previous.width - rect.width) < 0.5
        && Math.abs(previous.height - rect.height) < 0.5
          ? previous
          : { width: rect.width, height: rect.height }
      ));
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [canvasShown]);

  // Resizing the panel: a fitted camera stays fitted (the whole map remains
  // visible at any panel size); once the user has panned/zoomed, keep the world
  // point at the centre of the camera still instead of revealing a new strip of
  // the infinite canvas.
  React.useLayoutEffect(() => {
    if (viewport === null) return;
    const previous = previousViewportRef.current;
    previousViewportRef.current = viewport;
    if (!previous
      || (Math.abs(previous.width - viewport.width) < 0.5
        && Math.abs(previous.height - viewport.height) < 0.5)) {
      return;
    }
    if (!viewDirty) {
      setView(fitCanvasView());
      return;
    }
    setView((current) => {
      const worldCenterX = (previous.width / 2 - current.x) / current.k;
      const worldCenterY = (previous.height / 2 - current.y) / current.k;
      return {
        k: current.k,
        x: mruGraphRound(viewport.width / 2 - worldCenterX * current.k),
        y: mruGraphRound(viewport.height / 2 - worldCenterY * current.k),
      };
    });
  }, [viewport]);

  // First visible graph — and every document/library switch or rebuilt graph —
  // starts fitted to the content. Wait for a running build to finish (streaming
  // nodes would be fitted chunk by chunk and jump around); afterwards the
  // camera is stable until the user pans/zooms. Filtering does not change this
  // identity, so searching keeps the current viewport.
  React.useLayoutEffect(() => {
    if (viewport === null || !canvasShown || building) return;
    const identity = `${mode}|${mruGraphString(normalized.documentId)}|${signature}`;
    if (fittedKeyRef.current === identity) return;
    fittedKeyRef.current = identity;
    setView(fitCanvasView());
    setViewDirty(false);
  }, [viewport, canvasShown, mode, normalized, positions, building, signature]);

  // A filter/collapse relayout can place the visible map outside the current
  // camera. Only then re-fit, so ordinary searching never yanks the viewport.
  React.useLayoutEffect(() => {
    if (lastLayoutSignatureRef.current === layoutSignature) return;
    lastLayoutSignatureRef.current = layoutSignature;
    if (viewport === null || !canvasShown) return;
    if (mruGraphViewShowsAny(positions, view, viewport, 24)) return;
    setView(fitCanvasView());
    setViewDirty(false);
  }, [layoutSignature, viewport, canvasShown, positions, view]);

  React.useEffect(() => {
    setCollapseMode(mode === 'library' ? 'auto' : 'none');
  }, [mode]);

  // Keep the anchored card glued to its node while panning, zooming, resizing
  // or re-laying out; cardPos in the deps re-measures once the card has size.
  React.useLayoutEffect(() => {
    placeCard();
  }, [placeCard, view.x, view.y, view.k, layout, visible.nodes.length, cardPos, livePositions, cardKey]);

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
      if (!target.closest('.mru-graph')) closeCard();
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
      const point = mruGraphEventViewPoint(event, svg, viewport);
      if (!point) return;
      setView((previous) => {
        const nextK = mruGraphClamp(
          previous.k * Math.exp(-delta * MRU_GRAPH_WHEEL_ZOOM_SPEED),
          MRU_GRAPH_MIN_ZOOM,
          MRU_GRAPH_MAX_ZOOM,
        );
        if (Math.abs(nextK - previous.k) < 1e-5) return previous;
        return mruGraphCameraZoom(previous, nextK, point.x, point.y);
      });
      setViewDirty(true);
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [canvasShown, viewport]);

  const zoomBy = (factor) => {
    const size = mruGraphViewportOrFallback(viewport);
    setView((previous) => mruGraphCameraZoom(
      previous,
      previous.k * factor,
      size.width / 2,
      size.height / 2,
    ));
    setViewDirty(true);
  };

  // Reset = fit the whole map again (the camera is unbounded, so there is no
  // "home" rectangle to snap back to) and re-seed persisted (C1) pins.
  const resetView = () => {
    // A drag simulation may still be settling: freeze it first, otherwise its
    // settle frame would re-pin the dragged node after this reset cleared pins.
    if (liveRef.current !== null) persistSimulation();
    setView(fitCanvasView());
    setViewDirty(false);
    // Persisted pins survive "reset view"; transient drag pins do not.
    const seeded = mode === 'doc' ? storedPins : {};
    setPins(seeded);
    pinsRef.current = seeded;
    closeCard();
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
    if (members.length > 0) selectNode(members[0]);
    else closeCard();
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

  /** Select a node; while merging, another node becomes the merge target. */
  const selectNode = (node) => {
    if (!node) return;
    if (mergeFromId !== null && node.id !== mergeFromId && !node.cluster) {
      pickMergeTarget(node);
      return;
    }
    if (mergeFromId !== null && node.cluster) cancelMerge();
    if (node.id !== selectedId) {
      setRenameDraft(null);
      setCurationError('');
      setCurationNotice('');
    }
    setSelectedId(node.id);
  };

  const onCanvasPointerDown = (event) => {
    if (event && event.button !== undefined && event.button !== 0) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    closeCard();
    setHoverEdgeId(null);
    if (!event) return;
    const point = mruGraphEventViewPoint(event, svgRef.current, viewport);
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
    const point = mruGraphEventViewPoint(event, svgRef.current, viewport);
    if (!point) return;
    setView(mruGraphCameraPan(pan.origin, point.x - pan.start.x, point.y - pan.start.y));
    setViewDirty(true);
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
    if (mergeFromId !== null && node.id !== mergeFromId && !node.cluster) {
      // Merge mode: clicking any other node picks it as the merge target.
      if (typeof event.preventDefault === 'function') event.preventDefault();
      pickMergeTarget(node);
      return;
    }
    if (liveRef.current !== null) persistSimulation();
    selectNode(node);
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
    const start = mruGraphEventWorldPoint(event, svgRef.current, view, viewport);
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
    const point = mruGraphEventWorldPoint(event, svgRef.current, view, viewport);
    const deltaX = point.x - drag.start.x;
    const deltaY = point.y - drag.start.y;
    if (!drag.moved && Math.sqrt(deltaX * deltaX + deltaY * deltaY) > 2) drag.moved = true;
    if (!drag.moved) return;
    // The canvas is unbounded: a node can be dragged past the old layout sheet
    // (and past the viewport) instead of being clamped at an invisible wall.
    const target = {
      x: drag.origin.x + deltaX,
      y: drag.origin.y + deltaY,
    };
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return;
    setViewDirty(true);
    if (liveRef.current === null) {
      startSimulation(node, target);
    } else {
      moveDraggedNode(node, target);
    }
    // Reduced motion: no continuous animation, but the dynamic push still
    // happens stepwise as the pointer moves.
    if (mruGraphReducedMotion()) pumpSimulation(3);
  };

  const onNodePointerUp = (event, node) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== node.id) return;
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    const wasDragging = drag.moved === true;
    dragRef.current = null;
    try {
      if (event && event.currentTarget && typeof event.currentTarget.releasePointerCapture === 'function') {
        event.currentTarget.releasePointerCapture(drag.pointerId);
      }
    } catch {
      /* ignore */
    }
    if (wasDragging) {
      // Persist the released pin once the simulation settles (C1); the
      // reduced-motion branch below settles immediately.
      pendingPinRef.current = node.id;
    }
    if (wasDragging && liveRef.current !== null && (
      mruGraphReducedMotion() || typeof requestAnimationFrame !== 'function'
    )) {
      // Immediate, non-animated response for reduced-motion users.
      pumpSimulation(6);
      persistSimulation();
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
      closeCard();
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
      closeCard();
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
      closeCard();
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
      title: `${mruGraphTypeLabel(t, type)} · ${mruGraphFormatCount(count)}`,
      onClick: () => toggleType(type),
    },
    mruGraphH('span', { key: 'label' }, mruGraphTypeLabel(t, type)),
    mruGraphH('span', { key: 'count', className: 'mru-graph__legend-count' }, mruGraphFormatCount(count)));
  });
  const collapseThreshold = mode === 'library'
    ? MRU_GRAPH_LIBRARY_COLLAPSE_THRESHOLD
    : MRU_GRAPH_COLLAPSE_THRESHOLD;
  const showCollapseToggle = visible.filteredNodes > collapseThreshold || visible.collapsed;
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
    const typeLabel = mruGraphTypeLabel(t, node.type);
    const label = node.cluster
      ? `${typeLabel} · ${mruGraphFormatCount(node.count || 0)}`
      : mruGraphDisplay(node.label || node.id);
    const showLabel = node.cluster
      || visible.nodes.length <= 70
      || view.k >= 1.05
      || isSelected
      || inPath
      || related;
    const pinned = node.cluster ? false : (mruGraphNodeIsPinned(node) || Boolean(pins[node.id]));
    const isMergeSource = mergeFromId !== null && mergeFromId === node.id;
    const isMergeCandidate = mergeFromId !== null && mergeCandidateIds.has(node.id);
    const className = 'mru-graph__node mru-graph__node--' + typeClass
      + (isSelected ? ' mru-graph__node--active' : '')
      + (pinned ? ' mru-graph__node--pinned' : '')
      + (isMergeSource ? ' mru-graph__node--merge-source' : '')
      + (isMergeCandidate ? ' mru-graph__node--merge-candidate' : '');
    const clusterCount = node.cluster ? String(mruGraphFormatCount(node.count || 0)) : '';
    return mruGraphH('g', {
      key: node.id,
      ref: (element) => mruGraphSetNodeRef(nodeRefs, node.id, element),
      className,
      transform: `translate(${point.x} ${point.y})`,
      tabIndex: 0,
      role: 'button',
      'aria-label': `${label} · ${typeLabel} · ${tr('graph.degree', { count: mruGraphFormatCount(nodeDegree) })}`
        + (pinned ? ` · ${tr('graph.pinned')}` : ''),
      'aria-pressed': isSelected ? 'true' : 'false',
      'data-node-id': node.id,
      'data-type': node.type,
      'data-cluster': node.cluster ? 'true' : undefined,
      'data-pinned': pinned ? 'true' : undefined,
      'data-merge-source': isMergeSource ? 'true' : undefined,
      'data-merge-candidate': isMergeCandidate ? 'true' : undefined,
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
        if (dragRef.current && dragRef.current.id === node.id) {
          dragRef.current = null;
          if (liveRef.current !== null && mruGraphReducedMotion()) {
            pumpSimulation(6);
            persistSimulation();
          }
        }
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
    pinned
      ? mruGraphH('g', { key: 'pin', className: 'mru-graph__node-pin-group', 'aria-hidden': 'true' },
        mruGraphH('title', { key: 'title' }, tr('graph.pinned')),
        mruGraphH('circle', {
          key: 'dot',
          className: 'mru-graph__node-pin',
          cx: mruGraphRound10(radius * 0.72),
          cy: mruGraphRound10(-radius * 0.72),
          r: 3.4,
        }))
      : null,
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
    const fromLabel = fromNode ? (fromNode.cluster ? mruGraphTypeLabel(t, fromNode.type) : fromNode.label) : edge.from;
    const toLabel = toNode ? (toNode.cluster ? mruGraphTypeLabel(t, toNode.type) : toNode.label) : edge.to;
    const edgeLabel = edge.label || mruGraphEdgeTypeLabel(t, edge.type);
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

  // The canvas' viewBox is the measured element size: world units are CSS
  // pixels, the camera (viewport <g>) may translate/scale arbitrarily, and no
  // fixed 1000×680 window clips the map. The graph paper follows the camera so
  // panning/zooming feels like moving over an infinite sheet.
  const canvasSize = mruGraphViewportOrFallback(viewport);
  let gridStep = MRU_GRAPH_GRID_STEP * view.k;
  if (!Number.isFinite(gridStep) || gridStep <= 0) gridStep = MRU_GRAPH_GRID_STEP;
  while (gridStep < MRU_GRAPH_GRID_MIN_STEP) gridStep *= 2;
  while (gridStep > MRU_GRAPH_GRID_MAX_STEP) gridStep /= 2;
  gridStep = mruGraphRound(gridStep);
  const canvasStyle = {
    backgroundPosition: `${mruGraphRound(view.x)}px ${mruGraphRound(view.y)}px`,
    backgroundSize: `${gridStep}px ${gridStep}px`,
  };

  const canvas = mruGraphH('svg', {
    ref: svgRef,
    className: 'mru-graph__canvas',
    viewBox: `0 0 ${mruGraphRound(canvasSize.width)} ${mruGraphRound(canvasSize.height)}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'group',
    'aria-label': tr('graph.canvas'),
    'data-zoom': view.k,
    style: canvasStyle,
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
    width: mruGraphRound(canvasSize.width),
    height: mruGraphRound(canvasSize.height),
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
    if (renderEdges.trimmed) {
      statusBits.push(tr('graph.edgesTrimmed', {
        shown: mruGraphFormatCount(renderEdges.edges.length),
        total: mruGraphFormatCount(visible.edges.length),
      }));
    } else {
      statusBits.push(tr('graph.edges', { count: mruGraphFormatCount(normalized.edges.length) }));
    }
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
    (viewDirty || Object.keys(pins).length > 0)
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
  const liveText = building ? progressText : selected ? (selected.cluster ? `${mruGraphTypeLabel(t, selected.type)} ×${selected.count || 0}` : selected.label) : '';
  const live = mruGraphH('span', { className: 'mru-sr-only', 'aria-live': 'polite' }, liveText);

  // --- details card -------------------------------------------------------
  let card = null;
  if (selected) {
    const typeLabel = mruGraphTypeLabel(t, selected.type);
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
      meta.push(mruGraphH('span', { key: 'source' }, mruGraphSourceLabel(t, selected.source)));
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
        onClick: () => closeCard(),
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
            selectNode(member);
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
          onClick: () => selectNode(entry.other),
        }, `${entry.direction === 'out' ? '→' : '←'} ${mruGraphEdgeTypeLabel(t, entry.edge.type)} · ${mruGraphTruncate(entry.other.cluster ? mruGraphTypeLabel(t, entry.other.type) : (entry.other.label || entry.other.id), 16)}`));
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
      // Curation actions: doc mode with the C2 `onUpdateGraph` hook only.
      const askButton = typeof onAsk === 'function'
        ? mruGraphH('button', {
          key: 'ask',
          type: 'button',
          className: 'mru-btn mru-btn--primary mru-btn--sm'
            + (canCurate ? ' mru-graph__card-action' : ''),
          'data-action': 'graph-ask',
          onClick: () => onAsk(selected),
        }, tr('graph.ask'))
        : null;
      if (canCurate) {
        const pending = curationPending !== null;
        if (renameDraft !== null) {
          const renameInput = mruGraphH('input', {
            key: 'input',
            type: 'text',
            className: 'mru-graph__rename-input',
            value: renameDraft,
            maxLength: MRU_GRAPH_RENAME_MAX,
            placeholder: tr('graph.renamePlaceholder'),
            'aria-label': tr('graph.renameTitle'),
            'data-action': 'graph-rename-input',
            autoFocus: true,
            disabled: pending,
            onChange: (event) => {
              const raw = mruGraphString(event && event.target ? event.target.value : '');
              setRenameDraft([...raw].slice(0, MRU_GRAPH_RENAME_MAX).join(''));
            },
            onKeyDown: (event) => {
              if (!event) return;
              if (event.key === 'Enter') {
                if (typeof event.preventDefault === 'function') event.preventDefault();
                if (typeof event.stopPropagation === 'function') event.stopPropagation();
                saveRename();
              } else if (event.key === 'Escape') {
                if (typeof event.preventDefault === 'function') event.preventDefault();
                if (typeof event.stopPropagation === 'function') event.stopPropagation();
                cancelRename();
              }
            },
          });
          const renameSave = mruGraphH('button', {
            key: 'save',
            type: 'button',
            className: 'mru-btn mru-btn--primary mru-btn--sm mru-graph__card-action',
            'data-action': 'graph-rename-save',
            disabled: pending,
            onClick: saveRename,
          }, tr('graph.renameSave'));
          const renameCancel = mruGraphH('button', {
            key: 'cancel',
            type: 'button',
            className: 'mru-btn mru-btn--ghost mru-btn--sm mru-graph__card-action',
            'data-action': 'graph-rename-cancel',
            disabled: pending,
            onClick: cancelRename,
          }, tr('graph.renameCancel'));
          cardChildren.push(mruGraphH('div', {
            key: 'rename',
            className: 'mru-graph__rename',
            role: 'group',
            'aria-label': tr('graph.renameTitle'),
            'data-action': 'graph-rename-editor',
          }, renameInput, renameSave, renameCancel));
        } else if (mergeFromId !== null) {
          const fromLabel = mruGraphTruncate(mruGraphDisplay(selected.label || selected.id), 24);
          if (mergeTarget === null) {
            // Step 1 of the merge: pick a target node on the canvas.
            const mergeHint = mruGraphH('span', {
              key: 'hint',
              className: 'mru-graph__merge-hint',
            }, tr('graph.mergeHint'));
            const mergeSource = mruGraphH('span', {
              key: 'source',
              className: 'mru-graph__merge-node',
            }, fromLabel);
            const mergeCancel = mruGraphH('button', {
              key: 'cancel',
              type: 'button',
              className: 'mru-link-btn mru-graph__card-action',
              'data-action': 'graph-merge-cancel',
              onClick: cancelMerge,
            }, tr('graph.mergeCancel'));
            cardChildren.push(mruGraphH('div', {
              key: 'merge',
              className: 'mru-graph__merge-bar mru-graph__merge-bar--hint',
              role: 'group',
              'aria-label': tr('graph.mergeTitle'),
              'data-action': 'graph-merge-bar',
            }, mergeHint, mergeSource, mergeCancel));
          } else {
            // Step 2: the clicked target is shown before the patch is sent.
            const intoLabel = mruGraphTruncate(mruGraphDisplay(mergeTarget.label || mergeTarget.id), 24);
            const mergeTitle = mruGraphH('span', {
              key: 'title',
              className: 'mru-graph__merge-title',
            }, tr('graph.mergeTitle'));
            const mergeLabels = mruGraphH('span', {
              key: 'labels',
              className: 'mru-graph__merge-labels',
            },
            mruGraphH('span', { key: 'from', className: 'mru-graph__merge-node' }, fromLabel),
            mruGraphH('span', { key: 'arrow', className: 'mru-graph__merge-arrow', 'aria-hidden': 'true' }, '→'),
            mruGraphH('span', { key: 'into', className: 'mru-graph__merge-node' }, intoLabel));
            const mergeConfirm = mruGraphH('button', {
              key: 'confirm',
              type: 'button',
              className: 'mru-btn mru-btn--primary mru-btn--sm mru-graph__card-action',
              'data-action': 'graph-merge-confirm',
              disabled: pending,
              onClick: confirmMerge,
            }, tr('graph.mergeConfirm'));
            const mergeCancel = mruGraphH('button', {
              key: 'cancel',
              type: 'button',
              className: 'mru-link-btn mru-graph__card-action',
              'data-action': 'graph-merge-cancel',
              disabled: pending,
              onClick: cancelMerge,
            }, tr('graph.mergeCancel'));
            cardChildren.push(mruGraphH('div', {
              key: 'merge-confirm',
              className: 'mru-graph__merge-bar mru-graph__merge-bar--confirm',
              role: 'group',
              'aria-label': tr('graph.mergeTitle'),
              'data-action': 'graph-merge-confirm-bar',
            }, mergeTitle, mergeLabels, mergeConfirm, mergeCancel));
          }
        } else {
          const renameAction = mruGraphH('button', {
            key: 'rename',
            type: 'button',
            className: 'mru-btn mru-btn--ghost mru-btn--sm mru-graph__card-action',
            'data-action': 'graph-rename',
            title: tr('graph.renameTitle'),
            disabled: pending,
            onClick: startRename,
          }, mruGraphGlyph('edit', 14), tr('graph.rename'));
          const mergeAction = mruGraphH('button', {
            key: 'merge',
            type: 'button',
            className: 'mru-btn mru-btn--ghost mru-btn--sm mru-graph__card-action',
            'data-action': 'graph-merge',
            title: tr('graph.mergeTitle'),
            disabled: pending,
            onClick: startMerge,
          }, mruGraphGlyph('merge', 14), tr('graph.merge'));
          const pinAction = mruGraphH('button', {
            key: 'pin',
            type: 'button',
            className: 'mru-btn mru-btn--ghost mru-btn--sm mru-graph__card-action',
            'data-action': selectedPin ? 'graph-unpin' : 'graph-pin',
            'aria-pressed': selectedPin ? 'true' : 'false',
            disabled: pending,
            onClick: togglePin,
          }, mruGraphGlyph('pin', 14), selectedPin ? tr('graph.unpin') : tr('graph.pin'));
          const actionButtons = [renameAction, mergeAction, pinAction];
          if (askButton !== null) actionButtons.push(askButton);
          cardChildren.push(mruGraphH('div', {
            key: 'actions',
            className: 'mru-graph__card-actions',
            role: 'group',
            'aria-label': tr('graph.curate'),
          }, actionButtons));
        }
        if (curationPending !== null) {
          cardChildren.push(mruGraphH('span', {
            key: 'pending',
            className: 'mru-graph__card-pending',
            role: 'status',
          }, tr('graph.saving')));
        }
        if (curationError !== '') {
          cardChildren.push(mruGraphH('p', {
            key: 'error',
            className: 'mru-graph__card-error',
            role: 'alert',
          }, curationError));
        } else if (curationNotice !== '') {
          cardChildren.push(mruGraphH('p', {
            key: 'notice',
            className: 'mru-graph__card-notice',
            role: 'status',
          }, curationNotice));
        }
      } else if (askButton !== null) {
        cardChildren.push(askButton);
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
      'data-pending': curationPending !== null ? curationPending : undefined,
      'data-merging': mergeFromId !== null ? 'true' : undefined,
      'aria-busy': curationPending !== null ? 'true' : undefined,
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
    'data-merge-mode': mergeFromId !== null ? 'true' : undefined,
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
