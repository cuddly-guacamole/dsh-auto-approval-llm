/**
 * dsh-auto-approval-llm · PowerShell inline-colon deletion targets.
 *
 * The write heads lift the value out of `-Path:VALUE` (a fused flag/value word
 * the lexer cannot split), and the deletion head was left behind: a
 * `Remove-Item -Path:$HOME/.dsh/x` target stayed invisible, so the hard deny
 * decayed into a "deletion target could not be determined" ask. The category
 * plane still pins delete to a reject countdown, but the unconditional fuse
 * must see the target like it does for every other spelling.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell } from '../lib/auto/shell.js'

const roots = {
  workspace: 'C:/ws',
  home: 'C:/Users/u',
  dshHome: 'C:/Users/u/.dsh',
  tempRoots: ['C:/Temp'],
  trustedDirs: [],
  allowedDshSubpaths: [],
  maintenanceDshPaths: [],
  mode: 'standard',
}
const artifacts = { has: () => false }
const shell = (command) => assessShell(command, 'pwsh', roots, artifacts, undefined)

test('inline-colon deletion targets reach the destructive fuse', () => {
  for (const command of [
    'Remove-Item -Path:C:/Users/u/.ssh/authorized_keys',
    'Remove-Item -LiteralPath:C:/Users/u/.dsh/audit.jsonl',
    'Remove-Item -Path:C:/Users/u/.dsh/learning.json',
  ]) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must be hard-denied`)
    assert.equal(verdict.classifierEligible, false, `${command} must not be LLM-answerable`)
  }
})

test('the separated spelling keeps its verdict', () => {
  assert.equal(shell('Remove-Item -Path C:/Users/u/.ssh/authorized_keys').decision, 'deny')
})

test('a routine inline-colon target is not over-blocked', () => {
  for (const command of ['Remove-Item -Path:./out.txt', 'Remove-Item -Path:C:/Temp/scratch.bin']) {
    assert.notEqual(shell(command).decision, 'deny', `${command} stays not-denied`)
  }
})
