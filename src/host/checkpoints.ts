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
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rmdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

/** 默认永不追踪的文件/目录名（重量级依赖或版本控制元数据） */
export const DEFAULT_IGNORE_NAMES = [
  '.git', 'node_modules', '.pnpm-store', '.venv', 'venv', '__pycache__', 'dist', 'build',
  '.next', '.nuxt', '.idea', '.vscode', '.mypy_cache', '.pytest_cache',
  '.DS_Store', 'coverage', '.turbo', '.cache', 'target',
]
/**
 * 回退时额外清理「被忽略路径」时，永不进入的目录。
 * 这些是依赖商店与版本控制元数据：既不是 agent 的交付物，遍历成本也极高。
 * `dist`/`build`/`coverage` 等构建产物目录不在此列——它们正是需要被撤销的对象。
 */
export const NEVER_SCAN_IGNORED_DIRS = [
  '.git', 'node_modules', '.pnpm-store', '.venv', 'venv', '__pycache__', '.cache', '.turbo',
]

/** 默认追踪的文件体积上限：超过则只记 size+mtime（不计算哈希、不备份内容） */
export const DEFAULT_TRACK_SIZE_CAP = 100 * 1024 * 1024

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
  /**
   * 基线是否在会话已经产生事件之后才采集（插件晚于会话启动、或恢复旧会话）。
   * 这类基线只能说"当时的工作区"，不能代表"本轮工作开始前"，
   * 因此其中可能已包含此前 Agent 的产物——回退到它无法撤销那些文件。
   */
  late?: boolean
  /**
   * 基线是否在采集过程中与该轮的实际工作重叠（工作区很大时扫描可能慢于
   * 第一次工具调用，导致基线里已包含该轮产物）。为 true 时回退到基线会给出提示。
   */
  raced?: boolean
  /**
   * 被忽略路径（`.gitignore` / ignoreNames / ignorePatterns）的存在性索引，仅记录 size+mtime。
   * 不备份内容——这些路径通常是构建产物、日志与依赖，体量可能极大。
   * 回退时据此只删除「本会话新增」的被忽略文件，绝不触碰会话开始前就存在的文件。
   */
  ignored?: Record<string, { size: number; mtimeMs: number }>
  /** 被忽略路径索引是否因数量上限被截断；截断时回退不做被忽略路径清理（安全优先） */
  ignoredTruncated?: boolean
}

export interface CheckpointOptions {
  /** 需要忽略的目录/文件名列表 */
  ignoreNames?: readonly string[]
  /** 需要忽略的文件名通配模式（如 *.log） */
  ignorePatterns?: readonly string[]
  /** 超过此大小的文件不计算哈希（仅根据 size+mtime 标记） */
  trackSizeCap?: number
  /**
   * 单个文件可备份内容的上限。默认不限制（由 maxTotalBlobBytes 兜底）。
   * 只有显式设为有限值时才存在此限制；被限制的文件在回退时会被跳过并上报。
   */
  blobSizeCap?: number
  /** 单个工作区最大扫描追踪文件数量上限（防止超大目录死循环） */
  maxFiles?: number
  /** 单个会话保存的所有 Blob 总字节上限 */
  maxTotalBlobBytes?: number
  /** 是否自动解析工作区根目录的 .gitignore 文件（默认为 true） */
  enableGitignore?: boolean
  /** 扫描/备份文件的并发度（默认 8） */
  ioConcurrency?: number
  /** 日志记录器 */
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void }
}

/**
 * 还原无法进行时的结构化原因。
 * 这些情况**绝不能**被当成"成功但没变化"——否则调用方会继续 fork/归档，
 * 造成「对话回退了但文件完全没动」的不一致状态。
 */
export type RestoreFailure =
  /** 从未建立基线（插件晚于会话启动、或采集被跳过） */
  | 'no-baseline'
  /** 该回滚点没有对应快照，且也无法回落到基线 */
  | 'no-checkpoint'
  /** 缺少定位边界所需的事件日志 */
  | 'no-events'

