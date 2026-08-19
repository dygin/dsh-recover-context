/**
 * Icon-only action row rendered UNDER each user question:
 *
 *   - ↶ undo icon — roll back before this question (discard the question and
 *     everything after it, context AND workspace files). Two-step: first
 *     click arms a red ✓ confirm, second click executes.
 *   - ✎ pencil icon — edit this question (only on the most recent one):
 *     loads the text into the composer and arms the submit interceptor; the
 *     cut happens only when the user actually submits (a refresh before
 *     submit leaves the conversation untouched).
 *
 * Rendered by the plugin's own `recover-actions` conversation node kind,
 * registered into the keyed `conversation.chat.node` slot.
 */
import { useEffect, useRef, useState } from 'react'
import type { ClientContext } from './actions.ts'
import { beginEdit, rollbackBefore } from './actions.ts'
import { t } from './locales.ts'
import { analyzeQuestion, type SnapshotLike } from './snapshot.ts'

/** Keyed-slot props for the recover-actions renderer. */
export interface QuestionActionsProps {
  node: {
    key: string
    anchorSeq: number
    data: { seq: number; time: number; content: readonly { type?: string; text?: string }[] }
  }
  useSession: <T>(selector: (snap: SnapshotLike) => T) => T
  sessionId: string
}

/** Undo/rewind glyph. */
function UndoIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.2 6.5h5.3a3.5 3.5 0 0 1 0 7H5.5" />
      <path d="M6.8 3.6 3.6 6.5l3.2 2.9" />
    </svg>
  )
}

/** Pencil glyph. */
function EditIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11.2 2.8 13.2 4.8 5.4 12.6l-3 .9.9-3z" />
      <path d="m10.2 3.8 2 2" />
    </svg>
  )
}

/** Checkmark glyph (armed rollback confirmation). */
function CheckIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-6.5" />
    </svg>
  )
}

const CONFIRM_TIMEOUT_MS = 6000
let warnedMissingUseSession = false

/** Public face: surfaces render-time crashes on the debug badge. */
export function QuestionActions(props: QuestionActionsProps & { ctx: ClientContext }): JSX.Element | null {
  try {
    return QuestionActionsInner(props)
  } catch (error) {
    console.error('[dsh-recover-context] question-actions render error:', error)
    return null
  }
}

function QuestionActionsInner(props: QuestionActionsProps & { ctx: ClientContext }): JSX.Element | null {
  const { node, sessionId, useSession, ctx } = props
  if (typeof useSession !== 'function') {
    if (!warnedMissingUseSession) {
      warnedMissingUseSession = true
      console.error('[dsh-recover-context] useSession not delivered to the question-actions entry (standard kit missing?)')
    }
    return null
  }
  const info = useSession(snap => analyzeQuestion(snap, node.key))
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!confirming) return
    confirmTimer.current = setTimeout(() => setConfirming(false), CONFIRM_TIMEOUT_MS)
    return () => { if (confirmTimer.current !== undefined) clearTimeout(confirmTimer.current) }
  }, [confirming])

  if (info === null) return null
  const canEdit = info.isLastQuestion

  const onRollbackClick = async (): Promise<void> => {
    if (busy) return
    if (!confirming) {
      setConfirming(true)
      return
    }
    setConfirming(false)
    setBusy(true)
    setError('')
    try {
      await rollbackBefore(ctx, sessionId, info.boundarySeq)
      // navigation switches sessions and unmounts this component
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(false)
    }
  }

  const onEditClick = async (): Promise<void> => {
    if (busy || !canEdit) return
    setBusy(true)
    setError('')
    try {
      await beginEdit(ctx, sessionId, info.userText, info.boundarySeq)
      setBusy(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(false)
    }
  }

  const iconButton: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 22,
    padding: 0,
    border: 'none',
    borderRadius: '50%',
    background: 'transparent',
    color: 'var(--text-color, inherit)',
    opacity: 0.55,
    cursor: 'pointer',
  }
  const confirmButton: React.CSSProperties = {
    ...iconButton,
    color: '#fff',
    background: '#d9534f',
    opacity: 1,
  }

  return (
    <div
      style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 2, margin: '1px 0', height: 22 }}
      data-recover-question-actions={`t${info.turn}`}
      title={error !== '' ? `${t('errorPrefix')}${error}` : undefined}
    >
      <button
        type="button"
        className="rc-icon-btn"
        disabled={busy}
        style={confirming ? confirmButton : iconButton}
        title={confirming ? t('rollbackConfirm') : t('rollback')}
        onClick={() => { void onRollbackClick() }}
      >
        {confirming ? <CheckIcon /> : <UndoIcon />}
      </button>
      {canEdit && (
        <button
          type="button"
          className="rc-icon-btn"
          disabled={busy}
          style={iconButton}
          title={t('edit')}
          onClick={() => { void onEditClick() }}
        >
          <EditIcon />
        </button>
      )}
    </div>
  )
}
