/**
 * Backtick substitution as a segment boundary.
 *
 * `$(...)`, `(...)` and `{...}` all make a line opaque AND break the segment
 * scan at their delimiters, so a command hidden inside them still meets the
 * privilege / deletion / write fuses. A backtick substitution was recognized as
 * opaque (fail-closed on the classification axis) but was NOT a boundary in the
 * three anchor sets, so `` `sudo ls` `` and `` `rm -rf /` `` fell through to a
 * classifier-answerable ask while their `$(...)` spelling was hard-denied.
 *
 * The backtick now anchors the whole-line privilege fuse, the nested-deletion
 * detector, the nested redirect-target scan, and the opaque segment splitter.
 * Ordinary lines (including a literal backtick inside single quotes) are
 * unaffected on the allow side.
 *
 * Run: node --test tests/audit-r4-backtick-substitution.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'
import { assessShell } from '../lib/auto/shell.js'
import { resolveRoots } from '../lib/auto/paths.js'

const B = String.fromCharCode(96)
const roots = resolveRoots('C:/ws', { home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh' })
roots.allowedDshSubpaths = []
roots.maintenanceDshPaths = []
roots.mode = 'aggressive'
roots.trustedDirs = []
const registry = new ArtifactRegistry()
const owner = { id: 'session-a' }
const shell = (command) => assessShell(command, 'bash', roots, registry, owner)

test('a backtick substitution is denied like its $(...) spelling', () => {
  const pairs = [
    [`${B}sudo ls${B}`, '$(sudo ls)'],
    [`x=${B}sudo ls${B}`, 'x=$(sudo ls)'],
    [`${B}rm -rf /${B}`, '$(rm -rf /)'],
    [`${B}doas ls${B}`, '$(doas ls)'],
  ]
  for (const [backtick, substitution] of pairs) {
    const bare = shell(backtick)
    const dollar = shell(substitution)
    assert.equal(bare.decision, 'deny', `${backtick} must hard-deny (got ${bare.decision}: ${bare.reason})`)
    assert.equal(bare.decision, dollar.decision, `${backtick} and ${substitution} must share the verdict`)
  }
})

test('a redirect hidden in a backtick substitution reaches the write fuse', () => {
  const verdict = shell(`${B}printf x > C:/Users/u/.dsh/state.json${B}`)
  assert.equal(verdict.decision, 'deny', `got ${verdict.decision}: ${verdict.reason}`)
})

test('ordinary lines are unaffected', () => {
  for (const command of ['echo hi', 'ls', 'echo sudo', 'cat README.md']) {
    assert.notEqual(shell(command).decision, 'deny', `${command} must stay non-denied`)
  }
})
