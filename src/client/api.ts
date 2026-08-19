/**
 * Client fetch wrapper over the /recover-context JSON API. Every call posts
 * to `/recover-context/api/<method>`; failures surface as plain Errors with
 * the wire message.
 */

/** Restore result mirrored from the host. */
export interface RestoreResult {
  mode: 'turn' | 'baseline' | 'none'
  boundary?: { turn: number; endSeq: number }
  restored: string[]
  deleted: string[]
  skipped: { path: string; reason: string }[]
  dryRun: boolean
}

/** Checkpoint listing mirrored from the host. */
export interface CheckpointSummary {
  turn: number
  endSeq: number
  at: number
  changed: number
}

export interface CheckpointsResult {
  tracking: boolean
  hasBaseline: boolean
  checkpoints: CheckpointSummary[]
}

/** Wire envelope of one recover-context method. */
interface Wire<T> {
  ok?: boolean
  value?: T
  error?: { code?: string; message?: string }
}

/** Call one recover-context host method. */
export async function callApi<T>(method: string, payload: unknown): Promise<T> {
  const response = await fetch(`/recover-context/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  let body: Wire<T> | null = null
  try {
    body = await response.json() as Wire<T>
  } catch {
    // non-JSON body → fall through to the generic error
  }
  if (body === null || body.ok !== true) {
    const message = body?.error?.message ?? `recover-context ${method} failed (HTTP ${response.status})`
    throw new Error(message)
  }
  return body.value as T
}
