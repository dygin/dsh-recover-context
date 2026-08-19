/**
 * Composer tool-row affordance: when the agent is still answering the last
 * question (the premature-submit case), offer "edit this question" so the
 * user can pull it back into the composer, edit and resubmit — replacing the
 * wrong context instead of waiting for an answer they no longer want.
 * Registered into the `conversation.input.left` list slot.
 */
import { useState } from 'react'
import type { ClientContext } from './actions.ts'
import { beginEdit } from './actions.ts'
import { t } from './locales.ts'
import { analyzeComposerEdit, type SnapshotLike } from './snapshot.ts'

/** Owner (InputZone) + inject shares of the input.left entry. */
export interface ComposerEditProps {
  /** Owner share: point-in-time conversation snapshot. */
  session: SnapshotLike
  /** Inject share (session-scope slots receive the session id). */
  sessionId: string
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

const style: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  padding: 0,
  border: 'none',
  borderRadius: '50%',
  background: 'transparent',
  color: 'var(--text-color, inherit)',
  opacity: 0.7,
  cursor: 'pointer',
}

/** Public face: surfaces render-time crashes on the debug badge. */
export function ComposerEdit(props: ComposerEditProps & { ctx: ClientContext }): JSX.Element | null {
  try {
    return ComposerEditInner(props)
  } catch (error) {
    console.error('[dsh-recover-context] composer render error:', error)
    return null
  }
}

function ComposerEditInner(props: ComposerEditProps & { ctx: ClientContext }): JSX.Element | null {
  const { session, sessionId, ctx } = props
  const info = analyzeComposerEdit(session)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (info === null) return null

  const onClick = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      // Deferred edit: loads the question into the composer and arms the
      // submit interceptor; the context cut happens only on actual submit,
      // so a refresh before submit leaves the conversation untouched.
      await beginEdit(ctx, sessionId, info.userText, info.boundarySeq)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      title={error !== '' ? `${t('errorPrefix')}${error}` : t('edit')}
    >
      <button
        type="button"
        disabled={busy}
        style={style}
        onClick={() => { void onClick() }}
      >
        <EditIcon />
      </button>
    </span>
  )
}
