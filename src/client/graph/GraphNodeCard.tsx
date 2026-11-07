/**
 * Selected-node card rendered in the margin seat (same position as the read
 * scene's margin).
 *
 * The card is the single place where a node is curated; actions keep the fixed
 * order 重命名 · 合并到… · 固定位置/取消固定 · 问 AI · 跳到原文 (DESIGN-V2 §5)
 * so the control never jumps around. Library-scope nodes show their related
 * papers instead of document-scope curation.
 */

import type { ReactElement } from 'react'
import { useEffect, useMemo, useState } from 'react'

import type { DocumentSummary, GraphNode } from '../../shared/model.ts'
import { AspectDot, Badge, Button, IconButton, TextInput } from '../design/primitives.tsx'
import { useT } from '../shell/locale-context.ts'
import { mergeCandidates, nodeInk, type GraphScope, type Point } from './model.ts'
import { useGraphStore } from './store.ts'

/** Props of the node card. */
export interface GraphNodeCardProps {
  node: GraphNode
  scope: GraphScope
  /** All nodes of the active graph (merge candidates). */
  nodes: readonly GraphNode[]
  /** Current world position (pin action); `null` before the layout exists. */
  position: Point | null
  /** Library documents (resolving `node.documentIds`). */
  documents: readonly DocumentSummary[]
  onClose: () => void
  onJump: (node: GraphNode) => void
  /** Jump to one specific provenance block. */
  onJumpBlock: (blockKey: string) => void
  onOpenPaper: (documentId: string) => void
  onAsk: (node: GraphNode) => void
}

/** Visible provenance block keys on the card. */
const MAX_VISIBLE_BLOCKS = 3

