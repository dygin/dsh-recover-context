#!/usr/bin/env node
/**
 * Bundle and run the client-side logic tests headlessly (no DOM needed: the
 * snapshot analysis and the rollback/edit orchestration are pure data-flow).
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(mkdtempSync(join(tmpdir(), 'rc-client-test-')), 'client-logic.test.mjs')

execFileSync(
  join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [
    join(ROOT, 'tests', 'client-logic.test.ts'),
    '--bundle', '--platform=node', '--format=esm',
    `--outfile=${out}`,
    '--log-override:commonjs-variable-in-esm=silent',
  ],
  { stdio: 'inherit' },
)
try {
  execFileSync(process.execPath, [out], { stdio: 'inherit' })
} finally {
  rmSync(dirname(out), { recursive: true, force: true })
}
