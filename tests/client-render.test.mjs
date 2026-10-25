/**
 * 客户端 bundle 渲染级测试（lib/client.js）：
 * 通过模拟 `window.__ModuleLoader__` 加载真实 bundle，用仿 DSH 0.2.1 的客户端
 * 上下文运行 apply()，捕获插槽注册与会话节点定义，再用 react-dom/server 渲染，
 * 验证：
 *   - `recover-actions` 节点定义与 keyed 渲染器注册；
 *   - `conversation.input.left` 入口注册；
 *   - 首个问题只渲染回退图标，最后一个问题渲染回退 + 编辑；
 *   - 运行中且最后节点是提问时，输入框渲染编辑图标。
 */
import { readFile } from 'node:fs/promises'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ReactModule from 'react'
import * as JsxRuntime from 'react/jsx-runtime'

// ---- 通过 loader 契约加载真实 bundle --------------------------------------
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
      moduleExports = factory(localRequire)
    },
  },
}
new Function(bundle)()

if (moduleExports === null || typeof moduleExports.apply !== 'function') {
  throw new Error('bundle 未导出 apply()')
}
const { apply } = moduleExports
console.log('bundle apply() 加载成功; inject =', JSON.stringify(moduleExports.inject))

// ---- 仿客户端上下文 ------------------------------------------------------
const registered = []
const registeredDefinitions = []
const registeredNamespaces = []
const mockCtx = {
  effect(fn) {
    const out = fn()
    return typeof out === 'function' ? out : () => {}
  },
  locale: {
    register(namespace, dictionaries) {
      registeredNamespaces.push({ namespace, dictionaries })
      return () => {}
    },
  },
  slots: {
    inject(key, callback) {
      return callback()
    },
    register(options, component) {
      registered.push({ slot: options.name, key: options.key, options, component })
      return () => {}
    },
  },
  uiConversation: {
    events: {
      register(definition) {
        registeredDefinitions.push(definition)
        return () => {}
      },
    },
  },
  sessions: {
    binding: () => ({ session: { cancel: async () => {} } }),
    fork: async () => 'child-1',
    create: async () => 'child-blank',
    scope: (id) => (id === 'child-1' || id === 'child-blank' ? { fake: true } : undefined),
    list: { getSnapshot: () => ({ byId: { s1: { cwd: '/work' } } }) },
  },
  uiWorkspace: {
    openSession: () => {},
    archiveSession: async () => {},
  },
  get: () => ({ input: { for: () => ({ setDraft: () => {} }) } }),
}

apply(mockCtx)

const questionEntry = registered.find(r => r.slot === 'conversation.chat.node' && r.key === 'recover-actions')
const composerEntry = registered.find(r => r.slot === 'conversation.input.left')
if (questionEntry === undefined) throw new Error('recover-actions keyed 渲染器未注册')
if (composerEntry === undefined) throw new Error('conversation.input.left 入口未注册')
if (registeredDefinitions.length !== 1 || registeredDefinitions[0].kind !== 'recover-actions') {
  throw new Error('recover-actions 会话节点定义未注册')
}
if (!registeredNamespaces.some(n => n.namespace === 'recover-context')) {
  throw new Error('recover-context 字典命名空间未注册')
}
if (questionEntry.options.locale !== 'recover-context') {
  throw new Error('recover-actions 插槽应声明 locale 命名空间')
}
console.log('注册项 OK:', JSON.stringify(registered.map(r => `${r.slot}:${r.key ?? 'list'}`)))

// ---- 仿真实 Chat 快照：两个已完成轮次 -------------------------------------
function node(key, kind, anchorSeq, data) {
  return { key, kind, anchorSeq, data }
}
function makeChat(overrides = {}) {
  const nodes = [
    node('t1-user', 'user', 1, { kind: 'user', seq: 1, content: [{ type: 'text', text: 'first question' }] }),
    node('t1-actions', 'recover-actions', 1.1, { seq: 1, time: 0, content: [{ type: 'text', text: 'first question' }] }),
    node('t1-answer', 'assistant', 10, { kind: 'assistant', finalNode: { messageId: 'm1', seq: 10, turn: 1, step: 1 } }),
    node('t2-user', 'user', 11, { kind: 'user', seq: 11, content: [{ type: 'text', text: 'second question' }] }),
    node('t2-actions', 'recover-actions', 11.1, { seq: 11, time: 0, content: [{ type: 'text', text: 'second question' }] }),
    node('t2-answer', 'assistant', 20, { kind: 'assistant', finalNode: { messageId: 'm2', seq: 20, turn: 2, step: 1 } }),
  ]
  const byKey = new Map(nodes.map(n => [n.key, n]))
  return {
    order: nodes.map(n => n.key),
    nodes: { get: k => byKey.get(k), values: () => nodes },
    locations: {
      getTurn: t => t === 1
        ? ['t1-user', 't1-actions', 't1-answer']
        : t === 2 ? ['t2-user', 't2-actions', 't2-answer'] : [],
    },
    timeline: { turnOrder: [1, 2] },
    legacy: { turnEnds: new Map([[1, 10], [2, 20]]) },
    ...overrides,
  }
}

