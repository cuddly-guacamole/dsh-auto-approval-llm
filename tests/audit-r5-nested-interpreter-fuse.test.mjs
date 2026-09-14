/**
 * A nested inline source must not step below the fuse tier the same text
 * reaches on its own. `bash -c "cp a.txt ~/.dsh/history.jsonl"` writes exactly
 * what `cp a.txt ~/.dsh/history.jsonl` hard-denies, and `bash -c "sudo ls"`
 * escalates exactly like `sudo ls`; both used to fall out of the interpreter
 * branch as classifier-answerable asks because only `find -exec` consulted the
 * write-operand/redirect/privilege owners. The nested source now runs through
 * the same whole-line ladder, so every family keeps its single owner.
 *
 * Pins both directions: protected targets keep the hard deny behind every
 * interpreter spelling, and ordinary nested reads stay reviewable (not denied).
 *
 * Run: node --test tests/audit-r5-nested-interpreter-fuse.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell } from '../lib/auto/shell.js'
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
const DSH = 'C:/Users/u/.dsh'

const INNER_WRITES = [
  `cp a.txt ${DSH}/history.jsonl`,
  `mv a.txt ${DSH}/history.jsonl`,
  `tee ${DSH}/history.jsonl`,
  `dd of=${DSH}/history.jsonl`,
  `sed -i s/a/b/ ${DSH}/history.jsonl`,
  `install a.txt ${DSH}/history.jsonl`,
  `printf a > ${DSH}/history.jsonl`,
  `echo x >> ${DSH}/history.jsonl`,
  `sort -o ${DSH}/history.jsonl in.txt`,
]

test('a nested interpreter write to DSH_HOME is hard-denied on every spelling', () => {
  for (const inner of INNER_WRITES) {
    for (const command of [`bash -c "${inner}"`, `sh -c '${inner}'`]) {
      const verdict = shell(command)
      assert.equal(verdict.decision, 'deny', `${command} must be hard-denied`)
      assert.equal(verdict.classifierEligible, false, `${command} must not reach the classifier`)
    }
  }
})

test('a nested interpreter privilege escalation is hard-denied', () => {
  for (const command of ['bash -c "sudo ls"', "sh -c 'doas ls'", 'bash -c "su -c whoami"']) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must be hard-denied`)
  }
})

test('the nested deletion heuristic keeps its manual-review tier', () => {
  for (const command of ['bash -c "rm -rf /tmp/x"', `sh -c 'rm -rf ${DSH}/nothing-here'`]) {
    const verdict = shell(command)
    assert.notEqual(verdict.decision, 'allow', `${command} must not be allowed`)
    assert.equal(verdict.classifierEligible, false, `${command} must not reach the classifier`)
  }
})

test('ordinary nested work is not hard-denied', () => {
  for (const command of [
    'bash -c "cp a.txt /tmp/x"',
    'bash -c "printf a > /tmp/x"',
    'bash -c "echo hi"',
    'bash -c "sort -o /tmp/x in.txt"',
    'bash -c "cp a.txt ./build/out.txt"',
    'python -c "x = 1"',
    'node -e "console.log(1)"',
  ]) {
    assert.notEqual(shell(command).decision, 'deny', `${command} must not be hard-denied`)
  }
})

test('the programmatic-write owner keeps its own deny reason', () => {
  for (const command of [
    `node -e "require('fs').writeFileSync('${DSH}/foo', 'bar')"`,
    `python -c "open('${DSH}/foo', 'w').write('bar')"`,
  ]) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must be denied`)
    assert.equal(verdict.classifierEligible, false, `${command} must not reach the classifier`)
  }
})
