/**
 * Host-half integration smoke test: drives the plugin's apply() with a fake
 * cordis-ish context — session event feed, webServer route registration,
 * trust fence, persistence — and verifies that:
 *   - turn/end events produce per-turn workspace checkpoints,
 *   - the /recover-context/api/restore route rewinds the workspace to the
 *     recorded state at the requested boundary.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Redirect the plugin's storage under a temp DSH home before importing.
// The workspace must live OUTSIDE the DSH home (the plugin never tracks
// files under the harness home).
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
  events,
}

/** The captured session/event listener. */
let onEvent = null
/** The captured webServer route handler. */
let routeHandler = null

const ctx = {
  logger: { info: () => {}, warn: (msg) => { console.error('[host test warn]', msg) } },
  effect(fn) { const out = fn(); return typeof out === 'function' ? out : () => {} },
  on(event, listener) {
    if (event !== 'session/event') throw new Error(`unexpected event ${event}`)
    onEvent = listener
    return () => { onEvent = null }
  },
  sessions: {
    get(id) { return id === sessionId ? session : undefined },
  },
  webServer: {
    register(route) {
      if (route.path !== '/recover-context/api') throw new Error(`unexpected path ${route.path}`)
      routeHandler = route.handler
      return () => { routeHandler = null }
    },
  },
  webRuntime: { trustedHosts: [] },
  get() { return undefined },
}

apply(ctx)

if (routeHandler === null || onEvent === null) {
  throw new Error('apply() did not register the route and the event listener')
}

/** Emit one session event through the plugin's feed. */
function emit(type, seq, data) {
  const event = { type, seq, data, time: Date.now() }
  events.push(event)
  onEvent(session, event)
}

/** Invoke the route with a JSON body and return the parsed response. */
async function callRoute(method, payload) {
  const body = JSON.stringify(payload)
  const req = {
    url: `/recover-context/api/${method}`,
    method: 'POST',
    headers: { host: '127.0.0.1:3081', 'sec-fetch-site': 'same-origin' },
    [Symbol.asyncIterator]() {
      let sent = false
      return {
        next: async () => {
          if (sent) return { done: true }
          sent = true
          return { done: false, value: body }
        },
      }
    },
  }
  let status = 0
  let text = ''
  const res = {
    writeHead(code, headers) { status = code },
    end(chunk) { text = String(chunk ?? '') },
  }
  await routeHandler(req, res)
  return { status, body: JSON.parse(text || '{}') }
}

// Baseline: the first event for the session snapshots the workspace.
emit('turn/start', 0, { turn: 1 })
emit('user/message', 1, { source: { kind: 'user' } })

// Turn 1 work: modify a file, create a file.
await new Promise(resolve => setTimeout(resolve, 30)) // let the checkpoint chain settle
await writeFile(join(workspace, 'src', 'main.js'), 'v2\n')
await writeFile(join(workspace, 'extra.txt'), 'extra\n')
emit('turn/end', 10, { turn: 1, reason: { kind: 'completed' } })
await new Promise(resolve => setTimeout(resolve, 30))

// Turn 2 work: create another file.
await writeFile(join(workspace, 'later.txt'), 'later\n')
emit('turn/end', 20, { turn: 2, reason: { kind: 'completed' } })
await new Promise(resolve => setTimeout(resolve, 50))

// checkpoints listing
const list = await callRoute('checkpoints', { sessionId })
if (list.status !== 200 || list.body.ok !== true) throw new Error(`checkpoints failed: ${JSON.stringify(list)}`)
if (list.body.value.tracking !== true) throw new Error('checkpoints: tracking expected true')
if (list.body.value.hasBaseline !== true) throw new Error('checkpoints: hasBaseline expected true')
const turns = list.body.value.checkpoints
if (turns.length !== 2 || turns[0].turn !== 1 || turns[1].turn !== 2) {
  throw new Error(`checkpoints: unexpected rows ${JSON.stringify(turns)}`)
}

// restore to turn 1 (atSeq inside turn 1 → boundary = turn 1's end)
const restore = await callRoute('restore', { sessionId, atSeq: 5 })
if (restore.status !== 200 || restore.body.ok !== true) throw new Error(`restore failed: ${JSON.stringify(restore)}`)
const value = restore.body.value
if (value.mode !== 'turn' || value.boundary?.turn !== 1) {
  throw new Error(`restore: unexpected result ${JSON.stringify(value)}`)
}
if (await readFile(join(workspace, 'src', 'main.js'), 'utf8') !== 'v2\n') {
  throw new Error('restore: main.js should be back at its turn-1 content')
}
if (await exists(join(workspace, 'later.txt'))) throw new Error('restore: later.txt should be deleted')
if (await readFile(join(workspace, 'extra.txt'), 'utf8') !== 'extra\n') {
  throw new Error('restore: extra.txt should survive (created in turn 1)')
}
if (await readFile(join(workspace, 'README.md'), 'utf8') !== '# project\n') {
  throw new Error('restore: README should be untouched')
}

// baseline restore (edit-first-question scenario)
const baseline = await callRoute('restore', { sessionId, baseline: true })
if (baseline.body.ok !== true || baseline.body.value.mode !== 'baseline') {
  throw new Error(`baseline restore failed: ${JSON.stringify(baseline)}`)
}
if (await readFile(join(workspace, 'src', 'main.js'), 'utf8') !== 'v1\n') {
  throw new Error('baseline restore: main.js should be back at baseline content')
}
if (await exists(join(workspace, 'extra.txt'))) throw new Error('baseline restore: extra.txt should be deleted')

// unknown method → 404
const missing = await callRoute('nope', {})
if (missing.status !== 404) throw new Error('unknown method should 404')

console.log('host.test.mjs: all assertions passed ✓')
await rm(tempHome, { recursive: true, force: true })

async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}
