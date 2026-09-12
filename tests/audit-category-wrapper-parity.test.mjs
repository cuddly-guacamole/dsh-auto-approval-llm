/**
 * The wrapper table exists twice (src/auto/shell.ts is the authority,
 * src/auto/category.ts a hand-copied sibling), and the copy had lost `timeout`.
 * A `timeout -s KILL 5 rm -rf X` then classified as `unknown` instead of
 * `delete`, so the operator's delete categoryPolicy and the delete/disk hard
 * lock were bypassed by a wrapper flag — the shell plane saw `rm`, the
 * category plane saw `KILL`.
 *
 * Pins the behaviour AND the table parity, so the copy cannot drift again
 * silently.
 * Run: node --test tests/audit-category-wrapper-parity.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { categorizeTool } from '../lib/auto/category.js'

const roots = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh' }
const category = (command) => categorizeTool({ name: 'bash', arguments: { command } }, roots)

test('timeout value flags do not hide the wrapped command from the category layer', () => {
  const forms = [
    'timeout 5 rm -rf x',
    'timeout -s KILL 5 rm -rf x',
    'timeout --signal KILL 5 rm -rf x',
    'timeout -k 2 5 rm -rf x',
    'timeout --kill-after 2 5 rm -rf x',
  ]
  for (const command of forms) {
    assert.equal(category(command), 'delete', `${command} must classify as delete`)
  }
})

test('the other wrapper value flags keep working (no over-wrap)', () => {
  assert.equal(category('nice -n 5 rm -rf x'), 'delete')
  assert.equal(category('stdbuf -o0 rm -rf x'), 'delete')
  assert.equal(category('xargs -n 1 rm -rf x'), 'delete')
  assert.equal(category('timeout 5 ls'), 'readOnly')
})

test('the category wrapper table stays parity with the shell authority', () => {
  const categoryLib = readFileSync(fileURLToPath(new URL('../lib/auto/category.js', import.meta.url)), 'utf8')
  const shellLib = readFileSync(fileURLToPath(new URL('../lib/auto/shell.js', import.meta.url)), 'utf8')
  const timeoutFlag = /timeout:\s*\/\^-\(\?:s\|k\)\$/.source
  assert.match(categoryLib, new RegExp(timeoutFlag), 'category.ts must keep the timeout value flags')
  assert.match(shellLib, new RegExp(timeoutFlag), 'shell.ts is the table authority')
})
