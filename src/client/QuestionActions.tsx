/**
 * 用户问题下方的纯图标操作行组件。
 *
 *   - ↶ 回退图标 — 回退到该问题提出前（丢弃该问题及其之后的所有对话上下文和
 *     工作区文件）。二次确认：首次点击切换为红色 ✓，再次点击执行。
 *   - ✎ 编辑图标 — 编辑该问题（仅在最新问题提供）：
 *     将文本载入输入框并装载提交拦截器；只有用户实际提交时才触发截断。
 */
import { useEffect, useRef, useState } from 'react'
import type { ClientContext } from './actions.ts'
import { beginEdit, rollbackBefore } from './actions.ts'
import { fallbackTranslate, type Translate } from './locales.ts'
import { analyzeQuestion, type ChatSnapshotLike } from './snapshot.ts'

/** 问题操作行属性定义 */
export interface QuestionActionsProps {
  node: {
    key: string
    anchorSeq: number
    data: { seq: number; time: number; content: readonly { type?: string; text?: string }[] }
  }
  /** Chat 快照选择器（DSH 0.2.1 标准会话 props） */
  useChat: <T>(selector: (snap: ChatSnapshotLike) => T) => T
  sessionId: string
  /** 框架 locale 命名空间绑定的翻译函数 */
  t?: Translate
}

/** 撤销/回滚图标 */
function UndoIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.2 6.5h5.3a3.5 3.5 0 0 1 0 7H5.5" />
      <path d="M6.8 3.6 3.6 6.5l3.2 2.9" />
    </svg>
  )
}

/** 编辑铅笔图标 */
function EditIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11.2 2.8 13.2 4.8 5.4 12.6l-3 .9.9-3z" />
      <path d="m10.2 3.8 2 2" />
    </svg>
  )
}

/** 勾选确认图标（回滚确认） */
function CheckIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-6.5" />
    </svg>
  )
}

const CONFIRM_TIMEOUT_MS = 6000
let warnedMissingHook = false

/** 包装组件：隔离捕获渲染异常 */
export function QuestionActions(props: QuestionActionsProps & { ctx: ClientContext }): JSX.Element | null {
  try {
    return QuestionActionsInner(props)
  } catch (error) {
    console.error('[dsh-recover-context] question-actions 渲染错误:', error)
    return null
  }
}

function QuestionActionsInner(props: QuestionActionsProps & { ctx: ClientContext }): JSX.Element | null {
  const { node, sessionId, useChat, ctx } = props
  const t = props.t ?? fallbackTranslate
  if (typeof useChat !== 'function') {
    if (!warnedMissingHook) {
      warnedMissingHook = true
      console.error('[dsh-recover-context] 未获取到 useChat 标准钩子')
    }
    return null
  }
  const info = useChat(snap => analyzeQuestion(snap, node.key))
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
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
    setNotice('')
    try {
      const result = await rollbackBefore(ctx, sessionId, info.boundarySeq)
      // 回退成功后组件通常随即卸载（导航到新会话）；若仍在原会话上，
      // 用一行摘要说明恢复了什么、删掉了什么，避免「看起来没生效」。
      const restore = result.restore
      if (restore.mode === 'none') {
        setNotice(t('rollbackNone'))
      } else {
        const skipped = restore.skipped.length > 0 ? t('rollbackSkipped', { skipped: restore.skipped.length }) : ''
        const warned = (restore.warnings ?? []).length > 0 ? t('rollbackWarned', { warning: (restore.warnings ?? [])[0] }) : ''
        setNotice(`${t('rollbackResult', {
          restored: restore.restored.length,
          deleted: restore.deleted.length,
        })}${skipped}${warned}`)
      }
      setBusy(false)
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
      // 载入草稿后必须给出可见反馈，否则用户会以为点击无效。
      setNotice(t('editDraftReady'))
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

  const message = error !== ''
    ? `${t('errorPrefix')}${error}`
    : notice !== '' ? notice : undefined
  const hasMessage = message !== undefined

  return (
    <div
      style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4, margin: '1px 0', minHeight: 22 }}
      data-recover-question-actions={`t${info.turn}`}
      title={message}
    >
      {hasMessage && (
        <span
          data-recover-status={error !== '' ? 'error' : 'notice'}
          style={{
            fontSize: 11,
            lineHeight: 1.4,
            opacity: 0.75,
            color: error !== '' ? '#d9534f' : 'inherit',
            maxWidth: 420,
          }}
        >
          {message}
        </span>
      )}
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
