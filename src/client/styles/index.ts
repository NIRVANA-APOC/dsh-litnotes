/**
 * Style aggregation: every stylesheet is compiled to a minified string at
 * build time and injected once by the client plugin. Add area imports here as
 * scene styles land (Lead-owned file; ask before editing).
 */

import tokens from './tokens.css'
import base from './base.css'
import primitives from './primitives.css'
import frame from './frame.css'

export const CSS: string = [tokens, base, primitives, frame].join('\n')
