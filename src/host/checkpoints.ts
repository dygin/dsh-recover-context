/**
 * dsh-recover-context checkpoint engine (host half).
 *
 * Tracks the workspace directory state of a session at two granularities:
 *   - a BASELINE snapshot taken the first time the plugin observes the
 *     session (≈ the state before that conversation's work began), and
 *   - one CHECKPOINT per completed turn (`turn/end`), capturing the state
 *     exactly as it was when that turn finished.
 *
 * A rollback to a turn T restores the workspace to the state recorded at
 * T's checkpoint (or the baseline, for points before any work), undoing the
 * files the agent produced in the turns after T.
 *
 * Storage layout (outside the workspace, under the DSH home):
 *   <home>/storages/recover-context/<sessionId>/baseline.json
 *   <home>/storages/recover-context/<sessionId>/turn-<n>.json
 *
 * The engine is a plain class with no cordis dependency, so the same code is
 * exercised by the standalone smoke test in tests/checkpoints.test.mjs.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

/** Default names/dirs never tracked (heavy or VCS metadata). */
export const DEFAULT_IGNORE_NAMES = [
  '.git', 'node_modules', '.pnpm-store', '.venv', 'venv', '__pycache__', 'dist', 'build',
  '.next', '.nuxt', '.idea', '.vscode', '.mypy_cache', '.pytest_cache',
  '.DS_Store', 'coverage', '.turbo', '.cache', 'target',
]
/** Default filename patterns never tracked. */
export const DEFAULT_IGNORE_PATTERNS = ['*.pyc', '*.pyo', '*.log', '*.tmp', '*.swp']

/** Per-file identity recorded in a checkpoint. */
export interface TrackedFile {
  /** SHA-256 hex of the content; absent for files above {@link trackSizeCap}. */
  sha?: string
  size: number
  /** stat mtimeMs, used to skip re-hashing unchanged files on later snapshots. */
  mtimeMs: number
}

/** One immutable workspace snapshot. */
export interface Checkpoint {
  kind: 'baseline' | 'turn'
  /** Turn number; 0 for the baseline. */
  turn: number
  /** Seq of the turn/end event this checkpoint was taken at; -1 for the baseline. */
  endSeq: number
  /** Epoch ms when the snapshot was taken. */
  at: number
  /** Relative path → identity map of every tracked file at this point. */
  files: Record<string, TrackedFile>
  /**
   * Base64 file content for files whose content CHANGED since the previous
   * checkpoint (≤ blobSizeCap). The baseline stores every tracked file
   * ≤ blobSizeCap, so an unchanged-since-baseline file stays restorable.
   */
  blobs: Record<string, string>
}

export interface CheckpointOptions {
  /** Directories/file names to skip. */
  ignoreNames?: readonly string[]
  /** Glob-ish (*) filename patterns to skip. */
  ignorePatterns?: readonly string[]
  /** Files larger than this are not hashed (identity = size+mtime only). */
  trackSizeCap?: number
  /** Files larger than this carry no content blob (not restorable). */
  blobSizeCap?: number
}

/** Result of one restore operation. */
export interface RestoreResult {
  mode: 'turn' | 'baseline' | 'none'
  boundary?: { turn: number; endSeq: number }
  restored: string[]
  deleted: string[]
  skipped: { path: string; reason: string }[]
  dryRun: boolean
}

/** Summary row for the checkpoints API. */
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

/** Whether a relative path should be ignored by the tracker. */
export function isIgnored(
  relPath: string,
  ignoreNames: readonly string[],
  ignorePatterns: readonly string[],
): boolean {
  const segments = relPath.split(sep)
  const names = new Set(ignoreNames)
  const regexes = ignorePatterns.map(patternToRegExp).filter((r): r is RegExp => r !== null)
  for (const segment of segments) {
    if (names.has(segment)) return true
    for (const regex of regexes) if (regex.test(segment)) return true
  }
  return false
}

/** Normalize a user-supplied path to its relative form under the root. */
export function toRelative(root: string, absolute: string): string {
  const rel = relative(root, absolute)
  return rel === '' ? '.' : rel
}

