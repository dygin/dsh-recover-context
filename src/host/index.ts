/**
 * dsh-recover-context host half.
 *
 * Two responsibilities:
 *  1. Workspace checkpointing — subscribes to the session append feed and
 *     records the session's working directory at the baseline (first
 *     observed event) and after every completed turn, so a rollback can
 *     restore the files the agent produced in the turns being discarded.
 *  2. The /recover-context JSON API — checkpoint listing and workspace
 *     restore. The conversation rollback itself (fork + archive + navigate)
 *     is orchestrated by the client half through the stock session.fork and
 *     workspace.archiveSession RPCs; this host half supplies the missing
 *     "directory records" piece.
 *
 * Storage lives under the DSH home (never inside the workspace):
 *   <dshHome>/storages/recover-context/<sessionId>/baseline.json
 *   <dshHome>/storages/recover-context/<sessionId>/turn-<n>.json
 * An optional <dshHome>/storages/recover-context/config.json can override
 * the tracker defaults (see CheckpointOptions).
 */
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { CheckpointStore, type CheckpointOptions } from './checkpoints.ts'
import {
  RecoverError, isTrustedApiRequest, optionalBoolean, optionalNumber,
  readJsonBody, requireString, writeError, writeJson, writeOk,
} from './wire.ts'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-recover-context'

/** Services required before mounting. */
export const inject = ['webServer', 'sessions', 'webRuntime']

// Re-export the engine so consumers and tests can exercise it standalone.
export { CheckpointStore, isIgnored, walkWorkspace } from './checkpoints.ts'
export type { Checkpoint, CheckpointOptions, RestoreResult, TrackedFile } from './checkpoints.ts'

/** Structural mirror of the session store face this plugin touches. */
interface SessionLike {
  id: string
  header: { cwd?: string; origin?: 'subagent'; id: string }
  events: readonly { type: string; seq: number; data?: { turn?: number } }[]
}

/** Structural mirror of one event row. */
interface EventLike {
  type: string
  seq: number
  data?: { turn?: number }
}

/** Structural mirror of the web runtime's trusted-hosts value. */
interface WebRuntimeLike {
  trustedHosts: readonly string[]
}

/** Structural mirror of the optional persistence service. */
interface PersistenceLike {
  inspect(id: string): Promise<{ meta: { cwd?: string }; events: readonly EventLike[] }>
}

/** Structural mirror of the host context (subset used here). */
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

/** Resolve the DSH home (same precedence as @deepseek-ai/dsh-home-paths). */
function dshHome(): string {
  const env = process.env.DSH_HOME
  if (env !== undefined && env.trim() !== '') return resolve(env)
  return join(homedir(), '.dsh')
}

/** The plugin's storage root under the DSH home. */
function storageRoot(): string {
  return join(dshHome(), 'storages', 'recover-context')
}

/** Load the optional per-user config.json (defaults when absent/invalid). */
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
    }
  } catch {
    return { enabled: true }
  }
}

/**
 * Browser plugin body.
 * @param ctx - host plugin context.
 */
export function apply(ctx: RecoverContext): void {
  /** Per-session checkpoint stores, keyed by session id. */
  const stores = new Map<string, CheckpointStore>()
  /** Per-session serialization chains (snapshots must not interleave). */
  const chains = new Map<string, Promise<unknown>>()
  let configPromise: Promise<CheckpointOptions & { enabled?: boolean }> | null = null

  const config = (): Promise<CheckpointOptions & { enabled?: boolean }> => {
    configPromise ??= loadConfig()
    return configPromise
  }

  /** Serialize one task per session id (fire-and-forget errors logged). */
  function enqueue<T>(sessionId: string, task: () => Promise<T>): Promise<T | undefined> {
    const previous = chains.get(sessionId) ?? Promise.resolve()
    const next = previous.then(task, task)
    chains.set(sessionId, next.catch(() => undefined))
    return next
  }

  /** Resolve the workspace root for a session, or undefined when untrackable. */
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

  /** Get or create the checkpoint store for a session. */
  async function storeFor(sessionId: string): Promise<CheckpointStore | undefined> {
    const existing = stores.get(sessionId)
    if (existing !== undefined) return existing
    const root = await workspaceRootOf(sessionId)
    if (root === undefined) return undefined
    const dshRoot = dshHome()
    if (root === dshRoot || root.startsWith(dshRoot + sep)) return undefined // never track the harness home
    const { enabled, ...options } = await config()
    if (enabled === false) return undefined
    const dir = join(storageRoot(), sessionId)
    await mkdir(dir, { recursive: true })
    const store = new CheckpointStore(dir, root, options)
    stores.set(sessionId, store)
    return store
  }

  /** Session event feed → baseline + per-turn checkpoints. */
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      const sessionId = session.header.id ?? session.id
      if (session.header.origin === 'subagent') return // subagents share cwd with their parent
      void enqueue(sessionId, async () => {
        const store = await storeFor(sessionId)
        if (store === undefined) return
        try {
          await store.ensureBaseline()
          if (event.type === 'turn/end' && event.data?.turn !== undefined) {
            await store.recordTurn(event.data.turn, event.seq)
          }
        } catch (error) {
          ctx.logger.warn(`dsh-recover-context: checkpoint failed for ${sessionId}: ${String(error)}`)
        }
      })
    })
    return off
  }, 'dsh-recover-context: session checkpoint feed')

  /** Read the session's event log (live session preferred, else persistence). */
  async function eventsOf(sessionId: string): Promise<readonly EventLike[]> {
    const live = ctx.sessions.get(sessionId)
    if (live !== undefined) return live.events
    const persistence = ctx.get<PersistenceLike>('sessionPersistence')
    if (persistence !== undefined) {
      try {
        return (await persistence.inspect(sessionId)).events
      } catch {
        // fall through
      }
    }
    return []
  }

  const api = {
    /** List the checkpoints recorded for one session. */
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
     * Restore the session's workspace to the recorded state at the rollback
     * point. `atSeq` anchors the boundary (first turn/end at or after it,
     * mirroring session.fork); `baseline: true` restores the pre-work state
     * (used when editing the very first question). `dryRun` only reports.
     */
    async restore(payload: unknown): Promise<unknown> {
      const sessionId = requireString(payload, 'sessionId')
      const atSeq = optionalNumber(payload, 'atSeq')
      const baseline = optionalBoolean(payload, 'baseline') ?? false
      const dryRun = optionalBoolean(payload, 'dryRun') ?? false
      const store = await storeFor(sessionId)
      if (store === undefined) {
        throw new RecoverError('not-found', `no recover-context tracking for session "${sessionId}"`, 404)
      }
      const events = await eventsOf(sessionId)
      const result = await enqueue(sessionId, async () => store.restore(events, { atSeq, baseline, dryRun }))
      if (result === undefined) throw new RecoverError('internal', 'restore task failed')
      return result
    },
  }

  // ── JSON API ────────────────────────────────────────────────────────────
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
        writeError(res as never, new RecoverError('not-found', 'unknown recover-context API method', 404))
        return
      }
      try {
        const payload = await readJsonBody(req as never)
        const handler = (api as Record<string, (value: unknown) => Promise<unknown>>)[method]
        if (handler === undefined) {
          throw new RecoverError('not-found', `unknown recover-context API method "${method}"`, 404)
        }
        writeOk(res as never, await handler(payload))
      } catch (error) {
        writeError(res as never, error)
      }
    },
  }), 'dsh-recover-context: /recover-context/api routes')
}
