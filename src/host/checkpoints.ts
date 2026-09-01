/**
 * dsh-recover-context 快照引擎（宿主端核心实现）。
 *
 * 在两个粒度跟踪会话的工作区目录状态：
 *   - 基线快照（BASELINE）：插件首次监视到会话时采集（≈ 该会话开始工作前的初始状态）
 *   - 轮次检查点（CHECKPOINT）：每个轮次完成时（`turn/end`）采集，精确记录该轮结束时的工作区状态。
 *
 * 回滚到某个轮次 T 时，将工作区精准还原到 T 的检查点状态（或初始基线），撤销 T 之后产生的各类文件变更。
 *
 * 存储结构（位于 DSH 主目录外，不会污染工作区）：
 *   <home>/storages/recover-context/<sessionId>/baseline.json
 *   <home>/storages/recover-context/<sessionId>/turn-<n>.json
 *   <home>/storages/recover-context/<sessionId>/blobs/<sha>
 *
 * 该引擎为无 cordis 依赖的独立纯 TypeScript 类，可通过 tests/checkpoints.test.mjs 独立测试。
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

/** 默认永不追踪的文件/目录名（重量级依赖或版本控制元数据） */
export const DEFAULT_IGNORE_NAMES = [
  '.git', 'node_modules', '.pnpm-store', '.venv', 'venv', '__pycache__', 'dist', 'build',
  '.next', '.nuxt', '.idea', '.vscode', '.mypy_cache', '.pytest_cache',
  '.DS_Store', 'coverage', '.turbo', '.cache', 'target',
]
/** 默认永不追踪的文件名通配规则 */
export const DEFAULT_IGNORE_PATTERNS = ['*.pyc', '*.pyo', '*.log', '*.tmp', '*.swp']

/** 快照中记录的单个文件元数据标识 */
export interface TrackedFile {
  /** 文件的 SHA-256 哈希十六进制值；超过 trackSizeCap 的大文件不计算 sha */
  sha?: string
  size: number
  /** 文件 stat 的 mtimeMs，用于在后续快照扫描中跳过未修改文件的重复哈希计算 */
  mtimeMs: number
}

/** 一次不可变的工作区快照定义 */
export interface Checkpoint {
  kind: 'baseline' | 'turn'
  /** 轮次编号；基线快照为 0 */
  turn: number
  /** 生成该检查点的 turn/end 事件的 seq 序列号；基线为 -1 */
  endSeq: number
  /** 快照采集时的时间戳（毫秒） */
  at: number
  /** 相对路径 → 文件元数据映射字典 */
  files: Record<string, TrackedFile>
  /**
   * Base64 文件内容（用于向下兼容历史旧格式快照）。
   * 现代版本快照内容直接存储在 <storageDir>/blobs/<sha> 内容寻址池中。
   */
  blobs?: Record<string, string>
}

export interface CheckpointOptions {
  /** 需要忽略的目录/文件名列表 */
  ignoreNames?: readonly string[]
  /** 需要忽略的文件名通配模式（如 *.log） */
  ignorePatterns?: readonly string[]
  /** 超过此大小的文件不计算哈希（仅根据 size+mtime 标记） */
  trackSizeCap?: number
  /** 超过此大小的文件不保存内容 Blob（不可恢复内容） */
  blobSizeCap?: number
  /** 单个工作区最大扫描追踪文件数量上限（防止超大目录死循环） */
  maxFiles?: number
  /** 单个会话保存的所有 Blob 总字节上限 */
  maxTotalBlobBytes?: number
  /** 是否自动解析工作区根目录的 .gitignore 文件（默认为 true） */
  enableGitignore?: boolean
  /** 日志记录器 */
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void }
}

/** 一次还原操作的结果详情 */
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

