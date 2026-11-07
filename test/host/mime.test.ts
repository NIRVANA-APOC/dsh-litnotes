/**
 * Unit tests for the Host file-type map (`src/host/mime.ts`): extension
 * extraction, the source whitelist, image detection and content types.
 */

import { test } from 'vitest'
import { expect } from 'vitest'

import {
  IMAGE_EXTENSIONS,
  SUPPORTED_EXTENSIONS,
  extOf,
  isImagePath,
  isSupportedSource,
  mimeForPath,
} from '../../src/host/mime.ts'

test('extOf lowercases the last extension and rejects odd names', () => {
  expect(extOf('paper.PDF')).toBe('.pdf')
  expect(extOf('/tmp/dir/Paper.Docx')).toBe('.docx')
  expect(extOf('C:\\tmp\\paper.PnG')).toBe('.png')
  expect(extOf('paper.tar.gz')).toBe('.gz')
  expect(extOf('README')).toBe('')
  expect(extOf('.gitignore')).toBe('')
  expect(extOf('trailing.')).toBe('')
  expect(extOf('')).toBe('')
  expect(extOf(undefined)).toBe('')
  expect(extOf(42)).toBe('')
})

test('mimeForPath maps known types and falls back to octet-stream', () => {
  expect(mimeForPath('paper.pdf')).toBe('application/pdf')
  expect(mimeForPath('feat.docx')).toBe(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  )
  expect(mimeForPath('fig.png')).toBe('image/png')
  expect(mimeForPath('fig.svg')).toBe('image/svg+xml')
  expect(mimeForPath('style.css')).toBe('text/css; charset=utf-8')
  expect(mimeForPath('font.woff2')).toBe('font/woff2')
  expect(mimeForPath('unknown.xyz')).toBe('application/octet-stream')
  expect(mimeForPath(undefined)).toBe('application/octet-stream')
})

test('the supported source whitelist matches the MinerU upload list', () => {
  for (const ext of [
    '.pdf',
    '.doc',
    '.docx',
    '.ppt',
    '.pptx',
    '.xls',
    '.xlsx',
    '.png',
    '.jpg',
    '.jpeg',
    '.jp2',
    '.webp',
    '.gif',
    '.bmp',
    '.html',
    '.htm',
  ]) {
    expect(SUPPORTED_EXTENSIONS.has(ext)).toBe(true)
    expect(isSupportedSource(`file${ext}`)).toBe(true)
  }
  expect(isSupportedSource('notes.txt')).toBe(false)
  expect(isSupportedSource('archive.zip')).toBe(false)
  expect(isSupportedSource(undefined)).toBe(false)
  // Bare names never pass; the extension is required.
  expect(isSupportedSource('pdf')).toBe(false)
})

test('image detection includes svg and excludes source-only types', () => {
  for (const ext of IMAGE_EXTENSIONS) {
    expect(isImagePath(`asset${ext}`)).toBe(true)
  }
  expect(isImagePath('paper.pdf')).toBe(false)
  expect(isImagePath('paper.docx')).toBe(false)
  expect(isImagePath(undefined)).toBe(false)
  // The wider image set is exposed for the asset route.
  expect(IMAGE_EXTENSIONS.has('.svg')).toBe(true)
})
