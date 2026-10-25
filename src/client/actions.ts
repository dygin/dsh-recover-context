/**
 * 客户端回滚与编辑操作编排（适配 DSH 0.2.1 的 sessions / uiWorkspace 契约）。
 *
 *   rollback / rollbackBefore（回滚）:
 *     取消当前运行的轮次 → 分叉出目标截断点之前的会话（或创建空白子会话）→
 *     恢复工作区到对应检查点 → 归档旧会话 → 打开新会话。
 *
 *   beginEdit（编辑问题）:
 *     点击时不做任何截断：仅将原问题载入输入框并装载 prompt 拦截器；
 *     真正的截断（fork + 恢复 + 归档）在用户点击提交时执行。
 */
import { callApi, type RestoreResult } from './api.ts'

/** 提问内容块（结构镜像） */
type PromptContent = readonly { type: string; text?: string }[]
/** 提问结果（RemoteResult 的结构子集） */
type PromptResult = { ok: boolean; error?: { code?: string; message: string } }

/** 可拦截 prompt 的会话面（SessionFace 的结构子集） */
interface PatchableSession {
  cancel(): Promise<unknown>
  prompt(
    content: PromptContent,
    mode: string,
    signal?: AbortSignal,
    requestId?: unknown,
  ): Promise<PromptResult>
}

