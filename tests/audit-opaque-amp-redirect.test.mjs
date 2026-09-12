/**
 * dsh-auto-approval-llm · `>&` redirect targets on opaque lines.
 *
 * Shell spellings `>&file` (and `N>&file`) are writes: the decomposed lexer
 * sends them to `pending = 'write'`, so the plain spelling hard-denies a
 * protected target. The recovery scan used for opaque lines (grouping, command
 * substitution, here-documents) only accepted `&>` / `N>` / `>|`, so the same
 * protected write plus an opaque tail decayed into a classifier-eligible ask —
 * the degradation the recovery exists to close. A file-descriptor dup
 * (`>&2`, `2>&1`) is not a path and must stay unfused.
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
const artifacts = { has: () => false }
const shell = (command, roots = zoneRoots) => assessShell(command, 'bash', roots, artifacts, undefined)

test('an attached >& target naming a protected file is fused on an opaque line', () => {
  for (const command of [
    'printf x >&package.json; (:)',
    'printf x >&package.json; (true)',
    'printf x 2>&package.json; (:)',
    'printf x >&./package.json; $(:)',
  ]) {
    const verdict = shell(command)
    assert.equal(verdict.decision, 'deny', `${command} must be hard-denied`)
    assert.equal(verdict.classifierEligible, false, `${command} must not be LLM-answerable`)
  }
})

test('file-descriptor dups are not treated as paths', () => {
  for (const command of ['printf x >&2; (:)', 'printf x 2>&1; (:)', 'printf x >&-; (:)', 'printf x >& 2; (:)']) {
    assert.notEqual(shell(command).decision, 'deny', `${command} is a descriptor dup/close, not a file target`)
  }
})

test('a >& target on an ordinary path is not over-blocked', () => {
  assert.notEqual(shell('printf x >&out.txt; (:)', { ...zoneRoots, workspace: 'C:/ws', allowedDshSubpaths: [] }).decision, 'deny')
})
