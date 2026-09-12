/**
 * The destination extraction for cp/mv/install must see a fused short option
 * (`-tDIR`) exactly like the separated spelling (`-t DIR`). GNU getopt fuses
 * the value into the flag word, so `cp -t./lib README.md` used to leave only
 * the SOURCE in the operand list: the write-target fuses (plugin execution
 * code, DSH_HOME, credential trees) never judged the real destination and the
 * command kept its static allow — a silent overwrite of the approval body from
 * inside an auto-approved session.
 * Run: node --test tests/audit-write-target-fused-flag.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { assessShell } from '../lib/auto/shell.js'

const repoRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const roots = {
  workspace: repoRoot,
  home: 'C:/Users/u',
  dshHome: 'C:/Users/u/.dsh',
  tempRoots: ['C:/Temp'],
  allowedDshSubpaths: [repoRoot],
}
const artifacts = { has: () => false }
const shell = (command) => assessShell(command, 'bash', roots, artifacts, undefined)

test('fused -tDIR destination reaches the plugin-zone fuse (cp/mv/install)', () => {
  for (const command of [
    'cp -t./lib README.md',
    'mv -t./lib README.md',
    'install -t./lib README.md',
  ]) {
    const result = shell(command)
    assert.equal(result.decision, 'deny', `${command} must be hard-denied`)
    assert.match(result.reason ?? '', /execution code/, `${command} reason should name the plugin zone`)
    assert.equal(result.classifierEligible, false, `${command} must not degrade into an LLM-answerable ask`)
  }
})

test('fused and separated -t agree on a DSH_HOME destination', () => {
  for (const command of [
    'cp -tC:/Users/u/.dsh/sub README.md',
    'cp -t C:/Users/u/.dsh/sub README.md',
    'cp --target-directory=C:/Users/u/.dsh/sub README.md',
  ]) {
    const result = shell(command)
    assert.equal(result.decision, 'deny', `${command} must be hard-denied`)
    assert.match(result.reason ?? '', /DSH_HOME|contract/, `${command} reason should name the protected target`)
  }
})

test('a fused destination inside the writable zone keeps its static allow', () => {
  for (const command of ['cp -t./src README.md', 'cp -m0755 README.md ./src/README.md']) {
    assert.notEqual(shell(command).decision, 'deny', `${command} stays out of the hard fuse`)
  }
})

test('fused destinations stay dynamic-flagged like their separated spelling', () => {
  const result = shell('cp -t"$DEST" README.md')
  assert.notEqual(result.decision, 'allow', 'a dynamic fused destination must not keep the static allow')
  assert.equal(result.classifierEligible, true)
})
