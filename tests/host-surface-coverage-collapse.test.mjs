/**
 * Contract for the contract-surface coverage gate.
 *
 * `tests/host-contract-surface.test.mjs` used to report a package it could not
 * load as a TAP diagnostic, which is a comment: removing one package from a
 * `0.2.0-rc.1` prefix took 42 of the 50 contract rows out of the reading — the
 * ten entries are one import graph — and the file still reported every case
 * passed, including the load-bearing raw-identity canary it never ran. This file
 * pins the replacement: the reading those rows produce is a failure, and the
 * allowance that keeps the one documented upstream packaging condition from
 * being a failure cannot be widened into a silence on its own.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KNOWN_UNCHECKABLE, MIN_EVALUABLE_ROWS, assertCoverage, coverageVerdict } from './host-surface-coverage.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The reason a package entry that could not be loaded contributes. */
const ENTRY_FAILED = "entry failed to load: Cannot find package '@deepseek-ai/dsh-typert-protocol'"

/** The 50 row ids of the promised line, grouped by the package that carries them. */
const ROWS_BY_PACKAGE = {
  cordis: ['cordis.Context', 'cordis.Context.effect', 'cordis.reflect.get', 'cordis.reflect.inject', 'cordis.events.on', 'cordis.events.waterfall', 'cordis.events.dispatch'],
  schemastery: ['schemastery.default'],
  llm: ['llm.createUserMessage', 'llm.BlockAssembler', 'llm.BlockAssembler.push', 'llm.BlockAssembler.assemble', 'llm.LlmRuntime.stream', 'llm.LlmRuntime.prepareCall', 'llm.LlmRuntime.listModels', 'llm.LlmRuntime.resolveModelInfo', 'llm.LlmRuntime.listProviders'],
  tools: ['tools.ToolRuntime.guard', 'tools.ToolRuntime.register', 'tools.ToolRuntime.schemas'],
  session: ['session.Session', 'session.Session.append', 'session.Session.snapshotEvents', 'session.Session.requestHeader', 'session.KNOWN_SESSION_EVENT_TYPES'],
  agent: ['agent.AgentRegistry', 'agent.AgentRegistry.get', 'agent.AgentRegistry.list'],
  permissionPresets: ['permissionPresets.PermissionPresetService', 'permissionPresets.permissionState', 'permissionPresets.current', 'permissionPresets.set', 'permissionPresets.registerAuto', 'permissionPresets.catalog', 'permissionPresets.names', 'permissionPresets.specOf', 'permissionPresets.resolve', 'permissionPresets.derive', 'permissionPresets.AUTO_PRESET', 'permissionPresets.CUSTOM_PRESET'],
  approval: ['approval.APPROVAL_POLICIES', 'approval.setApprovalPolicy', 'approval.ApprovalService', 'approval.ApprovalService.setPolicy', 'approval.ApprovalService.request', 'approval.ApprovalService.effectivePolicy', 'approval.ApprovalService.decide'],
  typert: ['typert.TypertRemoteService'],
  primitives: ['primitives.Button', 'primitives.Input'],
}

/** Every row id, in the order the surface table declares them. */
const ALL_ROWS = Object.values(ROWS_BY_PACKAGE).flat()

/** The reason the two primitives rows carry on every line. */
const PRIMITIVES_REASON = "entry failed to load: Cannot find package 'react'"

/** A reading where the controls ran and only the declared rows went unchecked. */
function soundReading(overrides = {}) {
  return {
    rowIds: ALL_ROWS,
    unchecked: KNOWN_UNCHECKABLE.rows.map(id => ({ id, reason: PRIMITIVES_REASON })),
    canary: { exercised: true, reason: '' },
    reader: { exercised: true, reason: '' },
    ...overrides,
  }
}

test('the reading a promised line produces is accepted', () => {
  const verdict = assertCoverage(soundReading())
  assert.equal(verdict.declared, ALL_ROWS.length)
  assert.equal(verdict.evaluated, ALL_ROWS.length - KNOWN_UNCHECKABLE.rows.length)
  assert.equal(verdict.floor, MIN_EVALUABLE_ROWS)
  assert.deepEqual(verdict.unchecked, [...KNOWN_UNCHECKABLE.rows])
})

test('the declared unevaluable rows are a named set with a stated reason, not a count', () => {
  assert.deepEqual([...KNOWN_UNCHECKABLE.rows], ['primitives.Button', 'primitives.Input'])
  assert.match(KNOWN_UNCHECKABLE.reason, /react/)
  assert.match(KNOWN_UNCHECKABLE.reason, /peerDependencies/)
  // A reason is what keeps the two rows diagnosable: a run must be able to say
  // why they are absent, not only that they are.
  assert.ok(KNOWN_UNCHECKABLE.reason.length > 40, 'the stated reason is too short to diagnose anything')
})

