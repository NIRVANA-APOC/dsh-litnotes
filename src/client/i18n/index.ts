/**
 * Merged locale dictionaries. Each area file owns its keys in zh + en; this
 * module only merges them and declares the typed namespace used by `t()`.
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'
import * as base from './base.ts'
import * as reader from './read.ts'
import * as ai from './ai.ts'
import * as graph from './graph.ts'
import * as lib from './lib.ts'

export const zh = {
  ...base.zh,
  ...reader.zh,
  ...ai.zh,
  ...graph.zh,
  ...lib.zh,
}

export const en: Record<keyof typeof zh, string> = {
  ...base.en,
  ...reader.en,
  ...ai.en,
  ...graph.en,
  ...lib.en,
}

/** Key space of this plugin's locale namespace. */
export type LitnotesLocaleKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-litnotes': LitnotesLocaleKey
  }
}
