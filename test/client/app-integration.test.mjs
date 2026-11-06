/**
 * Offline render harness for the dsh-litnotes AI app integration (task-14).
 *
 * Loads the real generated bundle `lib/client.js` through a minimal fake React
 * + fake DOM, mounts the registered `main` panel with a mocked host, and drives
 * the AI surface: margin AI tab, quick actions, document/library graph views,
 * NDJSON streaming, preference persistence and the chat/graph module props.
 *
 * The placeholders in ui/chat.js / ui/graph.js are tolerated: when the real
 * modules land the harness asserts their props instead of the fallbacks.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------- fake react
const Fragment = Symbol('Fragment')
const instances = new Map()
const captured = new Map()
const CAPTURE = new Set(['MruAiPanel', 'MruGraphView'])
let dirty = false
let pendingEffects = []
let currentInstance = null
let tree = null

class FakeComponent {
  constructor(props) { this.props = props; this.state = {} }
  setState(update) {
    this.state = { ...this.state, ...(typeof update === 'function' ? update(this.state) : update) }
    dirty = true
  }
}
FakeComponent.prototype.isReactComponent = true

const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))

function createElement(type, props, ...children) {
  const merged = { ...(props || {}) }
  if (children.length === 1) merged.children = children[0]
  else if (children.length > 1) merged.children = children
  return { __el: true, type, props: merged }
}
function hookSlot() {
  if (!currentInstance) throw new Error('hook called outside a component render')
  const index = currentInstance.cursor
  currentInstance.cursor += 1
  if (!currentInstance.hooks[index]) currentInstance.hooks[index] = {}
  return currentInstance.hooks[index]
}
function useState(initial) {
  const slot = hookSlot()
  if (!('state' in slot)) slot.state = typeof initial === 'function' ? initial() : initial
  return [slot.state, (update) => {
    const next = typeof update === 'function' ? update(slot.state) : update
    if (Object.is(next, slot.state)) return
    slot.state = next
    dirty = true
  }]
}
function useRef(initial) {
  const slot = hookSlot()
  if (!('ref' in slot)) slot.ref = { current: initial }
  return slot.ref
}
function useMemo(factory, deps) {
  const slot = hookSlot()
  if (!('memo' in slot) || !sameDeps(slot.deps, deps)) {
    slot.memo = factory()
    slot.deps = deps
  }
  return slot.memo
}
function useEffect(fn, deps) {
  const slot = hookSlot()
  if (!('effect' in slot) || !sameDeps(slot.deps, deps)) {
    slot.effect = fn
    slot.deps = deps
    slot.pending = true
  }
}
const FakeReact = {
  Fragment,
  Component: FakeComponent,
  createElement,
  useState,
  useRef,
  useMemo,
  useEffect,
  useLayoutEffect: useEffect,
  useCallback: (fn, deps) => useMemo(() => fn, deps),
  useId: () => `id-${Math.random().toString(36).slice(2)}`,
  useContext: () => undefined,
  createContext: (value) => ({ Provider: (props) => props.children, Consumer: (props) => props.children(value), _value: value }),
  memo: (component) => component,
  forwardRef: (render) => (props) => render(props, null),
  createRef: () => ({ current: null }),
  version: 'fake',
}

// ---------------------------------------------------------------- fake dom
class FakeElement {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase()
    this.nodeType = 1
    this.props = {}
    this.style = {}
    this.children = []
    this.parentNode = null
    this.attrs = {}
    this.listeners = new Map()
    this.className = ''
    this.nodeValue = ''
    this.scrollTop = 0
    this.scrollLeft = 0
    this.scrollHeight = 600
    this.scrollWidth = 800
    this.clientHeight = 600
    this.clientWidth = 800
    this.offsetWidth = 800
    this.offsetHeight = 600
    this.hidden = false
    this.value = ''
    this.files = null
    this.classList = {
      add: () => {},
      remove: () => {},
      toggle: () => {},
      contains: () => false,
    }
  }
  getBoundingClientRect() { return { left: 100, top: 160, right: 400, bottom: 180, width: 300, height: 20, x: 100, y: 160 } }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null }
  setAttribute(name, value) { this.attrs[name] = String(value) }
  removeAttribute(name) { delete this.attrs[name] }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child }
  removeChild(child) { this.children = this.children.filter((item) => item !== child); return child }
  contains(node) {
    let cursor = node
    while (cursor) {
      if (cursor === this) return true
      cursor = cursor.parentNode
    }
    return false
  }
  closest(selector) {
    let cursor = this
    while (cursor) {
      if (matchesSelector(cursor, selector)) return cursor
      cursor = cursor.parentNode
    }
    return null
  }
  querySelector(selector) { return queryAll(this, selector)[0] || null }
  querySelectorAll(selector) { return queryAll(this, selector) }
  click() { if (this.props && typeof this.props.onClick === 'function') this.props.onClick(this.event()) }
  event(extra) {
    return { button: 0, currentTarget: this, target: this, preventDefault() {}, stopPropagation() {}, ...(extra || {}) }
  }
  focus() { activeElement = this }
  blur() { activeElement = null }
  select() {}
  scrollTo() {}
  scrollIntoView() {}
  setSelectionRange() {}
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(fn)
  }
  removeEventListener(name, fn) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter((item) => item !== fn))
  }
}
function matchesSelector(element, selector) {
  if (!element || element.nodeType !== 1) return false
  return String(selector).split(',').some((raw) => {
    const token = raw.trim()
    if (!token) return false
    if (token.startsWith('.')) return String(element.props.className || element.className || '').split(/\s+/).includes(token.slice(1))
    const attr = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(token)
    if (attr) {
      let value = element.attrs[attr[1]]
      if (value === undefined) value = element.props[attr[1]]
      if (value === undefined) return false
      return attr[2] === undefined || String(value) === attr[2]
    }
    return element.tagName === token.toUpperCase()
  })
}
function queryAll(root, selector) {
  const out = []
  const visit = (node) => {
    if (!node || typeof node === 'string') return
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (node.nodeType === 1 && matchesSelector(node, selector)) out.push(node)
    visit(node.children)
  }
  visit(root.children)
  return out
}
let activeElement = null
const documentStub = {
  baseURI: 'http://127.0.0.1:3080/',
  visibilityState: 'visible',
  head: new FakeElement('head'),
  body: new FakeElement('body'),
  documentElement: new FakeElement('html'),
  activeElement: null,
  listeners: new Map(),
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (ns, tag) => new FakeElement(tag),
  createTextNode: (text) => ({ nodeType: 3, nodeValue: text, textContent: text }),
  createRange: () => ({
    setStart() {}, setEnd() {}, selectNodeContents() {},
    toString: () => '',
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  }),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(fn)
  },
  removeEventListener(name, fn) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter((item) => item !== fn))
  },
}
const localStorageStub = {
  store: new Map(),
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
  setItem(key, value) { this.store.set(key, String(value)) },
  removeItem(key) { this.store.delete(key) },
}
const windowStub = {
  innerWidth: 1440,
  innerHeight: 900,
  baseURI: documentStub.baseURI,
  document: documentStub,
  localStorage: localStorageStub,
  listeners: new Map(),
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(fn)
  },
  removeEventListener(name, fn) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter((item) => item !== fn))
  },
  matchMedia: () => ({ matches: false }),
  requestAnimationFrame: (fn) => setTimeout(() => fn(0), 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  getSelection: () => null,
  setTimeout,
  clearTimeout,
  open: () => null,
}
documentStub.defaultView = windowStub
documentStub.activeElement = null
globalThis.window = windowStub
globalThis.document = documentStub
globalThis.Element = FakeElement
globalThis.Node = FakeElement
globalThis.URL = URL
globalThis.Blob = Blob
globalThis.localStorage = localStorageStub
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} }, language: 'zh-CN' },
    configurable: true,
  })
} catch {
  /* Node may expose a read-only navigator: the clipboard path is unused here */
}
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }

