/**
 * 客户端逻辑测试：
 *   - Chat 快照分析（snapshot.ts）—— 在仿 DSH 0.2.1 的 ChatSnapshot 上运行；
 *   - 回滚/编辑编排（actions.ts）—— 用假客户端上下文与 stub fetch。
 * 通过 esbuild 打包后由 node 执行。
 */
import assert from 'node:assert'
import {
  beginEdit, isEditArmed, previewRestore, rollback, rollbackBefore,
  type ClientContext,
} from '../src/client/actions.ts'
import { analyzeComposerEdit, analyzeQuestion, type ChatSnapshotLike } from '../src/client/snapshot.ts'

// ---- 假 Chat 快照：两个已完成轮次 -----------------------------------------
function node(key: string, kind: string, anchorSeq: number, data: unknown) {
  return { key, kind, anchorSeq, data }
}

function makeChat(): ChatSnapshotLike {
  const nodes = [
    // 第 1 轮
    node('t1-user', 'user', 1, { kind: 'user', seq: 1, content: [{ type: 'text', text: 'first question' }] }),
    node('t1-actions', 'recover-actions', 1.1, { seq: 1, time: 0, content: [{ type: 'text', text: 'first question' }] }),
    node('t1-answer', 'assistant', 10, { kind: 'assistant', finalNode: { messageId: 'm1', seq: 10 } }),
    // 第 2 轮
    node('t2-user', 'user', 11, { kind: 'user', seq: 11, content: [{ type: 'text', text: 'second question' }] }),
    node('t2-actions', 'recover-actions', 11.1, { seq: 11, time: 0, content: [{ type: 'text', text: 'second question' }] }),
    node('t2-answer', 'assistant', 20, { kind: 'assistant', finalNode: { messageId: 'm2', seq: 20 } }),
  ]
  const byKey = new Map(nodes.map(n => [n.key, n]))
  return {
    order: nodes.map(n => n.key),
    nodes: {
      get: key => byKey.get(key),
      values: () => nodes,
    },
    locations: {
      getTurn: turn => turn === 1
        ? ['t1-user', 't1-actions', 't1-answer']
        : ['t2-user', 't2-actions', 't2-answer'],
    },
    timeline: { turnOrder: [1, 2] },
    legacy: { turnEnds: new Map([[1, 10], [2, 20]]) },
  }
}

// ---- 快照分析：问题操作行 ------------------------------------------------
{
  const chat = makeChat()
  const q1 = analyzeQuestion(chat, 't1-actions')
  assert(q1 !== null, '第一个问题应解析成功')
  assert.equal(q1.turn, 1)
  assert.equal(q1.userText, 'first question')
  assert.equal(q1.isLastQuestion, false, '第一个问题不是最后一个')
  assert.equal(q1.boundarySeq, null, '第一个问题无上一完成轮次 → 空白子会话')

  const q2 = analyzeQuestion(chat, 't2-actions')
  assert(q2 !== null, '第二个问题应解析成功')
  assert.equal(q2.turn, 2)
  assert.equal(q2.userText, 'second question')
  assert.equal(q2.isLastQuestion, true, '第二个问题是最后一个')
  assert.equal(q2.boundarySeq, 10, '边界 = 第 1 轮结束 seq')

  assert.equal(analyzeQuestion(chat, 'missing-key'), null, '未知节点 → null')
  assert.equal(analyzeQuestion(chat, 't1-user'), null, '非 recover-actions 节点 → null')
}

// ---- 快照分析：输入框编辑 ------------------------------------------------
{
  const chat = makeChat()
  assert.equal(analyzeComposerEdit(chat, false), null, '未运行 → 无入口')

  const running: ChatSnapshotLike = {
    ...chat,
    order: ['t2-user'],
    nodes: {
      get: key => key === 't2-user'
        ? node('t2-user', 'user', 11, { kind: 'user', content: [{ type: 'text', text: 'premature' }] })
        : undefined,
      values: () => [node('t2-user', 'user', 11, { kind: 'user', content: [{ type: 'text', text: 'premature' }] })],
    },
    locations: { getTurn: turn => turn === 2 ? ['t2-user'] : [] },
    timeline: { turnOrder: [1, 2] },
    legacy: { turnEnds: new Map([[1, 10]]) },
  }
  const info = analyzeComposerEdit(running, true)
  assert(info !== null, '运行中且最后节点是问题 → 有入口')
  assert.equal(info.userText, 'premature')
  assert.equal(info.boundarySeq, 10, '边界为最后完成轮次结束 seq')
}