/**
 * Recursively walk a directory and return per-file identity. Symlinks are
 * skipped (no traversal escapes, no loops). Only files ≤ trackSizeCap are
 * hashed; larger files carry size+mtime identity and no blob.
 */
export async function walkWorkspace(
  root: string,
  options: CheckpointOptions = {},
): Promise<Record<string, TrackedFile>> {
  const ignoreNames = options.ignoreNames ?? DEFAULT_IGNORE_NAMES
  const ignorePatterns = options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS
  const trackSizeCap = options.trackSizeCap ?? 5 * 1024 * 1024
  const files: Record<string, TrackedFile> = {}
  const rootAbs = resolve(root)

  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable dir → skip
    }
    for (const entry of entries) {
      const absolute = join(dir, entry.name)
      const rel = toRelative(rootAbs, absolute)
      if (entry.isDirectory()) {
        if (!isIgnored(rel, ignoreNames, ignorePatterns)) await walk(absolute)
        continue
      }
      if (entry.isSymbolicLink()) continue
      if (!entry.isFile()) continue
      if (isIgnored(rel, ignoreNames, ignorePatterns)) continue
      let info
      try {
        info = await stat(absolute)
      } catch {
        continue
      }
      if (info.size > trackSizeCap) {
        files[rel] = { size: info.size, mtimeMs: info.mtimeMs }
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

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const data = await readFile(path)
  hash.update(data)
  return hash.digest('hex')
}

/** Read a file and base64-encode it, or null when it is too large to carry. */
async function readBlob(path: string, blobSizeCap: number): Promise<string | null> {
  const info = await stat(path).catch(() => undefined)
  if (info === undefined || info.size > blobSizeCap) return null
  const data = await readFile(path)
  return data.toString('base64')
}

/** Base64 → Buffer. */
export function decodeBlob(blob: string): Buffer {
  return Buffer.from(blob, 'base64')
}

/** Compute which blobs a new snapshot must carry vs its predecessor. */
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
      // Added or modified (or un-hashable before). Only files with a real
      // sha are restorable — carry the content blob when small enough.
      if (file.sha === undefined) continue
      const content = await readContent(rel, file.size)
      if (content !== null) blobs[rel] = content
    }
    return blobs
  })()
}

/**
 * The per-session checkpoint store. All operations are serialized by the
 * caller (the host keeps a promise chain per session id).
 */
export class CheckpointStore {
  private readonly dir: string
  private readonly root: string
  private readonly options: Required<CheckpointOptions>
  private baselineLoaded = false
  private baseline: Checkpoint | undefined
  private turnsLoaded = false
  private turns: Map<number, Checkpoint> = new Map()

