/**
 * The privilege fuse has to see the executable-suffix spelling of the same
 * program.
 *
 * Windows ships `sudo.exe` and `runas.exe` inside System32, and `sudo.exe`
 * resolves to the same elevation path as `sudo`; `gsudo.exe`, `doas.exe`,
 * `pkexec.exe` and `runas.exe` are the same form for their publishers. The
 * three owners that decide escalation (the whole-line fuse, the per-segment set
 * in the shell plane, and the category plane) each matched the bare spelling
 * only, so `sudo.exe ls` degraded from "hard refuse, no panel" to "unrecognized
 * command → independent classification", which an unattended countdown can
 * settle by running it.
 *
 * Pins all three owners, in both planes, and keeps the direction that must not
 * change: the program's NAME as data (an argument, a file name, a message) is
 * still not an escalation.
 *
 * Run: node --test tests/audit-r6-privilege-exe-spelling.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assessShell, hardDenyShellReason } from '../lib/auto/shell.js'
import { categorizeTool } from '../lib/auto/category.js'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'

const roots = {
  workspace: 'C:/ws',
  home: 'C:/Users/u',
  dshHome: 'C:/Users/u/.dsh',
  tempRoots: ['C:/Temp'],
  allowedDshSubpaths: ['C:/ws'],
  maintenanceDshPaths: [],
  trustedDirs: [],
  mode: 'aggressive',
}
const registry = new ArtifactRegistry()
const owner = { id: 'session-a' }
const shell = (command) => assessShell(command, 'bash', roots, registry, owner)
const category = (command) => categorizeTool({ name: 'bash', arguments: { command } }, roots)

const REFUSED = [
  'sudo.exe ls',
  'sudo.exe --version',
  'gsudo.exe ls',
  'doas.exe ls',
  'pkexec.exe ls',
  'runas.exe /user:a cmd',
  'su.exe root',
  'SUDO.EXE ls',
  'echo hi; sudo.exe ls',
  '(sudo.exe ls)',
  '{ sudo.exe ls; }',
  'stdbuf -o0 sudo.exe ls',
]

test('every executable-suffix spelling of a privilege command is refused outright', () => {
  for (const command of REFUSED) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command}: expected deny, got ${verdict.decision} (${verdict.reason})`)
    assert.equal(verdict.classifierEligible, false, `${command}: must not be classifier-answerable`)
    assert.match(verdict.reason, /privilege escalation/, `${command}: reason must name the privilege fuse`)
  }
})

test('the category plane labels the same spelling as privilege', () => {
  // The category plane does not decode grouping (`(cmd)` / `{ cmd; }` are
  // opaque to it), so this pins the segment shapes it does classify. The
  // grouped spellings are already refused by the shell plane (test 1).
  for (const command of REFUSED.filter(text => !/[({]/.test(text))) {
    assert.equal(category(command), 'privilege', command)
  }
})

test('the bare spellings keep their existing verdicts', () => {
  for (const command of ['sudo ls', 'gsudo ls', 'runas /user:a cmd', 'pkexec ls', 'doas ls', 'su root']) {
    assert.equal(shell(command).decision, 'deny', command)
    assert.equal(category(command), 'privilege', command)
  }
})

test('the program name as data is still not an escalation', () => {
  for (const command of ['echo runas.exe please', 'echo "sudo.exe"', 'cat sudo.exe.log']) {
    assert.notEqual(shell(command).decision, 'deny', `${command} must not be refused`)
  }
})

test('the whole-line fuse keeps the suffix optional without losing the name boundary', () => {
  const source = readFileSync(new URL('../src/auto/shell.ts', import.meta.url), 'utf8')
  const line = source.split('\n').find(text => text.includes('const PRIVILEGE_COMMAND_PATTERN'))
  assert.ok(line !== undefined, 'the whole-line privilege pattern must exist')
  assert.match(line, /PRIVILEGE_COMMANDS/, 'the pattern must stay derived from the name set')
  assert.equal(hardDenyShellReason('sudo.exe ls', 'bash', roots), 'privilege escalation is not permitted by auto mode')
})
