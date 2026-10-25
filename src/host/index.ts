/**
 * dsh-recover-context 宿主端入口（适配 DSH 0.2.1-rc.2）。
 *
 * 两大核心职责：
 *  1. 工作区检查点采集 — 监听 `session/event` 事件流，在基线时刻（首次观察到事件）
 *     与每个轮次完成时（`turn/end`）记录工作区目录状态，确保回滚时能精准还原
 *     被撤销轮次产生的文件变更。
 *  2. /api/recover-context JSON API — 提供检查点查询与工作区还原。
 *     路由通过 `ctx.connection.fetch` 注册，因而自动复用 Connection 的浏览器
 *     认证与 Host/Origin 信任域校验；无 Connection 服务时退回 `ctx.webServer`
 *     的自建路由 + 本地信任校验。
 *
 * 存储路径（位于 DSH 主目录下，绝不污染用户工作区）：
 *   <dshHome>/storages/recover-context/<sessionId>/baseline.json
 *   <dshHome>/storages/recover-context/<sessionId>/turn-<n>.json
 *   <dshHome>/storages/recover-context/<sessionId>/blobs/<sha>
 * 可通过 <dshHome>/storages/recover-context/config.json 覆盖追踪器默认配置。
 */
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { CheckpointStore, type CheckpointOptions } from './checkpoints.ts'
import {
  RecoverError, errorResponse, isTrustedNodeRequest, okResponse, optionalBoolean,
  optionalNumber, readJsonRequest, readNodeJsonBody, requireString,
  writeNodeError, writeNodeJson, writeNodeOk,
} from './wire.ts'

/** 插件名称 */
export const name = 'dsh-recover-context'

/** 挂载前依赖注入的服务（sessionPersistence / connection 按需可选读取） */
export const inject = ['webServer', 'sessions']

// 重新导出引擎核心实现，便于外部消费者与独立测试直接使用
export { CheckpointStore, isIgnored, walkWorkspace, parseGitignore, matchesGitignore, hashFile, writeAtomic } from './checkpoints.ts'
export type { Checkpoint, CheckpointOptions, RestoreResult, TrackedFile, GitignoreRule } from './checkpoints.ts'

/** 会话存储对象的结构镜像（取插件实际读取的字段） */
interface SessionLike {
  id: string
  header: { cwd?: string; origin?: 'subagent'; id: string }
  /** 旧版实时快照读取（持久化服务缺失时的回退） */
  snapshotEvents?(): readonly EventLike[]
}

/** 单个事件行的结构镜像 */
interface EventLike {
  type: string
  seq: number
  time?: number
  data?: { turn?: number; reason?: unknown }
}

/** 可选的会话持久化服务接口镜像（DSH 0.2.1 的 SessionPersistence） */
interface SessionPersistenceLike {
  stat(id: string): Promise<{ header: { cwd?: string } } | undefined>
  open(id: string, access: 'read' | 'write', options?: { signal?: AbortSignal }): Promise<{
    read(offset?: number, length?: number): Promise<{ events: readonly EventLike[] }>
    close(): Promise<void>
  }>
}

/** Connection 精确 Fetch 路由注册接口镜像 */
interface ConnectionLike {
  fetch: {
    register(route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered' | 'streaming'
      fetch(request: Request): Promise<Response>
    }): () => Promise<void>
  }
}

/** WebServer 原生路由注册接口镜像 */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler(req: unknown, res: unknown): void | Promise<void>
  }): () => void
}

/** 宿主上下文接口镜像 */
export interface RecoverContext {
  effect(fn: () => void | (() => void) | Promise<void | (() => void)>, label?: string): void
  on(event: string, listener: (session: SessionLike, event: EventLike) => void): () => void
  sessions: {
    get(id: string): SessionLike | undefined
  }
  webServer: WebServerLike
  get<T>(key: string): T | undefined
  logger: { info(message: string): void; warn(message: string): void }
}

/** 解析 DSH 根主目录路径（优先级：$DSH_HOME → ~/.dsh） */
function dshHome(): string {
  const env = process.env.DSH_HOME
  if (env !== undefined && env.trim() !== '') return resolve(env)
  return join(homedir(), '.dsh')
}

/** 插件存储在 DSH 下的根目录 */
function storageRoot(): string {
  return join(dshHome(), 'storages', 'recover-context')
}

