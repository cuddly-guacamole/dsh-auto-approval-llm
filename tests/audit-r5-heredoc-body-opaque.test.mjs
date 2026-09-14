/**
 * A here-document body is data, not shell syntax: `28a2721` already rule it out
 * of the fuse scan ("an ordinary git commit whose message names a fuse target
 * was hard-denied", fixed by stripping bodies against their closing
 * delimiter). The hard-deny plane strips bodies; the `assessShell` opaque
 * branch still judged the raw line, so the same commit message that no longer
 * hard-denies was reported as "a destructive command that cannot be read
 * statically" — a human prompt the ruling says must not happen.
 *
 * Pins both directions: a body that merely names a destructive target keeps the
 * ordinary review tier, and a destructive command outside the body still fires.
 *
 * Run: node --test tests/audit-r5-heredoc-body-opaque.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell } from '../lib/auto/shell.js'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'

const roots = {
  workspace: 'C:/ws',
  home: 'C:/Users/u',
  dshHome: 'C:/Users/u/.dsh',
  tempRoots: ['C:/Temp'],
  allowedDshSubpaths: ['C:/ws'],
  maintenanceDshPaths: [],
  trustedDirs: [],
  mode: 'aggressive',
}
const registry = new ArtifactRegistry()
const owner = { id: 'session-a' }
const shell = (command) => assessShell(command, 'bash', roots, registry, owner)
const commit = (message) => `git commit -m "$(cat <<'EOF'\n${message}\nEOF\n)"`

test('a commit message that names a fuse target keeps the ordinary review tier', () => {
  const control = shell(commit('sync the output handling docs'))
  const mentions = shell(commit('drop the rm -rf guard'))
  assert.equal(mentions.decision, control.decision, 'the body must not change the tier')
  assert.equal(mentions.classifierEligible, control.classifierEligible, 'the body must not remove the classifier')
  assert.notEqual(mentions.decision, 'deny')
})

test('the same body inside another command substitution is unaffected', () => {
  const control = shell('echo "$(cat <<\'EOF\'\nnote\nEOF\n)"')
  const mentions = shell('echo "$(cat <<\'EOF\'\nrm -rf x\nEOF\n)"')
  assert.equal(mentions.classifierEligible, control.classifierEligible, 'the body must not remove the classifier')
  assert.notEqual(mentions.decision, 'deny')
})

test('the backslash-escaped delimiter spelling is a body too', () => {
  const quoted = shell('git commit -m "$(cat <<\'EOF\'\nrm -rf x\nEOF\n)"')
  const escaped = shell('git commit -m "$(cat <<\\EOF\nrm -rf x\nEOF\n)"')
  const bare = shell('git commit -m "$(cat <<EOF\nrm -rf x\nEOF\n)"')
  for (const [label, verdict] of [['escaped', escaped], ['bare', bare]]) {
    assert.equal(verdict.decision, quoted.decision, `the ${label} spelling must keep the quoted spelling's tier`)
    assert.equal(verdict.classifierEligible, quoted.classifierEligible, `the ${label} spelling must keep the classifier`)
    assert.notEqual(verdict.decision, 'deny', `the ${label} body is data and must not be denied`)
  }
})

test('a destructive command outside the body still fires', () => {
  assert.equal(shell(`cat <<'EOF'\nnote\nEOF\nprintf x > C:/Users/u/.dsh/f; (:)`).decision, 'deny')
  const afterBody = shell(`${commit('rm -rf handling')}; rm -rf C:/Users/u/.dsh; (:)`)
  assert.equal(afterBody.decision, 'deny', 'the deletion after the body must still be denied')
  assert.equal(afterBody.classifierEligible, false)
})
