/**
 * Standalone smoke test for the checkpoint engine (host half). Runs without
 * the cordis runtime: builds a fake workspace, drives the CheckpointStore
 * through baseline + turns, and verifies restore rewinds the directory to
 * the recorded state (files added later deleted, modified files rewritten,
 * pre-existing files untouched).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CheckpointStore } from '../lib/index.js'

const base = await mkdtemp(join(tmpdir(), 'recover-context-test-'))

try {
  const workspace = join(base, 'workspace')
  const dataDir = join(base, 'data')
  await mkdir(workspace, { recursive: true })
  await mkdir(join(workspace, 'src'), { recursive: true })
  await mkdir(join(workspace, 'node_modules', 'dep'), { recursive: true })
  await mkdir(join(workspace, '.git'), { recursive: true })

  // Baseline state.
  await writeFile(join(workspace, 'README.md'), '# project\n')
  await writeFile(join(workspace, 'src', 'app.js'), 'console.log(1)\n')
  await writeFile(join(workspace, 'node_modules', 'dep', 'index.js'), 'heavy\n')
  await writeFile(join(workspace, '.git', 'HEAD'), 'ref\n')

  const store = new CheckpointStore(dataDir, workspace)
  await store.ensureBaseline()

  // Turn 1: modifies app.js, creates a new file, creates an ignored file.
  await writeFile(join(workspace, 'src', 'app.js'), 'console.log(2)\n')
  await writeFile(join(workspace, 'src', 'new.js'), 'module.exports = 1\n')
  await writeFile(join(workspace, 'debug.log'), 'log\n') // ignored pattern
  await store.recordTurn(1, 100)

  // Turn 2: modifies new.js, deletes app.js, creates another file.
  await writeFile(join(workspace, 'src', 'new.js'), 'module.exports = 2\n')
  await rm(join(workspace, 'src', 'app.js'))
  await writeFile(join(workspace, 'TODO.md'), 'todo\n')
  await store.recordTurn(2, 200)

  // ── restore to turn 1 (the state after turn 1's work) ───────────────────
  const events = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: {} },
    { type: 'turn/end', seq: 10, data: { turn: 1 } },
    { type: 'turn/start', seq: 11, data: { turn: 2 } },
    { type: 'user/message', seq: 12, data: {} },
    { type: 'turn/end', seq: 20, data: { turn: 2 } },
  ]
  const result = await store.restore(events, { atSeq: 5, dryRun: true })
  assertEqual(result.mode, 'turn', 'restore mode is turn')
  assertEqual(result.boundary?.turn, 1, 'boundary resolves to turn 1')
  assertTrue(result.restored.includes('src/new.js'), 'new.js restored (was modified in turn 2)')
  assertTrue(result.restored.includes('src/app.js'), 'app.js restored (was deleted in turn 2)')
  assertTrue(result.deleted.includes('TODO.md'), 'TODO.md deleted (created in turn 2)')

  const real = await store.restore(events, { atSeq: 5 })
  assertEqual(real.deleted.length, 1, 'one file deleted')
  assertTrue(real.deleted.includes('TODO.md'), 'TODO.md deleted')
  assertTrue(real.restored.includes('src/new.js'), 'new.js rewritten')

  assertEqual(await readFile(join(workspace, 'src', 'new.js'), 'utf8'), 'module.exports = 1\n', 'new.js content rewound to turn 1')
  assertTrue(await exists(join(workspace, 'TODO.md')) === false, 'TODO.md gone')
  assertEqual(await readFile(join(workspace, 'src', 'app.js'), 'utf8'), 'console.log(2)\n', 'app.js restored to its turn-1 content')
  assertEqual(await readFile(join(workspace, 'README.md'), 'utf8'), '# project\n', 'README untouched')
  assertEqual(await readFile(join(workspace, 'node_modules', 'dep', 'index.js'), 'utf8'), 'heavy\n', 'ignored node_modules untouched')
  assertEqual(await readFile(join(workspace, '.git', 'HEAD'), 'utf8'), 'ref\n', 'ignored .git untouched')
  assertEqual(await readFile(join(workspace, 'debug.log'), 'utf8'), 'log\n', 'ignored debug.log untouched')

  // ── restore to baseline (edit-first-question scenario) ──────────────────
  const baseline = await store.restore(events, { baseline: true })
  assertEqual(baseline.mode, 'baseline', 'baseline restore mode')
  assertTrue(baseline.restored.includes('src/app.js'), 'app.js restored from baseline content')
  assertTrue(baseline.deleted.includes('src/new.js') || baseline.deleted.includes('TODO.md'), 'later files deleted')
  assertEqual(await readFile(join(workspace, 'src', 'app.js'), 'utf8'), 'console.log(1)\n', 'app.js rewound to baseline')

  // ── checkpoint listing ──────────────────────────────────────────────────
  const list = await store.list()
  assertEqual(list.length, 2, 'two turn checkpoints listed')
  assertEqual(list[0].turn, 1, 'first checkpoint is turn 1')

  // ── fork-child scenario: a child session inherits seeded turns and has NO
  // checkpoint for them; restoring to a seeded turn must fall back to the
  // baseline (the fork-point state) instead of returning mode 'none'.
  const childData = join(base, 'data-child')
  const child = new CheckpointStore(childData, workspace)
  // The child only observes its own live events — turn 2 onward (the seed
  // carried turn 1). Its first live event takes the baseline; only turn 2
  // gets a checkpoint.
  await child.ensureBaseline()
  await writeFile(join(workspace, 'src', 'app.js'), 'console.log(9)\n') // turn-2 work
  await child.recordTurn(2, 200)
  const childEvents = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'turn/end', seq: 183, data: { turn: 1 } }, // seeded turn — in the log, but no checkpoint
    { type: 'turn/start', seq: 184, data: { turn: 2 } },
    { type: 'user/message', seq: 185, data: {} },
    { type: 'turn/end', seq: 200, data: { turn: 2 } },
  ]
  // Restore to turn 1 (a seeded turn, no checkpoint): falls back to baseline.
  const childRestore = await child.restore(childEvents, { atSeq: 183, dryRun: true })
  assertEqual(childRestore.mode, 'baseline', 'fork-child rollback to a seeded turn falls back to baseline')
  assertTrue(childRestore.restored.includes('src/app.js'), 'seeded-turn rollback restores baseline content')
  assertEqual(childRestore.boundary?.turn, 1, 'boundary still reports the seeded turn')
  const childReal = await child.restore(childEvents, { atSeq: 183 })
  assertEqual(await readFile(join(workspace, 'src', 'app.js'), 'utf8'), 'console.log(1)\n', 'fork-child rollback rewinds the file to the baseline state')

  // ── .gitignore support test ──────────────────────────────────────────────
  const gitignoreWs = join(base, 'ws-gitignore')
  const gitignoreData = join(base, 'data-gitignore')
  await mkdir(gitignoreWs, { recursive: true })
  await writeFile(join(gitignoreWs, '.gitignore'), 'stuff/\n*.secret\n!important.secret\n')
  await mkdir(join(gitignoreWs, 'stuff'), { recursive: true })
  await writeFile(join(gitignoreWs, 'stuff', 'big.bin'), 'huge stuff')
  await writeFile(join(gitignoreWs, 'file.secret'), 'hidden')
  await writeFile(join(gitignoreWs, 'important.secret'), 'kept')
  await writeFile(join(gitignoreWs, 'normal.txt'), 'normal')

  const gitignoreStore = new CheckpointStore(gitignoreData, gitignoreWs)
  const gitignoreBaseline = await gitignoreStore.ensureBaseline()
  assertTrue('normal.txt' in gitignoreBaseline.files, 'normal.txt is tracked')
  assertTrue('important.secret' in gitignoreBaseline.files, 'negated important.secret is tracked')
  assertTrue(!('stuff/big.bin' in gitignoreBaseline.files), 'stuff/ directory is ignored via .gitignore')
  assertTrue(!('file.secret' in gitignoreBaseline.files), '*.secret is ignored via .gitignore')

  // ── CAS deduplication & backward compatibility test ──────────────────────
  const legacyData = join(base, 'data-legacy')
  await mkdir(legacyData, { recursive: true })
  // Simulate a legacy checkpoint with inline blobs
  const legacyCheckpoint = {
    kind: 'turn',
    turn: 1,
    endSeq: 100,
    at: Date.now(),
    files: {
      'legacy.txt': { sha: 'legacysha', size: 10, mtimeMs: 1000 },
    },
    blobs: {
      'legacy.txt': Buffer.from('legacy content\n').toString('base64'),
    },
  }
  await writeFile(join(legacyData, 'baseline.json'), JSON.stringify({
    kind: 'baseline',
    turn: 0,
    endSeq: -1,
    at: Date.now(),
    files: {},
  }))
  await writeFile(join(legacyData, 'turn-1.json'), JSON.stringify(legacyCheckpoint))
  const legacyWs = join(base, 'ws-legacy')
  await mkdir(legacyWs, { recursive: true })
  const legacyStore = new CheckpointStore(legacyData, legacyWs)
  const legacyEvents = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'turn/end', seq: 100, data: { turn: 1 } },
  ]
  const legacyRestore = await legacyStore.restore(legacyEvents, { atSeq: 50 })
  assertTrue(legacyRestore.restored.includes('legacy.txt'), 'legacy blob restored successfully')
  assertEqual(await readFile(join(legacyWs, 'legacy.txt'), 'utf8'), 'legacy content\n', 'legacy content matches')

  console.log('checkpoints.test.mjs: all assertions passed ✓')
} finally {
  await rm(base, { recursive: true, force: true })
}

// ---- tiny assertion helpers ---------------------------------------------
function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
function assertTrue(condition, label) {
  if (!condition) throw new Error(`${label}: expected truthy`)
}
async function exists(path) {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}
