/**
 * A nested shell interpreter body must not hide an operand or identity write.
 *
 * The guard recursed into a nested interpreter only through the assess plane,
 * and only one level: `hardDenyShellReason` never consulted `nestedExecution`,
 * `shellPlaneOf` handed `pwsh`/`cmd` a `powershell` plane the pwsh operand
 * branch does not recognize, the interpreter flag table missed PowerShell's
 * real `-Command` spelling, and an identity cmdlet's `-Target` operand was
 * never extracted. A `bash`-wrapped `pwsh New-Item -ItemType SymbolicLink
 * -Target:lib` therefore reached llm-allow and really created the link.
 *
 * Pins both directions: the identity write is hard-denied behind every
 * spelling, and ordinary nested work stays reviewable.
 *
 * Run: node --test tests/audit-ak-nested-interpreter-identity.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { hardDenyShellReason, assessShell } from '../lib/auto/shell.js'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'

const roots = {
  workspace: 'C:/ws',
  home: 'C:/Users/u',
  dshHome: 'C:/Users/u/.dsh',
  tempRoots: ['C:/Temp'],
  devZoneRoots: ['C:/ws'],
  allowedDshSubpaths: ['C:/ws'],
  maintenanceDshPaths: [],
  trustedDirs: [],
  mode: 'aggressive',
}
const registry = new ArtifactRegistry()
const owner = { id: 'session-a' }
const verdict = (command, shell = 'bash') => assessShell(command, shell, roots, registry, owner)
const guard = (command, shell = 'bash') => hardDenyShellReason(command, shell, roots)
const N22 = `pwsh -NoProfile -Command "New-Item -ItemType SymbolicLink -Path:.agents/ak-live -Target:lib"`

test('a pwsh identity write behind bash is hard-denied', () => {
  const v = verdict(`bash -c '${N22}'`)
  assert.equal(v.decision, 'deny', 'the wrapped symlink creation must be hard-denied')
  assert.equal(v.classifierEligible, false)
})

test('the direct pwsh spelling is hard-denied too', () => {
  const v = verdict(N22, 'pwsh')
  assert.equal(v.decision, 'deny')
  assert.equal(v.classifierEligible, false)
  assert.notEqual(guard(N22, 'pwsh'), undefined)
})

test('cmd mklink link and target operands are judged', () => {
  const v = verdict('cmd /c mklink .agents/ak-live lib')
  assert.equal(v.decision, 'deny', 'mklink must not hide its identity target')
  assert.equal(v.classifierEligible, false)
})

test('a pwsh content write into the plugin lib is hard-denied behind bash', () => {
  const v = verdict(`bash -c 'pwsh -NoProfile -Command "Set-Content -Path:lib/evil.js -Value:x"'`)
  assert.equal(v.decision, 'deny')
})

test('ordinary nested work stays reviewable', () => {
  for (const command of [
    'bash -c "cp a.txt /tmp/x"',
    'bash -c "printf a > /tmp/x"',
    'bash -c "sort -o /tmp/x in.txt"',
  ]) {
    assert.notEqual(verdict(command).decision, 'deny', command)
  }
  const echo = verdict('bash -c "echo hi"')
  assert.notEqual(echo.decision, 'deny')
  assert.equal(echo.classifierEligible, true)
})

test('read-only pwsh keeps its previous tier', () => {
  const direct = verdict('pwsh -NoProfile -Command "Get-ChildItem"', 'pwsh')
  assert.notEqual(direct.decision, 'deny')
  const wrapped = verdict(`bash -c 'pwsh -NoProfile -Command "Get-ChildItem"'`)
  assert.notEqual(wrapped.decision, 'deny')
})

test('an encoded PowerShell program is refused, not reviewed', () => {
  const v = verdict(`bash -c 'pwsh -EncodedCommand ZgBvAG8A'`)
  assert.equal(v.decision, 'deny')
  assert.equal(v.classifierEligible, false)
})

test('an abbreviated identity flag is judged like the full spelling', () => {
  const v = verdict(`bash -c 'pwsh -NoProfile -Command "New-Item -ItemType SymbolicLink -Path:.agents/ak-live -Tar:lib"'`)
  assert.equal(v.decision, 'deny')
})

test('a nested interpreter beyond the depth limit fails closed', () => {
  const v = verdict("eval eval eval eval 'echo hi'")
  assert.equal(v.decision, 'deny')
  assert.equal(v.classifierEligible, false)
})
