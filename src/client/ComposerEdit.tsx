/**
 * 输入框工具栏操作组件：
 * 当 Agent 仍在回答上一问题时（误提交场景），提供“编辑此问题”按钮，
 * 用户可将问题拉回输入框修改重发 — 取代错误上下文，而无需苦等不再需要的回答生成完毕。
 * 注册至 `conversation.input.left` 插槽。
 */
import { useState } from 'react'
import type { ClientContext } from './actions.ts'
import { beginEdit } from './actions.ts'
import { t } from './locales.ts'
import { analyzeComposerEdit, type SnapshotLike } from './snapshot.ts'

/** 输入框左侧插槽属性 */
export interface ComposerEditProps {
  /** 会话快照 */
  session: SnapshotLike
  /** 会话 ID */
  sessionId: string
}

/** 铅笔图标 */
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

/** 包装组件：隔离捕获渲染异常 */
export function ComposerEdit(props: ComposerEditProps & { ctx: ClientContext }): JSX.Element | null {
  try {
    return ComposerEditInner(props)
  } catch (error) {
    console.error('[dsh-recover-context] composer 渲染错误:', error)
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
      // 延迟编辑模式：载入问题到输入框并装载提交拦截器
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
