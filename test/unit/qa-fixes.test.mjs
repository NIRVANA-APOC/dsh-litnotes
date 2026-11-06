/**
 * Regression tests for QA findings on the shared service's quote-located
 * annotations and the library store's per-document stale-file cleanup.
 *
 * The annotation locator must use the CLIENT parser's block model
 * (`ui/markdown.js`) so the `b<index>:<hash>` anchors it writes are the same
 * keys the reader renders.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, clearToken as resetMemoryToken } from '../../lib/config.js'
import { createService } from '../../lib/service.js'
import { createStore } from '../../lib/store.js'
import { parseMarkdown } from '../../ui/markdown.js'

/** Credentials stub: this suite never stores a token. */
function makeCredentials() {
  return {
    async readRecord() {
      return undefined
    },
    async describeRecord() {
      return { configured: false, writable: true }
    },
    async modifyRecord() {
      return undefined
    },
    async deleteRecord() {},
  }
}

async function setup() {
  await resetMemoryToken(undefined)
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-litnotes-qa-'))
  const config = resolveConfig({ dataDir, apiBase: 'https://api.mineru.test' })
  const store = createStore({ dataDir })
  await store.init()
  const manager = {
    async start() {
      throw new Error('not used')
    },
    async cancel() {
      throw new Error('not used')
    },
    async resume() {},
    async dispose() {},
  }
  const service = createService({
    store,
    manager,
    config,
    logger: { warn() {}, info() {} },
    hostVersion: '0.1.0+host',
    getCredentials: () => makeCredentials(),
    getTranslator: () => undefined,
    getLlm: () => undefined,
    getDefaultModel: () => undefined,
  })
  return { dataDir, store, service }
}

async function teardown(env) {
  await env.store.dispose()
  await rm(env.dataDir, { recursive: true, force: true })
}

async function addParsedDocument(env, markdown) {
  const id = randomUUID()
  const tempPath = env.store.newTempPath(id)
  await writeFile(tempPath, '%PDF-1.4 qa')
  const meta = await env.store.createFromFile({ id, tempPath, originalName: 'qa.pdf' })
  const parsedDir = env.store.parsedDir(meta.id)
  await mkdir(parsedDir, { recursive: true })
  await writeFile(join(parsedDir, 'full.md'), markdown)
  return env.store.update(meta.id, { status: 'parsed' })
}

/** The parser block that owns a substring, with its canonical key. */
function blockOwning(model, needle) {
  return model.blocks.find((block) => typeof block.plainText === 'string' && block.plainText.includes(needle))
}

test('annotate(quote) uses the client parser keys for blockquotes (no merged-block drift)', async () => {
  const env = await setup()
  try {
    const markdown = [
      '## Findings',
      '',
      '> First claim line one.',
      '> First claim line two.',
      '',
      '> Second claim is separate.',
      '',
      'A paragraph after both quotes anchors the index.',
      '',
    ].join('\n')
    const doc = await addParsedDocument(env, markdown)
    const model = parseMarkdown(markdown)

    const first = await env.service.toolAnnotate(doc.id, { quote: 'First claim line one.' })
    assert.equal(first.annotation.blockKey, blockOwning(model, 'First claim line one.').key)

    const second = await env.service.toolAnnotate(doc.id, { quote: 'Second claim is separate.' })
    assert.equal(second.annotation.blockKey, blockOwning(model, 'Second claim is separate.').key)

    const paragraph = await env.service.toolAnnotate(doc.id, { quote: 'A paragraph after both quotes' })
    assert.equal(paragraph.annotation.blockKey, blockOwning(model, 'A paragraph after both quotes').key)
    assert.notEqual(first.annotation.blockKey, second.annotation.blockKey)
  } finally {
    await teardown(env)
  }
})

test('annotate(quote) uses the client parser keys for list blocks and offsets', async () => {
  const env = await setup()
  try {
    const markdown = ['- alpha beta', '- gamma delta', ''].join('\n')
    const doc = await addParsedDocument(env, markdown)
    const model = parseMarkdown(markdown)
    const block = blockOwning(model, 'gamma delta')
    assert.ok(block, 'parser must produce a list block containing the item text')

    const result = await env.service.toolAnnotate(doc.id, { quote: 'gamma delta' })
    assert.equal(result.annotation.blockKey, block.key)
    assert.equal(block.plainText.slice(result.annotation.start, result.annotation.end), 'gamma delta')
  } finally {
    await teardown(env)
  }
})

test('annotate(quote) uses the client parser keys for table cells', async () => {
  const env = await setup()
  try {
    const markdown = [
      '<table>',
      '<tr><th>Model</th><th>Recall</th></tr>',
      '<tr><td>Ours</td><td>Exact 42</td></tr>',
      '</table>',
      '',
    ].join('\n')
    const doc = await addParsedDocument(env, markdown)
    const model = parseMarkdown(markdown)
    const block = blockOwning(model, 'Exact 42')
    assert.ok(block, 'parser must produce a table block containing the cell text')

    const result = await env.service.toolAnnotate(doc.id, { quote: 'Exact 42' })
    assert.equal(result.annotation.blockKey, block.key)
    assert.equal(block.plainText.slice(result.annotation.start, result.annotation.end), 'Exact 42')
  } finally {
    await teardown(env)
  }
})

test('annotate(quote) refuses an ambiguous quote with a clear code', async () => {
  const env = await setup()
  try {
    const doc = await addParsedDocument(env, 'repeat me once.\n\nrepeat me twice.\n')
    await assert.rejects(
      () => env.service.toolAnnotate(doc.id, { quote: 'repeat me' }),
      (error) => error && error.code === 'bad-request',
    )
  } finally {
    await teardown(env)
  }
})

test('store init removes interrupted-operation leftovers inside a document directory', async () => {
  const env = await setup()
  let dataDir = env.dataDir
  try {
    const id = randomUUID()
    const tempPath = env.store.newTempPath(id)
    await writeFile(tempPath, '%PDF-1.4 qa')
    const meta = await env.store.createFromFile({ id, tempPath, originalName: 'stale.pdf' })
    const docDir = env.store.docDir(meta.id)
    // Real artifact names produced by writeFileAtomic and writeStagedParsed.
    await writeFile(join(docDir, `.meta.json.tmp-1234-${randomUUID()}`), 'partial')
    await writeFile(join(docDir, 'upload.part'), 'partial')
    await mkdir(join(docDir, `.parsed-${randomUUID()}`), { recursive: true })
    await env.store.dispose()

    const reopened = createStore({ dataDir })
    await reopened.init()
    try {
      const names = await readdir(docDir)
      assert.ok(!names.includes('upload.part'))
      assert.ok(!names.some((name) => /^\.meta\.json\.tmp-/.test(name)))
      assert.ok(!names.some((name) => /^\.parsed-/.test(name)))
      assert.equal(reopened.get(meta.id).originalName, 'stale.pdf')
    } finally {
      await reopened.dispose()
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})
