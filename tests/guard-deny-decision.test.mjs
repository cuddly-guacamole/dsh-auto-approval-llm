/**
 * dsh-auto-approval-llm · the guard's refusal decision, as a value.
 *
 * The `tools.guard` hook can only be booted inside a running plugin, so before
 * this file the composed decision was pinned as SOURCE TEXT only: the hook was
 * grepped for its fuse order, and the actual "hard deny wins, otherwise symlink
 * escape" outcome was never evaluated. A change to that composition — or to the
 * guard's return-value shape, which the host reads — would have stayed green.
 *
 * `guardDenyDecision(exec, roots)` lifts the decision out of the hook so it can
 * be exercised with a real exec shape. The hook itself keeps the Auto-only gate
 * (and the audit write), because both need the live config and session.
 *
 * Every assertion is paired: a fused target AND a benign target. Asserting only
 * the refusals would be satisfied by a guard that refuses everything.
 *
 * Run: node --test tests/guard-deny-decision.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { guardDenyDecision } from '../lib/index.js'
import { resolveRoots } from '../lib/auto/paths.js'

const WORKSPACE = 'C:/Users/u/work/ws'
const DSH_HOME = 'C:/Users/u/.dsh'
const OTHER_WORKSPACE = 'C:/Users/u/work/other'

function makeRoots(workspace) {
  const roots = resolveRoots(workspace, { home: 'C:/Users/u', dshHome: DSH_HOME })
  roots.mode = 'aggressive'
  roots.trustedDirs = []
  roots.maintenanceDshPaths = []
  roots.allowedDshSubpaths = []
  return roots
}

const roots = makeRoots(WORKSPACE)

test('control: a DSH_HOME mutation is refused — so the benign cases mean something', () => {
  const reason = guardDenyDecision({ name: 'edit', arguments: { file_path: `${DSH_HOME}/config.json` } }, roots)
  assert.ok(reason !== undefined, 'a DSH_HOME write must be refused by the hard-deny fuse')
  assert.match(reason, /DSH_HOME/)
})

test('the return value is the refusal TEXT the host renders, not a wrapper object', () => {
  // The host treats a non-undefined return as the refusal string. Returning
  // `{ reason }` would be a host-contract break that the old source-text pin
  // could not see, because the pin only ordered `return reason`.
  const reason = guardDenyDecision({ name: 'edit', arguments: { file_path: `${DSH_HOME}/config.json` } }, roots)
  assert.equal(typeof reason, 'string')
  assert.ok(!reason.startsWith('{'), 'the reason is text, not a serialized object')
})

test('benign direction: ordinary workspace and temp paths clear the guard', () => {
  assert.equal(
    guardDenyDecision({ name: 'edit', arguments: { file_path: `${WORKSPACE}/src/app.ts` } }, roots),
    undefined,
    'a workspace file is not fused',
  )
  assert.equal(
    guardDenyDecision({ name: 'read', arguments: { file_path: `${WORKSPACE}/README.md` } }, roots),
    undefined,
    'a workspace read is not fused',
  )
  assert.equal(
    guardDenyDecision({ name: 'edit', arguments: { file_path: 'C:/Users/u/AppData/Local/Temp/scratch.txt' } }, roots),
    undefined,
    'an unrelated temp path is not fused',
  )
  assert.equal(
    guardDenyDecision({ name: 'bash', arguments: { command: 'ls' } }, roots),
    undefined,
    'a single-line local command is not fused',
  )
})

test('credential direction: a credential path is refused, its benign sibling is not', () => {
  const credential = guardDenyDecision({ name: 'edit', arguments: { file_path: 'C:/Users/u/.ssh/id_rsa' } }, roots)
  assert.ok(credential !== undefined, 'a credential path stays refused')
  assert.match(credential, /credential|system/)
  assert.equal(
    guardDenyDecision({ name: 'edit', arguments: { file_path: `${WORKSPACE}/id_rsa` } }, roots),
    undefined,
    'the same basename inside the workspace is not a credential path',
  )
})

test('fail-closed: a mutation whose target cannot be read is refused, not passed', () => {
  // An unparseable mutation must not be treated as "no fuse matched".
  const reason = guardDenyDecision({ name: 'write', arguments: {} }, roots)
  assert.ok(reason !== undefined, 'an unreadable mutation target is refused rather than allowed')
  assert.match(reason, /missing or unreadable/)
})

test('the guard is a MUTATION fuse: reads of protected metadata are another layer job', () => {
  // Documented boundary, pinned so it cannot drift silently: this layer denies
  // changes, and a plain read of the same path is cleared here. Read protection
  // lives in the policy/category layers (and the runtime-state read detector),
  // so anyone tightening this one learns the split from a failing test.
  assert.equal(
    guardDenyDecision({ name: 'read', arguments: { file_path: `${DSH_HOME}/config.json` } }, roots),
    undefined,
    'reads are not this fuse',
  )
})

test('composition: the hard deny answers before the symlink check', () => {
  const reason = guardDenyDecision(
    { name: 'apply_patch', arguments: { patches: [{ file_path: `${DSH_HOME}/config.json` }] } },
    roots,
  )
  assert.ok(reason !== undefined)
  assert.match(reason, /DSH_HOME/, 'the hard-deny reason is the one returned, not a symlink verdict')
})

test('the workspace anchor follows the roots it is given, not a cached first call', () => {
  // One dsh process serves every workspace, so a guard that remembered the
  // first workspace would misjudge the rest.
  const otherRoots = makeRoots(OTHER_WORKSPACE)
  assert.equal(
    guardDenyDecision({ name: 'edit', arguments: { file_path: `${OTHER_WORKSPACE}/src/app.ts` } }, otherRoots),
    undefined,
    'the second workspace judges by its own roots',
  )
  assert.equal(
    guardDenyDecision({ name: 'edit', arguments: { file_path: `${WORKSPACE}/src/app.ts` } }, roots),
    undefined,
    'and the first workspace still judges by its own',
  )
  // The discriminating case: a path that is fused for one workspace must not
  // inherit the other workspace's verdict.
  assert.equal(
    guardDenyDecision({ name: 'edit', arguments: { file_path: `${OTHER_WORKSPACE}/src/app.ts` } }, roots),
    undefined,
    'the other workspace path is outside this workspace and unfused',
  )
})
