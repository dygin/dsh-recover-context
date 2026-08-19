/**
 * Client-side logic tests: the snapshot analysis helpers (snapshot.ts) and
 * the rollback/edit orchestration (actions.ts) run headless with fake
 * snapshots and a fake client context (fetch stubbed to the host API
 * envelope). Bundled with esbuild and executed by node.
 */
import assert from 'node:assert'
import { beginEdit, isEditArmed, previewRestore, rollback, rollbackBefore, type ClientContext } from '../src/client/actions.ts'
import { analyzeComposerEdit, analyzeQuestion, analyzeTurnAction } from '../src/client/snapshot.ts'
import type { SnapshotLike } from '../src/client/snapshot.ts'

// ---- fake snapshot: two completed turns ---------------------------------
function node(key: string, kind: string, anchorSeq: number, data: unknown) {
  return { key, kind, anchorSeq, data }
}

function makeSnapshot(): SnapshotLike {
  const nodes = [
    // turn 1
    node('t1-user', 'user', 1, { kind: 'user', seq: 1, content: [{ type: 'text', text: 'first question' }] }),
    node('t1-tool', 'tool', 5, { kind: 'tool', root: { kind: 'tool-result' } }),
    node('t1-answer', 'assistant-step', 10, { kind: 'assistant', finalNode: { messageId: 'm1', seq: 10 } }),
    // turn 2
    node('t2-user', 'user', 11, { kind: 'user', seq: 11, content: [{ type: 'text', text: 'second question' }] }),
    node('t2-answer', 'assistant-step', 20, { kind: 'assistant', finalNode: { messageId: 'm2', seq: 20 } }),
  ]
  const byKey = new Map(nodes.map(n => [n.key, n]))
  return {
    removed: false,
    running: false,
    chat: {
      order: nodes.map(n => n.key),
      nodes: {
        get: key => byKey.get(key),
        values: () => nodes,
      },
      locations: {
        getTurn: (turn) => turn === 1 ? ['t1-user', 't1-tool', 't1-answer'] : ['t2-user', 't2-answer'],
      },
      timeline: { turnOrder: [1, 2] },
    },
    turnEnds: new Map([[1, 10], [2, 20]]),
  }
}

// ---- snapshot analysis: assistant message rows ----------------------------
{
  const snap = makeSnapshot()
  // The real runtime's assistant chat-node kind is 'assistant-step' — the
  // lookup must find the node by messageId regardless of kind.
  const first = analyzeTurnAction(snap, 'm1')
  assert(first !== null, 'm1 resolves with assistant-step kind')
  assert.equal(first.turn, 1)
  assert.equal(first.nodeSeq, 10)
  assert.equal(first.userText, 'first question')
  assert.equal(first.hasLater, true, 'turn 1 has later content')
  assert.equal(first.isLastCompleted, false)
  assert.equal(first.editBoundarySeq, null, 'turn 1 has no previous completed turn')

  const second = analyzeTurnAction(snap, 'm2')
  assert(second !== null, 'm2 resolves')
  assert.equal(second.turn, 2)
  assert.equal(second.hasLater, false, 'turn 2 is the last')
  assert.equal(second.isLastCompleted, true)
  assert.equal(second.editBoundarySeq, 10, 'edit boundary is turn 1 end seq')
  assert.equal(second.userText, 'second question')
}

// ---- snapshot analysis: question rows -------------------------------------
{
  const snap = makeSnapshot()
  const q1 = analyzeQuestion(snap, 't1-user')
  assert(q1 !== null, 'first question resolves')
  assert.equal(q1.turn, 1)
  assert.equal(q1.userText, 'first question')
  assert.equal(q1.isLastQuestion, false, 'first question is not the last')
  assert.equal(q1.boundarySeq, null, 'first question has no previous turn → blank child')

  const q2 = analyzeQuestion(snap, 't2-user')
  assert(q2 !== null, 'second question resolves')
  assert.equal(q2.turn, 2)
  assert.equal(q2.userText, 'second question')
  assert.equal(q2.isLastQuestion, true, 'second question is the last')
  assert.equal(q2.boundarySeq, 10, 'boundary = turn 1 end seq → cuts before question 2')

  assert.equal(analyzeQuestion(snap, 'missing-key'), null, 'unknown node → null')
}

// ---- composer edit analysis ----------------------------------------------
{
  const snap = makeSnapshot()
  // Not running → no composer edit affordance.
  assert.equal(analyzeComposerEdit(snap), null, 'not running → no affordance')
  // Running with the newest node = the question → affordance.
  const running: SnapshotLike = {
    ...snap,
    running: true,
    chat: {
      ...snap.chat,
      order: ['t2-user'],
      locations: { getTurn: (turn) => turn === 2 ? ['t2-user'] : [] },
      nodes: {
        get: key => key === 't2-user' ? node('t2-user', 'user', 11, { kind: 'user', content: [{ type: 'text', text: 'premature' }] }) : undefined,
        values: () => [node('t2-user', 'user', 11, { kind: 'user', content: [{ type: 'text', text: 'premature' }] })],
      },
      timeline: { turnOrder: [1, 2] },
    },
    turnEnds: new Map([[1, 10]]),
  }
  const info = analyzeComposerEdit(running)
  assert(info !== null, 'running first-answer affordance present')
  assert.equal(info.userText, 'premature')
  assert.equal(info.boundarySeq, 10, 'boundary is the last completed turn end')
}

