/**
 * dsh-auto-approval-llm · relative shell write targets must reach the fuses.
 *
 * The write-operand loop gated the DSH_HOME / plugin-zone / credential
 * (`hardDestructiveTargetReason`) fuse behind `looksLikeExplicitPath`, so an
 * operand spelled as a bare relative path (`lib/index.js`) skipped it: with
 * the plugin repo as the workspace, `cp ./src/index.ts lib/index.js` was a
 * static allow able to rewrite the compiled host module the process loads.
 * The gate exists only to keep bare flag values (`truncate -s 0`'s `0`) from
 * being read as paths, so the destructive predicate now runs for every
 * operand while the DSH_HOME "use the write tool instead" fuse keeps its
 * explicit-spelling boundary.
 *
 * `mv` sources are removals, so they ride the same predicate as deletion
 * targets; a trailing flag must not hide the destination.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { assessShell } from '../lib/auto/shell.js'

const ZONE = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const zoneRoots = {
  workspace: ZONE,
  home: 'C:/Users/u',
  dshHome: 'C:/Users/u/.dsh',
  tempRoots: [],
  trustedDirs: [],
  allowedDshSubpaths: [ZONE],
  maintenanceDshPaths: [],
  mode: 'aggressive',
}
const plainRoots = {
  workspace: 'C:/ws',
  home: 'C:/Users/u',
  dshHome: 'C:/Users/u/.dsh',
  tempRoots: ['C:/Temp'],
  trustedDirs: [],
  allowedDshSubpaths: [],
  maintenanceDshPaths: [],
  mode: 'aggressive',
}
const artifacts = { has: () => false }
const shell = (command, roots) => assessShell(command, 'bash', roots, artifacts, undefined)

test('relative write destinations reach the plugin-zone self-modify fuse', () => {
  for (const command of [
    'cp ./src/index.ts lib/index.js',
    'cp src/index.ts lib/index.js',
    'tee lib/index.js',
    'truncate -s 0 lib/index.js',
    'sed -i s/a/b/ lib/index.js',
  ]) {
    const verdict = shell(command, zoneRoots)
    assert.equal(verdict.decision, 'deny', `${command} must be hard-denied`)
    assert.match(verdict.reason ?? '', /plugin's own execution code/, `${command} reason must name the zone`)
    assert.equal(verdict.classifierEligible, false, `${command} must not degrade into an LLM-answerable ask`)
  }
})

test('a trailing flag does not hide the destination operand', () => {
  const verdict = shell('cp ./src/index.ts lib/index.js -v', zoneRoots)
  assert.equal(verdict.decision, 'deny', 'the destination is the last positional, not the last word')
})

test('a trailing value-taking flag does not hide the destination either', () => {
  for (const command of ['install ./src/index.ts lib/index.js -m 755', 'cp -b ./src/index.ts lib/index.js -S orig', 'mv ./src/index.ts lib/index.js -S orig']) {
    const verdict = shell(command, zoneRoots)
    assert.equal(verdict.decision, 'deny', `${command}: the flag value is not the destination`)
  }
})

test('mv sources are removals and reach the same fuse as deletion targets', () => {
  const verdict = shell('mv lib/index.js ./junk', zoneRoots)
  assert.equal(verdict.decision, 'deny', 'moving the plugin execution code out must be fused')
  assert.match(verdict.reason ?? '', /plugin's own execution code/)
})

test('routine relative operations keep their static allow (no over-block)', () => {
  for (const command of ['cp ./a ./b', 'cp ./a ./b -v', 'tee ./out.txt', 'truncate -s 0 ./log.bin', 'mv ./a ./b', 'sed -i s/a/b/ ./notes.txt', 'cp -r ./src ./dst']) {
    assert.equal(shell(command, plainRoots).decision, 'allow', `${command} stays static`)
  }
})

test('a dependency tree reached through a relative spelling is still fused', () => {
  const verdict = shell('cp ./src/index.ts node_modules/x.js', zoneRoots)
  assert.equal(verdict.decision, 'deny', 'a relative spelling must not dodge the dependency fuse')
})
