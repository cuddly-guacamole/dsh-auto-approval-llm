/**
 * Maintenance batch M1 · an interpreter spelled with `.exe` is the same boundary.
 *
 * The interpreter sets were matched against the command name verbatim, so
 * `python.exe -c …` and `node.exe -e …` (both real on a Windows box) fell outside
 * the nested-execution boundary that the same programs without the suffix hit:
 * the category decayed from privilege to unknown with the reviewer eligible to
 * answer. The privilege plane already normalized the suffix with its own
 * `commandNameWithoutExe`, so one spelling of the same program carried two
 * different meanings.
 *
 * The restriction-side lists (nested interpreters, nested shells, stdin-script
 * interpreters, inline probes) are now consulted through that normalization in
 * both planes. Normalization is deliberately NOT applied to allow/build lists
 * (`python.exe --version` therefore stays outside the routine build probe): the
 * batch tightens, and normalizing an allow list would widen it. That asymmetry
 * is pinned here so it stays a decision rather than an accident.
 *
 * Run: node --test tests/maint-m1-exe-interpreter.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell } from '../lib/auto/shell.js'
import { categorizeCommand } from '../lib/auto/category.js'
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
const owner = { id: 'session-m1-exe' }
const cfg = { categoryPolicy: {}, categoryMode: 'aggressive' }

const categoryOf = (command) => categorizeCommand(command, 'bash', roots, cfg).category
const assessmentOf = (command) => assessShell(command, 'bash', roots, new ArtifactRegistry(), owner)

const PAIRS = [
  ['python -c "print(1)"', 'python.exe -c "print(1)"'],
  ['node -e "1"', 'node.exe -e "1"'],
  ['cmd /c whoami', 'cmd.exe /c whoami'],
  ['pwsh -c "ls"', 'pwsh.exe -c "ls"'],
]

test('an interpreter is a nested-execution boundary under both spellings', () => {
  for (const [plain, exe] of PAIRS) {
    assert.equal(categoryOf(plain), 'privilege', `${plain} must stay a nested-execution boundary`)
    assert.equal(categoryOf(exe), categoryOf(plain), `${exe} must classify like ${plain}`)
  }
})

test('the suffixed spelling is never more permissive than the plain one', () => {
  // The restriction lists are normalized; the allow-side routine-probe list is
  // deliberately NOT (normalizing it would widen a static allow). So the suffixed
  // spelling may come out STRICTER than the plain one, never more permissive —
  // and the category label agrees either way.
  for (const [plain, exe] of PAIRS) {
    const plainAssessment = assessmentOf(plain)
    const exeAssessment = assessmentOf(exe)
    if (plainAssessment.decision === 'allow') {
      assert.notEqual(exeAssessment.decision, 'allow', `${exe} must stay stricter than ${plain}`)
    } else {
      assert.equal(exeAssessment.decision, plainAssessment.decision, `${exe} must settle like ${plain}`)
      assert.equal(exeAssessment.classifierEligible, plainAssessment.classifierEligible, `${exe} must not differ from ${plain}`)
    }
    assert.equal(categoryOf(exe), categoryOf(plain), `${exe} must be labelled like ${plain}`)
  }
})

test('an inline write into the plugin state tree is denied under both spellings', () => {
  const target = `${HOME}/.dsh/x`
  for (const command of [`python -c "open('${target}','w')"`, `python.exe -c "open('${target}','w')"`]) {
    const assessment = assessmentOf(command)
    assert.equal(assessment.decision, 'deny', `${command} must be denied`)
    assert.equal(assessment.classifierEligible, false)
  }
})

test('allow-list spellings keep their stricter side (deliberate asymmetry)', () => {
  assert.equal(categoryOf('python --version'), 'build', 'the plain spelling is a routine build probe')
  assert.notEqual(categoryOf('python.exe --version'), 'build', 'normalizing allow lists would widen them')
})