/** 客户端上下文镜像 */
export interface ClientContext {
  get<T>(key: string): T | undefined
  sessions: {
    binding(id: string): { session: PatchableSession } | undefined
    fork(opts: { sessionId: string; atSeq?: number }): Promise<string>
    create(opts: { workspaceId?: string; cwd?: string }): Promise<string>
    scope(id: string): unknown | undefined
    list: {
      getSnapshot(): { byId: Record<string, { cwd?: string }> }
    }
  }
  uiWorkspace: {
    openSession(target: string): void
    archiveSession(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
    /** 在工作区中解析（复用或新建）一个空白会话，返回会话 id。 */
    connectWorkspace?(workspaceId: string): Promise<string>
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

/** 判断某会话是否处于编辑拦截就绪状态（导出供测试使用） */
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
    await ctx.uiWorkspace.archiveSession(sessionId, { stopActivity: true })
  } catch {
    // 归档属于界面整理，不阻塞新会话
  }
}

/** 将文本填入会话输入框草稿区（重试直到作用域就绪） */
async function setDraftOn(ctx: ClientContext, sessionId: string, text: string): Promise<void> {
  const conversation = ctx.get<{
    input: { for(actx: unknown): { setDraft(value: string): void } }
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

/** 解析会话所属的工作区 id 与工作目录 */
function workspaceOf(ctx: ClientContext, sessionId: string): { workspaceId?: string; cwd?: string } {
  const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
  // workspaces 服务不在 inject 中：按框架约定用 ctx.get 读取（缺失时降级为 cwd）。
  const workspaces = ctx.get<{
    list: { getSnapshot(): { items: readonly { workspaceId: string; sessionIds: readonly string[]; path: string }[] } }
  }>('workspaces')
  if (workspaces !== undefined) {
    const items = workspaces.list.getSnapshot().items
    const byMembership = items.find(item => item.sessionIds.includes(sessionId))
    if (byMembership !== undefined) return { workspaceId: byMembership.workspaceId, ...(cwd === undefined ? {} : { cwd }) }
    if (cwd !== undefined) {
      const byPath = items.find(item => item.path === cwd)
      if (byPath !== undefined) return { workspaceId: byPath.workspaceId, cwd }
    }
  }
  return cwd === undefined ? {} : { cwd }
}

/**
 * 通用的“截断到某个问题之前”操作。
 *
 * 顺序很重要：**先还原工作区，再创建/分叉子会话**。
 * 子会话的基线是在它诞生时对工作区快照采集的；若先 fork 再还原，
 * 基线会记录下仍然残留的、本轮产出的文件（例如被编辑轮次写出的 3.txt）。
 * 之后在子会话里再点回退时，基线认为那些文件本来就在，插件反而会把它们重建出来。
 *
 * @param boundarySeqOrNull 上一已完成轮次的 turn/end seq；null 表示首个问题
 * @param draftText 截断后载入新会话输入框的文本
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
    // 第一个问题：先还原到初始基线，再创建空白会话，使新会话基线即还原后状态。
    restore = await callApi<RestoreResult>('restore', { sessionId, baseline: true, dryRun: false })
    const target = workspaceOf(ctx, sessionId)
    if (target.workspaceId !== undefined && ctx.uiWorkspace.connectWorkspace !== undefined) {
      childId = await ctx.uiWorkspace.connectWorkspace(target.workspaceId)
    } else {
      childId = await ctx.sessions.create(target)
    }
    // connectWorkspace 可能复用此前创建的空白会话，其基线是旧状态
    // （可能包含刚刚被还原删除的文件）。对齐到还原后的真实工作区。
    await resetBaselineQuietly(childId)
  } else {
    // 先还原到该边界，再分叉：子会话基线因此反映还原后的真实状态。
    restore = await callApi<RestoreResult>('restore', { sessionId, atSeq: boundarySeqOrNull, dryRun: false })
    childId = await ctx.sessions.fork({ sessionId, atSeq: boundarySeqOrNull })
  }

  await archive(ctx, sessionId)
  ctx.uiWorkspace.openSession(childId)
  if (draftText !== undefined && draftText !== '') {
    await setDraftOn(ctx, childId, draftText)
  }
  return { childId, restore }
}

/**
 * 回滚到包含 atSeq 的轮次完成状态，恢复文件，归档旧会话，打开子会话。
 * 与 {@link cutBefore} 同理：先还原工作区，再分叉，避免子会话基线记录残留文件。
 */
export async function rollback(
  ctx: ClientContext,
  sessionId: string,
  atSeq: number,
): Promise<RecoverOperationResult> {
  await cancelIfRunning(ctx, sessionId)
  const restore = await callApi<RestoreResult>('restore', { sessionId, atSeq, dryRun: false })
  const childId = await ctx.sessions.fork({ sessionId, atSeq })
  await archive(ctx, sessionId)
  ctx.uiWorkspace.openSession(childId)
  return { childId, restore }
}

/**
 * 回滚到某个问题提出之前：丢弃该问题及其之后的所有上下文与文件变更。
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
 * 尽力把某个空白会话的基线对齐到当前工作区。
 * 失败不应阻断回退流程：新会话仍可用，只是历史基线可能略陈旧。
 */
async function resetBaselineQuietly(sessionId: string): Promise<void> {
  try {
    await callApi<{ reset: boolean }>('resetBaseline', { sessionId })
  } catch {
    // 宿主未提供该接口或会话已有轮次时忽略
  }
}

/**
 * 进入编辑模式：将问题填入输入框并装载提交拦截器，截断操作推迟到提交时执行。
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

/** 包装会话的 prompt 方法，使用户下一次提交被重定向到新分叉的子会话 */
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
  session.prompt = async (
    content: PromptContent,
    mode: string,
    signal?: AbortSignal,
    requestId?: unknown,
  ): Promise<PromptResult> => {
    const armed = armedEdits.get(sessionId)
    if (armed === undefined) return originalPrompt(content, mode, signal, requestId)
    armedEdits.delete(sessionId)
    try {
      const { childId } = await cutBefore(ctx, sessionId, armed.boundarySeq)
      const child = await resolveChildBinding(ctx, childId)
      if (child === undefined) {
        return { ok: false, error: { code: 'internal', message: '编辑失败：子会话不可用' } }
      }
      // requestId 属于旧会话的提交回声，不能转交给子会话。
      return await child.session.prompt(content, mode)
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
