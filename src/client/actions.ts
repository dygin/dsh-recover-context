/**
 * 客户端回滚与编辑操作编排。
 * 两项操作均建立在 DSH 原生机制之上 — `session.fork`（原生分叉功能）与 `workspace.archiveSession`（归档旧会话），
 * 并结合本插件宿主提供的目录快照恢复 API：
 *
 *   rollback / rollbackBefore（回滚）:
 *     取消当前运行的轮次 → 分叉出目标截断点之前的新会话 →
 *     恢复工作区到对应检查点 → 归档旧会话 → 打开新子会话。
 *
 *   beginEdit（编辑问题）:
 *     点击时不会截断任何上下文：仅将原问题文本载入输入框并装载提交拦截器；
 *     截断（fork + 恢复 + 归档）仅在用户实际点击提交时触发。
 */
import { callApi, type RestoreResult } from './api.ts'

/** 单次提问提交的结构镜像 */
type PromptContent = readonly { type: string; text?: string }[]
type PromptResult = { ok: boolean; error?: { code: string; message: string } }

/** 支持 patch 拦截 prompt 的会话绑定对象镜像 */
interface PatchableSession {
  cancel(): Promise<unknown>
  prompt(content: PromptContent, mode: string): Promise<PromptResult>
}

/** 客户端上下文镜像 */
export interface ClientContext {
  get<T>(key: string): T | undefined
  sessions: {
    binding(id: string): { session: PatchableSession } | undefined
    fork(opts: { sessionId: string; atSeq?: number }): Promise<string>
    create(opts: { workspaceId?: string; cwd?: string }): Promise<string>
    open(id: string): void
    scope(id: string): unknown | undefined
    list: {
      getSnapshot(): { byId: Record<string, { cwd?: string }> }
    }
  }
  workspaces: {
    archiveSession(sessionId: string): Promise<void>
    list: {
      getSnapshot(): { items: readonly { id: string; path: string }[] }
    }
  }
}

/** 恢复操作完成的结果 */
export interface RecoverOperationResult {
  childId: string
  restore: RestoreResult
}

/**
 * 各会话内存中的编辑就绪状态。故意不持久化：刷新页面自动清除，不破坏原会话。
 */
const armedEdits = new Map<string, { boundarySeq: number | null }>()

/** 判断某会话是否处于编辑拦截就绪状态 */
export function isEditArmed(sessionId: string): boolean {
  return armedEdits.has(sessionId)
}

/** 尽力取消当前运行的轮次（不抛异常） */
async function cancelIfRunning(ctx: ClientContext, sessionId: string): Promise<void> {
  const binding = ctx.sessions.binding(sessionId)
  if (binding === undefined) return
  try {
    await binding.session.cancel()
  } catch {
    // 尽力取消，即使失败 fork 依然安全
  }
}

/** 归档旧会话（尽力而为） */
async function archive(ctx: ClientContext, sessionId: string): Promise<void> {
  try {
    await ctx.workspaces.archiveSession(sessionId)
  } catch {
    // 归档属于界面整理，不阻塞新会话
  }
}

