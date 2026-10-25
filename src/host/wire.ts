/**
 * /recover-context JSON API 的网络辅助方法（适配 DSH 0.2.1 的 Fetch 路由）：
 * 统一错误封装、请求体读取限制、响应构造，以及回退到原生 HTTP 路由时使用的
 * 浏览器信任域校验（与 Connection 的 /api 防御语义一致：校验 Host/Origin，
 * 拒绝跨站请求）。
 */
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'

/** recover-context API 的机器可读错误码 */
export type RecoverErrorCode =
  | 'bad-request'
  | 'not-found'
  | 'forbidden'
  | 'method-error'
  | 'internal'
  /** 目标回滚点无法还原（无基线/无快照/无事件日志）——调用方必须中止流程 */
  | 'restore-unavailable'

/** 包含 HTTP 状态码与错误码的 API 错误异常类 */
export class RecoverError extends Error {
  constructor(
    readonly code: RecoverErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** 请求体大小上限（1 MiB） */
export const MAX_BODY_BYTES = 1 << 20

/** 读取并解析 Fetch 请求的 JSON 请求体（受限于 1 MiB；格式错误抛出 bad-request） */
export async function readJsonRequest(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) {
    throw new RecoverError('bad-request', '请求体超出大小限制', 413)
  }
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new RecoverError('bad-request', '请求体不是合法的 JSON')
  }
}

/** 构造成功响应信封 { ok: true, value } */
export function okResponse(value: unknown): Response {
  return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
}

/** 构造失败响应信封 */
export function errorResponse(error: unknown): Response {
  if (error instanceof RecoverError) {
    return Response.json(
      { ok: false, error: { code: error.code, message: error.message } },
      { status: error.status, headers: { 'cache-control': 'no-store' } },
    )
  }
  const message = error instanceof Error ? error.message : String(error)
  return Response.json(
    { ok: false, error: { code: 'internal', message } },
    { status: 500, headers: { 'cache-control': 'no-store' } },
  )
}

/** 校验并提取载荷中的必填字符串字段 */
export function requireString(payload: unknown, key: string): string {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (typeof value !== 'string' || value === '') {
    throw new RecoverError('bad-request', `缺少或无效的字段 "${key}"`)
  }
  return value
}

/** 提取可选的数值字段 */
export function optionalNumber(payload: unknown, key: string): number | undefined {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RecoverError('bad-request', `无效的数值字段 "${key}"`)
  }
  return value
}

/** 提取可选的布尔字段 */
export function optionalBoolean(payload: unknown, key: string): boolean | undefined {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new RecoverError('bad-request', `无效的布尔字段 "${key}"`)
  return value
}

// ---- 原生 HTTP 回退路由的信任域校验 ----------------------------------------

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** 判断主机名是否为本地回环地址 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    const entryPort = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
    const canonical = entryPort === '' ? entryUrl.hostname : `${entryUrl.hostname}:${entryPort}`
    return canonical === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * 判断原生 HTTP 请求是否允许访问插件的回退 API 路由。
 * 仅在 Connection 服务缺失（非 Web 组合）时使用。
 */
export function isTrustedNodeRequest(
  request: { headers: IncomingHttpHeaders },
  trustedHosts: readonly string[],
): boolean {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 读取原生 HTTP 请求的 JSON 请求体（受限于 1 MiB） */
export async function readNodeJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Buffer)
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw new RecoverError('bad-request', '请求体超出大小限制', 413)
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new RecoverError('bad-request', '请求体不是合法的 JSON')
  }
}

/** 向原生 HTTP 响应写入 JSON 信封 */
export function writeNodeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

/** 向原生 HTTP 响应写入成功信封 */
export function writeNodeOk(response: ServerResponse, value: unknown): void {
  writeNodeJson(response, 200, { ok: true, value })
}

/** 向原生 HTTP 响应写入失败信封 */
export function writeNodeError(response: ServerResponse, error: unknown): void {
  if (error instanceof RecoverError) {
    writeNodeJson(response, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeNodeJson(response, 500, { ok: false, error: { code: 'internal', message } })
}