test('losing one package from the prefix fails the reading and names every row it took', () => {
  // The reproduced defect: `dsh-typert-protocol` removed from a 0.2.0-rc.1
  // prefix. Six package entries import it, so the rows it took with it are
  // seven packages' worth, not one.
  const lost = ['llm', 'tools', 'session', 'agent', 'permissionPresets', 'approval']
  const unchecked = [
    ...lost.flatMap(pkg => ROWS_BY_PACKAGE[pkg].map(id => ({ id, reason: ENTRY_FAILED }))),
    { id: 'typert.TypertRemoteService', reason: 'not installed in this checkout' },
    ...KNOWN_UNCHECKABLE.rows.map(id => ({ id, reason: PRIMITIVES_REASON })),
  ]
  assert.equal(unchecked.length, 42)
  let thrown
  try {
    assertCoverage(soundReading({
      unchecked,
      canary: { exercised: false, reason: ENTRY_FAILED },
      reader: { exercised: false, reason: ENTRY_FAILED },
    }))
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof Error, 'the collapsed reading was accepted')
  const message = thrown.message
  assert.match(message, /the load-bearing raw-identity canary was not exercised/)
  assert.match(message, /the contract reader's own negative control was not exercised/)
  for (const row of unchecked) {
    if (KNOWN_UNCHECKABLE.rows.includes(row.id)) continue
    assert.ok(message.includes(row.id), 'the failure does not name ' + row.id)
  }
  // The rows that went unchecked for a declared reason are still reported as
  // unchecked rather than dragged into the failure: the upstream packaging
  // condition must not be restated as a contract break.
  assert.equal(message.includes('contract row unchecked for a reason this file does not allow: primitives.'), false)
})

test('a raw-identity canary that never ran fails the reading', () => {
  const problems = coverageVerdict(soundReading({ canary: { exercised: false, reason: 'the permission-presets service did not register' } })).problems
  assert.equal(problems.length, 1)
  assert.match(problems[0], /^the load-bearing raw-identity canary was not exercised: the permission-presets service did not register$/)
})

test('a reader control that never ran fails the reading', () => {
  const problems = coverageVerdict(soundReading({ reader: { exercised: false, reason: 'not installed in this checkout' } })).problems
  assert.equal(problems.length, 1)
  assert.match(problems[0], /^the contract reader's own negative control was not exercised: not installed in this checkout$/)
})

test('a degenerate canary fixture is reported as a canary that was not exercised', () => {
  // The reading the caller passes is what a control would report about itself,
  // so a fixture whose raw and derived sides agree must not be able to certify
  // the canary: the gate asks the service, not the case.
  const problems = coverageVerdict(soundReading({ canary: { exercised: false, reason: 'the drift fixture no longer diverges: raw and derived both read auto-approval' } })).problems
  assert.equal(problems.length, 1)
  assert.match(problems[0], /the drift fixture no longer diverges/)
})

test('the floor rejects a widened allowance on its own', () => {
  // The allowance can always be widened, so the floor is what remains once it
  // is: every unchecked row declared unevaluable, yet too few of the surface
  // read. Silencing a collapse therefore has to edit two numbers, and the
  // second one is a constant that does not move by itself.
  const swallowed = ['llm', 'tools', 'session', 'agent', 'permissionPresets', 'approval', 'typert']
  const unchecked = swallowed.flatMap(pkg => ROWS_BY_PACKAGE[pkg].map(id => ({ id, reason: ENTRY_FAILED })))
  const wide = { reason: 'a reason that would silence everything', rows: unchecked.map(row => row.id) }
  const problems = coverageVerdict(soundReading({ unchecked }), wide, MIN_EVALUABLE_ROWS).problems
  assert.equal(problems.length, 1)
  assert.match(problems[0], new RegExp('^only ' + (ALL_ROWS.length - unchecked.length) + ' of ' + ALL_ROWS.length + ' contract rows were evaluated, below the floor of ' + MIN_EVALUABLE_ROWS))
})

test('a floor below the measured reading still admits it, and one above it does not', () => {
  const reading = soundReading()
  const measured = ALL_ROWS.length - KNOWN_UNCHECKABLE.rows.length
  assert.equal(coverageVerdict(reading, KNOWN_UNCHECKABLE, measured).problems.length, 0)
  assert.equal(coverageVerdict(reading, KNOWN_UNCHECKABLE, measured + 1).problems.length, 1)
  // The floor is a floor and not an equality: a future line that can read the
  // primitives rows must not turn red for reading more than it must.
  const everything = soundReading({ unchecked: [] })
  assert.equal(coverageVerdict(everything).problems.length, 0)
})

test('a duplicated row id is refused, so a count cannot be inflated', () => {
  const problems = coverageVerdict(soundReading({ rowIds: [...ALL_ROWS, 'llm.createUserMessage'] })).problems
  assert.equal(problems.length, 1)
  assert.match(problems[0], /repeats a row id/)
  assert.ok(problems[0].includes('llm.createUserMessage'))
})

test('the surface file applies this rule rather than carrying its own', () => {
  // Without this, the gate could be satisfied by a module nothing calls: the
  // teeth live in the file that reads the surface, so the wiring is the claim.
  const source = readFileSync(join(ROOT, 'tests', 'host-contract-surface.test.mjs'), 'utf8')
  assert.match(source, /from '\.\/host-surface-coverage\.mjs'/)
  assert.match(source, /assertCoverage\(\{/)
  // The per-row report survives: a failure has to stay diagnosable.
  assert.match(source, /t\.diagnostic\(/)
  // The rule is applied from a declared case, so it runs in the suite.
  assert.match(source, /^test\('the contract surface was read, not merely attempted'/m)
})