  constructor(dataDir: string, workspaceRoot: string, options: CheckpointOptions = {}) {
    this.dir = dataDir
    this.root = resolve(workspaceRoot)
    this.options = {
      ignoreNames: options.ignoreNames ?? DEFAULT_IGNORE_NAMES,
      ignorePatterns: options.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS,
      trackSizeCap: options.trackSizeCap ?? 5 * 1024 * 1024,
      blobSizeCap: options.blobSizeCap ?? 1024 * 1024,
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
        // corrupt checkpoint → ignore (restore degrades to earlier ones)
      }
    }
  }

  /** Whether any checkpoint exists for this session. */
  async hasAny(): Promise<boolean> {
    await this.loadBaseline()
    await this.loadTurns()
    return this.baseline !== undefined || this.turns.size > 0
  }

  /**
   * Take the baseline snapshot (no-op when one already exists). Must run
   * before the first turn does any file work (the host calls it on the first
   * observed event for a session).
   */
  async ensureBaseline(now = Date.now()): Promise<Checkpoint> {
    await this.loadBaseline()
    if (this.baseline !== undefined) return this.baseline
    await mkdir(this.dir, { recursive: true })
    const files = await walkWorkspace(this.root, this.options)
    const blobs: Record<string, string> = {}
    for (const [rel, file] of Object.entries(files)) {
      if (file.sha === undefined) continue
      const content = await readBlob(join(this.root, rel), this.options.blobSizeCap)
      if (content !== null) blobs[rel] = content
    }
    const baseline: Checkpoint = { kind: 'baseline', turn: 0, endSeq: -1, at: now, files, blobs }
    await writeFile(this.baselinePath(), JSON.stringify(baseline))
    this.baseline = baseline
    return baseline
  }

  /**
   * Record the checkpoint for one completed turn. The snapshot is
   * differential: unchanged files keep their identity (mtime comparison skips
   * re-hashing), changed files are hashed and their content blob stored.
   */
  async recordTurn(turn: number, endSeq: number, now = Date.now()): Promise<Checkpoint> {
    await this.loadTurns()
    const existing = this.turns.get(turn)
    if (existing !== undefined && existing.endSeq === endSeq) return existing
    await mkdir(this.dir, { recursive: true })
    const previous = await this.previousOf(turn)
    const files = await walkWorkspace(this.root, this.options)
    const blobs = await changedBlobs(files, previous?.files, async (rel, size) =>
      size <= this.options.blobSizeCap ? readBlob(join(this.root, rel), this.options.blobSizeCap) : null)
    const checkpoint: Checkpoint = { kind: 'turn', turn, endSeq, at: now, files, blobs }
    await writeFile(this.turnPath(turn), JSON.stringify(checkpoint))
    this.turns.set(turn, checkpoint)
    return checkpoint
  }

  /** The checkpoint immediately before turn `turn` (the previous turn or the baseline). */
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

  /** Ordered checkpoint summaries (baseline excluded unless requested). */
  async list(): Promise<CheckpointSummary[]> {
    await this.loadTurns()
    const rows: CheckpointSummary[] = []
    for (const checkpoint of this.turns.values()) {
      rows.push({
        turn: checkpoint.turn,
        endSeq: checkpoint.endSeq,
        at: checkpoint.at,
        changed: Object.keys(checkpoint.blobs).length,
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
   * Resolve the checkpoint to restore to. `atSeq` is the rollback anchor: the
   * boundary is the first `turn/end` at or after it (mirrors session.fork).
   * `baseline: true` forces the baseline (used when editing the first
   * question, where no earlier turn exists).
   * @param events - the session's event log (for boundary resolution).
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
    // The exact checkpoint for the boundary turn wins. When it is missing —
    // a forked child has no checkpoints for its SEEDED (inherited) turns —
    // fall back to the nearest checkpoint at or before the boundary; the
    // baseline represents the fork-point state, which is exactly the
    // pre-boundary state for a child that forked through that turn.
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
   * Restore the workspace to the recorded state at the target checkpoint.
   * Files created after the target are deleted; files whose content differs
   * are rewritten from the stored blobs (the latest blob at or before the
   * target wins, so content matches the moment the target turn ended). Files
   * with no stored blob (too large at snapshot time) are skipped and
   * reported.
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

    // Build the content lookup for the target state: iterate checkpoints up
    // to the target in ascending order, last blob per path wins.
    const blobsAt = new Map<string, string>()
    const ordered: Checkpoint[] = []
    if (this.baseline !== undefined) ordered.push(this.baseline)
    for (const [turn, checkpointRow] of this.turns) {
      if (turn <= checkpoint.turn) ordered.push(checkpointRow)
    }
    ordered.sort((a, b) => a.turn - b.turn)
    for (const row of ordered) {
      for (const [rel, blob] of Object.entries(row.blobs)) blobsAt.set(rel, blob)
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

    // 1. Files present now but absent at the target → delete.
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

    // 2. Files at the target: create or restore when content differs.
    for (const [rel, file] of Object.entries(checkpoint.files)) {
      if (!within(rel)) continue
      const present = current[rel]
      const same = present !== undefined && file.sha !== undefined && present.sha === file.sha
      if (same) continue
      const blob = blobsAt.get(rel)
      if (blob === undefined) {
        skipped.push({ path: rel, reason: 'no-content' })
        continue
      }
      if (dryRun) {
        restored.push(rel)
        continue
      }
      try {
        await mkdir(dirname(absolute(rel)), { recursive: true })
        await writeFile(absolute(rel), decodeBlob(blob))
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
