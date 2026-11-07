/** Small formatting helpers shared by the frame and scenes. */

/** Locale key of one parse engine's status-bar label. */
export function engineLabelKey(engine: string | null | undefined): string {
  if (engine === 'standard') return 'status.engine.standard'
  if (engine === 'agent') return 'status.engine.agent'
  if (engine === 'local') return 'status.engine.local'
  return 'status.engine.none'
}

/** Data attribute for the status dot. */
export function statusDot(status: string | null | undefined): 'none' | 'parsing' | 'parsed' | 'failed' | 'uploaded' {
  if (status === 'parsed' || status === 'parsing' || status === 'failed' || status === 'uploaded') return status
  return 'none'
}

/** Locale key of one document status label. */
export function statusLabelKey(status: string | null | undefined): string {
  if (status === 'parsed') return 'rail.status.parsed'
  if (status === 'parsing') return 'rail.status.parsing'
  if (status === 'failed') return 'rail.status.failed'
  return 'rail.status.uploaded'
}

/** Format an integer with the user's locale grouping. */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat().format(value)
}
