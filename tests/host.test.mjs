/**
 * 宿主端集成冒烟测试（适配 DSH 0.2.1 契约）。
 *
 * 用一个仿 cordis 上下文驱动插件 apply()：会话事件流、Connection Fetch 路由、
 * 会话持久化服务，验证：
 *   - turn/end 事件产生逐轮工作区检查点；
 *   - /api/recover-context/restore 路由能把工作区还原到请求边界；
 *   - checkpoints 路由返回检查点摘要；
 *   - 持久化缺失或 Connection 缺失时的回退路径。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 在导入插件前把 DSH 主目录指向临时目录。
// 工作区必须位于 DSH 主目录之外（插件绝不追踪 harness 主目录）。
const tempHome = await mkdtemp(join(tmpdir(), 'recover-context-home-'))
process.env.DSH_HOME = tempHome

const { apply } = await import('../lib/index.js')

const workspace = join(tmpdir(), `recover-context-ws-${Date.now()}`)
await mkdir(join(workspace, 'src'), { recursive: true })
await writeFile(join(workspace, 'README.md'), '# project\n')
await writeFile(join(workspace, 'src', 'main.js'), 'v1\n')

const sessionId = 'session-test-0001'
const events = []
const session = {
  id: sessionId,
  header: { id: sessionId, cwd: workspace },
}

/** 捕获的 session/event 监听器 */
let onEvent = null
/** 捕获的 session/created 监听器 */
let onCreated = null
/** 捕获的 Fetch 路由表 */
const fetchRoutes = new Map()

const ctx = {
  logger: { info: () => {}, warn: (msg) => { console.error('[host test warn]', msg) } },
  effect(fn) {
    const out = fn()
    return typeof out === 'function' ? out : () => {}
  },
  on(event, listener) {
    if (event === 'session/event') { onEvent = listener; return () => { onEvent = null } }
    if (event === 'session/created') { onCreated = listener; return () => { onCreated = null } }
    throw new Error(`unexpected event ${event}`)
  },
  sessions: {
    get(id) { return id === sessionId ? session : undefined },
  },
  connection: {
    fetch: {
      register(route) {
        fetchRoutes.set(route.path, route)
        return async () => { fetchRoutes.delete(route.path) }
      },
    },
  },
  // 模拟 DSH 0.2.1 的 Connection 与 SessionPersistence 服务。
  get(key) {
    if (key === 'connection') return ctx.connection
    if (key !== 'sessionPersistence') return undefined
    return {
      async stat(id) {
        return id === sessionId ? { header: { cwd: workspace } } : undefined
      },
      async open(id) {
        if (id !== sessionId) throw new Error('not found')
        return {
          async read() { return { events } },
          async close() {},
        }
      },
    }
  },
}

apply(ctx)

if (onEvent === null) throw new Error('apply() 未注册 session/event 监听器')
if (onCreated === null) throw new Error('apply() 未注册 session/created 监听器（提前采集基线）')
if (!fetchRoutes.has('/api/recover-context/checkpoints') || !fetchRoutes.has('/api/recover-context/restore')) {
  throw new Error(`Connection Fetch 路由未注册：${JSON.stringify([...fetchRoutes.keys()])}`)
}
if (!fetchRoutes.has('/api/recover-context/resetBaseline')) {
  throw new Error('resetBaseline 路由未注册')
}

/** 通过插件事件流发送一条会话事件 */
function emit(type, seq, data) {
  const event = { type, seq, data, time: Date.now() }
  events.push(event)
  onEvent(session, event)
}