// ---- 编排 ----------------------------------------------------------------
function fakeCtx(overrides: Partial<ClientContext> = {}): ClientContext & { calls: string[] } {
  const calls: string[] = []
  const sessionCache = new Map<string, { cancel(): Promise<void>; prompt(c: unknown, m: unknown): Promise<{ ok: boolean }> }>()
  const sessions = {
    binding: (id: string) => {
      if (id !== 's1' && id !== 'child-1' && id !== 'child-blank') return undefined
      let session = sessionCache.get(id)
      if (session === undefined) {
        session = {
          cancel: async () => { calls.push('cancel') },
          prompt: async (content: unknown, mode: unknown) => {
            calls.push(`prompt:${JSON.stringify(content)}:${mode}`)
            return { ok: true }
          },
        }
        sessionCache.set(id, session)
      }
      return { session }
    },
    fork: async (opts: { sessionId: string; atSeq?: number }) => {
      calls.push(`fork:${opts.atSeq ?? 'none'}`)
      return 'child-1'
    },
    create: async (opts: { workspaceId?: string; cwd?: string }) => {
      calls.push(`create:${opts.workspaceId ?? opts.cwd ?? 'none'}`)
      return 'child-blank'
    },
    scope: () => ({ fake: true }),
    list: { getSnapshot: () => ({ byId: { s1: { cwd: '/work' } } }) },
  }
  const uiWorkspace = {
    openSession: (id: string) => { calls.push(`open:${id}`) },
    archiveSession: async (id: string) => { calls.push(`archive:${id}`) },
    connectWorkspace: async (workspaceId: string) => {
      calls.push(`connect:${workspaceId}`)
      return 'child-blank'
    },
  }
  const workspaces = {
    list: {
      getSnapshot: () => ({
        items: [{ workspaceId: 'w1', sessionIds: ['s1'], path: '/work' }],
      }),
    },
  }
  const conversation = {
    input: { for: () => ({ setDraft: (text: string) => { calls.push(`draft:${text}`) } }) },
  }
  const ctx = {
    get: (key: string) => {
      if (key === 'conversation') return conversation
      if (key === 'workspaces') return workspaces
      return undefined
    },
    sessions,
    uiWorkspace,
  } as unknown as ClientContext
  return { ...ctx, ...overrides, calls } as ClientContext & { calls: string[] }
}

const okRestore = (mode: string) => ({ ok: true, value: { mode, restored: ['a'], deleted: ['b'], skipped: [], dryRun: false } })

/**
 * 安装 fetch stub，并把每次宿主调用记进同一个 calls 日志，
 * 以便断言「还原」与「fork/创建会话」的相对顺序。
 */
function withRestoreStub<T>(
  calls: string[],
  mode: string,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = String(url).split('/').pop() ?? ''
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      baseline?: boolean
      atSeq?: number
      sessionId?: string
    }
    if (method === 'resetBaseline') {
      calls.push(`resetBaseline:${String(body.sessionId)}`)
      return { json: async () => ({ ok: true, value: { reset: true } }) } as Response
    }
    calls.push(`restore:${body.baseline === true ? 'baseline' : `atSeq=${String(body.atSeq)}`}`)
    return { json: async () => okRestore(mode) } as Response
  }) as typeof fetch
  return run().finally(() => { globalThis.fetch = originalFetch }) as Promise<T>
}

// rollback: cancel → restore → fork(atSeq) → archive → open
// 还原必须早于 fork：子会话基线在诞生时采集，晚还原会让基线包含残留文件。
{
  const ctx = fakeCtx()
  const result = await withRestoreStub(ctx.calls, 'turn', () => rollback(ctx, 's1', 10))
  assert.equal(result.childId, 'child-1')
  assert.deepEqual(
    ctx.calls,
    ['cancel', 'restore:atSeq=10', 'fork:10', 'archive:s1', 'open:child-1'],
    '回退必须先还原工作区，再分叉子会话',
  )
  assert.equal(result.restore.mode, 'turn')
}

