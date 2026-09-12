/**
 * MSYS/Git-Bash spellings of a Windows location must reach the same fuses as the
 * win32 spelling. The agent's shell is Git Bash, so `$HOME` reaches the model as
 * `/c/Users/…`; that style mismatch made `isWithin` (and with it the
 * DSH_HOME / credential / plugin-zone fuses) answer "not inside" for a target it
 * hard-denied when spelled `C:\…`.
 *
 * Pins the platform gate (a POSIX host keeps `/c/…` as a real path), the pure
 * translation, and the end-to-end effect on the shell fuses.
 * Run: node --test tests/audit-msys-spelling-fuses.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { canonicalizeMsysPath, isWithin, normalizePath } from '../lib/auto/paths.js'
import { hardDenyShellReason } from '../lib/auto/shell.js'

const WIN = { skip: process.platform !== 'win32' }

test('the translation is platform-gated: POSIX hosts keep `/c/...` verbatim', () => {
  assert.equal(canonicalizeMsysPath('/c/Users/u/.dsh', 'linux'), '/c/Users/u/.dsh')
  assert.equal(canonicalizeMsysPath('/c/Users/u/.dsh', 'darwin'), '/c/Users/u/.dsh')
  assert.equal(canonicalizeMsysPath('/c/Users/u/.dsh', 'win32'), 'C:/Users/u/.dsh')
  assert.equal(canonicalizeMsysPath('/c', 'win32'), 'C:\\')
  assert.equal(canonicalizeMsysPath('//server/share/x', 'win32'), '\\\\server\\share\\x')
  // Non-drive posix paths and near-miss shapes stay untouched.
  assert.equal(canonicalizeMsysPath('/tmp/x', 'win32'), '/tmp/x')
  assert.equal(canonicalizeMsysPath('/cc/foo', 'win32'), '/cc/foo')
  assert.equal(canonicalizeMsysPath('C:/x', 'win32'), 'C:/x')
})

test('a posix-spelled target is inside a win32 root (win32 only)', WIN, () => {
  assert.equal(isWithin('C:/Users/u/.dsh', '/c/Users/u/.dsh/sub'), true)
  assert.equal(normalizePath('/c/Users/u/.dsh/sub', 'C:/ws'), 'c:\\users\\u\\.dsh\\sub')
})

test('the shell DSH_HOME fuse fires for the posix spelling too (win32 only)', WIN, () => {
  const roots = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: ['C:/Temp'], allowedDshSubpaths: [] }
  const deny = (command) => hardDenyShellReason(command, 'bash', roots)
  for (const command of [
    'printf x > /c/Users/u/.dsh/evil.txt',
    'rm -rf /c/Users/u/.dsh',
    'tee -a /c/Users/u/.dsh/history.jsonl',
  ]) {
    const reason = deny(command)
    assert.ok(reason !== undefined, `${command} must be hard-denied`)
    assert.match(reason, /DSH_HOME|runtime state|destructive/, `${command} reason: ${reason}`)
  }
  // The win32 spelling of the same targets must agree (no new divergence).
  assert.ok(deny('printf x > C:/Users/u/.dsh/evil.txt') !== undefined)
})

test('the plugin-zone fuse fires for the posix spelling of this repo (win32 only)', WIN, () => {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
  const msys = `/${repoRoot[0].toLowerCase()}${repoRoot.slice(2)}`
  const roots = { workspace: repoRoot, home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: [], allowedDshSubpaths: [repoRoot] }
  const reason = hardDenyShellReason(`printf x > ${msys}/lib/index.js`, 'bash', roots)
  assert.ok(reason !== undefined, 'a posix-spelled write into lib/ must be hard-denied')
  assert.match(reason, /execution code/)
})

test('an ordinary posix path keeps its ask/allow treatment (no over-block)', WIN, () => {
  const roots = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: ['C:/Temp'], allowedDshSubpaths: [] }
  assert.equal(hardDenyShellReason('printf x > /c/Users/u/Desktop/notes.txt', 'bash', roots), undefined)
})