/** `restore` 的结构化失败（非 dryRun 时抛出） */
export class RestoreUnavailableError extends Error {
  constructor(readonly failure: RestoreFailure, message: string) {
    super(message)
  }
}

/** 一次还原操作的结果详情 */
export interface RestoreResult {
  mode: 'turn' | 'baseline' | 'none'
  boundary?: { turn: number; endSeq: number }
  restored: string[]
  deleted: string[]
  skipped: { path: string; reason: string }[]
  /** 影响还原完整性的提示（例如基线可能已包含该轮改动） */
  warnings?: string[]
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
 *
 * 遍历分两阶段：先用 readdir/stat 收集候选文件（很快），再以有限并发计算哈希。
 * 这样大工作区的基线采集窗口显著缩短，减少与首轮实际工作重叠的可能。
 */
export async function walkWorkspace(
  root: string,
  options: CheckpointOptions = {},
  previousFiles?: Record<string, TrackedFile>,
): Promise<Record<string, TrackedFile>> {
  const ignoreNames = options.ignoreNames ?? DEFAULT_IGNORE_NAMES
  const ignorePatterns = options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS
  const trackSizeCap = options.trackSizeCap ?? DEFAULT_TRACK_SIZE_CAP
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

  /** 待计算哈希的候选文件 */
  const pending: { rel: string; absolute: string; size: number; mtimeMs: number }[] = []
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

      pending.push({ rel, absolute, size: info.size, mtimeMs: info.mtimeMs })
    }
  }

  await walk(rootAbs)

  await runPool(pending, options.ioConcurrency ?? 8, async (item) => {
    try {
      const sha = await hashFile(item.absolute)
      files[item.rel] = { sha, size: item.size, mtimeMs: item.mtimeMs }
    } catch {
      // 不可读文件跳过
    }
  })
  return files
}

/** 以有限并发执行任务队列 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length))
  let next = 0
  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      await worker(items[index])
    }
  })
  await Promise.all(runners)
}

/**
 * 收集被忽略路径的存在性索引（仅 size+mtime，不读内容、不计算哈希）。
 *
 * 这些路径不参与内容备份，但 agent 常往其中写产物（`dist/`、`*.log` 等），
 * 回退时需要知道「哪些是会话开始前就有的」，因此必须记录基线。
 * 依赖商店与版本控制等目录（{@link NEVER_SCAN_IGNORED_DIRS}）永不进入，避免开销失控。
 *
 * @param limit - 最多记录多少个条目；超出即截断并返回 `truncated: true`。
 */
