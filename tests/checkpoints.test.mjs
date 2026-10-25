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

  // ── 回归：子会话基线若在“还原前”采集，会把被丢弃轮次的产物记为基线内容，
  // 之后在子会话里回退反而会把已删除的文件“复活”。
  // 正确顺序是「先还原工作区，再分叉」，下面验证该顺序下不会复活。
  {
    const staleWs = join(base, 'ws-stale')
    const parentData = join(base, 'data-stale-parent')
    const childData2 = join(base, 'data-stale-child')
    await mkdir(staleWs, { recursive: true })
    await writeFile(join(staleWs, 'keep.txt'), 'base\n')

    const parentStore = new CheckpointStore(parentData, staleWs)
    await parentStore.ensureBaseline()
    // 第 1 轮产出 2.txt
    await writeFile(join(staleWs, '2.txt'), 'two\n')
    await parentStore.recordTurn(1, 18)
    // 第 2 轮产出 3.txt（这就是被编辑/回退轮次的产物）
    await writeFile(join(staleWs, '3.txt'), 'three\n')
    await parentStore.recordTurn(2, 28)

    const parentEvents = [
      { type: 'turn/end', seq: 18, data: { turn: 1 } },
      { type: 'turn/end', seq: 28, data: { turn: 2 } },
    ]

    // 正确顺序：先还原到第 1 轮边界，再创建子会话（其基线在此采集）
    await parentStore.restore(parentEvents, { atSeq: 18 })
    assertTrue(await exists(join(staleWs, '3.txt')) === false, '还原后本轮产物 3.txt 已删除')

    const childStore = new CheckpointStore(childData2, staleWs)
    const childBaseline = await childStore.ensureBaseline()
    assertTrue(
      !('3.txt' in childBaseline.files),
      '子会话基线不得包含已被还原删除的 3.txt（否则回退会复活它）',
    )

    // 子会话继续工作并在完成后回退到它的基线
    await writeFile(join(staleWs, '4.txt'), 'four\n')
    await childStore.recordTurn(2, 40)
    const childEvents2 = [
      { type: 'turn/end', seq: 18, data: { turn: 1 } },
      { type: 'turn/end', seq: 40, data: { turn: 2 } },
    ]
    const childRollback = await childStore.restore(childEvents2, { atSeq: 18 })
    assertTrue(await exists(join(staleWs, '4.txt')) === false, '子会话回退应删除其自身轮次的产物')
    assertTrue(await exists(join(staleWs, '3.txt')) === false, '子会话回退不得复活已丢弃轮次的 3.txt')
    assertTrue(await exists(join(staleWs, '2.txt')) === true, '边界轮次内产生的 2.txt 应保留')
    assertEqual(await readFile(join(staleWs, 'keep.txt'), 'utf8'), 'base\n', '原有文件保持完好')
    void childRollback
  }

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

  // ── 被忽略路径的产物必须被撤销，但会话前已有的文件必须保留 ──────────────
  const ignoredWs = join(base, 'ws-ignored')
  const ignoredData = join(base, 'data-ignored')
  await mkdir(ignoredWs, { recursive: true })
  await writeFile(join(ignoredWs, '.gitignore'), 'dist/\n*.log\n')
  await writeFile(join(ignoredWs, 'app.js'), 'v1\n')
  // 会话开始前就存在的被忽略文件
  await writeFile(join(ignoredWs, 'debug.log'), 'PRE-EXISTING')
  await mkdir(join(ignoredWs, 'dist'), { recursive: true })
  await writeFile(join(ignoredWs, 'dist', 'old.js'), 'OLD BUILD')

  const ignoredStore = new CheckpointStore(ignoredData, ignoredWs)
  await ignoredStore.ensureBaseline()
  // 本轮 agent 写入的产物（全部落在被忽略路径）
  await writeFile(join(ignoredWs, 'app.js'), 'v2\n')
  await writeFile(join(ignoredWs, 'new.log'), 'NEW LOG')
  await writeFile(join(ignoredWs, 'dist', 'bundle.js'), 'NEW BUILD')
  await ignoredStore.recordTurn(1, 100)

  const ignoredDry = await ignoredStore.restore([], { baseline: true, dryRun: true })
  assertTrue(ignoredDry.deleted.includes('new.log'), 'dry-run 应报告新增日志将被删除')
  assertTrue(ignoredDry.deleted.includes('dist/bundle.js'), 'dry-run 应报告新增构建产物将被删除')
  assertTrue(!ignoredDry.deleted.includes('debug.log'), 'dry-run 不得把会话前的日志列入删除')
  assertTrue(!ignoredDry.deleted.includes('dist/old.js'), 'dry-run 不得把会话前的构建产物列入删除')

  await ignoredStore.restore([], { baseline: true })
  assertEqual(await readFile(join(ignoredWs, 'app.js'), 'utf8'), 'v1\n', '被追踪文件已还原')
  assertEqual(await readFile(join(ignoredWs, 'debug.log'), 'utf8'), 'PRE-EXISTING', '会话前的日志保留')
  assertEqual(await readFile(join(ignoredWs, 'dist', 'old.js'), 'utf8'), 'OLD BUILD', '会话前的构建产物保留')
  assertTrue(await exists(join(ignoredWs, 'new.log')) === false, '本轮新增日志已删除')
  assertTrue(await exists(join(ignoredWs, 'dist', 'bundle.js')) === false, '本轮新增构建产物已删除')

  // ── 本轮新建的空目录骨架也应被清理 ──────────────────────────────────────
  {
    const pruneWs = join(base, 'ws-prune')
    const pruneData = join(base, 'data-prune')
    await mkdir(pruneWs, { recursive: true })
    await writeFile(join(pruneWs, 'app.js'), 'v1\n')
    const pruneStore = new CheckpointStore(pruneData, pruneWs)
    await pruneStore.ensureBaseline()
    await mkdir(join(pruneWs, 'build', 'deep'), { recursive: true })
    await writeFile(join(pruneWs, 'build', 'deep', 'out.js'), 'X')
    await pruneStore.recordTurn(1, 100)
    await pruneStore.restore([], { baseline: true })
    assertTrue(await exists(join(pruneWs, 'build')) === false, '本轮新建的空目录应被清理')
    assertEqual(await readFile(join(pruneWs, 'app.js'), 'utf8'), 'v1\n', '工作区文件保持完好')
  }

  // ── 大文件（超过旧版 1 MiB 上限）必须能还原 ─────────────────────────────
  const bigWs = join(base, 'ws-big')
  const bigData = join(base, 'data-big')
  await mkdir(bigWs, { recursive: true })
  const bigV1 = Buffer.alloc(3 * 1024 * 1024, 'a')
  await writeFile(join(bigWs, 'bundle.bin'), bigV1)
  const bigStore = new CheckpointStore(bigData, bigWs)
  await bigStore.ensureBaseline()
  await writeFile(join(bigWs, 'bundle.bin'), Buffer.alloc(3 * 1024 * 1024, 'b'))
  await bigStore.recordTurn(1, 100)
  const bigRestore = await bigStore.restore([], { baseline: true })
  assertTrue(bigRestore.restored.includes('bundle.bin'), '超过 1 MiB 的文件也应被还原')
  assertEqual(bigRestore.skipped.length, 0, '大文件还原不应有跳过项')
  const bigAfter = await readFile(join(bigWs, 'bundle.bin'))
  assertTrue(bigAfter.equals(bigV1), '大文件内容已精确还原')

  // ── dry-run 与实际执行必须报告同一批文件 ────────────────────────────────
  const consistencyWs = join(base, 'ws-consistency')
  const consistencyData = join(base, 'data-consistency')
  await mkdir(consistencyWs, { recursive: true })
  await writeFile(join(consistencyWs, 'keep.txt'), 'same\n')
  const consistencyStore = new CheckpointStore(consistencyData, consistencyWs)
  await consistencyStore.ensureBaseline()
  await writeFile(join(consistencyWs, 'keep.txt'), 'changed\n')
  await writeFile(join(consistencyWs, 'added.txt'), 'added\n')
  await consistencyStore.recordTurn(1, 100)
  const preview = await consistencyStore.restore([], { baseline: true, dryRun: true })
  const applied = await consistencyStore.restore([], { baseline: true })
  assertEqual(
    [...preview.restored].sort().join(','),
    [...applied.restored].sort().join(','),
    'dry-run 与真实还原的 restored 列表必须一致',
  )
  assertEqual(
    [...preview.deleted].sort().join(','),
    [...applied.deleted].sort().join(','),
    'dry-run 与真实还原的 deleted 列表必须一致',
  )

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

  // ── resetBaseline：空白会话的陈旧基线必须能对齐到当前工作区 ─────────────
  {
    const resetWs = join(base, 'ws-reset')
    const resetData = join(base, 'data-reset')
    await mkdir(resetWs, { recursive: true })
    await writeFile(join(resetWs, 'keep.txt'), 'base\n')
    await writeFile(join(resetWs, 'stale.txt'), 'STALE\n')

    // 模拟“此前创建的空白会话”：基线包含 stale.txt
    const reused = new CheckpointStore(resetData, resetWs)
    const staleBaseline = await reused.ensureBaseline()
    assertTrue('stale.txt' in staleBaseline.files, '陈旧基线包含 stale.txt')

    // 随后 stale.txt 被删除（例如上一次还原清掉了它）
    await rm(join(resetWs, 'stale.txt'))

    // 复用该会话时必须重建基线
    const reset = await reused.resetBaseline()
    assertTrue(reset === true, '空白会话允许重建基线')
    const fresh = await reused.ensureBaseline()
    assertTrue(!('stale.txt' in fresh.files), '重建后的基线不再包含已删除的 stale.txt')

    // 重建后回退不应复活 stale.txt
    await writeFile(join(resetWs, 'work.txt'), 'work\n')
    await reused.recordTurn(1, 10)
    await reused.restore([], { baseline: true })
    assertTrue(await exists(join(resetWs, 'stale.txt')) === false, '回退不得复活已删除文件')
    assertTrue(await exists(join(resetWs, 'work.txt')) === false, '回退应删除本轮产物')

    // 已有轮次检查点的会话拒绝重建，保护历史基线
    const refused = await reused.resetBaseline()
    assertTrue(refused === false, '已有轮次检查点的会话应拒绝重建基线')
  }

  // ── 还原不可用时必须报错，而不是静默返回空结果 ──────────────────────────
  {
    const emptyWs = join(base, 'ws-empty')
    const emptyData = join(base, 'data-empty')
    await mkdir(emptyWs, { recursive: true })
    const emptyStore = new CheckpointStore(emptyData, emptyWs)
    let threw = false
    try {
      await emptyStore.restore([], { baseline: true })
    } catch (error) {
      threw = true
      assertEqual(error.failure, 'no-baseline', '无基线时应报 no-baseline')
    }
    assertTrue(threw, '无基线时 restore 必须抛错，不得静默成功')

    // dryRun 仍可用于探测（不抛错，返回 mode: none）
    const probe = await emptyStore.restore([], { baseline: true, dryRun: true })
    assertEqual(probe.mode, 'none', 'dryRun 探测允许返回 none')
  }

  // ── 晚采集的基线必须如实告警（它无法撤销此前已存在的产物）────────────────
  {
    const lateWs = join(base, 'ws-late')
    const lateData = join(base, 'data-late')
    await mkdir(lateWs, { recursive: true })
    await writeFile(join(lateWs, 'keep.txt'), 'base\n')
    // 会话已经产生过事件（priorEventCount > 0），且 Agent 已写出 1.txt
    await writeFile(join(lateWs, '1.txt'), 'agent output\n')
    const lateStore = new CheckpointStore(lateData, lateWs)
    const lateBaseline = await lateStore.ensureBaseline(Date.now(), 5)
    assertTrue(lateBaseline.late === true, '会话已启动后采集的基线应标记 late')
    assertTrue('1.txt' in lateBaseline.files, '晚采集基线会含已有产物（这正是问题所在）')

    const lateRestore = await lateStore.restore([], { baseline: true, dryRun: false })
    assertTrue(
      (lateRestore.warnings ?? []).some(w => w.startsWith('baseline-late')),
      '回退到晚采集基线时必须给出 baseline-late 告警',
    )
    // 1.txt 属于基线内容，因此不会被删除——告警正是为了说明这一点
    assertTrue(await exists(join(lateWs, '1.txt')) === true, '晚采集基线中原有产物不会被删除')
  }

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