/** 加载可选的用户全局配置文件 config.json */
async function loadConfig(): Promise<CheckpointOptions & { enabled?: boolean }> {
  try {
    const raw = await readFile(join(storageRoot(), 'config.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
      ...(Array.isArray(parsed.ignoreNames) ? { ignoreNames: parsed.ignoreNames as string[] } : {}),
      ...(Array.isArray(parsed.ignorePatterns) ? { ignorePatterns: parsed.ignorePatterns as string[] } : {}),
      ...(typeof parsed.trackSizeCap === 'number' ? { trackSizeCap: parsed.trackSizeCap } : {}),
      ...(typeof parsed.blobSizeCap === 'number' ? { blobSizeCap: parsed.blobSizeCap } : {}),
      ...(typeof parsed.maxFiles === 'number' ? { maxFiles: parsed.maxFiles } : {}),
      ...(typeof parsed.maxTotalBlobBytes === 'number' ? { maxTotalBlobBytes: parsed.maxTotalBlobBytes } : {}),
      ...(typeof parsed.enableGitignore === 'boolean' ? { enableGitignore: parsed.enableGitignore } : {}),
    }
  } catch {
    return { enabled: true }
  }
}

/**
 * 宿主插件主入口。
 * @param ctx 宿主插件上下文
 */
export function apply(ctx: RecoverContext): void {
  /** 各会话的快照存储实例字典 */
  const stores = new Map<string, CheckpointStore>()
  /** 各会话的串行化操作 Promise 链（防止并发快照互相交错） */
  const chains = new Map<string, Promise<unknown>>()
  let configPromise: Promise<CheckpointOptions & { enabled?: boolean }> | null = null

  const config = (): Promise<CheckpointOptions & { enabled?: boolean }> => {
    configPromise ??= loadConfig()
    return configPromise
  }

  /** 串行化执行单个会话的操作队列 */
  function enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T | undefined> {
    const previous = chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(task, task)
    chains.set(sessionId, next.catch(() => undefined))
    return next
  }

  /** 读取会话持久化服务（Web 组合中由 session-persistence-jsonl 提供） */
  function persistence(): SessionPersistenceLike | undefined {
    return ctx.get<SessionPersistenceLike>('sessionPersistence')
  }

  /** 获取指定会话的工作区根目录 */
  async function workspaceRootOf(sessionId: string): Promise<string | undefined> {
    const live = ctx.sessions.get(sessionId)
    const liveCwd = live?.header.cwd
    if (liveCwd !== undefined && liveCwd !== '') return liveCwd
    const store = persistence()
    if (store === undefined) return undefined
    try {
      const snapshot = await store.stat(sessionId)
      return snapshot?.header.cwd
    } catch {
      return undefined
    }
  }

  /** 获取或初始化会话的检查点存储器 */
  async function storeFor(sessionId: string): Promise<CheckpointStore | undefined> {
    const existing = stores.get(sessionId)
    if (existing !== undefined) return existing
    const root = await workspaceRootOf(sessionId)
    if (root === undefined) return undefined
    const dshRoot = dshHome()
    if (root === dshRoot || root.startsWith(dshRoot + sep)) return undefined // 绝不追踪 DSH 自身主目录
    const { enabled, ...options } = await config()
    if (enabled === false) return undefined
    const dir = join(storageRoot(), sessionId)
    await mkdir(dir, { recursive: true })
    const store = new CheckpointStore(dir, root, { ...options, logger: ctx.logger })
    stores.set(sessionId, store)
    return store
  }

  /** 监听会话事件流 → 自动创建基线与轮次检查点 */
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      const sessionId = session.header.id ?? session.id
      if (session.header.origin === 'subagent') return // 子代理共享父会话的 cwd，不重复采集
      void enqueue(sessionId, async () => {
        const store = await storeFor(sessionId)
        if (store === undefined) return
        try {
          await store.ensureBaseline()
          if (event.type === 'turn/end' && event.data?.turn !== undefined) {
            await store.recordTurn(event.data.turn, event.seq)
          }
        } catch (error) {
          ctx.logger.warn(`dsh-recover-context: 会话 ${sessionId} 检查点保存失败: ${String(error)}`)
        }
      })
    })
    return off
  }, 'dsh-recover-context: session checkpoint feed')

  /** 读取会话的事件日志（优先持久化服务，其次旧的实时快照） */
  async function eventsOf(sessionId: string): Promise<readonly EventLike[]> {
    const store = persistence()
    if (store !== undefined) {
      let handle
      try {
        handle = await store.open(sessionId, 'read')
        const result = await handle.read()
        return result.events
      } catch {
        // 持久化不可用 → 回退到实时快照
      } finally {
        if (handle !== undefined) {
          await handle.close().catch(() => undefined)
        }
      }
    }
    const live = ctx.sessions.get(sessionId)
    if (live?.snapshotEvents !== undefined) {
      try {
        return live.snapshotEvents()
      } catch {
        // 忽略读取失败
      }
    }
    return []
  }

  const api = {
    /** 查询某个会话已记录的检查点列表 */
    async checkpoints(payload: unknown): Promise<unknown> {
      const sessionId = requireString(payload, 'sessionId')
      const store = await storeFor(sessionId)
      if (store === undefined) {
        return { tracking: false, hasBaseline: false, checkpoints: [] }
      }
      const result = await enqueue(sessionId, async () =>
        Promise.all([store.hasBaseline(), store.list()]))
      return {
        tracking: true,
        hasBaseline: result?.[0] ?? false,
        checkpoints: result?.[1] ?? [],
      }
    },

    /**
     * 按当前工作区重建该会话的基线（仅对尚无任何轮次检查点的空白会话生效）。
     *
     * 回滚/编辑会先还原工作区、再让 Workspace 流程复用或创建空白会话；
     * 被复用的空白会话可能带着陈旧基线。调用本方法让它对齐还原后的真实状态，
     * 避免日后在该会话里回退时把已删除的文件“复活”。
     */
    async resetBaseline(payload: unknown): Promise<unknown> {
      const sessionId = requireString(payload, 'sessionId')
      const store = await storeFor(sessionId)
      if (store === undefined) {
        throw new RecoverError('not-found', `未找到会话 "${sessionId}" 的恢复上下文记录`, 404)
      }
      const result = await enqueue(sessionId, async () => store.resetBaseline())
      if (result === undefined) throw new RecoverError('internal', '基线重建失败')
      return { reset: result }
    },

    /**
     * 将工作区目录还原到回滚点。
     * atSeq 指定截断锚点；baseline: true 恢复到初始状态；dryRun 仅做预检。
     */
    async restore(payload: unknown): Promise<unknown> {
      const sessionId = requireString(payload, 'sessionId')
      const atSeq = optionalNumber(payload, 'atSeq')
      const baseline = optionalBoolean(payload, 'baseline') ?? false
      const dryRun = optionalBoolean(payload, 'dryRun') ?? false
      const store = await storeFor(sessionId)
      if (store === undefined) {
        throw new RecoverError('not-found', `未找到会话 "${sessionId}" 的恢复上下文记录`, 404)
      }
      const events = await eventsOf(sessionId)
      const result = await enqueue(sessionId, async () => store.restore(events, { atSeq, baseline, dryRun }))
      if (result === undefined) throw new RecoverError('internal', '恢复任务执行失败')
      return result
    },
  }

  /** 按方法名分发一次 API 调用 */
  async function dispatch(method: string, payload: unknown): Promise<unknown> {
    if (method !== 'checkpoints' && method !== 'restore' && method !== 'resetBaseline') {
      throw new RecoverError('not-found', `未知的 recover-context API 方法 "${method}"`, 404)
    }
    return api[method](payload)
  }

  // ── 首选：Connection 精确 Fetch 路由（自动获得浏览器认证与信任域校验） ──
  const connection = ctx.get<ConnectionLike>('connection')
  const routes = [
    { method: 'checkpoints', path: '/api/recover-context/checkpoints' },
    { method: 'restore', path: '/api/recover-context/restore' },
    { method: 'resetBaseline', path: '/api/recover-context/resetBaseline' },
  ] as const

  if (connection !== undefined) {
    ctx.effect(() => {
      const disposers = routes.map(route => connection.fetch.register({
        path: route.path,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request): Promise<Response> => {
          if (request.method !== 'POST') {
            return Response.json(
              { ok: false, error: { code: 'method-error', message: 'method not allowed' } },
              { status: 405 },
            )
          }
          try {
            const payload = await readJsonRequest(request)
            return okResponse(await dispatch(route.method, payload))
          } catch (error) {
            return errorResponse(error)
          }
        },
      }))
      return async () => {
        await Promise.allSettled(disposers.map(dispose => dispose()))
      }
    }, 'dsh-recover-context: /api/recover-context fetch routes')
    return
  }

  // ── 回退：原生 HTTP 路由（无 Connection 的部署） ────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/recover-context',
    handler: async (req, res) => {
      const request = req as { method?: string; url?: string; headers: Record<string, string | string[] | undefined> }
      const response = res as {
        writeHead(status: number, headers?: Record<string, string>): unknown
        end(body?: string): unknown
      }
      if (!isTrustedNodeRequest(request as never, [])) {
        writeNodeJson(response as never, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (request.method !== 'POST') {
        writeNodeJson(response as never, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const url = new URL(request.url ?? '/', 'http://dsh.internal')
      const method = url.pathname.startsWith('/api/recover-context/')
        ? url.pathname.slice('/api/recover-context/'.length)
        : undefined
      if (method === undefined || method.includes('/')) {
        writeNodeError(response as never, new RecoverError('not-found', '未知的 recover-context API 方法', 404))
        return
      }
      try {
        const payload = await readNodeJsonBody(req as never)
        writeNodeOk(response as never, await dispatch(method, payload))
      } catch (error) {
        writeNodeError(response as never, error)
      }
    },
  }), 'dsh-recover-context: /api/recover-context fallback routes')
}
