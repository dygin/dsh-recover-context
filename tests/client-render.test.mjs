/**
 * Render-level test of the REAL client bundle (lib/client.js): loads it
 * through a simulated `window.__ModuleLoader__`, runs apply() against a mock
 * client context that mirrors the runtime's service surface, captures the
 * slot registrations AND the recover-actions conversation-node definition,
 * then renders the registered components with react-dom/server — no browser
 * needed. This reproduces the "buttons do not appear" report headlessly and
 * uses the REAL chat-node kinds from the runtime (`assistant-step`).
 */
import { readFile } from 'node:fs/promises'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ReactModule from 'react'
import * as JsxRuntime from 'react/jsx-runtime'

// ---- load the real bundle through the loader contract --------------------
const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
let moduleExports = null
const localModules = new Map([
  ['react', ReactModule],
  ['react/jsx-runtime', JsxRuntime],
])
globalThis.document = {
  createElement: () => ({ style: {}, remove: () => {} }),
  head: { appendChild: () => {} },
}
globalThis.window = {
  __ModuleLoader__: {
    load({ factory }) {
      const localRequire = (id) => {
        const resolved = localModules.get(id)
        if (resolved !== undefined) return resolved
        throw new Error(`unexpected client require: ${id}`)
      }
      // The bundle's factory creates its own `module` internally and RETURNS
      // module.exports — the real loader consumes the return value.
      moduleExports = factory(localRequire)
    },
  },
}
new Function(bundle)()

if (moduleExports === null || typeof moduleExports.apply !== 'function') {
  throw new Error('bundle did not export apply()')
}
const { apply } = moduleExports
console.log('bundle apply() loaded; inject =', JSON.stringify(moduleExports.inject))

// ---- mock client context ------------------------------------------------
const registered = [] // { slot, key, options, component }
const registeredDefinitions = [] // conversation-node definitions
const mockCtx = {
  effect(fn) { const out = fn(); return typeof out === 'function' ? out : () => {} },
  locale: {
    getSnapshot: () => ({ active: 'zh' }),
    subscribe: () => () => {},
  },
  slots: {
    inject(key, callback) {
      const dispose = callback()
      return dispose
    },
    register(options, component) {
      registered.push({ slot: options.name, key: options.key, options, component })
      return () => {}
    },
  },
  conversationEvents: {
    register(definition) {
      registeredDefinitions.push(definition)
      return () => {}
    },
  },
  sessions: {
    binding: () => ({ session: { cancel: async () => {} } }),
    fork: async () => 'child-1',
    create: async () => 'child-blank',
    open: () => {},
    scope: (id) => (id === 'child-1' || id === 'child-blank' ? { fake: true } : undefined),
    list: { getSnapshot: () => ({ byId: { s1: { cwd: '/work' } } }) },
  },
  workspaces: {
    archiveSession: async () => {},
    list: { getSnapshot: () => ({ items: [{ id: 'w1', path: '/work' }] }) },
  },
  get: () => ({ input: { for: () => ({ setDraft: () => {} }) } }),
}

apply(mockCtx)

const questionEntry = registered.find(r => r.slot === 'conversation.chat.node' && r.key === 'recover-actions')
const composerEntry = registered.find(r => r.slot === 'conversation.input.left')
if (questionEntry === undefined) throw new Error('recover-actions keyed renderer was not registered')
if (composerEntry === undefined) throw new Error('input.left entry was not registered')
if (registeredDefinitions.length !== 1 || registeredDefinitions[0].kind !== 'recover-actions') {
  throw new Error('recover-actions conversation node definition was not registered')
}
console.log('registrations OK:', JSON.stringify(registered.map(r => `${r.slot}:${r.key ?? 'list'}`)))

