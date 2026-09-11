/**
 * dsh-auto-approval-llm · the credential-free Git read opening.
 *
 * Reading `.git/HEAD` and `.git/refs/**` is how an agent checks what it is
 * working on, but the workspace `.git` directory is protected project metadata,
 * so every such read reached the human as a question (observed: a read-only
 * subagent verifying a commit hit the approval panel for a `glob` of `.git`).
 *
 * The opening granted here is deliberately tiny — the symbolic HEAD and the ref
 * tree, which carry a ref name and commit ids and nothing else. Everything else
 * under `.git` stays gated, because it is not the same kind of object:
 *   - `.git/config` carries credential helpers and `url.*.insteadOf` rewrites;
 *   - `.git/hooks/**` are files git EXECUTES;
 *   - `.git/objects/**`, `.git/packed-refs` and `.gitmodules` stay protected.
 *
 * What is pinned:
 *   1. the predicate's exact surface, including traversal and out-of-workspace
 *      spellings that must NOT qualify;
 *   2. the policy plane and the category plane agree on every target. A drift
 *      is not cosmetic: a path the policy layer marks `classifierEligible` can
 *      still be pinned to an unanswerable countdown by the category layer's
 *      LOCKED set, which is the mismatch that made this class of ask
 *      impossible to resolve;
 *   3. the opening does NOT follow the mutating commands, and does not widen to
 *      the credential-bearing siblings (the direction where the criterion must
 *      not hold).
 *
 * Run: node --test tests/git-ref-read-allow.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { assessTool } from '../lib/auto/policy.js'
import { categorizeTool } from '../lib/auto/category.js'
import { isGitRefReadPath, isProtectedReadMetadata, isProtectedProjectPath } from '../lib/auto/paths.js'

const rootsOf = (workspace = 'C:/ws', home = 'C:/Users/u', mode = 'standard') => ({
  workspace, home, dshHome: join(home, '.dsh'),
  allowedDshSubpaths: [], trustedDirs: [], tempRoots: [], mode,
})
const artifacts = { has: () => false }
const read = (path) => ({ name: 'read', arguments: { file_path: path } })
const view = (path) => ({ name: 'str_replace_editor', arguments: { command: 'view', path } })
const shell = (command) => ({ name: 'bash', arguments: { command } })

/** Targets that are credential-free Git metadata a reader may open. */
const OPENED = ['C:/ws/.git/HEAD', 'C:/ws/.git/refs', 'C:/ws/.git/refs/heads/main', 'C:/ws/.git/refs/remotes/origin/HEAD']
/** Targets that must stay exactly as gated as before. */
const GATED = [
  'C:/ws/.git/config',
  'C:/ws/.git/hooks/pre-commit',
  'C:/ws/.git/objects/ab/cdef',
  'C:/ws/.git/packed-refs',
  'C:/ws/.git/modules/sub/HEAD',
  'C:/ws/.gitmodules',
  // A traversal spelling normalizes out of `.git/refs` and must not qualify.
  'C:/ws/.git/refs/../../.env',
  'C:/ws/.env',
  // A `.git` outside the workspace is not this opening's business at all.
  'C:/elsewhere/.git/HEAD',
]

// ── the predicate's surface ────────────────────────────────────────────────

test('predicate: exactly the symbolic HEAD and the refs tree qualify', () => {
  const roots = rootsOf()
  for (const target of OPENED) {
    assert.equal(isGitRefReadPath(target, roots), true, `${target} is credential-free Git metadata`)
    // The opening is a subtraction from the protected rule, never a bypass of it.
    assert.equal(isProtectedProjectPath(target, roots), true, `${target} is still protected metadata`)
    assert.equal(isProtectedReadMetadata(target, roots), false, `${target} is opened to readers`)
  }
})

test('predicate: the credential-bearing and executable siblings do not qualify', () => {
  const roots = rootsOf()
  for (const target of GATED) {
    assert.equal(isGitRefReadPath(target, roots), false, `${target} must not be opened`)
  }
  // The protected rule itself is untouched by this change.
  for (const target of ['C:/ws/.git/config', 'C:/ws/.git/hooks/pre-commit', 'C:/ws/.gitmodules', 'C:/ws/.env']) {
    assert.equal(isProtectedProjectPath(target, roots), true, `${target} stays protected`)
    assert.equal(isProtectedReadMetadata(target, roots), true, `${target} stays gated for readers`)
  }
})

// ── the two planes agree (the drift guard) ─────────────────────────────────

