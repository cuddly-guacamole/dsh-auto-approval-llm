/**
 * dsh-auto-approval-llm · workspace-facts probe + recent-creates index.
 *
 * Fixture-based (mkdtempSync) tests over the compiled lib. Run:
 * node --test tests/probe.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'
import { probeTargetFacts } from '../lib/auto/probe.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsa-probe-'))
  const workspace = join(root, 'ws')
  const outside = join(root, 'outside')
  mkdirSync(workspace)
  mkdirSync(outside)
  return {
    root,
    workspace,
    outside,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

// ── probeTargetFacts: existence and kind ─────────────────────────────────
test('probeTargetFacts: existing file reports file kind and lstat size', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'a.txt')
    writeFileSync(target, 'hello')
    assert.deepEqual(probeTargetFacts(target, f.workspace),
      { targetExists: true, targetKind: 'file', targetSize: 5 })
  } finally {
    f.cleanup()
  }
})

test('probeTargetFacts: existing directory reports dir kind', () => {
  const f = fixture()
  try {
    const target = join(f.workspace, 'sub')
    mkdirSync(target)
    const facts = probeTargetFacts(target, f.workspace)
    assert.equal(facts.targetExists, true)
    assert.equal(facts.targetKind, 'dir')
    assert.equal(typeof facts.targetSize, 'number')
  } finally {
    f.cleanup()
  }
})

test('probeTargetFacts: missing target returns missing facts without throwing', () => {
  const f = fixture()
  try {
    assert.deepEqual(probeTargetFacts(join(f.workspace, 'nope.txt'), f.workspace),
      { targetExists: false, targetKind: 'missing', targetSize: null })
  } finally {
    f.cleanup()
  }
})

// ── probeTargetFacts: workspace boundary ──────────────────────────────────
test('probeTargetFacts: out-of-workspace target keeps kind but nulls size', () => {
  const f = fixture()
  try {
    const target = join(f.outside, 'big.bin')
    writeFileSync(target, 'x'.repeat(4096))
    assert.deepEqual(probeTargetFacts(target, f.workspace),
      { targetExists: true, targetKind: 'file', targetSize: null })
  } finally {
    f.cleanup()
  }
})

test('probeTargetFacts: symlink/junction escaping the workspace is omitted', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.outside, 'sec.txt'), 'secret')
    // File symlink first (needs privileges on Windows); junction to the
    // outside directory as the fallback (no privileges needed / POSIX-safe).
    let used = ''
    try {
      symlinkSync(join(f.outside, 'sec.txt'), join(f.workspace, 'link-file'), 'file')
      used = 'file'
    } catch {
      symlinkSync(f.outside, join(f.workspace, 'link-dir'), 'junction')
      used = 'junction'
    }
    const link = join(f.workspace, used === 'file' ? 'link-file' : 'link-dir')
    assert.equal(probeTargetFacts(link, f.workspace), undefined)
  } finally {
    f.cleanup()
  }
})

test('probeTargetFacts: invalid input / probe failure returns undefined, never throws', () => {
  const f = fixture()
  try {
    assert.equal(probeTargetFacts(undefined, f.workspace), undefined)
    assert.equal(probeTargetFacts('', f.workspace), undefined)
    assert.equal(probeTargetFacts(join(f.workspace, 'x.txt'), undefined), undefined)
    assert.equal(probeTargetFacts('', ''), undefined)
  } finally {
    f.cleanup()
  }
})

// ── recent-creates parallel index (artifacts.list) ────────────────────────
test('list: returns workspace-relative paths, newest first, sanitized', () => {
  const f = fixture()
  try {
    const registry = new ArtifactRegistry()
    const owner = { id: 's1' }
    const roots = { workspace: f.workspace, home: f.workspace, tempRoots: [] }
    const p = (name) => join(f.workspace, name)
    registry.add(owner, p('a.txt'), roots)
    registry.add(owner, p('b.txt'), roots)
    registry.add(owner, join(f.workspace, 'sub', 'c.txt'), roots)
    assert.deepEqual(registry.list(owner, roots), [join('sub', 'c.txt'), 'b.txt', 'a.txt'])
  } finally {
    f.cleanup()
  }
})

test('list: temp-root files and out-of-workspace paths are rejected', () => {
  const f = fixture()
  try {
    const registry = new ArtifactRegistry()
    const owner = { id: 's1' }
    const roots = { workspace: f.workspace, home: f.workspace, tempRoots: [f.outside, join(f.workspace, 'tmp')] }
    registry.add(owner, join(f.workspace, 'ok.txt'), roots)
    registry.add(owner, join(f.outside, 'tmp.bin'), roots)
    registry.add(owner, join(f.workspace, 'tmp', 'junk.bin'), roots)
    assert.deepEqual(registry.list(owner, roots), ['ok.txt'])
  } finally {
    f.cleanup()
  }
})

test('list: capped at 8 with re-creates bumping recency', () => {
  const f = fixture()
  try {
    const registry = new ArtifactRegistry()
    const owner = { id: 's1' }
    const roots = { workspace: f.workspace, home: f.workspace, tempRoots: [] }
    const p = (name) => join(f.workspace, name)
    for (let i = 1; i <= 10; i += 1) registry.add(owner, p(`f${i}.txt`), roots)
    assert.deepEqual(registry.list(owner, roots),
      ['f10.txt', 'f9.txt', 'f8.txt', 'f7.txt', 'f6.txt', 'f5.txt', 'f4.txt', 'f3.txt'])
    // A re-create bumps the path to the newest slot and evicts the oldest.
    registry.add(owner, p('f1.txt'), roots)
    assert.deepEqual(registry.list(owner, roots),
      ['f1.txt', 'f10.txt', 'f9.txt', 'f8.txt', 'f7.txt', 'f6.txt', 'f5.txt', 'f4.txt'])
  } finally {
    f.cleanup()
  }
})

// ── plan → settle → has chain (session-created artifact provenance) ───────
test('settle: a planned create promotes on a non-error string result (str_replace_editor create)', () => {
  const f = fixture()
  try {
    const registry = new ArtifactRegistry()
    const owner = { id: 's1' }
    const roots = { workspace: f.workspace, home: f.workspace, tempRoots: [] }
    const target = join(f.workspace, 'fresh.txt')
    const exec = { name: 'str_replace_editor', token: 't1', agent: { session: owner } }
    registry.plan(exec, [target], roots)
    assert.equal(registry.has(owner, target, roots), false, 'nothing is proven before settlement')
    registry.settle(exec, { isError: false, value: `New file created successfully at: ${target}` }, roots)
    assert.equal(registry.has(owner, target, roots), true, 'the planned create is proven after a non-error result')
  } finally {
    f.cleanup()
  }
})

test('settle: a failed shell exit and error results never promote planned creates', () => {
  const f = fixture()
  try {
    const registry = new ArtifactRegistry()
    const owner = { id: 's1' }
    const roots = { workspace: f.workspace, home: f.workspace, tempRoots: [] }
    const okExec = { name: 'bash', token: 't1', agent: { session: owner } }
    const failExec = { name: 'bash', token: 't2', agent: { session: owner } }
    const errExec = { name: 'bash', token: 't3', agent: { session: owner } }
    const target = join(f.workspace, 'made-by-shell.txt')
    registry.plan(okExec, [target], roots)
    registry.plan(failExec, [target], roots)
    registry.plan(errExec, [target], roots)
    registry.settle(failExec, { isError: false, value: { exitCode: 1 } }, roots)
    registry.settle(errExec, { isError: true, value: undefined }, roots)
    registry.settle(okExec, { isError: false, value: { exitCode: 0 } }, roots)
    assert.equal(registry.has(owner, target, roots), true, 'only the zero-exit execution promotes')
  } finally {
    f.cleanup()
  }
})

test('settle: the host write result carries the create contract directly', () => {
  const f = fixture()
  try {
    const registry = new ArtifactRegistry()
    const owner = { id: 's1' }
    const roots = { workspace: f.workspace, home: f.workspace, tempRoots: [] }
    const created = join(f.workspace, 'via-write.txt')
    const updated = join(f.workspace, 'via-overwrite.txt')
    const exec = { name: 'write', token: 't1', agent: { session: owner } }
    registry.settle(exec, { isError: false, value: { path: created, operation: 'create', before: null, after: 'x' } }, roots)
    registry.settle(exec, { isError: false, value: { path: updated, operation: 'update', before: 'x', after: 'y' } }, roots)
    assert.equal(registry.has(owner, created, roots), true, 'a create outcome proves the artifact')
    assert.equal(registry.has(owner, updated, roots), false, 'an overwrite is not a session creation')
  } finally {
    f.cleanup()
  }
})