// ---- orchestration --------------------------------------------------------
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
    open: (id: string) => { calls.push(`open:${id}`) },
    scope: () => ({ fake: true }),
    list: { getSnapshot: () => ({ byId: { s1: { cwd: '/work' } } }) },
  }
  const workspaces = {
    archiveSession: async (id: string) => { calls.push(`archive:${id}`) },
    list: { getSnapshot: () => ({ items: [{ id: 'w1', path: '/work' }] }) },
  }
  const conversation = {
    input: { for: (actx: unknown) => ({ setDraft: (text: string) => { calls.push(`draft:${text}`) } }) },
  }
  const ctx = {
    get: (key: string) => (key === 'conversation' ? conversation : undefined),
    sessions,
    workspaces,
  } as ClientContext
  return { ...ctx, ...overrides, calls } as ClientContext & { calls: string[] }
}

const okRestore = (mode: string) => ({ ok: true, value: { mode, restored: ['a'], deleted: ['b'], skipped: [], dryRun: false } })

{
  // rollback: cancel → fork(atSeq) → restore → archive → open
  const ctx = fakeCtx()
  const fetchStub = async () => ({ json: async () => okRestore('turn') }) as Response
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchStub as typeof fetch
  try {
    const result = await rollback(ctx, 's1', 10)
    assert.equal(result.childId, 'child-1')
    assert.deepEqual(ctx.calls, ['cancel', 'fork:10', 'archive:s1', 'open:child-1'])
    assert.equal(result.restore.mode, 'turn')
  } finally {
    globalThis.fetch = originalFetch
  }
}

{
  // beginEdit does NOT cut anything: no fork/create, just drafts + arms
  const ctx = fakeCtx()
  const fetchStub = async () => ({ json: async () => okRestore('turn') }) as Response
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchStub as typeof fetch
  try {
    await beginEdit(ctx, 's1', 'edited question', 10)
    assert(isEditArmed('s1'), 'edit is armed')
    assert.deepEqual(ctx.calls, ['draft:edited question'], 'beginEdit must not cut context (no fork/create/archive/open)')
  } finally {
    globalThis.fetch = originalFetch
  }
}

{
  // submitting after beginEdit: cut happens then, content goes to the child
  const ctx = fakeCtx()
  const fetchStub = async () => ({ json: async () => okRestore('turn') }) as Response
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchStub as typeof fetch
  try {
    await beginEdit(ctx, 's1', 'edited question', 10)
    assert(isEditArmed('s1'), 'armed before submit')
    const session = ctx.sessions.binding('s1')!.session as { prompt: (c: unknown, m: unknown) => Promise<{ ok: boolean }> }
    const result = await session.prompt([{ type: 'text', text: 'edited question' }], 'queue')
    assert(result.ok, 'prompt accepted')
    assert(!isEditArmed('s1'), 'armed state consumed on submit')
    assert.deepEqual(
      ctx.calls,
      ['draft:edited question', 'cancel', 'fork:10', 'archive:s1', 'open:child-1', 'prompt:[{"type":"text","text":"edited question"}]:queue'],
      'submit cuts before the question, opens the child and prompts it',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
}

{
  // submitting the very first question's edit → blank create + baseline restore
  const ctx = fakeCtx()
  const fetchStub = async () => ({ json: async () => okRestore('baseline') }) as Response
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchStub as typeof fetch
  try {
    await beginEdit(ctx, 's1', 'edited first question', null)
    const session = ctx.sessions.binding('s1')!.session as { prompt: (c: unknown, m: unknown) => Promise<{ ok: boolean }> }
    await session.prompt([{ type: 'text', text: 'edited first question' }], 'queue')
    assert.deepEqual(
      ctx.calls,
      ['draft:edited first question', 'cancel', 'create:w1', 'archive:s1', 'open:child-blank', 'prompt:[{"type":"text","text":"edited first question"}]:queue'],
      'first-question edit creates a blank child and prompts it',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
}

{
  // a normal (unarmed) submit passes straight through
  const ctx = fakeCtx()
  const fetchStub = async () => ({ json: async () => okRestore('turn') }) as Response
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchStub as typeof fetch
  try {
    const session = ctx.sessions.binding('s1')!.session as { prompt: (c: unknown, m: unknown) => Promise<{ ok: boolean }> }
    await session.prompt([{ type: 'text', text: 'normal question' }], 'queue')
    assert.deepEqual(ctx.calls, ['prompt:[{"type":"text","text":"normal question"}]:queue'])
  } finally {
    globalThis.fetch = originalFetch
  }
}

{
  // previewRestore forwards the dry-run payload
  let seen: unknown = null
  const ctx = fakeCtx()
  const fetchStub = async (_url: RequestInfo | URL, init?: RequestInit) => {
    seen = init?.body
    return { json: async () => okRestore('turn') } as Response
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchStub as typeof fetch
  try {
    await previewRestore('s1', 7)
    assert(seen !== null, 'fetch was called')
    assert(JSON.parse(String(seen)).dryRun === true, 'dry-run flag sent')
    assert.equal(JSON.parse(String(seen)).atSeq, 7)
    void ctx
  } finally {
    globalThis.fetch = originalFetch
  }
}

console.log('client-logic.test.mjs: all assertions passed ✓')
