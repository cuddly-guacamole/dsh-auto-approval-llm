/**
 * Maintenance batch M1 · a local rsync destination is a file write.
 *
 * rsync was classified solely by its name, so every invocation landed in
 * `networkExec` — a category the aggressive builtin maps to the `auto`
 * directive. A local mirror (`rsync -a src/ D:/mirror/`) was therefore silently
 * allowed with no ask, no reviewer and no verdict naming the write, while the
 * same copy through `cp` was judged as a write. The destination operand now
 * decides: a local path enters the write-vector family (guard face + label),
 * and a remote destination keeps the network classification.
 *
 * The drive-letter case is the reason the remote predicate runs after the
 * Windows-path check: `C:/ws` contains a colon and would otherwise read as
 * `host:path`. Uploads (remote destination) are pinned here as unchanged — a
 * later batch must narrow them deliberately, not inherit a silent widening.
 *
 * Run: node --test tests/maint-m1-rsync-category.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell, hardDenyShellReason } from '../lib/auto/shell.js'
import { categorizeCommand, categoryDirective } from '../lib/auto/category.js'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'

const HOME = 'C:/Users/u'
const roots = {
  workspace: 'C:/ws',
  home: HOME,
  dshHome: `${HOME}/.dsh`,
  tempRoots: [],
  allowedDshSubpaths: [],
  trustedDirs: [],
  mode: 'aggressive',
}
const owner = { id: 'session-m1-rsync' }
const cfg = { categoryPolicy: {}, categoryMode: 'aggressive' }

const hardDeny = (command) => hardDenyShellReason(command, 'bash', roots)
const categoryOf = (command) => categorizeCommand(command, 'bash', roots, cfg).category
/** The directive the category layer derives for this line under aggressive defaults. */
const directiveOf = (command) => categoryDirective(cfg, categoryOf(command), { decision: 'ask', classifierEligible: true })
const assessmentOf = (command) => assessShell(command, 'bash', roots, new ArtifactRegistry(), owner)

test('a local mirror is labelled as a write and no longer derives the auto directive', () => {
  const command = 'rsync -a C:/ws/ D:/outside/mirror/'
  assert.equal(categoryOf(command), 'fileEdit')
  assert.notEqual(directiveOf(command), 'auto', 'a local write must never ride the aggressive network auto')
  assert.equal(assessmentOf(command).classifierEligible, false)
})

test('a Windows drive destination is not mistaken for a remote host:path', () => {
  assert.equal(categoryOf('rsync -a C:/ws/ C:/ws/backup/'), 'fileEdit')
  assert.equal(categoryOf('rsync -a C:/ws/ D:/mirror/'), 'fileEdit')
})

test('a local destination inside the plugin state tree is hard-denied', () => {
  assert.match(String(hardDeny(`rsync -a C:/ws/ ${HOME}/.dsh/mirror/`)), /DSH_HOME/)
})

test('a local destination carrying a protected name is labelled protected', () => {
  assert.equal(categoryOf(`rsync -a C:/ws/ ${HOME}/.npmrc`), 'protected')
})

test('a workspace-to-workspace mirror stays allowed and unfused', () => {
  assert.equal(hardDeny('rsync -a C:/ws/ C:/ws/backup/'), undefined)
})

test('read-only and dry-run spellings are not booked as writes', () => {
  assert.equal(categoryOf('rsync --version'), 'networkExec')
  assert.equal(categoryOf('rsync -n -a C:/ws/ D:/mirror/'), 'networkExec', 'a dry run writes nothing')
  assert.equal(hardDeny(`rsync -n -a C:/ws/ ${HOME}/.dsh/mirror/`), undefined)
})

test('an upload keeps the network classification (pinned residual)', () => {
  // Registered residual: the remote destination is the write face and the
  // exfiltration fuse does not name rsync. Pinned so narrowing it later is a
  // deliberate change with a red test.
  assert.equal(categoryOf('rsync -a C:/ws/ user@host:/dest/'), 'networkExec')
  assert.equal(directiveOf('rsync -a C:/ws/ user@host:/dest/'), 'auto')
})
