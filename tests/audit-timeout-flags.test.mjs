/**
 * dsh-auto-approval-llm · timeout wrapper flag-value contracts.
 *
 * Fix: `timeout -s KILL 5 sudo rm -rf /` used to unwrap to `kill` as the
 * effective command — the `-s` value was not consumed, so the sudo/rm fuses
 * never saw the real command. The signal value is now consumed like every
 * other wrapper flag value, restoring the unconditional privilege fuse.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell } from '../lib/auto/shell.js'

const plainRoots = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: ['C:/Temp'], allowedDshSubpaths: [] }
const artifacts = { has: () => false }
const shell = (command, roots = plainRoots) => assessShell(command, 'bash', roots, artifacts, undefined)

test('assessShell: timeout signal/kill-after values cannot hide sudo or deletion', () => {
  for (const command of [
    'timeout -s KILL 5 sudo rm -rf /',
    'timeout --signal KILL 5 sudo ls',
    'timeout --kill-after 3 5 sudo ls',
  ]) {
    const r = shell(command)
    assert.equal(r.decision, 'deny', `${command} must hit the privilege fuse`)
  }
  // The deletion behind timeout is judged on its own terms: an ordinary
  // workspace target stays a semantic review (no sudo, no system root).
  assert.equal(shell('timeout -s KILL 5 rm -rf C:/ws/ok').decision, 'ask')
})

test('assessShell: timeout wrapper keeps ordinary commands working (no over-block)', () => {
  assert.equal(shell('timeout -s TERM 5 node --version').decision, 'allow')
  assert.equal(shell('timeout 5 ls').decision, 'allow')
  assert.equal(shell('timeout 5 sudo ls').decision, 'deny')
})