/** 调用一个 Fetch 路由并返回解析后的响应 JSON */
async function callRoute(method, payload) {
  const route = fetchRoutes.get(`/api/recover-context/${method}`)
  if (route === undefined) throw new Error(`missing route ${method}`)
  const response = await route.fetch(new Request(`http://127.0.0.1:3081/api/recover-context/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }))
  return { status: response.status, body: await response.json() }
}

// 基线：会话创建即采集（早于任何一轮工作），确保基线代表"工作开始前"的状态。
onCreated(session)
await new Promise(resolve => setTimeout(resolve, 40))
emit('turn/start', 0, { turn: 1 })
emit('user/message', 1, { source: { kind: 'user' } })

// 第 1 轮工作：修改文件、创建文件
await new Promise(resolve => setTimeout(resolve, 40)) // 等检查点链落定
await writeFile(join(workspace, 'src', 'main.js'), 'v2\n')
await writeFile(join(workspace, 'extra.txt'), 'extra\n')
emit('turn/end', 10, { turn: 1, reason: { kind: 'completed' } })
await new Promise(resolve => setTimeout(resolve, 40))

// 第 2 轮工作：再创建一个文件
await writeFile(join(workspace, 'later.txt'), 'later\n')
emit('turn/end', 20, { turn: 2, reason: { kind: 'completed' } })
await new Promise(resolve => setTimeout(resolve, 60))

// 检查点列表
const list = await callRoute('checkpoints', { sessionId })
if (list.status !== 200 || list.body.ok !== true) throw new Error(`checkpoints 失败: ${JSON.stringify(list)}`)
if (list.body.value.tracking !== true) throw new Error('checkpoints: tracking 应为 true')
if (list.body.value.hasBaseline !== true) throw new Error('checkpoints: hasBaseline 应为 true')
const turns = list.body.value.checkpoints
if (turns.length !== 2 || turns[0].turn !== 1 || turns[1].turn !== 2) {
  throw new Error(`checkpoints: 行数据异常 ${JSON.stringify(turns)}`)
}

// 还原到第 1 轮（atSeq 位于第 1 轮内 → 边界为第 1 轮结束）
const restore = await callRoute('restore', { sessionId, atSeq: 5 })
if (restore.status !== 200 || restore.body.ok !== true) throw new Error(`restore 失败: ${JSON.stringify(restore)}`)
const value = restore.body.value
if (value.mode !== 'turn' || value.boundary?.turn !== 1) {
  throw new Error(`restore: 结果异常 ${JSON.stringify(value)}`)
}
if (await readFile(join(workspace, 'src', 'main.js'), 'utf8') !== 'v2\n') {
  throw new Error('restore: main.js 应回到第 1 轮内容')
}
if (await exists(join(workspace, 'later.txt'))) throw new Error('restore: later.txt 应被删除')
if (await readFile(join(workspace, 'extra.txt'), 'utf8') !== 'extra\n') {
  throw new Error('restore: extra.txt 应保留（第 1 轮创建）')
}
if (await readFile(join(workspace, 'README.md'), 'utf8') !== '# project\n') {
  throw new Error('restore: README 应保持不变')
}

// 还原到基线（首个问题编辑场景）
const baseline = await callRoute('restore', { sessionId, baseline: true })
if (baseline.body.ok !== true || baseline.body.value.mode !== 'baseline') {
  throw new Error(`baseline restore 失败: ${JSON.stringify(baseline)}`)
}
if (await readFile(join(workspace, 'src', 'main.js'), 'utf8') !== 'v1\n') {
  throw new Error('baseline restore: main.js 应回到基线内容')
}
if (await exists(join(workspace, 'extra.txt'))) throw new Error('baseline restore: extra.txt 应被删除')

// 未知方法：精确 Fetch 路由下不存在该路径 → Connection 侧 404
if (fetchRoutes.has('/api/recover-context/nope')) throw new Error('未知方法不应注册路由')

// 缺少 sessionId → 400
const badRequest = await callRoute('checkpoints', {})
if (badRequest.status !== 400) throw new Error(`缺少 sessionId 应返回 400，实际 ${badRequest.status}`)

// 方法错误 → 405
{
  const route = fetchRoutes.get('/api/recover-context/checkpoints')
  const response = await route.fetch(new Request('http://127.0.0.1:3081/api/recover-context/checkpoints', { method: 'GET' }))
  if (response.status !== 405) throw new Error(`GET 应返回 405，实际 ${response.status}`)
}

// ── 回退路径：没有 Connection 时使用 webServer 原生路由 ──────────────────
{
  const fallbackHome = await mkdtemp(join(tmpdir(), 'recover-context-home2-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = fallbackHome
  try {
    const { apply: applyFallback } = await import(`../lib/index.js?fallback=${Date.now()}`)
    let nativeRoute = null
    const fallbackCtx = {
      logger: { info: () => {}, warn: () => {} },
      effect(fn) {
        const out = fn()
        return typeof out === 'function' ? out : () => {}
      },
      on(event, listener) {
        return () => {}
      },
      sessions: { get: () => undefined },
      webServer: {
        register(route) {
          nativeRoute = route
          return () => { nativeRoute = null }
        },
      },
      get: () => undefined,
    }
    applyFallback(fallbackCtx)
    if (nativeRoute === null || nativeRoute.path !== '/api/recover-context') {
      throw new Error('无 Connection 时应注册 webServer 回退路由')
    }
  } finally {
    process.env.DSH_HOME = previousHome
    await rm(fallbackHome, { recursive: true, force: true })
  }
}

console.log('host.test.mjs: 所有断言通过 ✓')
await rm(tempHome, { recursive: true, force: true })
await rm(workspace, { recursive: true, force: true })

async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}
