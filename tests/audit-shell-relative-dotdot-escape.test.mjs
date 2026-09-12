/**
 * A relative operand that climbs out of the workspace with an interior `..`
 * must reach the same routine-path gate as one that starts with `..`.
 * `looksLikeExplicitPath` only recognized tokens starting with `/`, `.`, `~`, a
 * drive spec or a UNC prefix, so `b/../../../../Users/…` was dropped from
 * `explicitPaths`, the `.every()` over the empty list answered "routine", and
 * both a read and a write outside the workspace took the static allow.
 *
 * Pins the shell assessment for the escape family plus the in-workspace
 * controls that must stay routine.
 * Run: node --test tests/audit-shell-relative-dotdot-escape.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell, hardDenyShellReason } from '../lib/auto/shell.js'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'

const roots = {
  workspace: 'C:/ws',
  home: 'C:/Users/u',
  dshHome: 'C:/Users/u/.dsh',
  tempRoots: ['C:/Temp'],
  allowedDshSubpaths: [],
}
const assess = (command) => assessShell(command, 'bash', roots, new ArtifactRegistry(), undefined)

test('an interior `..` operand cannot hide an out-of-workspace read', () => {
  for (const command of [
    'cat b/../../../../Users/u/Documents/x',
    'cat b/../../../../../../Users/u/Documents/x',
    'head b/../../../other/notes.txt',
    'grep -n needle b/../../../../other/notes.txt',
    'wc -l b/../../../../other/notes.txt',
  ]) {
    const verdict = assess(command)
    assert.notEqual(verdict.decision, 'allow', `${command} must not be statically allowed`)
    assert.equal(hardDenyShellReason(command, 'bash', roots), undefined, `${command} is a routine-path question, not a hard fuse`)
  }
})

test('an interior `..` operand cannot hide an out-of-workspace write', () => {
  for (const command of [
    'cp ./a.txt b/../../../../evil.txt',
    'mv a.txt b/../../../../evil.txt',
    'mkdir b/../../../../evil-dir',
    'touch b/../../../../evil.txt',
  ]) {
    const verdict = assess(command)
    assert.notEqual(verdict.decision, 'allow', `${command} must not be statically allowed`)
  }
})

test('the same escape written with a leading `..` keeps its previous verdict', () => {
  const leading = assess('cat ../../../../Users/u/Documents/x')
  const interior = assess('cat b/../../../../Users/u/Documents/x')
  assert.equal(leading.decision, interior.decision, 'one target must not split into two verdicts by spelling')
})

test('in-workspace relative paths and `..` that stays inside keep the routine allow', () => {
  for (const command of [
    'cat sub/dir/file.txt',
    'cat b/../c.txt',
    'cat ./b/../c.txt',
    'sort src/index.ts',
    'wc -l sub/a.txt',
  ]) {
    const verdict = assess(command)
    assert.equal(verdict.decision, 'allow', `${command} must stay statically allowed, got ${verdict.decision}`)
  }
})

test('an interior `..` that stays inside is not escalated past its plain spelling', () => {
  assert.equal(assess('cp ./a.txt b/../b.txt').decision, assess('cp ./a.txt b.txt').decision)
  assert.equal(assess('cat b/../c.txt').decision, assess('cat c.txt').decision)
})
