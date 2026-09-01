/**
 * dsh-recover-context 宿主端入口。
 *
 * 两大核心职责：
 *  1. 工作区检查点采集 — 监听会话事件流（session/event），在基线时刻（首次观察到事件）
 *     以及每个轮次完成时（turn/end）记录工作区目录状态，确保在回滚时能精准还原被撤销轮次产生的文件变更。
 *  2. /recover-context JSON API — 提供检查点查询列表与工作区恢复还原接口。
 *     会话本身的对话回滚由前端客户端基于原生 session.fork 与 workspace.archiveSession 完成，
 *     宿主端补充对应的工作区目录状态还原能力。
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
  RecoverError, isTrustedApiRequest, optionalBoolean, optionalNumber,
  readJsonBody, requireString, writeError, writeJson, writeOk,
} from './wire.ts'

/** 插件名称 */
export const name = 'dsh-recover-context'

/** 挂载前依赖注入的服务 */
export const inject = ['webServer', 'sessions', 'webRuntime']

// 重新导出引擎核心实现，便于外部消费者与独立测试直接使用
export { CheckpointStore, isIgnored, walkWorkspace, parseGitignore, matchesGitignore, hashFile, writeAtomic } from './checkpoints.ts'
export type { Checkpoint, CheckpointOptions, RestoreResult, TrackedFile, GitignoreRule } from './checkpoints.ts'

/** 会话存储对象的结构镜像 */
interface SessionLike {
  id: string
  header: { cwd?: string; origin?: 'subagent'; id: string }
  events: readonly { type: string; seq: number; data?: { turn?: number } }[]
}

/** 单个事件行的结构镜像 */
interface EventLike {
  type: string
  seq: number
  data?: { turn?: number }
}

/** Web 运行时的信任域结构镜像 */
interface WebRuntimeLike {
  trustedHosts: readonly string[]
}

/** 可选的会话持久化服务接口镜像 */
interface PersistenceLike {
  inspect(id: string): Promise<{ meta: { cwd?: string }; events: readonly EventLike[] }>
}

/** 宿主上下文接口镜像 */
export interface RecoverContext {
  effect(fn: () => void | (() => void), label?: string): void
  on(event: string, listener: (session: SessionLike, event: EventLike) => void): () => void
  sessions: {
    get(id: string): SessionLike | undefined
  }
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler(req: unknown, res: unknown): void | Promise<void>
    }): () => void
  }
  webRuntime: WebRuntimeLike
  get<T>(key: string): T | undefined
  logger: { info(message: string): void; warn(message: string): void }
}

/** 解析 DSH 根主目录路径 */
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

  /** 获取指定会话的工作区根目录 */
  async function workspaceRootOf(sessionId: string): Promise<string | undefined> {
    const live = ctx.sessions.get(sessionId)
    const liveCwd = live?.header.cwd
    if (liveCwd !== undefined && liveCwd !== '') return liveCwd
    const persistence = ctx.get<PersistenceLike>('sessionPersistence')
    if (persistence === undefined) return undefined
    try {
      const inspected = await persistence.inspect(sessionId)
      return inspected.meta.cwd
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

  /** 读取会话的事件日志（优先从活跃会话中读取，其次从持久化中读取） */
  async function eventsOf(sessionId: string): Promise<readonly EventLike[]> {
    const live = ctx.sessions.get(sessionId)
    if (live !== undefined) return live.events
    const persistence = ctx.get<PersistenceLike>('sessionPersistence')
    if (persistence !== undefined) {
      try {
        return (await persistence.inspect(sessionId)).events
      } catch {
        // 忽略读取错误
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
     * 将工作区目录还原到回滚点。
     * atSeq 指定截断锚点；baseline: true 恢复到初始状态；dryRun 仅做预检返回受影响文件清单。
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

  // ── JSON API 路由注册 ──────────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/recover-context/api',
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req as { headers: import('node:http').IncomingHttpHeaders }, ctx.webRuntime.trustedHosts)) {
        writeJson(res as never, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if ((req as { method?: string }).method !== 'POST') {
        writeJson(res as never, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
        return
      }
      const url = new URL((req as { url?: string }).url ?? '/', 'http://dsh.internal')
      const pathname = url.pathname
      const method = pathname.startsWith('/recover-context/api/')
        ? pathname.slice('/recover-context/api/'.length)
        : undefined
      if (method === undefined || method.includes('/')) {
        writeError(res as never, new RecoverError('not-found', '未知的 recover-context API 方法', 404))
        return
      }
      try {
        const payload = await readJsonBody(req as never)
        const handler = (api as Record<string, (value: unknown) => Promise<unknown>>)[method]
        if (handler === undefined) {
          throw new RecoverError('not-found', `未知的 recover-context API 方法 "${method}"`, 404)
        }
        writeOk(res as never, await handler(payload))
      } catch (error) {
        writeError(res as never, error)
      }
    },
  }), 'dsh-recover-context: /recover-context/api routes')
}
