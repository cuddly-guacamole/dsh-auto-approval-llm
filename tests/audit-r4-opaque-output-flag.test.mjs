/**
 * Output-flag writes on a line that cannot be decomposed.
 *
 * The whole-line fuse recovers redirect targets from opaque lines (a grouping
 * form, a command substitution, a heredoc) so a write every other spelling
 * hard-denies cannot hide behind an unreadable line. A read-only command's
 * output flag carries its target without any redirection token, and that
 * recovery did not cover it: `sort -o <protected> in.txt; (:)` degraded from
 * hard deny to a classifier-answerable ask while the decomposable spelling
 * stayed denied.
 *
 * Run: node --test tests/audit-r4-opaque-output-flag.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'
import { assessShell } from '../lib/auto/shell.js'
import { resolveRoots } from '../lib/auto/paths.js'

const roots = resolveRoots('C:/ws', { home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh' })
roots.allowedDshSubpaths = []
roots.maintenanceDshPaths = []
roots.mode = 'aggressive'
roots.trustedDirs = []
const registry = new ArtifactRegistry()
const owner = { id: 'session-a' }
const shell = (command) => assessShell(command, 'bash', roots, registry, owner)

const PROTECTED = 'C:/Users/u/.dsh/state.json'

test('an opaque line keeps the output-flag verdict', () => {
  for (const command of [
    `sort -o ${PROTECTED} in.txt; (:)`,
    `sort --output=${PROTECTED} in.txt; (:)`,
    `sort --output ${PROTECTED} in.txt; (:)`,
    `git diff --output=${PROTECTED}; (:)`,
    `tree --output=${PROTECTED} src; (:)`,
  ]) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must keep the hard deny (got ${verdict.decision}: ${verdict.reason})`)
  }
})

test('the decomposable spelling still agrees', () => {
  const bare = shell(`sort -o ${PROTECTED} in.txt`)
  const opaque = shell(`sort -o ${PROTECTED} in.txt; (:)`)
  assert.equal(bare.decision, 'deny')
  assert.equal(opaque.decision, bare.decision)
})

test('an ordinary opaque line is not denied', () => {
  const verdict = shell('sort -o C:/tmp/ok.txt in.txt; (:)')
  assert.notEqual(verdict.decision, 'deny', `got ${verdict.decision}: ${verdict.reason}`)
})
