/**
 * recover-context 按钮的中英文文案。
 *
 * 通过 `ctx.locale.register(NS, { zh, en })` 注册字典命名空间；注册插槽时传
 * `locale: NS`，框架会把绑定好的 `t` 作为组件 props 下发。
 */

/** 本插件拥有的字典命名空间 */
export const NS = 'recover-context'

export const ZH: Record<string, string> = {
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

export const EN: Record<string, string> = {
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

/** 翻译函数（由框架 locale 命名空间绑定后下发） */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** 不带框架 locale 时的后备翻译（按 key 原样返回） */
export function fallbackTranslate(key: string): string {
  return key
}
