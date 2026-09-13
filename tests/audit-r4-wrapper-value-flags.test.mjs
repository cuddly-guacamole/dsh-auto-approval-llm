/**
 * Wrapper flags that consume the following word.
 *
 * Wrappers (`env`, `nice`, `stdbuf`, `ionice`, `timeout`, `time`, `xargs`) are
 * stripped so the effective command is judged by the fuses. When a value-taking
 * flag was missing from the table, the "effective command" became the flag's
 * VALUE: `env -u FOO rm -rf /` unwrapped to `FOO`, so the privilege, delete,
 * write-operand and find fuses all skipped and the line fell through to a
 * classifier-answerable ask (the category layer also dropped delete -> unknown,
 * which disarms the delete hard lock).
 *
 * Only the short spellings were listed, so long spellings and every separated
 * value (`--unset FOO`, `--adjustment 5`, `--output L`, `--class 3`,
 * `--max-args 2`, `--output FILE`) kept the gap. The table now covers both
 * spellings in one place per plane, and the parity check compares the two
 * planes entry by entry instead of pinning one literal.
 *
 * Run: node --test tests/audit-r4-wrapper-value-flags.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'
import { assessShell } from '../lib/auto/shell.js'
import { categorizeTool } from '../lib/auto/category.js'
import { resolveRoots } from '../lib/auto/paths.js'

const roots = resolveRoots('C:/ws', {})
roots.allowedDshSubpaths = []
roots.maintenanceDshPaths = []
roots.mode = 'aggressive'
roots.trustedDirs = []
const registry = new ArtifactRegistry()
const owner = { id: 'session-a' }
const shell = (command) => assessShell(command, 'bash', roots, registry, owner)
const category = (command) => categorizeTool({ name: 'bash', arguments: { command } }, roots)

const DESTRUCTIVE_FORMS = [
  'env -u FOO rm -rf /',
  'env --unset FOO rm -rf /',
  'env -C /tmp rm -rf /',
  'env --chdir /tmp rm -rf /',
  'env --argv0 x rm -rf /',
  'nice --adjustment 5 rm -rf /',
  'stdbuf --output L rm -rf /',
  'stdbuf --input 0 rm -rf /',
  'ionice --class 3 rm -rf /',
  'ionice --pid 1 rm -rf /',
  'timeout --signal KILL 5 rm -rf /',
  'timeout --kill-after 2 5 rm -rf /',
  'xargs --max-args 2 rm -rf /',
  'xargs --arg-file f rm -rf /',
  'time --output /tmp/x rm -rf /',
  'time --format %e rm -rf /',
  'find . -exec env -u FOO rm -rf / +',
]

test('a separated wrapper value never becomes the effective command', () => {
  for (const command of DESTRUCTIVE_FORMS) {
    assert.equal(shell(command).decision, 'deny', `${command} must stay hard-denied`)
    assert.equal(category(command), 'delete', `${command} must still classify as delete`)
  }
})

test('privilege escalation behind a separated wrapper value stays denied', () => {
  for (const command of ['env -u FOO sudo ls', 'env --unset FOO doas ls', 'nice --adjustment 5 sudo ls']) {
    assert.equal(shell(command).decision, 'deny', `${command} must stay hard-denied`)
    assert.equal(category(command), 'privilege', `${command} must still classify as privilege`)
  }
})

test('the fused and short spellings keep working (no over-wrap)', () => {
  for (const command of [
    'env -u FOO rm -rf /',
    'env --unset=FOO rm -rf /',
    'nice -n 5 rm -rf /',
    'stdbuf -o L rm -rf /',
    'ionice -c 3 rm -rf /',
    'timeout -s KILL 5 rm -rf /',
    'timeout -k 2 5 rm -rf /',
    'xargs -n 1 rm -rf /',
  ]) {
    assert.equal(shell(command).decision, 'deny', `${command} must stay hard-denied`)
    assert.equal(category(command), 'delete', `${command} must still classify as delete`)
  }
})

test('routine uses of the same wrappers are not rejected', () => {
  for (const command of [
    'env FOO=1 ls',
    'env -i ls',
    'env -u FOO ls',
    'nice -n 5 ls',
    'stdbuf -o L ls',
    'timeout -s KILL 5 ls',
    'xargs -n 2 echo',
    'time -o /tmp/x ls',
  ]) {
    assert.notEqual(shell(command).decision, 'deny', `${command} is a routine read and must not be denied`)
  }
})

function tableOf(libPath) {
  const source = readFileSync(fileURLToPath(new URL(libPath, import.meta.url)), 'utf8')
  const at = source.indexOf('const WRAPPER_VALUE_FLAGS = {')
  assert.ok(at > 0, `${libPath} declares the wrapper value-flag table`)
  const block = source.slice(at, source.indexOf('};', at))
  const entries = new Map()
  for (const match of block.matchAll(/([A-Za-z]+):\s*(\/.*?\/[a-z]*),/g)) entries.set(match[1], match[2])
  return entries
}

test('the category copy is entry-for-entry parity with the shell authority', () => {
  const shellTable = tableOf('../lib/auto/shell.js')
  const categoryTable = tableOf('../lib/auto/category.js')
  assert.ok(shellTable.size >= 7, `the authority table lists every wrapper with a value flag (got ${shellTable.size})`)
  assert.deepEqual(
    [...categoryTable.entries()].sort(),
    [...shellTable.entries()].sort(),
    'the hand-copied table must match the authority entry by entry',
  )
})