/** One node card. */
export function GraphNodeCard(props: GraphNodeCardProps): ReactElement {
  const t = useT()
  const { node, scope, nodes, position, documents, onClose, onJump, onJumpBlock, onOpenPaper, onAsk } = props
  const curate = useGraphStore((state) => state.curate)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(node.label)
  const [saving, setSaving] = useState(false)
  const [mergeStep, setMergeStep] = useState<'idle' | 'pick' | 'confirm'>('idle')
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null)

  // A different node resets every transient editor state.
  useEffect(() => {
    setEditing(false)
    setDraft(node.label)
    setMergeStep('idle')
    setMergeTargetId(null)
    setSaving(false)
  }, [node.id, node.label])

  const pinned = node.pinned === true
  const ink = nodeInk(node)
  const candidates = useMemo(() => mergeCandidates(nodes, node.id).slice(0, 12), [nodes, node.id])
  const mergeTarget = mergeTargetId === null ? null : nodes.find((candidate) => candidate.id === mergeTargetId) ?? null
  const relatedPapers = useMemo(() => {
    if (scope !== 'library') return []
    const ids = node.documentIds ?? []
    const resolved = ids
      .map((id) => documents.find((document) => document.id === id))
      .filter((document): document is DocumentSummary => document !== undefined)
    if (resolved.length > 0) return resolved
    // Aggregate nodes may only carry block provenance; offer every parsed paper.
    return documents.filter((document) => document.status === 'parsed').slice(0, 8)
  }, [scope, node.documentIds, documents])
  const visibleBlocks = node.blockKeys.slice(0, MAX_VISIBLE_BLOCKS)
  const hiddenBlockCount = Math.max(0, node.blockKeys.length - MAX_VISIBLE_BLOCKS)

  const saveRename = async (): Promise<void> => {
    const label = draft.trim()
    if (label === '' || label === node.label) {
      setEditing(false)
      setDraft(node.label)
      return
    }
    setSaving(true)
    const ok = await curate('rename', { id: node.id, label })
    setSaving(false)
    if (ok) setEditing(false)
  }

  const togglePin = async (): Promise<void> => {
    if (pinned) {
      await curate('unpin', { id: node.id })
      return
    }
    if (position === null) return
    await curate('pin', { id: node.id, position })
  }

  const confirmMerge = async (): Promise<void> => {
    if (mergeTarget === null) return
    setSaving(true)
    const ok = await curate('merge', { from: node.id, into: mergeTarget.id })
    setSaving(false)
    if (ok) {
      setMergeStep('idle')
      setMergeTargetId(null)
    }
  }

  return (
    <section className="ln-gnode" aria-label={t('graph.card.title')} data-node-type={node.type}>
      <header className="ln-gnode__head">
        <span className="ln-gnode__type">
          {ink === 'ink' ? null : <AspectDot aspect={ink} />}
          {t(`graph.node.${node.type}` as 'graph.node.concept')}
          {node.curated === true ? <Badge tone="neutral">{t('graph.card.source')}</Badge> : null}
        </span>
        <IconButton icon="close" label={t('graph.card.close')} size={15} onClick={onClose} />
      </header>

      {editing ? (
        <form
          className="ln-gnode__rename"
          onSubmit={(event) => {
            event.preventDefault()
            void saveRename()
          }}
        >
          <TextInput
            autoFocus
            value={draft}
            aria-label={t('graph.rename.placeholder')}
            placeholder={t('graph.rename.placeholder')}
            maxLength={80}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setEditing(false)
                setDraft(node.label)
              }
            }}
          />
          <Button type="submit" variant="primary" size="sm" disabled={saving || draft.trim() === ''}>
            {t('graph.rename.save')}
          </Button>
        </form>
      ) : (
        <h3 className="ln-gnode__label">{node.label}</h3>
      )}

      {node.summary !== '' ? <p className="ln-gnode__summary">{node.summary}</p> : null}

      {node.blockKeys.length > 0 ? (
        <div className="ln-gnode__prov">
          <span className="ln-gnode__provlabel">{t('graph.card.source')}</span>
          <div className="ln-gnode__blocks">
            {visibleBlocks.map((blockKey) => (
              <button
                key={blockKey}
                type="button"
                className="ln-gnode__block"
                title={blockKey}
                onClick={() => onJumpBlock(blockKey)}
              >
                {blockKey}
              </button>
            ))}
            {hiddenBlockCount > 0 ? (
              <span className="ln-gnode__more">{t('graph.card.moreBlocks', { count: hiddenBlockCount })}</span>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="ln-gnode__provlabel">{t('graph.card.noSource')}</p>
      )}

      <div className="ln-gnode__actions" role="group" aria-label={t('graph.card.title')}>
        {scope === 'doc' ? (
          <>
            <Button variant="ghost" size="sm" icon="edit" disabled={saving} onClick={() => setEditing(true)}>
              {t('graph.action.rename')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon="merge"
              disabled={saving || editing || candidates.length === 0}
              onClick={() => setMergeStep(mergeStep === 'idle' ? 'pick' : 'idle')}
            >
              {t('graph.action.merge')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon="pin"
              aria-pressed={pinned}
              disabled={saving || (!pinned && position === null)}
              onClick={() => void togglePin()}
            >
              {pinned ? t('graph.action.unpin') : t('graph.action.pin')}
            </Button>
          </>
        ) : null}
        <Button variant="ghost" size="sm" icon="sparkle" disabled={saving} onClick={() => onAsk(node)}>
          {t('graph.action.ask')}
        </Button>
        <Button variant="ghost" size="sm" icon="arrowRight" disabled={saving} onClick={() => onJump(node)}>
          {t('graph.action.jump')}
        </Button>
      </div>

      {mergeStep !== 'idle' ? (
        <div className="ln-gnode__merge" role="group" aria-label={t('graph.merge.pick')}>
          {mergeStep === 'pick' ? (
            <>
              <span className="ln-gnode__provlabel">{t('graph.merge.pick')}</span>
              {candidates.length === 0 ? (
                <p className="ln-gnode__more">{t('graph.merge.none')}</p>
              ) : (
                <div className="ln-gnode__candidates">
                  {candidates.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      className="ln-gnode__candidate"
                      onClick={() => {
                        setMergeTargetId(candidate.id)
                        setMergeStep('confirm')
                      }}
                    >
                      <span>{candidate.label}</span>
                      <span className="ln-gnode__candidateType">{t(`graph.node.${candidate.type}` as 'graph.node.concept')}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            mergeTarget !== null ? (
              <div className="ln-gnode__mergeConfirm">
                <p className="ln-gnode__more">
                  {t('graph.merge.confirm', { label: node.label, into: mergeTarget.label })}
                </p>
                <div className="ln-gnode__mergeButtons">
                  <Button variant="primary" size="sm" disabled={saving} onClick={() => void confirmMerge()}>
                    {saving ? t('graph.merge.saving') : t('action.confirm')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                    onClick={() => {
                      setMergeStep('pick')
                      setMergeTargetId(null)
                    }}
                  >
                    {t('action.cancel')}
                  </Button>
                </div>
              </div>
            ) : null
          )}
        </div>
      ) : null}

      {scope === 'library' ? (
        <div className="ln-gnode__papers">
          <span className="ln-gnode__provlabel">{t('graph.card.papers')}</span>
          {relatedPapers.length === 0 ? (
            <p className="ln-gnode__more">{t('graph.card.noSource')}</p>
          ) : (
            <ul className="ln-gnode__paperlist">
              {relatedPapers.map((document) => (
                <li key={document.id} className="ln-gnode__paper">
                  <button
                    type="button"
                    className="ln-gnode__paperTitle"
                    onClick={() => onOpenPaper(document.id)}
                  >
                    {document.title}
                  </button>
                  <Button variant="quiet" size="sm" onClick={() => onOpenPaper(document.id)}>
                    {t('graph.card.openPaper')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  )
}
