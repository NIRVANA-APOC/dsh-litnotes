/**
 * Reader-test helpers (port of `.agents/baseline-1.0.0/test/reader/helpers.mjs`).
 *
 * `assertModelIntegrity` asserts the structural invariants every reader model
 * must satisfy. The 1.0.0 helper inspected plain JS objects; the 2.0 model is a
 * typed discriminated union, so the helper narrows per kind and additionally
 * checks the uniform `page`/`plainText` base fields.
 */

import { expect } from 'vitest'

import { runsText } from '../../src/shared/markdown/model.ts'
import type { Block, PaperModel } from '../../src/shared/markdown/model.ts'

/** Read one block, failing the test when the index is out of range. */
export function blockAt(model: PaperModel, index: number): Block {
  const block = model.blocks[index]
  if (block === undefined) throw new Error(`model has no block at index ${index}`)
  return block
}

/** All blocks of one kind (narrowed). */
export function blocksOfKind<K extends Block['kind']>(
  model: PaperModel,
  kind: K,
): Array<Extract<Block, { kind: K }>> {
  return model.blocks.filter((block): block is Extract<Block, { kind: K }> => block.kind === kind)
}

/**
 * Assert the structural invariants every reader model must satisfy.
 *
 * Plain `parseMarkdown()` models have `index === position`. Models returned by
 * `appendPageMarks()` keep the originals' index/key untouched and add synthetic
 * page blocks, so positional indices only hold for unmarked models.
 */
export function assertModelIntegrity(model: PaperModel): void {
  expect(model !== null && typeof model === 'object').toBe(true)
  expect(Array.isArray(model.blocks)).toBe(true)
  expect(Array.isArray(model.outline)).toBe(true)
  expect(Object.keys(model.stats).sort()).toEqual(['blocks', 'chars', 'headings', 'words'])
  const pageMarked = model.blocks.some((block) => block.kind === 'page')
  const keys = new Set<string>()
  const byKey = new Map<string, Block>()
  for (let index = 0; index < model.blocks.length; index += 1) {
    const block = blockAt(model, index)
    expect(Number.isInteger(block.page) || block.page === null).toBe(true)
    if (!pageMarked) expect(block.index).toBe(index)
    else expect(Number.isInteger(block.index)).toBe(true)
    if (block.kind === 'page') {
      expect(block.key).toMatch(/^page:\d+:\d+$/)
      // 2.0 contract: page marks carry the uniform base field as ''.
      expect(block.plainText).toBe('')
    } else {
      expect(block.key).toMatch(/^b\d+:[0-9a-f]{8}$/)
    }
    expect(keys.has(block.key)).toBe(false)
    keys.add(block.key)
    byKey.set(block.key, block)
    if (block.kind !== 'page' && 'runs' in block) {
      expect(block.plainText).toBe(runsText(block.runs))
    }
    if (block.kind === 'list') {
      expect(Array.isArray(block.items)).toBe(true)
      expect(block.items.length).toBeGreaterThan(0)
      let cumulative = 0
      for (const item of block.items) {
        expect(Array.isArray(item.runs)).toBe(true)
        expect(item.plainText).toBe(runsText(item.runs))
        if (!pageMarked) {
          expect(block.plainText.slice(cumulative, cumulative + item.plainText.length)).toBe(item.plainText)
        }
        cumulative += item.plainText.length
      }
    }
    if (block.kind === 'table') {
      expect(Array.isArray(block.head)).toBe(true)
      expect(Array.isArray(block.rows)).toBe(true)
      const cells = block.head.concat(block.rows.flat())
      for (const cell of cells) {
        expect(cell.plainText).toBe(runsText(cell.runs))
        expect(Number.isInteger(cell.colspan) && cell.colspan >= 1).toBe(true)
        expect(Number.isInteger(cell.rowspan) && cell.rowspan >= 1).toBe(true)
      }
    }
  }
  for (const entry of model.outline) {
    const block = byKey.get(entry.key)
    expect(block).toBeDefined()
    if (block === undefined) continue
    expect(block.kind).toBe('heading')
    expect(block.index).toBe(entry.blockIndex)
  }
  expect(model.stats.blocks).toBe(model.blocks.length)
  expect(model.stats.headings).toBe(model.outline.length)
}

/** Page numbers of the inserted page marks, in block order. */
export function pageNumbers(model: PaperModel): number[] {
  return model.blocks.filter((block) => block.kind === 'page').map((block) => block.page)
}

/** Positions of the inserted page marks, in block order. */
export function pagePositions(model: PaperModel): number[] {
  const positions: number[] = []
  for (let index = 0; index < model.blocks.length; index += 1) {
    if (model.blocks[index]?.kind === 'page') positions.push(index)
  }
  return positions
}

/** Narrow one block to a specific kind (fails the test when it is a different kind). */
export function blockAs<K extends Block['kind']>(block: Block, kind: K): Extract<Block, { kind: K }> {
  if (block.kind !== kind) throw new Error(`expected a ${kind} block, got ${block.kind}`)
  return block as Extract<Block, { kind: K }>
}

/** First block of the given kind (fails the test when absent). */
export function firstBlockOfKind<K extends Block['kind']>(
  model: PaperModel,
  kind: K,
): Extract<Block, { kind: K }> {
  const block = model.blocks.find((candidate): candidate is Extract<Block, { kind: K }> => candidate.kind === kind)
  if (block === undefined) throw new Error(`expected a ${kind} block`)
  return block
}
