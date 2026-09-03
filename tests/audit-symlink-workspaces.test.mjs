/**
 * dsh-auto-approval-llm · symlink-guard multi-workspace regression tests.
 *
 * Regression (2026-09-03 audit): the host's symlink-escape guard cached the
 * FIRST workspace's realpath as a process-wide anchor. `dsh web` serves every
 * workspace from one process, so every non-first workspace's target resolved
 * outside that anchor and was hard-denied as a "symlink escape" — all file
 * mutations in the second workspace were blocked. The guard now resolves the
 * workspace root FRESH per call (injectable resolver, see auto/symlink.ts).
 *
 * Run: node --test tests/audit-symlink-workspaces.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDeepest, symlinkEscapeReason } from '../lib/auto/symlink.js'

const rootsOf = (workspace, home) => ({
  workspace, home, dshHome: join(home, '.dsh'),
  allowedDshSubpaths: [], trustedDirs: [], mode: 'standard',
})
const execWrite = (filePath) => ({ name: 'write', arguments: { file_path: filePath } })

test('symlink guard: a fresh per-call anchor keeps every workspace mutation allowed', () => {
  // No symlinks involved: the identity resolver plays "realpath === textual".
  const identity = (p) => p
  const rootsA = rootsOf('C:/ws/a', 'C:/Users/u')
  const rootsB = rootsOf('C:/ws/b', 'C:/Users/u')
  assert.equal(symlinkEscapeReason(execWrite('C:/ws/a/f.txt'), rootsA, identity), undefined, 'workspace A target is allowed')
  // THE regression: a B target evaluated after A must not be judged against
  // A's anchor — with the old process-wide cache this returned a hard-deny
  // "resolves outside the workspace via a symlink" reason.
  assert.equal(symlinkEscapeReason(execWrite('C:/ws/b/f.txt'), rootsB, identity), undefined, 'workspace B target is allowed after A')
})

test('symlink guard: a stale cross-workspace anchor is exactly what used to hard-deny B', () => {
  // Negative-assertion validity: replay the old cache semantics — the anchor
  // was frozen to A's realpath while every target resolved to its own. The
  // guard must treat B's target as an escape under that stale anchor, proving
  // the per-call freshness of the anchor is what keeps B working.
  const rootsA = rootsOf('C:/ws/a', 'C:/Users/u')
  const rootsB = rootsOf('C:/ws/b', 'C:/Users/u')
  const staleAnchor = (input) => (input === rootsB.workspace ? 'C:/ws/a' : input)
  const stale = symlinkEscapeReason(execWrite('C:/ws/b/f.txt'), rootsB, staleAnchor)
  assert.match(stale ?? '', /resolves outside the workspace via a symlink/)
})

test('symlink guard: two real workspaces both pass; only a genuine escape denies', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsa-symlink-'))
  // On macOS the temp root itself is a symlink (/var → /private/var); realpath
  // it once so the fixtures are stable underneath the guard.
  const realRoot = realpathSync(root)
  const wsA = join(realRoot, 'wsA')
  const wsB = join(realRoot, 'wsB')
  const outside = join(realRoot, 'outside')
  mkdirSync(wsA)
  mkdirSync(wsB)
  mkdirSync(outside)
  try {
    writeFileSync(join(wsA, 'a.txt'), 'x')
    const rootsA = rootsOf(wsA, realRoot)
    const rootsB = rootsOf(wsB, realRoot)
    assert.equal(symlinkEscapeReason(execWrite(join(wsA, 'a.txt')), rootsA, resolveDeepest), undefined)
    assert.equal(symlinkEscapeReason(execWrite(join(wsB, 'new.txt')), rootsB, resolveDeepest), undefined,
      'a write into the second workspace must not be judged against the first workspace')
    const link = join(wsA, 'ln-dir')
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const reason = symlinkEscapeReason({ name: 'read', arguments: { file_path: link } }, rootsA, resolveDeepest)
    assert.match(reason ?? '', /resolves outside the workspace via a symlink/, 'a real escape still hard-denies')
    assert.equal(symlinkEscapeReason({ name: 'read', arguments: { file_path: join(wsA, 'a.txt') } }, rootsA, resolveDeepest), undefined,
      'routine reads stay allowed after the escape check')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})