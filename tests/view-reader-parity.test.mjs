/**
 * `str_replace_editor view` must be as gated as the rest of the read family.
 *
 * Two independent gaps made the reader choice the security boundary:
 *
 * 1. `symlinkGuardTargets` excluded `str_replace_editor` whenever the command
 *    was `view`, so a workspace link pointing at a credential file had NO
 *    realpath re-check at all on that reader while `read` of the same path was
 *    resolved and hard-denied. (The official host performs no symlink
 *    resolution of its own — it asks the registered guard — so the exclusion
 *    here was the whole guard surface for `view`.)
 * 2. The policy `view` branch skipped `isProtectedProjectPath`, while the read
 *    branch applied it, so `view <workspace>/.env` was a static ALLOW and
 *    `read <workspace>/.env` was an ask.
 *
 * Both halves are pinned here, together with the controls that keep each from
 * degenerating: a textually external `view` target must keep its ordinary
 * escalation (the guard's position rule is not widened), and an ordinary
 * workspace file must stay allowed.
 *
 * Run: node --test tests/view-reader-parity.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assessTool, symlinkGuardTargets } from '../lib/auto/policy.js'
import { symlinkEscapeReason, resolveDeepest } from '../lib/auto/symlink.js'
import { categorizeTool } from '../lib/auto/category.js'

const rootsOf = (workspace, home, mode = 'standard') => ({
  workspace, home, dshHome: join(home, '.dsh'),
  allowedDshSubpaths: [], trustedDirs: [], mode,
})
const artifacts = { has: () => false }
const view = (path) => ({ name: 'str_replace_editor', arguments: { command: 'view', path } })

// ── half 1: the guard covers `view` ────────────────────────────────────────

test('guard targets: view carries its path operand, like the mutation commands', () => {
  // The regression this file exists for. Before the fix this returned [].
  assert.deepEqual(symlinkGuardTargets('str_replace_editor', { command: 'view', path: 'C:/ws/a.ts' }), ['C:/ws/a.ts'])
  // The non-view commands keep their existing operand handling.
  assert.deepEqual(symlinkGuardTargets('str_replace_editor', { command: 'str_replace', path: 'C:/ws/a.ts' }), ['C:/ws/a.ts'])
  // A view without a path is still "no operand", not a crash.
  assert.deepEqual(symlinkGuardTargets('str_replace_editor', { command: 'view' }), [])
})

test('guard: a view through a workspace link into a credential tree is refused', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsa-view-')))
  const ws = join(root, 'ws')
  const creds = join(root, 'creds')
  mkdirSync(ws)
  mkdirSync(creds)
  try {
    const secret = join(creds, 'id_key_material')
    writeFileSync(secret, 'private')
    const link = join(ws, 'linked-secret')
    symlinkSync(creds, link, process.platform === 'win32' ? 'junction' : 'dir')
    // The link is textually INSIDE the workspace, so the guard must judge it —
    // and its realpath leaves the workspace, so it must hard-deny.
    const reason = symlinkEscapeReason(view(link), rootsOf(ws, root), resolveDeepest)
    assert.match(reason ?? '', /resolves outside the workspace via a symlink/)
    // Control: the same reader on a plain in-workspace file stays allowed, and
    // the guard really did resolve (a stub resolver that returns nothing would
    // silently pass this control with the guard doing no work).
    writeFileSync(join(ws, 'plain.txt'), 'x')
    assert.equal(symlinkEscapeReason(view(join(ws, 'plain.txt')), rootsOf(ws, root), resolveDeepest), undefined)
    let calls = 0
    const seen = []
    const counting = (p) => { calls += 1; seen.push(p); return resolveDeepest(p) }
    assert.equal(symlinkEscapeReason(view(join(ws, 'plain.txt')), rootsOf(ws, root), counting), undefined)
    // The guard resolves the workspace root AND the target, so require the
    // target to be among the resolved paths: a bare `calls > 0` is satisfied by
    // the unconditional workspace resolution alone, which would let a guard that
    // silently stopped resolving targets pass this control.
    assert.ok(calls >= 2, `the guard resolved the workspace and the target, got ${calls} call(s)`)
    assert.ok(
      seen.some((p) => p.includes('plain.txt')),
      `the guard resolved the target path itself, got: ${seen.join(', ')}`,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('guard: the position rule still limits view, so an external target is not swept in', () => {
  // A textually external target is not this guard's business — it keeps the
  // ordinary hard-deny / ask escalation. Adding `view` to the guard must not
  // have turned every external read into an unconditional hard deny.
  const identity = (p) => p
  const roots = rootsOf('C:/ws', 'C:/Users/u')
  assert.equal(symlinkEscapeReason(view('C:/elsewhere/a.ts'), roots, identity), undefined)
})

// ── half 2: the view branch mirrors the read family's gates ────────────────

test('policy: view and read agree on protected workspace metadata', () => {
  const roots = rootsOf('C:/ws', 'C:/Users/u')
  const viaView = assessTool(view('C:/ws/.env'), roots, artifacts)
  const viaRead = assessTool({ name: 'read', arguments: { file_path: 'C:/ws/.env' } }, roots, artifacts)
  assert.equal(viaView.decision, 'ask', 'view of a workspace .env is an ask')
  assert.equal(viaRead.decision, 'ask', 'read of a workspace .env is an ask')
  assert.equal(viaView.classifierEligible, true, 'the view ask reaches the semantic reviewer')
  assert.equal(categorizeTool(view('C:/ws/.env'), roots), 'protected', 'and it keeps the protected label')
})

test('policy: the read-decision the view branch used to give up is now the documented one', () => {
  // "The criterion should NOT hold here" half — the gates must not swallow
  // ordinary reads. `.env.example` is a documentation template by design, and
  // ordinary source files are not protected metadata.
  const roots = rootsOf('C:/ws', 'C:/Users/u')
  for (const path of ['C:/ws/.env.example', 'C:/ws/src/app.ts', 'C:/ws/README.md']) {
    const result = assessTool(view(path), roots, artifacts)
    assert.equal(result.decision, 'allow', `${path} must stay readable through view`)
    assert.equal(result.classifierEligible, false, `${path} must not be sent to the reviewer`)
  }
})

test('policy: an out-of-workspace sensitive path through view is gated like read', () => {
  const roots = rootsOf('C:/ws', 'C:/Users/u')
  const target = 'C:/Users/u/.npmrc'
  const viaView = assessTool(view(target), roots, artifacts)
  const viaRead = assessTool({ name: 'read', arguments: { file_path: target } }, roots, artifacts)
  assert.notEqual(viaView.decision, 'allow', 'the view path must not silently read a sensitive file')
  assert.equal(viaView.decision, viaRead.decision, 'the two readers agree')
})
