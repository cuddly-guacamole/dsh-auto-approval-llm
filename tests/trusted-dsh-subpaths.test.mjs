/**
 * trustedDshSubpaths — opt-in DSH_HOME write openings.
 *
 * DSH_HOME is fenced by one predicate (hardDestructiveTargetReason) consumed
 * from four mutation gates: tools.guard, policy write/edit, apply_patch and
 * str_replace_editor. The openings join `allowedDshSubpaths`, so all four honour
 * them without a second code path. These tests pin that reach, the fail-closed
 * default, and the two ways an opening must NOT widen: to sibling trees, and to
 * the plugin's own runtime state.
 *
 * Paths use forward slashes on purpose: isWithin/normalizePath fold both sides,
 * so the semantics are identical while the fixtures stay free of backslash
 * escaping hazards. Run: node --test tests/trusted-dsh-subpaths.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessTool, hardDenyReason } from '../lib/auto/policy.js'
import { assessShell, hardDenyShellReason } from '../lib/auto/shell.js'

const HOME = 'C:/Users/u'
const DSH_HOME = 'C:/Users/u/.dsh'
const PLUGIN_ZONE = 'C:/Users/u/.dsh/plugins/dsh-auto-approval-llm'
const SKILL = 'C:/Users/u/.dsh/skills/foo/SKILL.md'
const artifacts = { has: () => false, plan: () => {} }

/** roots as rootsFor() builds them: plugin zone always, openings appended. */
const dshRoots = (openings = []) => ({
  workspace: PLUGIN_ZONE,
  home: HOME,
  dshHome: DSH_HOME,
  tempRoots: [],
  trustedDirs: [],
  allowedDshSubpaths: [PLUGIN_ZONE, ...openings],
  mode: 'standard',
})

const mutationVectors = (target) => [
  { name: 'edit', arguments: { file_path: target } },
  { name: 'write', arguments: { file_path: target } },
  { name: 'apply_patch', arguments: { patches: [{ file_path: target }] } },
  { name: 'str_replace_editor', arguments: { command: 'create', path: target } },
]

test('default (no openings): every mutation vector stays hard-denied in DSH_HOME', () => {
  const roots = dshRoots()
  for (const exec of mutationVectors(SKILL)) {
    assert.match(
      hardDenyReason(exec, roots) ?? '',
      /DSH_HOME path/,
      `${exec.name} must be hard-denied while no opening is configured`,
    )
  }
})

test('a named opening clears the fence for all four mutation vectors', () => {
  const roots = dshRoots(['C:/Users/u/.dsh/skills'])
  for (const exec of mutationVectors(SKILL)) {
    assert.equal(hardDenyReason(exec, roots), undefined, `${exec.name} must clear the guard`)
    const assessed = assessTool(exec, roots, artifacts)
    assert.equal(assessed.decision, 'allow', `${exec.name} must be allowed inside the opening`)
    assert.match(assessed.reason, /trusted DSH_HOME path/)
  }
})

test('an opening covers its own subtree but never a sibling or a prefix match', () => {
  const roots = dshRoots(['C:/Users/u/.dsh/skills'])
  // Deeper inside the opening: allowed.
  assert.equal(hardDenyReason({ name: 'edit', arguments: { file_path: 'C:/Users/u/.dsh/skills/a/b/c.md' } }, roots), undefined)
  // Siblings and prefix lookalikes: still fenced.
  for (const target of [
    'C:/Users/u/.dsh/cordis.patch.yml',
    'C:/Users/u/.dsh/sessions/s.jsonl',
    'C:/Users/u/.dsh/credentials.json',
    'C:/Users/u/.dsh/skills-evil/x.md',
  ]) {
    assert.match(
      hardDenyReason({ name: 'edit', arguments: { file_path: target } }, roots) ?? '',
      /DSH_HOME path/,
      `${target} must stay denied`,
    )
  }
})

test('plugin runtime state stays denied even while a DSH_HOME tree is open', () => {
  // Orthogonal fence: history/audit/learning are the audit trail, so they must
  // not become writable because some other DSH_HOME subtree was opened.
  const roots = dshRoots(['C:/Users/u/.dsh/skills'])
  for (const base of ['history.jsonl', 'audit.jsonl', 'learning.json', 'approval-debug.jsonl']) {
    const assessed = assessTool({ name: 'edit', arguments: { file_path: `${PLUGIN_ZONE}/${base}` } }, roots, artifacts)
    assert.equal(assessed.decision, 'deny', `${base} must stay denied`)
    assert.match(assessed.reason, /plugin runtime state file/)
  }
  // Ordinary plugin sources stay writable (the dev zone still works).
  const source = assessTool({ name: 'edit', arguments: { file_path: `${PLUGIN_ZONE}/src/index.ts` } }, roots, artifacts)
  assert.equal(source.decision, 'allow')
})

test('an opening does not grant deletion or reach outside DSH_HOME', () => {
  const roots = dshRoots(['C:/Users/u/.dsh/skills'])
  // The fence this key opens is the DSH_HOME one; a critical tree outside it is
  // governed by its own predicate and must stay denied.
  assert.match(
    hardDenyReason({ name: 'edit', arguments: { file_path: `${HOME}/.ssh/id_rsa` } }, roots) ?? '',
    /critical path/,
    'a credential tree is not reachable through a DSH_HOME opening',
  )
  // Deletion of an opened path must not inherit the WRITE opening: the
  // destructive-name fuse routes it to human review instead (measured: 'ask'
  // with "registered tool name indicates a destructive operation").
  const removal = assessTool({ name: 'delete_file', arguments: { path: SKILL } }, roots, artifacts)
  assert.equal(removal.decision, 'ask', 'deletion is reviewed, not allowed by the write opening')
  assert.match(removal.reason, /destructive operation/)
})

// ── shell 写 DSH_HOME 收口：开口不影响 shell 向量（结构化工具才享用） ──

test('shell writes to DSH_HOME stay hard-denied even inside an opening', () => {
  const roots = dshRoots(['C:/Users/u/.dsh/skills'])
  for (const cmd of [
    `cp /tmp/x ${SKILL}`,
    `tee ${SKILL}`,
    `sed -i s/a/b/ ${SKILL}`,
    `mkdir -p C:/Users/u/.dsh/skills/new`,
    `touch C:/Users/u/.dsh/skills/foo.txt`,
  ]) {
    assert.match(hardDenyShellReason(cmd, 'bash', roots) ?? '', /DSH_HOME/, `${cmd} inside an opening stays hard-denied`)
  }
  assert.match(hardDenyShellReason(`echo hi > ${SKILL}`, 'bash', roots) ?? '', /DSH_HOME/, 'echo > inside an opening stays hard-denied')
})

test('shell writes outside DSH_HOME are not denied by this fuse', () => {
  const roots = dshRoots(['C:/Users/u/.dsh/skills'])
  for (const cmd of [`cp /tmp/x /tmp/y`, `echo hi > /tmp/out.txt`]) {
    const reason = hardDenyShellReason(cmd, 'bash', roots)
    if (reason) assert.ok(!reason.includes('DSH_HOME'), `${cmd} must not be denied for DSH_HOME`)
  }
})
