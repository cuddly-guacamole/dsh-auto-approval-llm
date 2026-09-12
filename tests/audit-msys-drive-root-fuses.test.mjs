/**
 * Drive-root spellings of one Windows location must reach the same destructive
 * fuse. MSYS/Git Bash spells the drive root `/c` (and `//c`); win32 spells it
 * `C:\`; a glob over the root (`C:\*`, `C:/*`, `/c/*`) is the same target one
 * level down. Before this contract, only the two spellings that survived
 * normalization as an absolute path (`C:\`, `C:/`) were hard-denied: `/c` and
 * `//c` were translated to a drive-relative `C:` / a driveless `\c` and
 * resolved to the workspace, and the glob forms were read as the literal
 * `c:\*` — so `rm -rf /c` reached the classifier as a routine ask.
 *
 * Pins the end-to-end shell fuse and the pure translation, plus the
 * no-over-block controls for ordinary MSYS paths, UNC spellings and a normal
 * drive-rooted file below the root.
 * Run: node --test tests/audit-msys-drive-root-fuses.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalizeMsysPath, hardDestructiveTargetReason, normalizePath } from '../lib/auto/paths.js'
import { hardDenyShellReason, assessShell } from '../lib/auto/shell.js'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'

const WIN = { skip: process.platform !== 'win32' }
const roots = {
  workspace: 'C:/ws',
  home: 'C:/Users/u',
  dshHome: 'C:/Users/u/.dsh',
  tempRoots: ['C:/Temp'],
  allowedDshSubpaths: [],
}

test('bare drive spellings translate to the drive root, not a relative path', WIN, () => {
  assert.equal(canonicalizeMsysPath('/c', 'win32'), 'C:\\')
  assert.equal(canonicalizeMsysPath('/C', 'win32'), 'C:\\')
  assert.equal(canonicalizeMsysPath('//c', 'win32'), 'C:\\')
  assert.equal(normalizePath('/c', 'C:/ws'), 'c:\\')
  assert.equal(normalizePath('//c', 'C:/ws'), 'c:\\')
})

test('every drive-root spelling is hard-denied by the shell fuse', WIN, () => {
  for (const command of [
    'rm -rf /c',
    'rm -rf /C',
    'rm -rf //c',
    'rm -rf /c/',
    'rm -rf /c/*',
    'rm -rf /C/*',
    'rm -rf C:\\*',
    'rm -rf C:/*',
    'rm -rf C:\\',
    'rm -rf C:/',
  ]) {
    const reason = hardDenyShellReason(command, 'bash', roots)
    assert.ok(reason !== undefined, `${command} must be hard-denied`)
    assert.match(reason, /filesystem root|drive-relative/, `${command} reason: ${reason}`)
    const assessment = assessShell(command, 'bash', roots, new ArtifactRegistry(), undefined)
    assert.equal(assessment.decision, 'deny', `${command} must deny, got ${assessment.decision}`)
    assert.equal(assessment.classifierEligible, false, `${command} must not reach the classifier`)
  }
})

test('the destructive-target fuse names the drive root for the glob spellings', WIN, () => {
  for (const target of ['/c', '/C', '//c', 'C:\\*', 'C:/*', '/c/*']) {
    const reason = hardDestructiveTargetReason(target, roots)
    assert.ok(reason !== undefined, `${target} must be fused`)
  }
})

test('ordinary MSYS, UNC and below-root spellings are not over-blocked', WIN, () => {
  assert.equal(canonicalizeMsysPath('/c/Users/u/Desktop/notes.txt', 'win32'), 'C:/Users/u/Desktop/notes.txt')
  assert.equal(canonicalizeMsysPath('//server/share/x', 'win32'), '\\\\server\\share\\x')
  assert.equal(canonicalizeMsysPath('/tmp/x', 'win32'), '/tmp/x')
  assert.equal(canonicalizeMsysPath('/cc/foo', 'win32'), '/cc/foo')
  assert.equal(hardDenyShellReason('printf x > /c/Users/u/Desktop/notes.txt', 'bash', roots), undefined)
  assert.equal(hardDenyShellReason('rm -rf C:/ws/build', 'bash', roots), undefined)
  assert.equal(hardDestructiveTargetReason('C:/ws/build', roots), undefined)
  assert.equal(hardDestructiveTargetReason('//server/share/x', roots), undefined)
})

test('a glob over a normal directory keeps its ordinary treatment', WIN, () => {
  assert.equal(hardDenyShellReason('rm -rf /c/Users/u/Desktop/tmp/*', 'bash', roots), undefined)
  assert.equal(hardDenyShellReason('rm -rf C:/ws/build/*', 'bash', roots), undefined)
})
