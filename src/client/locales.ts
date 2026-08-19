/**
 * Minimal zh/en copy for the recover-context buttons. The active locale is
 * read from the locale service at client start and on locale switches
 * (module-level flag — same pattern as dsh-context's attachLocale).
 */

const ZH: Record<string, string> = {
  rollback: '回退到此',
  rollbackConfirm: '确认回退？将丢弃此后的对话并还原工作区文件',
  rollbackConfirmShort: '确认回退？',
  rollbackBusy: '回退中…',
  rollbackResult: '已回退：还原 {restored} 个文件，删除 {deleted} 个',
  rollbackSkipped: '（{skipped} 个文件因过大未能还原）',
  rollbackNone: '此会话没有可还原的文件记录',
  edit: '编辑此问题',
  editBusy: '处理中…',
  errorPrefix: '操作失败：',
  cancel: '取消',
}

const EN: Record<string, string> = {
  rollback: 'Roll back here',
  rollbackConfirm: 'Confirm rollback? This discards later turns and restores workspace files',
  rollbackConfirmShort: 'Confirm?',
  rollbackBusy: 'Rolling back…',
  rollbackResult: 'Rolled back: restored {restored} files, deleted {deleted}',
  rollbackSkipped: ' ({skipped} files skipped: too large)',
  rollbackNone: 'No restorable file records for this session',
  edit: 'Edit this question',
  editBusy: 'Working…',
  errorPrefix: 'Failed: ',
  cancel: 'Cancel',
}

let zh = true

/** Bind the module-level locale flag to the locale service (disposer). */
export function attachLocale(locale: {
  getSnapshot(): { active: string }
  subscribe(fn: () => void): () => void
}): () => void {
  const sync = (): void => { zh = locale.getSnapshot().active === 'zh' }
  sync()
  const off = locale.subscribe(sync)
  return off
}

/** Translate one key with optional {placeholders}. */
export function t(key: string, params?: Record<string, string | number>): string {
  const table = zh ? ZH : EN
  let text = table[key] ?? key
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}
