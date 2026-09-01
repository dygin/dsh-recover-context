/**
 * /recover-context JSON API 的网络传输辅助方法：
 * 包括请求体读取限制、响应格式化、统一错误封装，以及浏览器信任域防御
 * （逻辑与 /api 网关防御一致：校验 Loopback 主机头或已配置的信任域名；拒绝跨站跨域请求）。
 */
import type { IncomingHttpHeaders } from 'node:http'

/** recover-context API 的机器可读错误码 */
export type RecoverErrorCode =
  | 'bad-request'
  | 'not-found'
  | 'forbidden'
  | 'method-error'
  | 'internal'

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

const MAX_BODY_BYTES = 1 << 20

/** 读取并解析 JSON 请求体（受限于 1MB；格式错误抛出 bad-request） */
export async function readJsonBody(req: {
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>
}): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new RecoverError('bad-request', '请求体超出大小限制')
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

/** 写入指定状态码的 JSON 响应 */
export function writeJson(
  res: { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void },
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 写入成功响应信封 { ok: true, value } */
export function writeOk(res: Parameters<typeof writeJson>[0], value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

/** 写入失败响应信封 */
export function writeError(res: Parameters<typeof writeJson>[0], error: unknown): void {
  if (error instanceof RecoverError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
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

// ---- 信任域防护校验 --------------------------------------------------------

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

function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * 判断请求是否允许访问插件的内部 API 路由
 */
export function isTrustedApiRequest(
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