export async function walkIgnoredPaths(
  root: string,
  options: CheckpointOptions = {},
  limit = 20000,
): Promise<{ entries: Record<string, { size: number; mtimeMs: number }>; truncated: boolean }> {
  const ignoreNames = options.ignoreNames ?? DEFAULT_IGNORE_NAMES
  const ignorePatterns = options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS
  const enableGitignore = options.enableGitignore ?? true
  const neverEnter = new Set(NEVER_SCAN_IGNORED_DIRS)
  const entries: Record<string, { size: number; mtimeMs: number }> = {}
  const rootAbs = resolve(root)

  let gitignoreRules: GitignoreRule[] = []
  if (enableGitignore) {
    try {
      const content = await readFile(join(rootAbs, '.gitignore'), 'utf8')
      gitignoreRules = parseGitignore(content)
    } catch {
      // 无 .gitignore
    }
  }

  let count = 0
  let truncated = false

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return
    let listing
    try {
      listing = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of listing) {
      if (count >= limit) {
        truncated = true
        return
      }
      if (neverEnter.has(entry.name)) continue
      const absolute = join(dir, entry.name)
      const rel = toRelative(rootAbs, absolute)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (entry.isSymbolicLink() || !entry.isFile()) continue
      // 只记录被忽略的路径；被追踪的文件已由 files 索引覆盖
      if (!isIgnored(rel, ignoreNames, ignorePatterns, false, gitignoreRules)) continue
      try {
        const info = await stat(absolute)
        entries[rel] = { size: info.size, mtimeMs: info.mtimeMs }
        count += 1
      } catch {
        // 不可读文件跳过
      }
    }
  }

  await walk(rootAbs)
  return { entries, truncated }
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
  private readonly options: Required<Omit<CheckpointOptions, 'blobSizeCap'>> & { blobSizeCap: number }
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
      trackSizeCap: options.trackSizeCap ?? DEFAULT_TRACK_SIZE_CAP,
      // 默认不限制单文件体积：真实项目里的锁文件、图片、数据集常常超过 1 MiB，
      // 限制它们只会让回退静默漏掉改动。内存已由流式复制保证 O(1)。
      blobSizeCap: options.blobSizeCap ?? Number.POSITIVE_INFINITY,
      maxFiles: options.maxFiles ?? 100000,
      maxTotalBlobBytes: options.maxTotalBlobBytes ?? 512 * 1024 * 1024,
      enableGitignore: options.enableGitignore ?? true,
      ioConcurrency: options.ioConcurrency ?? 8,
      logger: options.logger ?? {},
    }
  }

  get workspaceRoot(): string {
    return this.root
  }

  /** 本会话快照数据的存放目录（供 fork 后继承父会话历史使用）。 */
  get storageDir(): string {
    return this.dir
  }

  /** 清空内存缓存，使下次读取重新从磁盘加载（继承/重建后使用）。 */
  private resetCache(): void {
    this.baselineLoaded = false
    this.baseline = undefined
    this.turnsLoaded = false
    this.turns.clear()
    this.totalBlobBytes = 0
  }

  /** 重新统计已占用的 blob 字节数（继承父会话 blob 后使用）。 */
  private async recountBlobBytes(): Promise<void> {
    let total = 0
    try {
      for (const name of await readdir(this.blobsDir())) {
        try {
          total += (await stat(join(this.blobsDir(), name))).size
        } catch {
          // 统计失败的条目忽略
        }
      }
    } catch {
      total = 0
    }
    this.totalBlobBytes = total
  }

  /**
   * 从父会话的存储目录继承检查点历史。
   *
   * fork 出的子会话会继承父会话的若干轮对话，但它的工作区基线是 fork 那一刻的状态——
   * 也就是**已经包含那些被继承轮次产物**的状态。若沿用它，在子会话里编辑/回退被继承的
   * 问题时就撤不掉那些产物（插件认为它们"原本就存在"）。
   *
   * 因此子会话必须继承父会话的完整历史：基线（真正的"工作开始前"）+ 截止 fork 边界的
   * 各轮快照 + 它们引用的 blob。继承后，子会话里的回退/编辑行为与父会话完全一致。
   *
   * @param parentDir - 父会话的存储目录。
   * @param upToEndSeq - 只继承 endSeq ≤ 该值的轮次（即 fork 边界及之前）。
   */
  async inheritFrom(
    parentDir: string,
    upToEndSeq?: number,
  ): Promise<{ baseline: boolean; turns: number[] }> {
    if (resolve(parentDir) === resolve(this.dir)) return { baseline: false, turns: [] }

    const load = async (file: string): Promise<Checkpoint | undefined> => {
      try {
        return JSON.parse(await readFile(join(parentDir, file), 'utf8')) as Checkpoint
      } catch {
        return undefined
      }
    }

    const parentBaseline = await load('baseline.json')
    const parentTurns: Checkpoint[] = []
    let names: string[] = []
    try {
      names = await readdir(parentDir)
    } catch {
      names = []
    }
    for (const name of names) {
      if (!/^turn-\d+\.json$/.test(name)) continue
      const checkpoint = await load(name)
      if (checkpoint === undefined) continue
      if (upToEndSeq !== undefined && checkpoint.endSeq > upToEndSeq) continue
      parentTurns.push(checkpoint)
    }
    parentTurns.sort((left, right) => left.turn - right.turn)

    if (parentBaseline === undefined && parentTurns.length === 0) {
      return { baseline: false, turns: [] }
    }

    await mkdir(this.dir, { recursive: true })
    if (parentBaseline !== undefined) {
      await writeAtomic(this.baselinePath(), JSON.stringify(parentBaseline))
    }
    for (const checkpoint of parentTurns) {
      await writeAtomic(this.turnPath(checkpoint.turn), JSON.stringify(checkpoint))
    }

    // 只复制被继承快照引用的 blob
    const shas = new Set<string>()
    for (const checkpoint of [parentBaseline, ...parentTurns]) {
      if (checkpoint === undefined) continue
      for (const file of Object.values(checkpoint.files)) {
        if (file.sha !== undefined) shas.add(file.sha)
      }
    }
    if (shas.size > 0) await mkdir(this.blobsDir(), { recursive: true })
    for (const sha of shas) {
      if (await this.hasBlob(sha)) continue
      const tmp = `${this.blobPath(sha)}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
      try {
        await pipeline(
          createReadStream(join(parentDir, 'blobs', sha)),
          createWriteStream(tmp),
        )
        await rename(tmp, this.blobPath(sha))
      } catch {
        await rm(tmp, { force: true }).catch(() => undefined)
        // 缺失的 blob 会让对应文件在回退时报告 no-content，不影响其余还原
      }
    }

    this.resetCache()
    await this.recountBlobBytes()
    return {
      baseline: parentBaseline !== undefined,
      turns: parentTurns.map(checkpoint => checkpoint.turn),
    }
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

  /**
   * 将工作区文件以流式复制的方式保存到 CAS 内容寻址池（已存在则跳过）。
   * 流式复制保证任意大小的文件都不会把内容读进内存。
   */
  private async saveBlob(sha: string, sourcePath: string, size: number): Promise<boolean> {
    if (size > this.options.blobSizeCap) {
      this.options.logger.warn?.(`[dsh-recover-context] 文件超过 blobSizeCap (${this.options.blobSizeCap} 字节)，未备份内容: ${sha}`)
      return false
    }
    if (await this.hasBlob(sha)) return true
    if (this.totalBlobBytes + size > this.options.maxTotalBlobBytes) {
      this.options.logger.warn?.(`[dsh-recover-context] 会话 Blob 存储超出限制 (${this.options.maxTotalBlobBytes} 字节)，跳过存储 ${sha}`)
      return false
    }
    const target = this.blobPath(sha)
    const tmpPath = `${target}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    try {
      await mkdir(this.blobsDir(), { recursive: true })
      await pipeline(createReadStream(sourcePath), createWriteStream(tmpPath))
      await rename(tmpPath, target)
      this.totalBlobBytes += size
      return true
    } catch {
      await rm(tmpPath, { force: true }).catch(() => undefined)
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
   *
   * 基线必须反映「本轮工作开始前」的状态。若扫描期间工作区已被改动（大仓库扫描较慢，
   * 或插件到得很晚），基线里会混入本轮产物——这样的基线回退时无法撤销那些改动。
   * 这里用 mtime 与扫描起始时间比较来识别该情况，并在回退时明确告警。
   *
   * @param now - 快照时间戳。
   * @param priorEventCount - 采集时该会话已有的事件数；> 0 表示基线是"晚采集"的。
   */
  async ensureBaseline(now = Date.now(), priorEventCount = 0): Promise<Checkpoint> {
    await this.loadBaseline()
    if (this.baseline !== undefined) return this.baseline
    await mkdir(this.dir, { recursive: true })
    const scanStartedAt = Date.now()
    const files = await walkWorkspace(this.root, this.options)

    let raced = false
    for (const file of Object.values(files)) {
      // 扫描期间被写入的文件说明工作已开始，基线可能已包含本轮产物。
      if (file.mtimeMs >= scanStartedAt) {
        raced = true
        break
      }
    }
    const late = priorEventCount > 0
    if (raced || late) {
      this.options.logger.warn?.(
        `[dsh-recover-context] 基线可能不代表"工作开始前"的状态（${this.root}）：`
        + `${late ? `会话已有 ${priorEventCount} 个事件；` : ''}${raced ? '采集期间工作区仍在变化' : ''}`,
      )
    }

    // 并发流式写盘：任意大小的文件都不会整块读入内存
    const entries = Object.entries(files).filter(([, file]) => file.sha !== undefined)
    await runPool(entries, this.options.ioConcurrency, async ([rel, file]) => {
      await this.saveBlob(file.sha as string, join(this.root, rel), file.size)
    })

    // 记录被忽略路径的基线存在性：回退时据此只删本会话新增的产物
    const ignoredBaseline = await walkIgnoredPaths(this.root, this.options)

    const baseline: Checkpoint = {
      kind: 'baseline',
      turn: 0,
      endSeq: -1,
      at: now,
      files,
      ...(raced ? { raced: true } : {}),
      ...(late ? { late: true } : {}),
      ignored: ignoredBaseline.entries,
      ...(ignoredBaseline.truncated ? { ignoredTruncated: true } : {}),
    }
    await writeAtomic(this.baselinePath(), JSON.stringify(baseline))
    this.baseline = baseline
    return baseline
  }

  /**
   * 丢弃已有基线并按当前工作区重建（仅当该会话还没有任何轮次检查点时允许）。
   *
   * 使用场景：回退/编辑会先还原工作区，再让 Workspace 流程「复用」一个此前创建的空白会话。
   * 那个空白会话的基线是它诞生时的旧状态，可能包含后来已被删除的文件——
   * 若沿用它，用户在那个会话里再点回退时，插件会把已删除的文件「复活」出来。
   * 因此复用空白会话时必须以还原后的真实工作区重建基线。
   *
   * 已有轮次检查点的会话拒绝重建：那意味着它已经工作过，其基线是有效的历史依据。
   *
   * @returns 是否执行了重建（已有轮次时返回 false）。
   */
  async resetBaseline(now = Date.now()): Promise<boolean> {
    await this.loadTurns()
    if (this.turns.size > 0) return false

    await this.loadBaseline()
    const old = this.baseline
    // 清理旧基线遗留的 blob 之外，不删除共享 CAS（其他快照可能引用同一 sha，
    // 且目录内 blob 以内容寻址，冗余不会造成正确性问题）。
    const scanStartedAt = Date.now()
    const files = await walkWorkspace(this.root, this.options)

    let raced = false
    for (const file of Object.values(files)) {
      if (file.mtimeMs >= scanStartedAt) {
        raced = true
        break
      }
    }

    const entries = Object.entries(files).filter(([, file]) => file.sha !== undefined)
    await runPool(entries, this.options.ioConcurrency, async ([rel, file]) => {
      await this.saveBlob(file.sha as string, join(this.root, rel), file.size)
    })
    const ignoredSnapshot = await walkIgnoredPaths(this.root, this.options)

    const baseline: Checkpoint = {
      kind: 'baseline',
      turn: 0,
      endSeq: -1,
      at: now,
      files,
      ...(raced ? { raced: true } : {}),
      ignored: ignoredSnapshot.entries,
      ...(ignoredSnapshot.truncated ? { ignoredTruncated: true } : {}),
    }
    await writeAtomic(this.baselinePath(), JSON.stringify(baseline))
    this.baseline = baseline
    if (old !== undefined) {
      this.options.logger.info?.(`[dsh-recover-context] 已按当前工作区重建基线（原基线 ${Object.keys(old.files).length} 项 → 现 ${Object.keys(files).length} 项）`)
    }
    return true
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

    // 并发保存本轮中新增或修改的文件至 CAS Blob 存储
    const changed = Object.entries(files).filter(([rel, file]) => {
      if (file.sha === undefined) return false
      const before = previous?.files[rel]
      return before === undefined || before.sha !== file.sha
    })
    await runPool(changed, this.options.ioConcurrency, async ([rel, file]) => {
      await this.saveBlob(file.sha as string, join(this.root, rel), file.size)
    })

    // 逐轮同样记录被忽略路径的存在性（内容不备份），供回退时判断新增产物
    const ignoredSnapshot = await walkIgnoredPaths(this.root, this.options)

    const checkpoint: Checkpoint = {
      kind: 'turn',
      turn,
      endSeq,
      at: now,
      files,
      ignored: ignoredSnapshot.entries,
      ...(ignoredSnapshot.truncated ? { ignoredTruncated: true } : {}),
    }
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
    const dryRun = options.dryRun === true
    const target = this.resolveTarget(events, options.atSeq, options.baseline === true)
    if (target.checkpoint === undefined) {
      // 失败必须可见：静默返回 'none' 会让调用方继续 fork/归档，
      // 最终呈现为「对话回退了但文件没动」。dryRun 允许用来探测可用性。
      if (dryRun) {
        return { mode: 'none', restored: [], deleted: [], skipped: [], dryRun: true }
      }
      if (this.baseline === undefined) {
        throw new RestoreUnavailableError(
          'no-baseline',
          `会话没有可用基线（${this.dir}）。插件可能在本会话开始后才启用，或基线数据已丢失。`,
        )
      }
      if (events.length === 0) {
        throw new RestoreUnavailableError(
          'no-events',
          '无法读取会话事件日志，不能定位回滚边界。',
        )
      }
      throw new RestoreUnavailableError(
        'no-checkpoint',
        `回滚点 ${options.atSeq === undefined ? '(未指定)' : `atSeq=${options.atSeq}`} 没有对应快照。`,
      )
    }
    const checkpoint = target.checkpoint
    const current = await walkWorkspace(this.root, this.options)

    // 被忽略路径（.gitignore / ignoreNames / ignorePatterns）的内容不在 files 索引里，
    // 但 agent 常往这些地方写产物（dist/、*.log 等）。回退时只删除「目标快照里没有、
    // 但现在存在」的被忽略文件；目标快照里已存在的（会话开始前就有的）绝不触碰。
    // 快照缺少该索引（旧版本数据）或索引被截断时保守跳过，避免误删用户文件。
    const ignoredNow = await walkIgnoredPaths(this.root, this.options)
    const canCleanIgnored = checkpoint.ignored !== undefined && checkpoint.ignoredTruncated !== true && ignoredNow.truncated !== true
    const ignoredLeftovers = new Set<string>()
    if (canCleanIgnored) {
      for (const rel of Object.keys(ignoredNow.entries)) {
        if (checkpoint.ignored?.[rel] === undefined) ignoredLeftovers.add(rel)
      }
    }

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

    const absolute = (rel: string): string => resolve(this.root, rel)
    const within = (rel: string): boolean => {
      const abs = absolute(rel)
      return abs === this.root || abs.startsWith(this.root + sep)
    }
    /** 删除后清理空目录，避免留下空壳构建目录 */
    const pruneEmptyDirs = async (relPath: string): Promise<void> => {
      let dir = dirname(absolute(relPath))
      while (dir !== this.root && dir.startsWith(this.root + sep)) {
        try {
          // rmdir 只删空目录：非空时抛 ENOTEMPTY，恰好用来停止上溯
          await rmdir(dir)
        } catch {
          return
        }
        dir = dirname(dir)
      }
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
        await pruneEmptyDirs(rel)
        deleted.push(rel)
      } catch {
        skipped.push({ path: rel, reason: 'delete-failed' })
      }
    }

    // 1b. 被忽略路径中、快照里不存在的残留产物 → 也删除
    for (const rel of ignoredLeftovers) {
      if (!within(rel)) continue
      if (dryRun) {
        deleted.push(rel)
        continue
      }
      try {
        await rm(absolute(rel), { force: true })
        await pruneEmptyDirs(rel)
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
        // 超过 trackSizeCap 的文件只记录了 size+mtime，没有可供还原的内容
        skipped.push({ path: rel, reason: 'too-large' })
        continue
      }

      const target_ = absolute(rel)
      if (dryRun) {
        const available = await this.hasBlob(file.sha) || legacyBlobsAt.has(rel)
        if (available) restored.push(rel)
        else skipped.push({ path: rel, reason: 'no-content' })
        continue
      }

      try {
        await mkdir(dirname(target_), { recursive: true })
        if (await this.hasBlob(file.sha)) {
          // CAS 命中：流式复制，避免把大文件整块读进内存
          const tmpPath = `${target_}.${Date.now()}.${Math.random().toString(36).slice(2)}.rc-tmp`
          try {
            await pipeline(createReadStream(this.blobPath(file.sha)), createWriteStream(tmpPath))
            await rename(tmpPath, target_)
          } catch (error) {
            await rm(tmpPath, { force: true }).catch(() => undefined)
            throw error
          }
          restored.push(rel)
          continue
        }
        const legacyBlob = legacyBlobsAt.get(rel)
        if (legacyBlob === undefined) {
          skipped.push({ path: rel, reason: 'no-content' })
          continue
        }
        await writeAtomic(target_, decodeBlob(legacyBlob))
        restored.push(rel)
      } catch {
        skipped.push({ path: rel, reason: 'write-failed' })
      }
    }

    // 还原完整性告警：基线若在采集期间已被本轮改动污染，无法撤销那部分改动
    const warnings: string[] = []
    if (checkpoint.kind === 'baseline' && checkpoint.raced === true) {
      warnings.push(
        'baseline-race: 基线是在工作区仍在变化时采集的，可能已包含本轮改动，这些改动无法通过回退撤销',
      )
    }
    if (checkpoint.kind === 'baseline' && checkpoint.late === true) {
      warnings.push(
        'baseline-late: 基线是在会话已开始之后才采集的（插件启用较晚或恢复了旧会话），'
        + '此前已存在的产物无法通过回退撤销',
      )
    }

    // 还原后自检：确认「目标快照中不存在的文件」确实已从磁盘消失。
    // 删除可能因权限、并发写入或路径异常而失败；不校验就会出现
    // 「报告成功、文件却还在」的静默不一致。
    if (!dryRun && deleted.length > 0) {
      const after = await walkWorkspace(this.root, this.options)
      const survivors = deleted.filter(rel => after[rel] !== undefined)
      if (survivors.length > 0) {
        for (const rel of survivors) {
          if (!skipped.some(entry => entry.path === rel)) {
            skipped.push({ path: rel, reason: 'delete-failed' })
          }
        }
        warnings.push(`残留文件: 有 ${survivors.length} 个文件未能删除，仍存在于工作区`)
      }
      // 被忽略路径同样自检
      const ignoredAfter = await walkIgnoredPaths(this.root, this.options)
      const ignoredSurvivors = [...ignoredLeftovers].filter(rel => ignoredAfter.entries[rel] !== undefined)
      if (ignoredSurvivors.length > 0) {
        warnings.push(`残留文件: 有 ${ignoredSurvivors.length} 个被忽略路径的文件未能删除`)
        for (const rel of ignoredSurvivors) {
          if (!skipped.some(entry => entry.path === rel)) {
            skipped.push({ path: rel, reason: 'delete-failed' })
          }
        }
      }
    }

    return {
      mode: checkpoint.kind,
      ...(target.boundary === undefined ? {} : { boundary: target.boundary }),
      restored,
      deleted,
      skipped,
      ...(warnings.length === 0 ? {} : { warnings }),
      dryRun,
    }
  }
}