// ---- realistic snapshot: two completed turns (real chat kinds) ------------
function node(key, kind, anchorSeq, data) {
  return { key, kind, anchorSeq, data, id: key, target: 'chat', location: { kind: 'turn' } }
}
function makeSnapshot(overrides = {}) {
  const nodes = [
    node('t1-user', 'user', 1, { kind: 'user', seq: 1, content: [{ type: 'text', text: 'first question' }] }),
    node('t1-answer', 'assistant-step', 10, { kind: 'assistant', finalNode: { messageId: 'm1', seq: 10, turn: 1, step: 1 } }),
    node('t2-user', 'user', 11, { kind: 'user', seq: 11, content: [{ type: 'text', text: 'second question' }] }),
    node('t2-answer', 'assistant-step', 20, { kind: 'assistant', finalNode: { messageId: 'm2', seq: 20, turn: 2, step: 1 } }),
  ]
  const byKey = new Map(nodes.map(n => [n.key, n]))
  return {
    removed: false,
    running: false,
    chat: {
      order: nodes.map(n => n.key),
      nodes: { get: k => byKey.get(k), values: () => nodes },
      locations: { getTurn: t => t === 1 ? ['t1-user', 't1-answer'] : t === 2 ? ['t2-user', 't2-answer'] : [] },
      timeline: { turnOrder: [1, 2] },
    },
    turnEnds: new Map([[1, 10], [2, 20]]),
    ...overrides,
  }
}

const useSessionStub = (snapshot) => (selector) => selector(snapshot)

// Render the question action row for the FIRST question (expect ↶, no ✎)
const Comp = questionEntry.component
const snap1 = makeSnapshot()
const qNode1 = {
  key: 't1-user',
  anchorSeq: 1,
  data: { seq: 1, time: 0, content: [{ type: 'text', text: 'first question' }] },
}
const html1 = renderToStaticMarkup(createElement(Comp, {
  node: qNode1, sessionId: 's1', useSession: useSessionStub(snap1),
}))
console.log('q1 markup:', JSON.stringify(html1))
if (!html1.includes('<svg')) throw new Error('first question should render icon buttons')
if (html1.includes('>回退到此<') || html1.includes('>编辑此问题<')) throw new Error('buttons must be icon-only, no visible text labels')
const svgCount1 = (html1.match(/<svg/g) || []).length
if (svgCount1 !== 1) throw new Error('first question should render exactly one icon (rollback), got ' + svgCount1)

// Render for the LAST question (expect both ↶ and ✎)
const qNode2 = {
  key: 't2-user',
  anchorSeq: 11,
  data: { seq: 11, time: 0, content: [{ type: 'text', text: 'second question' }] },
}
const html2 = renderToStaticMarkup(createElement(Comp, {
  node: qNode2, sessionId: 's1', useSession: useSessionStub(snap1),
}))
console.log('q2 markup:', JSON.stringify(html2))
const svgCount2 = (html2.match(/<svg/g) || []).length
if (svgCount2 !== 2) throw new Error('last question should render two icons (rollback + edit), got ' + svgCount2)

// Composer entry: running session with the last node being the question
const runningSnap = makeSnapshot({
  running: true,
  chat: {
    order: ['t3-user'],
    nodes: {
      get: k => (k === 't3-user' ? node('t3-user', 'user', 21, { kind: 'user', content: [{ type: 'text', text: 'premature' }] }) : undefined),
      values: () => [node('t3-user', 'user', 21, { kind: 'user', content: [{ type: 'text', text: 'premature' }] })],
    },
    locations: { getTurn: t => t === 3 ? ['t3-user'] : t === 1 ? ['t1-user', 't1-answer'] : t === 2 ? ['t2-user', 't2-answer'] : [] },
    timeline: { turnOrder: [1, 2, 3] },
  },
  turnEnds: new Map([[1, 10], [2, 20]]),
})
const CComp = composerEntry.component
const composerHtml = renderToStaticMarkup(createElement(CComp, {
  session: runningSnap, sessionId: 's1',
}))
console.log('composer markup:', JSON.stringify(composerHtml))
if (!composerHtml.includes('<svg')) throw new Error('composer should render the edit icon')
if (composerHtml.includes('>编辑此问题<')) throw new Error('composer edit must be icon-only (tooltips allowed)')

console.log('client-render.test.mjs: all assertions passed ✓')