const patternToRegExp = (pattern: string): RegExp | null => {
  if (!pattern.includes('*')) return null
  const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${escaped}$`)
}

export interface GitignoreRule {
  pattern: string
  negate: boolean
  dirOnly: boolean
  regex: RegExp
}

/** 解析 .gitignore 文本行并生成规则集合 */
export function parseGitignore(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = []
  const lines = content.split(/\r?\n/)
  for (let line of lines) {
    line = line.trim()
    if (line === '' || line.startsWith('#')) continue
    let negate = false
    if (line.startsWith('!')) {
      negate = true
      line = line.slice(1).trim()
    }
    if (line === '') continue

    let dirOnly = false
    if (line.endsWith('/')) {
      dirOnly = true
      line = line.slice(0, -1)
    }

    const hasSlash = line.includes('/')
    let norm = line.startsWith('/') ? line.slice(1) : line
    norm = norm.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // 通配符转换处理
    norm = norm.replace(/\*\*/g, '___DOUBLE_STAR___')
    norm = norm.replace(/\*/g, '[^/]*')
    norm = norm.replace(/\?/g, '[^/]')
    norm = norm.replace(/___DOUBLE_STAR___\//g, '(?:.*/)?')
    norm = norm.replace(/___DOUBLE_STAR___/g, '.*')

    const regexStr = hasSlash ? `^${norm}$` : `(?:^|/)${norm}$`
    try {
      rules.push({
        pattern: line,
        negate,
        dirOnly,
        regex: new RegExp(regexStr),
      })
    } catch {
      // 忽略无效正则
    }
  }
  return rules
}

/** 校验相对路径是否匹配 .gitignore 规则 */
export function matchesGitignore(
  relPath: string,
  isDir: boolean,
  rules: readonly GitignoreRule[],
): boolean {
  if (rules.length === 0) return false
  const normalizedPath = relPath.split(sep).join('/')
  let ignored = false
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue
    if (rule.regex.test(normalizedPath)) {
      ignored = !rule.negate
    }
  }
  return ignored
}

/** 判断某个相对路径是否应被忽略 */
export function isIgnored(
  relPath: string,
  ignoreNames: readonly string[],
  ignorePatterns: readonly string[],
  isDir = false,
  gitignoreRules: readonly GitignoreRule[] = [],
): boolean {
  const segments = relPath.split(sep)
  const names = new Set(ignoreNames)
  const regexes = ignorePatterns.map(patternToRegExp).filter((r): r is RegExp => r !== null)
  for (const segment of segments) {
    if (names.has(segment)) return true
    for (const regex of regexes) if (regex.test(segment)) return true
  }
  if (gitignoreRules.length > 0 && matchesGitignore(relPath, isDir, gitignoreRules)) {
    return true
  }
  return false
}

/** 将用户传入的绝对路径规范化为相对于工作区根目录的相对路径 */
export function toRelative(root: string, absolute: string): string {
  const rel = relative(root, absolute)
  return rel === '' ? '.' : rel
}

/** 基于 Stream 流式计算 SHA-256，避免整读文件撑大内存 */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  await pipeline(stream, hash)
  return hash.digest('hex')
}

/** 基于临时文件 + rename 实现原子落盘，防止中途异常损坏文件 */
export async function writeAtomic(targetPath: string, data: string | Buffer): Promise<void> {
  const tmpPath = `${targetPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(tmpPath, data)
  await rename(tmpPath, targetPath)
}

/**
 * 递归遍历工作区目录并收集文件标识元数据。
 * 跳过符号链接（防止循环引用或越界），仅对 <= trackSizeCap 的文件计算哈希。
 * 当提供 previousFiles 时，尺寸与修改时间一致的文件直接复用旧哈希，无需重新读盘。
 */
export async function walkWorkspace(
  root: string,
  options: CheckpointOptions = {},
  previousFiles?: Record<string, TrackedFile>,
): Promise<Record<string, TrackedFile>> {
  const ignoreNames = options.ignoreNames ?? DEFAULT_IGNORE_NAMES
  const ignorePatterns = options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS
  const trackSizeCap = options.trackSizeCap ?? 5 * 1024 * 1024
  const maxFiles = options.maxFiles ?? 100000
  const enableGitignore = options.enableGitignore ?? true
  const files: Record<string, TrackedFile> = {}
  const rootAbs = resolve(root)

  let gitignoreRules: GitignoreRule[] = []
  if (enableGitignore) {
    try {
      const gitignoreContent = await readFile(join(rootAbs, '.gitignore'), 'utf8')
      gitignoreRules = parseGitignore(gitignoreContent)
    } catch {
      // .gitignore 不存在或无法读取
    }
  }

  let count = 0
  let limitWarned = false

  const walk = async (dir: string): Promise<void> => {
    if (count >= maxFiles) {
      if (!limitWarned) {
        limitWarned = true
        options.logger?.warn?.(`[dsh-recover-context] 工作区文件数量达到上限 (${maxFiles} 个)，停止继续深度遍历`)
      }
      return
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // 不可读目录直接跳过
    }
    for (const entry of entries) {
      if (count >= maxFiles) break
      const absolute = join(dir, entry.name)
      const rel = toRelative(rootAbs, absolute)
      if (entry.isDirectory()) {
        if (!isIgnored(rel, ignoreNames, ignorePatterns, true, gitignoreRules)) {
          await walk(absolute)
        }
        continue
      }
      if (entry.isSymbolicLink()) continue
      if (!entry.isFile()) continue
      if (isIgnored(rel, ignoreNames, ignorePatterns, false, gitignoreRules)) continue

      let info
      try {
        info = await stat(absolute)
      } catch {
        continue
      }

      count += 1
      if (info.size > trackSizeCap) {
        files[rel] = { size: info.size, mtimeMs: info.mtimeMs }
        continue
      }

      // 若大小和修改时间与上一版本一致，直接复用上一次的 SHA 哈希
      const prev = previousFiles?.[rel]
      if (prev !== undefined && prev.sha !== undefined && prev.size === info.size && Math.abs(prev.mtimeMs - info.mtimeMs) < 1) {
        files[rel] = { sha: prev.sha, size: info.size, mtimeMs: info.mtimeMs }
        continue
      }

      let sha = ''
      try {
        sha = await hashFile(absolute)
      } catch {
        continue
      }
      files[rel] = { sha, size: info.size, mtimeMs: info.mtimeMs }
    }
  }

  await walk(rootAbs)
  return files
}

/** Base64 字符串解码为 Buffer */
export function decodeBlob(blob: string): Buffer {
  return Buffer.from(blob, 'base64')
}

/** 计算新快照中相较于上一快照发生变动的文件内容 Blob（仅用于兼容性） */
function changedBlobs(
  next: Record<string, TrackedFile>,
  prev: Record<string, TrackedFile> | undefined,
  readContent: (rel: string, size: number) => Promise<string | null>,
): Promise<Record<string, string>> {
  return (async () => {
    const blobs: Record<string, string> = {}
    for (const [rel, file] of Object.entries(next)) {
      const before = prev?.[rel]
      if (before !== undefined && before.sha === file.sha) continue
      if (file.sha === undefined) continue
      const content = await readContent(rel, file.size)
      if (content !== null) blobs[rel] = content
    }
    return blobs
  })()
}

/**
 * 单会话检查点存储管理器。所有操作由调用方按 session id 串行化排队执行。
 */
export class CheckpointStore {
  private readonly dir: string
  private readonly root: string
  private readonly options: Required<CheckpointOptions>
  private baselineLoaded = false
  private baseline: Checkpoint | undefined
  private turnsLoaded = false
  private turns: Map<number, Checkpoint> = new Map()
  private totalBlobBytes = 0

  constructor(dataDir: string, workspaceRoot: string, options: CheckpointOptions = {}) {
    this.dir = dataDir
    this.root = resolve(workspaceRoot)
    this.options = {
      ignoreNames: options.ignoreNames ?? DEFAULT_IGNORE_NAMES,
      ignorePatterns: options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS,
      trackSizeCap: options.trackSizeCap ?? 5 * 1024 * 1024,
      blobSizeCap: options.blobSizeCap ?? 1024 * 1024,
      maxFiles: options.maxFiles ?? 100000,
      maxTotalBlobBytes: options.maxTotalBlobBytes ?? 500 * 1024 * 1024,
      enableGitignore: options.enableGitignore ?? true,
      logger: options.logger ?? {},
    }
  }

  get workspaceRoot(): string {
    return this.root
  }

  private baselinePath(): string {
    return join(this.dir, 'baseline.json')
  }

  private turnPath(turn: number): string {
    return join(this.dir, `turn-${turn}.json`)
  }

  private blobsDir(): string {
    return join(this.dir, 'blobs')
  }

  private blobPath(sha: string): string {
    return join(this.blobsDir(), sha)
  }

  /** 检查 CAS 磁盘中是否已存在该 SHA 对应的 Blob 文件 */
  private async hasBlob(sha: string): Promise<boolean> {
    try {
      await stat(this.blobPath(sha))
      return true
    } catch {
      return false
    }
  }

  /** 将工作区文件安全保存到 CAS 内容寻址池中（已存在则跳过写入） */
  private async saveBlob(sha: string, sourcePath: string, size: number): Promise<boolean> {
    if (size > this.options.blobSizeCap) return false
    if (this.totalBlobBytes + size > this.options.maxTotalBlobBytes) {
      this.options.logger.warn?.(`[dsh-recover-context] 会话 Blob 存储超出限制 (${this.options.maxTotalBlobBytes} 字节)，跳过存储 ${sha}`)
      return false
    }
    if (await this.hasBlob(sha)) return true
    try {
      const data = await readFile(sourcePath)
      await writeAtomic(this.blobPath(sha), data)
      this.totalBlobBytes += size
      return true
    } catch {
      return false
    }
  }

  /** 从 CAS 存储中读取 Blob，或降级解析旧格式内联 Base64 Blob */
  async getBlob(sha: string, legacyBlob?: string): Promise<Buffer | null> {
    if (await this.hasBlob(sha)) {
      try {
        return await readFile(this.blobPath(sha))
      } catch {
        // 读取失败则回退
      }
    }
    if (legacyBlob !== undefined) {
      return decodeBlob(legacyBlob)
    }
    return null
  }

  private async loadBaseline(): Promise<void> {
    if (this.baselineLoaded) return
    this.baselineLoaded = true
    try {
      const raw = await readFile(this.baselinePath(), 'utf8')
      this.baseline = JSON.parse(raw) as Checkpoint
    } catch {
      this.baseline = undefined
    }
  }

  private async loadTurns(): Promise<void> {
    if (this.turnsLoaded) return
    this.turnsLoaded = true
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      const match = /^turn-(\d+)\.json$/.exec(name)
      if (match === null) continue
      try {
        const raw = await readFile(join(this.dir, name), 'utf8')
        const checkpoint = JSON.parse(raw) as Checkpoint
        this.turns.set(checkpoint.turn, checkpoint)
      } catch {
        // 损坏快照直接忽略（恢复时降级寻找更早可用快照）
      }
    }
  }

  /** 检查该会话是否存在任何有效快照 */
  async hasAny(): Promise<boolean> {
    await this.loadBaseline()
    await this.loadTurns()
    return this.baseline !== undefined || this.turns.size > 0
  }

  /**
   * 采集基线快照（若已存在则直接返回）。
   *
   * CAS 流式基线：将追踪的文件 Blob 逐个写入独立的 blobs/<sha> 磁盘文件（O(1) 内存开销），
   * baseline.json 仅持久化轻量级的元数据索引字典 `{ relPath: TrackedFile }`。
   */
  async ensureBaseline(now = Date.now()): Promise<Checkpoint> {
    await this.loadBaseline()
    if (this.baseline !== undefined) return this.baseline
    await mkdir(this.dir, { recursive: true })
    const files = await walkWorkspace(this.root, this.options)

    // 逐个流式写盘，内存不常驻任何大 Base64 对象
    for (const [rel, file] of Object.entries(files)) {
      if (file.sha === undefined) continue
      await this.saveBlob(file.sha, join(this.root, rel), file.size)
    }

    const baseline: Checkpoint = { kind: 'baseline', turn: 0, endSeq: -1, at: now, files }
    await writeAtomic(this.baselinePath(), JSON.stringify(baseline))
    this.baseline = baseline
    return baseline
  }

  /**
   * 记录一轮完成时的检查点。
   * 采用差量快照：未变动的文件通过 mtime 复用哈希；本轮新增或修改的文件流式写入 CAS blobs/<sha>。
   */
  async recordTurn(turn: number, endSeq: number, now = Date.now()): Promise<Checkpoint> {
    await this.loadTurns()
    const existing = this.turns.get(turn)
    if (existing !== undefined && existing.endSeq === endSeq) return existing
    await mkdir(this.dir, { recursive: true })
    const previous = await this.previousOf(turn)
    const files = await walkWorkspace(this.root, this.options, previous?.files)

    // 保存本轮中新增或修改的文件至 CAS Blob 存储中
    for (const [rel, file] of Object.entries(files)) {
      if (file.sha === undefined) continue
      const before = previous?.files[rel]
      if (before !== undefined && before.sha === file.sha) continue
      await this.saveBlob(file.sha, join(this.root, rel), file.size)
    }

    const checkpoint: Checkpoint = { kind: 'turn', turn, endSeq, at: now, files }
    await writeAtomic(this.turnPath(turn), JSON.stringify(checkpoint))
    this.turns.set(turn, checkpoint)
    return checkpoint
  }

  /** 获取指定轮次前最近的可用快照（前一轮或初始基线） */
  private async previousOf(turn: number): Promise<Checkpoint | undefined> {
    if (turn <= 1) {
      await this.loadBaseline()
      return this.baseline
    }
    await this.loadTurns()
    let best: Checkpoint | undefined
    for (const candidate of this.turns.values()) {
      if (candidate.turn < turn && (best === undefined || candidate.turn > best.turn)) best = candidate
    }
    return best
  }

  /** 获取有序的检查点摘要列表 */
  async list(): Promise<CheckpointSummary[]> {
    await this.loadTurns()
    const rows: CheckpointSummary[] = []
    for (const checkpoint of this.turns.values()) {
      const previous = await this.previousOf(checkpoint.turn)
      let changed = 0
      if (checkpoint.blobs !== undefined) {
        changed = Object.keys(checkpoint.blobs).length
      } else {
        for (const [rel, file] of Object.entries(checkpoint.files)) {
          const prev = previous?.files[rel]
          if (prev === undefined || prev.sha !== file.sha) changed += 1
        }
      }
      rows.push({
        turn: checkpoint.turn,
        endSeq: checkpoint.endSeq,
        at: checkpoint.at,
        changed,
      })
    }
    rows.sort((a, b) => a.turn - b.turn)
    return rows
  }

  async hasBaseline(): Promise<boolean> {
    await this.loadBaseline()
    return this.baseline !== undefined
  }

  /**
   * 解析需要还原的目标快照点。
   * @param events 会话的事件流日志
   * @param atSeq 回滚锚点序列号
   * @param baseline 是否强制还原到初始基线
   */
  resolveTarget(
    events: readonly { type: string; seq: number; data?: { turn?: number } }[],
    atSeq: number | undefined,
    baseline: boolean,
  ): { checkpoint: Checkpoint | undefined; boundary: { turn: number; endSeq: number } | undefined } {
    if (baseline) return { checkpoint: this.baseline, boundary: undefined }
    if (atSeq === undefined) return { checkpoint: undefined, boundary: undefined }
    const boundaryEvent = events.find(event => event.type === 'turn/end' && event.seq >= atSeq)
    if (boundaryEvent === undefined || boundaryEvent.data?.turn === undefined) {
      return { checkpoint: this.baseline, boundary: undefined }
    }
    const turn = boundaryEvent.data.turn
    let checkpoint = this.turns.get(turn)
    if (checkpoint === undefined) {
      for (let earlier = turn - 1; earlier >= 1 && checkpoint === undefined; earlier -= 1) {
        checkpoint = this.turns.get(earlier)
      }
      checkpoint ??= this.baseline
    }
    return {
      checkpoint,
      boundary: { turn, endSeq: boundaryEvent.seq },
    }
  }

  /**
   * 将工作区目录还原到指定目标快照点：
   * 1. 目标快照之后新创建的文件予以删除；
   * 2. 内容发生变更的文件从 CAS 磁盘池或旧内联 Blob 中重写还原；
   * 3. 超过大小限制未备份的文件自动跳过并记录。
   */
  async restore(
    events: readonly { type: string; seq: number; data?: { turn?: number } }[],
    options: { atSeq?: number; baseline?: boolean; dryRun?: boolean } = {},
  ): Promise<RestoreResult> {
    await this.loadBaseline()
    await this.loadTurns()
    const target = this.resolveTarget(events, options.atSeq, options.baseline === true)
    if (target.checkpoint === undefined) {
      return { mode: 'none', restored: [], deleted: [], skipped: [], dryRun: options.dryRun === true }
    }
    const checkpoint = target.checkpoint
    const current = await walkWorkspace(this.root, this.options)

    // 兼容旧版内联 Blobs 的查询回退表
    const legacyBlobsAt = new Map<string, string>()
    const ordered: Checkpoint[] = []
    if (this.baseline !== undefined) ordered.push(this.baseline)
    for (const [turn, checkpointRow] of this.turns) {
      if (turn <= checkpoint.turn) ordered.push(checkpointRow)
    }
    ordered.sort((a, b) => a.turn - b.turn)
    for (const row of ordered) {
      if (row.blobs !== undefined) {
        for (const [rel, blob] of Object.entries(row.blobs)) legacyBlobsAt.set(rel, blob)
      }
    }

    const restored: string[] = []
    const deleted: string[] = []
    const skipped: { path: string; reason: string }[] = []
    const dryRun = options.dryRun === true

    const absolute = (rel: string): string => resolve(this.root, rel)
    const within = (rel: string): boolean => {
      const abs = absolute(rel)
      return abs === this.root || abs.startsWith(this.root + sep)
    }

    // 1. 当前存在但目标快照中不存在的文件 → 删除
    for (const rel of Object.keys(current)) {
      if (checkpoint.files[rel] !== undefined) continue
      if (!within(rel)) continue
      if (dryRun) {
        deleted.push(rel)
        continue
      }
      try {
        await rm(absolute(rel), { force: true })
        deleted.push(rel)
      } catch {
        skipped.push({ path: rel, reason: 'delete-failed' })
      }
    }

    // 2. 目标快照中存在的文件：若内容不一致则重写还原
    for (const [rel, file] of Object.entries(checkpoint.files)) {
      if (!within(rel)) continue
      const present = current[rel]
      const same = present !== undefined && file.sha !== undefined && present.sha === file.sha
      if (same) continue

      if (file.sha === undefined) {
        skipped.push({ path: rel, reason: 'too-large' })
        continue
      }

      const legacyBlob = legacyBlobsAt.get(rel)
      const blobBuffer = await this.getBlob(file.sha, legacyBlob)
      if (blobBuffer === null) {
        skipped.push({ path: rel, reason: 'no-content' })
        continue
      }

      if (dryRun) {
        restored.push(rel)
        continue
      }
      try {
        await writeAtomic(absolute(rel), blobBuffer)
        restored.push(rel)
      } catch {
        skipped.push({ path: rel, reason: 'write-failed' })
      }
    }

    return {
      mode: checkpoint.kind,
      ...(target.boundary === undefined ? {} : { boundary: target.boundary }),
      restored,
      deleted,
      skipped,
      dryRun,
    }
  }
}
