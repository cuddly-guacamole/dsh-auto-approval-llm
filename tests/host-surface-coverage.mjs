/**
 * The collapse detector for `tests/host-contract-surface.test.mjs`.
 *
 * A TAP diagnostic is a comment. A package entry that cannot be loaded therefore
 * cost the file nothing: the rows it owned were named and the run still read as
 * clean. Deleting one package from a `0.2.0-rc.1` prefix took 42 of the 50 rows
 * out of the reading — the ten entries are one import graph, not ten trees — and
 * the file still reported every case passed, including the load-bearing
 * raw-identity canary it never ran. This module is the counterweight: it turns
 * the same reading into a failure, and it lives outside the test file so the
 * decision can be driven directly by its own contract test.
 *
 * The allowance below is the whole reason the file is not a vacuous pass: a row
 * the host cannot supply is tolerated only while it is a row this module already
 * names, and the floor is what stops that allowance from being widened into a
 * silence.
 */

/**
 * Rows no host line can supply, and why. `dsh-client-ui-primitives/lib/index.js`
 * imports `react`, which its manifest declares only under
 * `peerDependencies: {@deepseek-ai/cordis}`; a bare `import()` cannot resolve an
 * undeclared import outside a bundler, so the entry fails to load and the two
 * component rows have nothing to be read from. This is an upstream packaging
 * condition, not a regression and not a contract break: the rows stay reported
 * unchecked, with this reason, and never become a failure.
 */
export const KNOWN_UNCHECKABLE = Object.freeze({
  reason: "dsh-client-ui-primitives/lib/index.js imports `react`, which its manifest declares only under peerDependencies: { @deepseek-ai/cordis }; a bare import() cannot resolve an undeclared import outside a bundler",
  rows: Object.freeze(['primitives.Button', 'primitives.Input']),
})

/**
 * The floor on evaluated rows, which is the measured reading of a promised line
 * with no slack in it: 48 of 50, the other two being the allowance above. A
 * higher floor would be red on every line the plugin supports; a lower one would
 * absorb a real collapse. It is a constant rather than a value derived from
 * `KNOWN_UNCHECKABLE` precisely because a derived floor rises by itself whenever
 * the allowance grows — which is the silent widening this floor exists to make
 * visible: silencing a collapse has to edit two numbers, not one.
 */
export const MIN_EVALUABLE_ROWS = 48

/**
 * Decide whether a reading of the contract surface is acceptable. Returns the
 * problems rather than throwing, so a caller can report all of them at once.
 *
 * @param {{rowIds: string[], unchecked: {id: string, reason: string}[],
 *          canary: {exercised: boolean, reason: string},
 *          reader: {exercised: boolean, reason: string}}} reading
 * @param {{reason: string, rows: readonly string[]}} [known]
 * @param {number} [floor]
 */
export function coverageVerdict(reading, known = KNOWN_UNCHECKABLE, floor = MIN_EVALUABLE_ROWS) {
  const problems = []
  const rowIds = reading.rowIds ?? []
  const unchecked = reading.unchecked ?? []
  const declared = new Set(rowIds)
  if (declared.size !== rowIds.length) {
    const seen = new Set()
    problems.push('CONTRACT_SURFACE repeats a row id, so the declared row count is not a count of distinct contract names: ' + rowIds.filter(id => (seen.has(id) ? true : (seen.add(id), false))).join(', '))
  }
  const checked = new Set(unchecked.map(row => row.id))
  for (const id of checked) {
    if (!declared.has(id)) problems.push('an unchecked row is not a declared row: ' + id)
  }
  // The controls come before the count: a file that never mounted the service has
  // no reading at all, and reporting that as "too few rows" would describe the
  // symptom instead of the cause.
  if (reading.canary?.exercised !== true) {
    problems.push('the load-bearing raw-identity canary was not exercised: ' + (reading.canary?.reason ?? 'no reason recorded'))
  }
  if (reading.reader?.exercised !== true) {
    problems.push('the contract reader\'s own negative control was not exercised: ' + (reading.reader?.reason ?? 'no reason recorded'))
  }
  const allowed = new Set(known.rows)
  const unexpected = unchecked.filter(row => !allowed.has(row.id))
  for (const row of unexpected) {
    problems.push('contract row unchecked for a reason this file does not allow: ' + row.id + ' — ' + row.reason)
  }
  const evaluated = rowIds.length - unchecked.length
  if (unexpected.length === 0 && evaluated < floor) {
    problems.push('only ' + evaluated + ' of ' + rowIds.length + ' contract rows were evaluated, below the floor of ' + floor + '; the unchecked rows are all declared unevaluable, so the allowance itself no longer describes the host')
  }
  return { problems, declared: rowIds.length, evaluated, unchecked: unchecked.map(row => row.id), floor }
}

/**
 * Assert a reading of the contract surface. Throws with every problem joined, so
 * a collapsed run names the rows it lost rather than a single opaque failure.
 */
export function assertCoverage(reading, known = KNOWN_UNCHECKABLE, floor = MIN_EVALUABLE_ROWS) {
  const verdict = coverageVerdict(reading, known, floor)
  if (verdict.problems.length > 0) {
    throw new Error('the contract surface reading is not trustworthy:\n  - ' + verdict.problems.join('\n  - '))
  }
  return verdict
}