// ---------------------------------------------------------------- renderer
function getInstance(path, name) {
  const key = `${path}|${name}`
  if (!instances.has(key)) instances.set(key, { hooks: [], cursor: 0 })
  return instances.get(key)
}
function renderChildren(children, path) {
  if (children === undefined || children === null || typeof children === 'boolean') return []
  if (Array.isArray(children)) return children.flatMap((child, index) => renderNode(child, `${path}.${index}`))
  return renderNode(children, path)
}
function renderNode(node, path) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap((child, index) => renderNode(child, `${path}.${index}`))
  const { type, props } = node
  if (type === Fragment) return renderChildren(props.children, path)
  if (typeof type === 'function') {
    if (type.prototype && type.prototype.isReactComponent) {
      const key = `${path}|${type.name}`
      const instance = instances.get(key) || new type(props)
      instances.set(key, instance)
      instance.props = props
      return renderChildren(instance.render(), `${path}.c`)
    }
    if (CAPTURE.has(type.name)) captured.set(type.name, props)
    const instance = getInstance(path, type.name || 'anonymous')
    instance.cursor = 0
    const previous = currentInstance
    currentInstance = instance
    let output
    try {
      output = type(props)
    } finally {
      currentInstance = previous
    }
    instance.hooks.forEach((hook, index) => {
      if (hook && hook.pending) {
        hook.pending = false
        pendingEffects.push({ instance, index })
      }
    })
    return renderChildren(output, `${path}.c`)
  }
  const element = new FakeElement(type)
  element.props = props || {}
  for (const [key, value] of Object.entries(props || {})) {
    if (key === 'children' || key === 'ref' || key === 'dangerouslySetInnerHTML') continue
    if (key.startsWith('on') && typeof value === 'function') continue
    if (key === 'className') element.className = String(value)
    if (key.startsWith('aria-') || key.startsWith('data-') || ['role', 'id', 'hidden', 'disabled', 'title', 'value', 'href', 'type', 'placeholder'].includes(key)) {
      element.attrs[key] = value
    }
  }
  if (props && props.ref) {
    if (typeof props.ref === 'function') props.ref(element)
    else if (props.ref && typeof props.ref === 'object') props.ref.current = element
  }
  element.children = renderChildren(props ? props.children : undefined, path)
  for (const child of element.children) if (child && child.nodeType === 1) child.parentNode = element
  return [element]
}
function runEffects() {
  const queue = pendingEffects
  pendingEffects = []
  for (const item of queue) {
    const hook = item.instance.hooks[item.index]
    try {
      if (hook.cleanup) hook.cleanup()
      const cleanup = hook.effect()
      hook.cleanup = typeof cleanup === 'function' ? cleanup : null
    } catch (error) {
      console.error('[app-test] effect failed:', error)
      throw error
    }
  }
}
function renderOnce() {
  dirty = false
  tree = renderNode(globalThis.__rootNode, 'root')
  runEffects()
}
async function settle(rounds = 12) {
  for (let index = 0; index < rounds; index += 1) {
    if (dirty || index === 0) renderOnce()
    await sleep(3)
  }
}
function walk(node, fn) {
  if (!node || typeof node === 'string') return
  if (Array.isArray(node)) { node.forEach((item) => walk(item, fn)); return }
  if (node.nodeType === 1) { fn(node); walk(node.children, fn) }
}
function findAll(className) {
  const out = []
  walk(tree, (element) => {
    if (String(element.props.className || '').split(/\s+/).includes(className)) out.push(element)
  })
  return out
}
const first = (className) => findAll(className)[0] || null
function textOf(node) {
  let text = ''
  const visit = (item) => {
    if (!item) return
    if (typeof item === 'string') { text += item; return }
    if (Array.isArray(item)) { item.forEach(visit); return }
    visit(item.children)
  }
  visit(node)
  return text
}
function findButtonByText(fragment) {
  let found = null
  walk(tree, (element) => {
    if (found) return
    if (element.tagName !== 'BUTTON') return
    if (typeof element.props.onClick !== 'function') return
    if (textOf(element).includes(fragment)) found = element
  })
  return found
}
function click(node) {
  assert.ok(node, 'expected a clickable node')
  assert.equal(typeof node.props.onClick, 'function', 'node has no onClick')
  node.props.onClick(node.event())
}