/** 仿框架下发的 t（本测试用 key 直出，验证绑定的确生效） */
const t = (key) => key
const useChatStub = (chat) => (selector) => selector(chat)

// 第 1 个问题：仅回退图标
const Comp = questionEntry.component
const chat1 = makeChat()
const qNode1 = {
  key: 't1-actions',
  anchorSeq: 1.1,
  data: { seq: 1, time: 0, content: [{ type: 'text', text: 'first question' }] },
}
const html1 = renderToStaticMarkup(createElement(Comp, {
  node: qNode1, sessionId: 's1', useChat: useChatStub(chat1), t,
}))
console.log('q1 markup:', JSON.stringify(html1))
if (!html1.includes('<svg')) throw new Error('第一个问题应渲染图标按钮')
if (html1.includes('>回退到此<') || html1.includes('>编辑此问题<')) {
  throw new Error('按钮必须是纯图标，不带可见文字')
}
const svgCount1 = (html1.match(/<svg/g) ?? []).length
if (svgCount1 !== 1) throw new Error(`第一个问题应恰好一个图标（回退），实际 ${svgCount1}`)

// 最后一个问题：回退 + 编辑
const qNode2 = {
  key: 't2-actions',
  anchorSeq: 11.1,
  data: { seq: 11, time: 0, content: [{ type: 'text', text: 'second question' }] },
}
const html2 = renderToStaticMarkup(createElement(Comp, {
  node: qNode2, sessionId: 's1', useChat: useChatStub(chat1), t,
}))
console.log('q2 markup:', JSON.stringify(html2))
const svgCount2 = (html2.match(/<svg/g) ?? []).length
if (svgCount2 !== 2) throw new Error(`最后一个问题应有两个图标（回退 + 编辑），实际 ${svgCount2}`)

// 缺少 useChat 时安全降级为 null（不抛渲染错误）
const missing = renderToStaticMarkup(createElement(Comp, {
  node: qNode1, sessionId: 's1', t,
}))
if (missing !== '') throw new Error('缺少 useChat 时应渲染空内容')

// 输入框入口：运行中且最后节点是提问
const runningChat = makeChat({
  order: ['t3-user'],
  nodes: {
    get: k => (k === 't3-user'
      ? node('t3-user', 'user', 21, { kind: 'user', content: [{ type: 'text', text: 'premature' }] })
      : undefined),
    values: () => [node('t3-user', 'user', 21, { kind: 'user', content: [{ type: 'text', text: 'premature' }] })],
  },
  locations: {
    getTurn: t => t === 3 ? ['t3-user'] : t === 1 ? ['t1-user', 't1-actions', 't1-answer'] : t === 2 ? ['t2-user', 't2-actions', 't2-answer'] : [],
  },
  timeline: { turnOrder: [1, 2, 3] },
  legacy: { turnEnds: new Map([[1, 10], [2, 20]]) },
})
const CComp = composerEntry.component
const composerHtml = renderToStaticMarkup(createElement(CComp, {
  session: { running: true, removed: false },
  sessionId: 's1',
  useChat: useChatStub(runningChat),
  t,
}))
console.log('composer markup:', JSON.stringify(composerHtml))
if (!composerHtml.includes('<svg')) throw new Error('运行中应渲染编辑图标')
if (composerHtml.includes('>编辑此问题<')) throw new Error('输入框编辑必须是纯图标')

// 未运行时输入框入口不渲染
const idleHtml = renderToStaticMarkup(createElement(CComp, {
  session: { running: false, removed: false },
  sessionId: 's1',
  useChat: useChatStub(runningChat),
  t,
}))
if (idleHtml !== '') throw new Error('未运行时不应渲染输入框编辑入口')

console.log('client-render.test.mjs: 所有断言通过 ✓')
