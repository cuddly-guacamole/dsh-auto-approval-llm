/**
 * dsh-auto-approval-llm · git rev:path object-read gate contracts.
 *
 * Fix: `git show HEAD:.env` names a path inside a colon token that the
 * explicit-path extraction never lifts, so the empty path set
 * short-circuited `readPathsAreRoutine`'s `.every()` to a static allow —
 * a silent bypass of the .env/.git protected-read gate that the read tool
 * and `cat .env` both honor. The object-path portion is now judged with the
 * same routine / protected / sensitive gates.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell } from '../lib/auto/shell.js'

const plainRoots = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: ['C:/Temp'], allowedDshSubpaths: [] }
const artifacts = { has: () => false }
const shell = (command, roots = plainRoots) => assessShell(command, 'bash', roots, artifacts, undefined)

test('assessShell: git rev:path reads of protected content are gated', () => {
  for (const command of ['git show HEAD:.env', 'git show HEAD:.git/config', 'git show HEAD:.npmrc']) {
    const r = shell(command)
    assert.notEqual(r.decision, 'allow', `${command} must not be statically allowed`)
    assert.equal(r.classifierEligible, true, `${command} reaches semantic review`)
  }
})

test('assessShell: git object reads of ordinary content stay static (no over-block)', () => {
  assert.equal(shell('git show HEAD:src/a.ts').decision, 'allow')
  assert.equal(shell('git status').decision, 'allow')
  assert.equal(shell('git log --oneline -5').decision, 'allow')
  assert.equal(shell('git diff HEAD').decision, 'allow')
})