// ---------------------------------------------------------------- host mock
const DOC_ID = '11111111-1111-4111-8111-111111111111'
const PARSE_ID = '22222222-2222-4222-8222-222222222222'
const MARKDOWN = ['# Attention Is All You Need', '', '## 1 Introduction', '', 'Recurrent networks are the state of the art.', '', '## 2 Background', '', 'Reducing sequential computation matters.'].join('\n')
const PREFERENCES = {
  targetLanguage: 'zh', translationProvider: 'auto', readingMode: 'original', readingScale: 1,
  defaultEngine: 'auto', defaultModelVersion: 'vlm', defaultLanguage: 'ch', defaultIsOcr: false,
  defaultEnableFormula: true, defaultEnableTable: true, showPageMarks: true,
  aiPanelOpen: false, libraryView: 'library', docView: 'read', graphAutoBuild: false, marginTab: 'outline',
}
const PARSED = {
  id: DOC_ID, title: 'Attention Is All You Need', originalName: 'attention.pdf', ext: '.pdf', size: 2210123,
  status: 'parsed', createdAt: '2026-11-06T09:00:00.000Z',
  parse: { engine: 'standard', modelVersion: 'vlm', pages: 15 },
}
const UPLOADED = { id: PARSE_ID, title: 'draft.pdf', originalName: 'draft.pdf', ext: '.pdf', status: 'uploaded', createdAt: '2026-11-05T09:00:00.000Z' }
const STATUS = {
  version: '0.3.0+host', dataDirDisplay: '~/.dsh/litnotes', tokenConfigured: true, tokenPersistent: true,
  counts: { total: 2, parsed: 1, parsing: 0, failed: 0 }, preferences: PREFERENCES,
  ai: { available: true, graph: true, route: { provider: 'deepseek', model: 'deepseek-flash' }, retriever: true },
}
const DOC_GRAPH = {
  version: 1, scope: 'document', documentId: DOC_ID, nodes: [
    { id: 'n-1', type: 'concept', label: 'Self-attention', summary: 'Attention over one sequence.', blockKeys: ['b2:abc'] },
  ], edges: [],
}
const LIBRARY_GRAPH = {
  version: 1, scope: 'library', nodes: [
    { id: 'p-1', type: 'paper', label: 'Attention Is All You Need', documentIds: [DOC_ID] },
    { id: 't-1', type: 'topic', label: 'Attention' },
  ], edges: [{ id: 'e-1', from: 'p-1', to: 't-1', type: 'mentions' }],
}
const calls = []
const settingsUpdates = []
function envelope(value) {
  return { ok: true, status: 200, headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null) }, json: async () => ({ ok: true, value }) }
}
function errorEnvelope(code, message, status) {
  return {
    ok: false,
    status: status || 400,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => ({ ok: false, error: { code, message } }),
  }
}
function ndjson(frames) {
  const encoder = new TextEncoder()
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`))
      controller.close()
    },
  })
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? 'application/x-ndjson; charset=utf-8' : null) },
    body,
  }
}
async function mockFetch(url, options) {
  const text = String(url)
  const method = text.includes('/dsh-litnotes/api/') ? text.split('/dsh-litnotes/api/')[1].split('?')[0] : text
  let payload = null
  try {
    payload = options && options.body ? JSON.parse(options.body) : null
  } catch {
    payload = null
  }
  calls.push({ method, payload })
  switch (method) {
    case 'health.ping': return envelope({ ok: true })
    case 'status': return envelope(STATUS)
    case 'library.list': return envelope({ documents: [PARSED, UPLOADED] })
    case 'library.get': return envelope({
      document: payload && payload.id === DOC_ID ? PARSED : UPLOADED,
      annotations: [],
      translations: { version: 1, targetLanguage: 'zh', entries: {} },
    })
    case 'document.markdown': return envelope({ markdown: MARKDOWN, contentList: null, pages: 15 })
    case 'settings.update':
      settingsUpdates.push(payload && payload.preferences ? payload.preferences : {})
      return envelope({ preferences: (payload && payload.preferences) || PREFERENCES })
    case 'settings.get': return envelope({ tokenConfigured: true, preferences: PREFERENCES, providers: ['google'], defaults: {} })
    case 'graph.doc': return envelope({ graph: DOC_GRAPH })
    case 'graph.library': return envelope({ graph: LIBRARY_GRAPH })
    case 'graph.build': return ndjson([
      { type: 'progress', phase: 'reading', done: 0, total: 2, chunk: 0 },
      { type: 'progress', phase: 'extracting', done: 1, total: 2, chunk: 1 },
      { type: 'graph', graph: DOC_GRAPH },
      { type: 'done' },
    ])
    case 'graph.library.rebuild': return ndjson([
      { type: 'progress', phase: 'reading', done: 1, total: 2 },
      { type: 'graph', graph: LIBRARY_GRAPH },
      { type: 'done' },
    ])
    case 'chat.history': return envelope({ messages: [] })
    case 'chat.clear': return envelope({ cleared: true })
    case 'chat': {
      if (payload && payload.question === 'FAIL') return errorEnvelope('ai-unavailable', 'No model route', 503)
      return ndjson([
        { type: 'start', messageId: 'm-1', model: { provider: 'deepseek', model: 'deepseek-flash' } },
        { type: 'delta', text: 'Answer' },
        { type: 'answer', messageId: 'm-1', markdown: 'Answer [1]', citations: [], unverified: [], followups: [], annotationIds: [] },
        { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
        { type: 'done' },
      ])
    }
    case 'annotations.save':
    case 'translations.save': return envelope({ saved: true })
    default: return envelope({})
  }
}
class FakeXHR {
  constructor() { this.upload = {} }
  open() {}
  setRequestHeader() {}
  send() {
    this.status = 200
    this.responseText = JSON.stringify({ ok: true, value: { document: UPLOADED } })
    if (this.onload) this.onload()
  }
  abort() { if (this.onabort) this.onabort() }
}
globalThis.fetch = mockFetch
globalThis.XMLHttpRequest = FakeXHR

// ---------------------------------------------------------------- boot bundle
const moduleFactories = new Map()
windowStub.__ModuleLoader__ = { load: ({ id, factory }) => moduleFactories.set(id, factory) }
vm.runInThisContext(readFileSync(BUNDLE, 'utf8'), { filename: 'lib/client.js' })
const factory = moduleFactories.get('dsh-litnotes')
assert.ok(factory, 'bundle must register the dsh-litnotes module')
const fakeT = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key)
const plugin = factory((id) => {
  if (id === 'react') return FakeReact
  throw new Error(`unexpected require(${id})`)
})
assert.equal(typeof plugin.apply, 'function', 'clientMain must expose apply()')
let mainRegistration = null
let rootElement = null
plugin.apply({
  effect(fn) {
    const dispose = fn()
    return () => { if (typeof dispose === 'function') dispose() }
  },
  locale: { register: () => () => {}, bind: () => fakeT },
  slots: {
    inject: (key, callback) => {
      const dispose = callback()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    register: (options, component) => {
      if (options.name === 'main') mainRegistration = component
      return () => {}
    },
  },
})
assert.ok(mainRegistration, 'the main panel must be registered')
globalThis.__rootNode = createElement(mainRegistration, { t: fakeT })

// ---------------------------------------------------------------- the test
test('AI integration: tabs, quick actions, graph views, streaming and prefs', async (t) => {
  await settle(3)
  assert.ok(first('mru-root'), 'app must render')
  assert.equal(findAll('mru-doc').length, 2, 'library rail must show both documents')

  await t.test('opens the parsed paper', async () => {
    click(findAll('mru-doc')[0])
    await settle(14)
    assert.ok(first('mru-paper'), 'paper must render')
    assert.ok(findAll('mru-block').length >= 3, 'paper blocks must render')
  })

  await t.test('margin AI tab renders the panel and persists aiPanelOpen', async () => {
    const aiTab = findButtonByText('margin.ai')
    assert.ok(aiTab, 'margin AI tab must exist')
    click(aiTab)
    await settle(8)
    assert.ok(first('mru-ai'), 'AI panel surface must render')
    assert.ok(settingsUpdates.some((prefs) => prefs.aiPanelOpen === true), 'AI tab must persist aiPanelOpen')
    assert.ok(settingsUpdates.some((prefs) => prefs.marginTab === 'ai'), 'AI tab must persist marginTab')
  })

  await t.test('block 问 AI quick action opens the conversation with context', async () => {
    const askButtons = findAll('mru-block__ask')
    assert.ok(askButtons.length >= 1, 'block tools must expose 问 AI')
    click(askButtons[0])
    await settle(6)
    const aiTab = findButtonByText('margin.ai')
    assert.ok(aiTab, 'AI tab must exist')
    assert.equal(String(aiTab.attrs['aria-selected']), 'true', 'quick action must activate the AI tab')
    const panel = captured.get('MruAiPanel')
    assert.ok(calls.some((call) => call.method === 'chat.history'), 'the chat module must load history through the app transport')
    if (panel) {
      assert.equal(panel.documentId, DOC_ID, 'AI panel must receive the document id')
      assert.equal(typeof panel.streamChat, 'function', 'AI panel must receive streamChat')
      assert.equal(typeof panel.post, 'function', 'AI panel must receive post')
      assert.ok(panel.context && panel.context.visibleBlockKey, 'AI panel must receive a context block')
    }
  })

  await t.test('document graph view loads and streams a build', async () => {
    const graphButton = findButtonByText('reader.viewGraph')
    assert.ok(graphButton, 'runhead must expose the 图谱 view switch')
    click(graphButton)
    await settle(14)
    assert.ok(calls.some((call) => call.method === 'graph.doc'), 'opening the graph must fetch graph.doc')
    assert.ok(first('mru-graph'), 'graph surface must render')
    const graphView = captured.get('MruGraphView')
    if (graphView) {
      assert.equal(graphView.mode, 'doc', 'doc graph view must be in doc mode')
      graphView.onBuild()
    } else {
      const buildButton = findAll('mru-graph__actions').length
        ? first('mru-graph__actions').children.find((child) => child.nodeType === 1 && child.attrs['data-action'] === 'graph-build')
        : null
      const button = buildButton || (findAll('mru-graph').length ? findAll('mru-graph')[0].querySelector('[data-action="graph-build"]') : null)
      assert.ok(button, 'graph placeholder must expose a build action')
      click(button)
    }
    await settle(16)
    assert.ok(calls.some((call) => call.method === 'graph.build'), 'build must stream graph.build')
    const updated = captured.get('MruGraphView')
    if (updated) {
      assert.ok(updated.graph && Array.isArray(updated.graph.nodes) && updated.graph.nodes.length > 0, 'graph view must receive the built graph')
    } else {
      assert.match(textOf(first('mru-graph')), /graph\.nodes/, 'placeholder must reflect the built graph')
    }
  })

  await t.test('library graph view loads and rebuilds', async () => {
    const graphButton = findButtonByText('topbar.viewGraph')
    assert.ok(graphButton, 'topbar must expose the 全景图谱 view switch')
    click(graphButton)
    await settle(14)
    assert.ok(calls.some((call) => call.method === 'graph.library'), 'opening the library graph must fetch graph.library')
    assert.ok(first('mru-main--graph'), 'library graph must take the main column')
    assert.ok(first('mru-graph'), 'library graph surface must render')
    const graphView = captured.get('MruGraphView')
    if (graphView) {
      assert.equal(graphView.mode, 'library', 'library graph view must be in library mode')
      graphView.onBuild()
    } else {
      const button = first('mru-graph').querySelector('[data-action="graph-build"]')
      assert.ok(button, 'library graph placeholder must expose a rebuild action')
      click(button)
    }
    await settle(16)
    assert.ok(calls.some((call) => call.method === 'graph.library.rebuild'), 'rebuild must stream graph.library.rebuild')
    click(findButtonByText('topbar.viewLibrary'))
    await settle(6)
    assert.ok(!first('mru-main--graph'), 'returning to the library view must restore the desk')
  })

  await t.test('Cmd/Ctrl+J opens the AI conversation', async () => {
    const before = settingsUpdates.length
    const listeners = windowStub.listeners.get('keydown') || []
    assert.ok(listeners.length >= 1, 'app must install a keydown listener')
    for (const listener of listeners) {
      listener({
        key: 'j', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
        target: rootElement || tree[0], preventDefault() {}, stopPropagation() {},
      })
    }
    await settle(6)
    assert.ok(settingsUpdates.length > before, 'Cmd/Ctrl+J must persist AI panel state')
    assert.equal(settingsUpdates[settingsUpdates.length - 1].aiPanelOpen, true, 'Cmd/Ctrl+J must open the AI panel')
    assert.ok(first('mru-ai'), 'AI panel surface must be visible after Cmd/Ctrl+J')
  })

  await t.test('chat module contract: history, streaming frames and error mapping', async () => {
    const panel = captured.get('MruAiPanel')
    if (!panel) {
      // Placeholder module: the app integration is still asserted through props
      // captured by the fallback path in the previous steps.
      assert.ok(first('mru-ai'), 'fallback AI panel must remain rendered')
      return
    }
    const history = await panel.post('chat.history', { documentId: DOC_ID })
    assert.ok(history && Array.isArray(history.messages), 'post(chat.history) must resolve messages')
    const frames = []
    await panel.streamChat({ documentId: DOC_ID, question: 'What is attention?' }, { onFrame: (frame) => frames.push(frame) })
    assert.ok(frames.some((frame) => frame.type === 'start'), 'stream must deliver start')
    assert.ok(frames.some((frame) => frame.type === 'answer'), 'stream must deliver answer')
    assert.ok(frames.some((frame) => frame.type === 'done'), 'stream must deliver done')
    await assert.rejects(
      () => panel.streamChat({ documentId: DOC_ID, question: 'FAIL' }, { onFrame() {} }),
      (error) => error && error.code === 'ai-unavailable',
      'stream errors must surface the host error code',
    )
  })
})
