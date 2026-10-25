/**
 * 客户端对 /api/recover-context JSON API 的 fetch 封装。
 * 所有调用向 `/api/recover-context/<method>` 发送 POST 请求；失败时抛出带
 * 网络错误信息的普通 Error。
 */

/** 宿主返回的恢复结果镜像 */
export interface RestoreResult {
  mode: 'turn' | 'baseline' | 'none'
  boundary?: { turn: number; endSeq: number }
  restored: string[]
  deleted: string[]
  skipped: { path: string; reason: string }[]
  dryRun: boolean
}

/** 检查点列表摘要项 */
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

/** 单个方法的线上响应信封 */
interface Wire<T> {
  ok?: boolean
  value?: T
  error?: { code?: string; message?: string }
}

const API_BASE = '/api/recover-context'

/** 调用一个 recover-context 宿主方法 */
export async function callApi<T>(method: string, payload: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  let body: Wire<T> | null = null
  try {
    body = await response.json() as Wire<T>
  } catch {
    // 非 JSON 响应 → 走通用错误
  }
  if (body === null || body.ok !== true) {
    const message = body?.error?.message ?? `recover-context ${method} 调用失败 (HTTP ${response.status})`
    throw new Error(message)
  }
  return body.value as T
}