// rollbackBefore 首个问题：先还原基线，再创建空白会话
{
  const ctx = fakeCtx()
  await withRestoreStub(ctx.calls, 'baseline', () => rollbackBefore(ctx, 's1', null))
  assert.deepEqual(
    ctx.calls,
    ['cancel', 'restore:baseline', 'connect:w1', 'resetBaseline:child-blank', 'archive:s1', 'open:child-blank'],
    '首问回滚应先还原基线，再创建空白子会话、归档旧会话并打开新会话',
  )
}

// beginEdit 不截断上下文
{
  const ctx = fakeCtx()
  await withRestoreStub(ctx.calls, 'turn', () => beginEdit(ctx, 's1', 'edited question', 10))
  assert(isEditArmed('s1'), '编辑拦截已装载')
  assert.deepEqual(ctx.calls, ['draft:edited question'], 'beginEdit 不得截断上下文')
}

// beginEdit 后提交：截断发生在提交时，且还原早于 fork，内容进入子会话
{
  const ctx = fakeCtx()
  await withRestoreStub(ctx.calls, 'turn', async () => {
    await beginEdit(ctx, 's1', 'edited question', 10)
    assert(isEditArmed('s1'), '提交前处于装载状态')
    const session = ctx.sessions.binding('s1')!.session as {
      prompt: (c: unknown, m: unknown) => Promise<{ ok: boolean }>
    }
    const result = await session.prompt([{ type: 'text', text: 'edited question' }], 'queue')
    assert(result.ok, 'prompt 被接受')
    assert(!isEditArmed('s1'), '提交后装载状态被消费')
  })
  assert.deepEqual(
    ctx.calls,
    ['draft:edited question', 'cancel', 'restore:atSeq=10', 'fork:10', 'archive:s1', 'open:child-1', 'prompt:[{"type":"text","text":"edited question"}]:queue'],
    '提交时必须先还原工作区再分叉，否则子会话基线会记录本轮残留文件',
  )
}

// 首问编辑提交：空白子会话 + 基线还原
{
  const ctx = fakeCtx()
  await withRestoreStub(ctx.calls, 'baseline', async () => {
    await beginEdit(ctx, 's1', 'edited first question', null)
    const session = ctx.sessions.binding('s1')!.session as {
      prompt: (c: unknown, m: unknown) => Promise<{ ok: boolean }>
    }
    await session.prompt([{ type: 'text', text: 'edited first question' }], 'queue')
  })
  assert.deepEqual(
    ctx.calls,
    ['draft:edited first question', 'cancel', 'restore:baseline', 'connect:w1', 'resetBaseline:child-blank', 'archive:s1', 'open:child-blank', 'prompt:[{"type":"text","text":"edited first question"}]:queue'],
    '首问编辑应先还原基线，再创建空白子会话并提问',
  )
}

// 未装载时的普通提交直接透传
{
  const ctx = fakeCtx()
  const session = ctx.sessions.binding('s1')!.session as {
    prompt: (c: unknown, m: unknown) => Promise<{ ok: boolean }>
  }
  await session.prompt([{ type: 'text', text: 'normal question' }], 'queue')
  assert.deepEqual(ctx.calls, ['prompt:[{"type":"text","text":"normal question"}]:queue'])
}

// previewRestore 转发 dryRun 标记
{
  let seen: unknown = null
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    seen = init?.body
    return { json: async () => okRestore('turn') } as Response
  }) as typeof fetch
  try {
    await previewRestore('s1', 7)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert(seen !== null, 'fetch 被调用')
  assert.equal(JSON.parse(String(seen)).dryRun, true, '请求携带 dryRun 标记')
  assert.equal(JSON.parse(String(seen)).atSeq, 7)
}

console.log('client-logic.test.mjs: 所有断言通过 ✓')