/** 将文本填入会话输入框草稿区（重试直到作用域就绪） */
async function setDraftOn(ctx: ClientContext, sessionId: string, text: string): Promise<void> {
  const conversation = ctx.get<{
    input: { for(actx: unknown): { setDraft(text: string): void } }
  }>('conversation')
  if (conversation === undefined) return
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const scope = ctx.sessions.scope(sessionId)
    if (scope !== undefined) {
      try {
        conversation.input.for(scope).setDraft(text)
        return
      } catch {
        // 输入框尚未就绪则重试
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/**
 * 通用的“截断到某个问题之前”操作：在上一已完成轮次处分叉（或对首个问题创建空白子会话），
 * 恢复工作区到该时间点，归档旧会话并打开新子会话。
 */
async function cutBefore(
  ctx: ClientContext,
  sessionId: string,
  boundarySeqOrNull: number | null,
  draftText?: string,
): Promise<RecoverOperationResult> {
  await cancelIfRunning(ctx, sessionId)
  let childId: string
  let restore: RestoreResult
  if (boundarySeqOrNull === null) {
    // 第一个问题：无法基于已完成轮次 fork，因此创建相同工作区的全新空白会话并还原基线文件
    const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
    const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.path === cwd)
    childId = await ctx.sessions.create(workspace !== undefined
      ? { workspaceId: workspace.id }
      : cwd !== undefined ? { cwd } : {})
    restore = await callApi<RestoreResult>('restore', { sessionId, baseline: true, dryRun: false })
  } else {
    childId = await ctx.sessions.fork({ sessionId, atSeq: boundarySeqOrNull })
    restore = await callApi<RestoreResult>('restore', { sessionId, atSeq: boundarySeqOrNull, dryRun: false })
  }
  await archive(ctx, sessionId)
  ctx.sessions.open(childId)
  if (draftText !== undefined && draftText !== '') {
    await setDraftOn(ctx, childId, draftText)
  }
  return { childId, restore }
}

/** 回滚到包含 atSeq 的轮次完成状态，恢复文件，归档旧会话，打开子会话 */
export async function rollback(
  ctx: ClientContext,
  sessionId: string,
  atSeq: number,
): Promise<RecoverOperationResult> {
  await cancelIfRunning(ctx, sessionId)
  const childId = await ctx.sessions.fork({ sessionId, atSeq })
  const restore = await callApi<RestoreResult>('restore', { sessionId, atSeq, dryRun: false })
  await archive(ctx, sessionId)
  ctx.sessions.open(childId)
  return { childId, restore }
}

/**
 * 回滚到某个问题提出之前：丢弃该问题及其之后的所有上下文与文件变更
 */
export async function rollbackBefore(
  ctx: ClientContext,
  sessionId: string,
  boundarySeqOrNull: number | null,
): Promise<RecoverOperationResult> {
  return cutBefore(ctx, sessionId, boundarySeqOrNull)
}

/** 预检恢复文件数量（dryRun 试运行） */
export function previewRestore(sessionId: string, atSeq: number): Promise<RestoreResult> {
  return callApi<RestoreResult>('restore', { sessionId, atSeq, dryRun: true })
}

/**
 * 进入编辑模式：将问题填入输入框并装载提交拦截器，截断操作推迟到提交时执行
 */
export async function beginEdit(
  ctx: ClientContext,
  sessionId: string,
  userText: string,
  boundarySeqOrNull: number | null,
): Promise<void> {
  armEditInterceptor(ctx, sessionId, boundarySeqOrNull)
  if (userText !== '') {
    await setDraftOn(ctx, sessionId, userText)
  }
}

/** 包装会话的 prompt 提问方法，以便在用户下一次提交时重定向到新分叉的子会话 */
function armEditInterceptor(
  ctx: ClientContext,
  sessionId: string,
  boundarySeqOrNull: number | null,
): void {
  armedEdits.set(sessionId, { boundarySeq: boundarySeqOrNull })
  const binding = ctx.sessions.binding(sessionId)
  if (binding === undefined) return
  const session = binding.session as PatchableSession & { __recoverEditWrapped?: boolean }
  if (session.__recoverEditWrapped === true) return
  session.__recoverEditWrapped = true
  const originalPrompt = session.prompt.bind(session)
  session.prompt = async (content: PromptContent, mode: string): Promise<PromptResult> => {
    const armed = armedEdits.get(sessionId)
    if (armed === undefined) return originalPrompt(content, mode)
    armedEdits.delete(sessionId)
    try {
      const { childId } = await cutBefore(ctx, sessionId, armed.boundarySeq)
      const child = await resolveChildBinding(ctx, childId)
      if (child === undefined) {
        return { ok: false, error: { code: 'internal', message: '编辑失败：子会话不可用' } }
      }
      return child.session.prompt(content, mode)
    } catch (error) {
      return { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } }
    }
  }
}

/** 解析子会话绑定（重试直到会话绑定就绪） */
async function resolveChildBinding(
  ctx: ClientContext,
  childId: string,
): Promise<{ session: PatchableSession } | undefined> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const binding = ctx.sessions.binding(childId)
    if (binding !== undefined) return binding
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return undefined
}
