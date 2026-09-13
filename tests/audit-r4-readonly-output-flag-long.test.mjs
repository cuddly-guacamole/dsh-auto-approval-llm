/**
 * Read-only commands that write through their own output flag, long spelling.
 *
 * `sort -o FILE`, `sort --output=FILE`, `tree --output FILE` and
 * `git diff --output FILE` write a file with no redirection token. The target
 * extractor sliced the value out of the SHORT spelling (`indexOf('o', 1)`), so
 * for the long form without `=` it produced the literal `utput`: the real
 * destination never reached the destructive fuse and the segment degraded from
 * hard deny to a classifier-answerable ask. Three places document the long
 * spelling as covered.
 *
 * The long form now takes the following word as its value, the short cluster
 * keeps fusing its value, and the ordinary project-local case stays off the
 * static read-only allow (a write is a write) without being rejected.
 *
 * Run: node --test tests/audit-r4-readonly-output-flag-long.test.mjs (tsc first)
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

const PROTECTED = 'C:/Users/u/.dsh/runtime-state.json'

test('every spelling of the output flag carries its real target into the fuse', () => {
  for (const command of [
    `sort -o ${PROTECTED} in.txt`,
    `sort -oC:/Users/u/.dsh/x in.txt`,
    `sort --output=${PROTECTED} in.txt`,
    `sort --output ${PROTECTED} in.txt`,
    `tree --output ${PROTECTED} src`,
    `tree --output=${PROTECTED} src`,
    `git diff --output ${PROTECTED}`,
    `git diff --output=${PROTECTED}`,
  ]) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must hard-deny (got ${verdict.decision}: ${verdict.reason})`)
    assert.match(String(verdict.reason ?? ''), /output flag/, `${command} must be denied by the output-flag fence`)
  }
})

test('an ordinary project-local output target stays off the static allow', () => {
  const verdict = shell('sort --output out.txt in.txt')
  assert.notEqual(verdict.decision, 'allow', 'a write target must never ride the static read-only allow')
  assert.notEqual(verdict.decision, 'deny', 'a workspace write is not a destructive target')
})

test('display-only reads keep the static allow', () => {
  assert.equal(shell('sort in.txt').decision, 'allow')
  // `--output-indicator-*` is not an output FILE for git, and the table keeps
  // that distinction.
  assert.notEqual(shell('git diff --output-indicator-new=+').decision, 'deny')
})