test('planes: readers agree on every opened target', () => {
  const roots = rootsOf()
  for (const target of OPENED) {
    const viaRead = assessTool(read(target), roots, artifacts)
    const viaView = assessTool(view(target), roots, artifacts)
    assert.equal(viaRead.decision, 'allow', `read ${target} must be a static allow`)
    assert.equal(viaRead.classifierEligible, false, `read ${target} must not reach the reviewer`)
    assert.equal(viaView.decision, 'allow', `view ${target} must agree with read (reader choice is not a boundary)`)
    // The category label is what the pre-execute wiring reads. Were it still
    // `protected` while the policy says allow, the LOCKED/unlocked directive
    // would force an ask and the opening would never take effect.
    assert.equal(categorizeTool(read(target), roots), 'readOnly', `read ${target} must not stay a protected-category call`)
    assert.equal(categorizeTool(view(target), roots), 'readOnly')
  }
})

test('planes: readers agree on every gated target', () => {
  const roots = rootsOf()
  for (const target of GATED) {
    const viaRead = assessTool(read(target), roots, artifacts)
    const viaView = assessTool(view(target), roots, artifacts)
    assert.notEqual(viaRead.decision, 'allow', `read ${target} must not be silently allowed`)
    assert.equal(viaView.decision, viaRead.decision, `view and read must agree on ${target}`)
    assert.equal(categorizeTool(read(target), roots), categorizeTool(view(target), roots), `categories must agree on ${target}`)
  }
  // The two files that define this opening's boundary keep their protected label.
  for (const target of ['C:/ws/.git/config', 'C:/ws/.git/hooks/pre-commit', 'C:/ws/.git/objects/ab/cdef']) {
    assert.equal(categorizeTool(read(target), roots), 'protected', `${target} must keep its protected label`)
  }
})

// ── shell: the read opening, and the directions it must not reach ──────────

test('shell: reading the refs is opened, writing or creating them is not', () => {
  const roots = rootsOf()
  const decision = (command) => assessTool(shell(command), roots, artifacts).decision
  const category = (command) => categorizeTool(shell(command), roots)

  for (const command of ['cat .git/HEAD', 'cat .git/refs/heads/main', 'cat .git/refs/remotes/origin/HEAD']) {
    assert.equal(decision(command), 'allow', `${command} must be a routine read`)
    assert.equal(category(command), 'readOnly', `${command} must not stay a protected-category call`)
  }
  // The direction where the criterion must NOT hold: the same paths reached
  // through a write, a creation or an in-place edit keep the protected gate.
  for (const command of [
    'cat .git/config',
    'ls .git/hooks',
    'printf x > .git/HEAD',
    'printf x > .git/config',
    'mkdir .git/refs/x',
    'touch .git/HEAD',
    'cp x .git/HEAD',
    'sed -i s/a/b/ .git/HEAD',
  ]) {
    assert.notEqual(decision(command), 'allow', `${command} must not be allowed`)
    assert.equal(category(command), 'protected', `${command} must keep the protected label`)
  }
})

// ── the structured writers ────────────────────────────────────────────────

test('writers: no mutating command gains the reader opening', () => {
  const roots = rootsOf()
  const mutating = (path) => [
    { name: 'write', arguments: { file_path: path, content: 'x' } },
    { name: 'edit', arguments: { file_path: path, old_string: 'a', new_string: 'b' } },
    { name: 'apply_patch', arguments: { patches: [{ file_path: path, hunks: [] }] } },
    { name: 'str_replace_editor', arguments: { command: 'create', path } },
    { name: 'str_replace_editor', arguments: { command: 'str_replace', path, old_str: 'a', new_str: 'b' } },
  ]
  for (const target of ['C:/ws/.git/HEAD', 'C:/ws/.git/refs/heads/main', 'C:/ws/.git/config']) {
    for (const exec of mutating(target)) {
      const result = assessTool(exec, roots, artifacts)
      assert.notEqual(result.decision, 'allow', `${exec.name} on ${target} must not be allowed`)
      assert.equal(categorizeTool(exec, roots), 'protected', `${exec.name} on ${target} must keep the protected label`)
    }
  }
})

// ── controls: ordinary work is untouched ──────────────────────────────────

test('control: ordinary reads and unrelated metadata keep their existing behaviour', () => {
  const roots = rootsOf()
  for (const path of ['C:/ws/src/app.ts', 'C:/ws/README.md', 'C:/ws/.env.example']) {
    assert.equal(assessTool(read(path), roots, artifacts).decision, 'allow', `${path} stays readable`)
  }
  assert.equal(assessTool(read('C:/ws/.env'), roots, artifacts).decision, 'ask', '.env stays gated')
  assert.equal(categorizeTool(read('C:/ws/.env'), roots), 'protected')
})
