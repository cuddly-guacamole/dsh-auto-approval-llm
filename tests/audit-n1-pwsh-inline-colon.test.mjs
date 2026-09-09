/**
 * dsh-auto-approval-llm · pwsh inline colon write-operand contract.
 *
 * Fix: the pwsh write-operand extraction in the hard-deny path only matched
 * separated flag spellings (`-Path VALUE`). PowerShell's inline colon form
 * (`-Path:VALUE`, `-FilePath:VALUE`, `-Destination:VALUE`) fuses flag and
 * value into one `-`-leading word, which the old matcher skipped entirely, so
 * `set-content -Path:$HOME/.dsh/audit.jsonl …` bypassed the unconditional
 * DSH_HOME / runtime-state / critical hard denies and decayed into an
 * LLM-answerable ask. The fused form now lifts the value and inherits the
 * source word's dynamic/glob markers, matching the separated spelling.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell } from '../lib/auto/shell.js'

const plainRoots = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: ['C:/Temp'], allowedDshSubpaths: [] }
const artifacts = { has: () => false }
const shell = (command, roots = plainRoots) => assessShell(command, 'pwsh', roots, artifacts, undefined)

// ── inline colon $HOME destinations: unconditional hard deny ───────────────
test('assessShell(pwsh): inline colon -Path:/ -FilePath:/ -Destination: $HOME targets hard-deny', () => {
  for (const command of [
    'Set-Content -Path:$HOME/.ssh/authorized_keys -Value x',
    'Set-Content -Path:$HOME/.dsh/audit.jsonl -Value x',
    'Add-Content -Path:$HOME/.dsh/history.jsonl -Value x',
    'Out-File -FilePath:$HOME/.dsh/audit.jsonl -InputObject x',
    'New-Item -Path:$HOME/.ssh/evil.ps1 -ItemType File',
    'Copy-Item C:/ws/src.txt -Destination:$HOME/.dsh/audit.jsonl',
    'Move-Item C:/ws/src.txt -Destination:$HOME/.ssh/authorized_keys',
    'Set-Content -LiteralPath:$HOME/.dsh/learning.json -Value x',
  ]) {
    const r = shell(command)
    assert.equal(r.decision, 'deny', `${command} must be hard-denied`)
    assert.equal(r.classifierEligible, false, `${command} must not degrade into an LLM-answerable ask`)
  }
})

// ── inline colon non-home dynamic destinations: still lose any static allow ─
test('assessShell(pwsh): inline colon dynamic non-home target never statically allows', () => {
  const r = shell('Set-Content -Path:$DEST -Value x')
  assert.notEqual(r.decision, 'allow', 'dynamic target must not be statically allowed')
})

// ── separated spellings keep prior behavior (parity, no regression) ─────────
test('assessShell(pwsh): separated -Path/-Destination spellings stay hard-denied on $HOME', () => {
  for (const command of [
    'Set-Content -Path "$HOME/.ssh/authorized_keys" -Value x',
    'Out-File -FilePath "$HOME/.dsh/audit.jsonl" -InputObject x',
  ]) {
    const r = shell(command)
    assert.equal(r.decision, 'deny', `${command} must stay hard-denied`)
  }
})

// ── ordinary workspace writes stay outside the unconditional deny ───────────
test('assessShell(pwsh): in-workspace inline colon targets are not hard-denied', () => {
  const r = shell('Set-Content -Path:C:/ws/out.txt -Value hi')
  assert.notEqual(r.decision, 'deny', 'a workspace content write must not be hard-denied')
  assert.equal(r.classifierEligible, true, 'a workspace pwsh write is judged by semantic review')
})
