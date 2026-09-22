/**
 * dsh-auto-approval-llm · auto -> auto-approval rename, raw-identity gate,
 * own-spec enforcement and legacy migration decisions.
 *
 * The module under test is pure: every host touchpoint is injected, so these
 * cases drive the decision layer directly. The compiled anchors at the end pin
 * the wiring that cannot be reached without a live session/announce harness.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GATED_PRESET, LEGACY_AUTO_PRESET } from '../lib/auto/constants.js'
import {
  classifyForMigration,
  degradeAfterFailedMigration,
  detectHostCapability,
  effectiveApprovalNever,
  enforceOwnSpec,
  gatePresetNames,
  isGatedSession,
  isUsableTargetSpec,
  migrationAuditLine,
  migrationDecision,
  rawPresetOf,
  rootAuthoritySessionId,
  runPresetMigration,
  safeResolveSpec,
  scanAuditLine,
} from '../lib/auto/preset-migration.js'

const OK_SPEC = { sandbox: 'danger-full-access', approval: 'ask' }
const AT = 1_700_000_000_000

/** A bare host surface for capability probing, with independent signal control. */
function service({ permissionState, registerAuto, catalog, specOf } = {}) {
  const svc = {}
  if (permissionState !== null) svc.permissionState = permissionState ?? (() => undefined)
  if (registerAuto !== undefined) svc.registerAuto = registerAuto
  if (catalog !== undefined) svc.catalog = catalog
  if (specOf !== undefined) svc.specOf = specOf
  return svc
}

/**
 * A mutable fake host for migration/enforcement: permissionState reads a live
 * ref, append folds the event back into that ref so the post-append asserts see
 * the new identity, and every audit/warn/append is recorded.
 */
function harness(options = {}) {
  const stateRef = {
    value: {
      preset: 'auto',
      sandbox: 'danger-full-access',
      approval: 'ask',
      ...(options.initial ?? {}),
    },
  }
  const appends = []
  const audits = []
  const warns = []
  const targetSpec = options.targetSpec === undefined ? OK_SPEC : options.targetSpec
  const permissionPresets = {
    permissionState: () => stateRef.value,
    resolve: (name) => {
      if (name !== GATED_PRESET) throw new Error(`unknown preset: ${name}`)
      if (targetSpec === null) throw new Error(`unknown preset: ${name}`)
      return targetSpec
    },
    current: options.current ?? (() => stateRef.value.preset),
  }
  if (options.capability === 'modern') {
    permissionPresets.registerAuto = () => {}
    permissionPresets.catalog = () => ({})
  }
  const append = options.append ?? ((session, type, data) => {
    appends.push({ type, data })
    if (type === 'permission/preset' && data?.preset === GATED_PRESET) {
      stateRef.value = { ...stateRef.value, preset: GATED_PRESET }
    } else if (type === 'approval/policy' && typeof data?.policy === 'string') {
      stateRef.value = { ...stateRef.value, approval: data.policy }
    }
  })
  const session = options.session ?? { id: options.id ?? 's1' }
  const deps = {
    permissionPresets,
    capability: options.capability ?? 'modern',
    approval: options.approval ?? { config: { policy: 'ask' } },
    append,
    audit: (line) => audits.push(JSON.parse(line)),
    warn: (message) => warns.push(message),
    markPluginInitiated: options.markPluginInitiated,
    current: options.depsCurrent,
    now: () => AT,
  }
  return { deps, session, stateRef, appends, audits, warns }
}

const compile = (file) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')

test('T14: the machine constants are the rename contract', () => {
  assert.equal(GATED_PRESET, 'auto-approval')
  assert.equal(LEGACY_AUTO_PRESET, 'auto')
})

test('T1: capability is a multi-signal probe and mismatch fails closed', () => {
  const both = service({ permissionState: () => ({}), registerAuto: () => {}, catalog: () => ({}) })
  assert.deepEqual(detectHostCapability(both), { capability: 'modern', reason: 'catalog+registerAuto' })

  const neither = service({ permissionState: () => ({}) })
  assert.deepEqual(detectHostCapability(neither), { capability: 'unknown', reason: 'unrecognized-shape' })

  const onlyRegister = service({ permissionState: () => ({}), registerAuto: () => {} })
  assert.deepEqual(detectHostCapability(onlyRegister), { capability: 'unknown', reason: 'registerAuto/catalog mismatch' })

  const onlyCatalog = service({ permissionState: () => ({}), catalog: () => ({}) })
  assert.deepEqual(detectHostCapability(onlyCatalog), { capability: 'unknown', reason: 'registerAuto/catalog mismatch' })

  assert.deepEqual(detectHostCapability(undefined), { capability: 'unknown', reason: 'no-permission-state' })
  assert.deepEqual(detectHostCapability(service({ permissionState: null })), { capability: 'unknown', reason: 'no-permission-state' })

  // `specOf('auto')` reserved shape without the modern surfaces is unknown: we
  // cannot tell what an `auto` row means there.
  const reservedNoSurfaces = service({
    permissionState: () => ({}),
    specOf: (name) => (name === LEGACY_AUTO_PRESET ? { sandbox: 'danger-full-access', approval: 'never' } : undefined),
  })
  assert.deepEqual(detectHostCapability(reservedNoSurfaces), { capability: 'unknown', reason: 'legacy-but-reserved-shape' })

  // Modern with the reserved spec is still modern (the aux signal only refines
  // the reason).
  const modernReserved = service({
    permissionState: () => ({}),
    registerAuto: () => {},
    catalog: () => ({}),
    specOf: (name) => (name === LEGACY_AUTO_PRESET ? { sandbox: 'danger-full-access', approval: 'never' } : undefined),
  })
  assert.deepEqual(detectHostCapability(modernReserved), { capability: 'modern', reason: 'reserved-shape' })
})

test('T2: the gate carries the plugin preset on every capability', () => {
  assert.deepEqual(gatePresetNames('modern'), [GATED_PRESET])
  assert.deepEqual(gatePresetNames('unknown'), [GATED_PRESET])

  const foreignAuto = service({ permissionState: () => ({ preset: LEGACY_AUTO_PRESET }) })
  const gated = service({ permissionState: () => ({ preset: GATED_PRESET }) })

  assert.equal(isGatedSession(gated, { id: 's' }, gatePresetNames('modern')), true)
  assert.equal(isGatedSession(foreignAuto, { id: 's' }, gatePresetNames('modern')), false)
  assert.equal(isGatedSession(foreignAuto, { id: 's' }, gatePresetNames('unknown')), false)

  // A throw while reading the raw state reads as not-gated.
  const throwing = service({ permissionState: () => { throw new Error('projection not registered') } })
  assert.equal(isGatedSession(throwing, { id: 's' }, gatePresetNames('modern')), false)
  assert.equal(isGatedSession(foreignAuto, undefined, gatePresetNames('modern')), false)
})

test('T-G1: the gate reads raw identity, so a never override cannot slide it off', () => {
  const hoistedCurrent = {
    permissionState: () => ({ preset: GATED_PRESET, sandbox: 'danger-full-access', approval: 'never' }),
    current: () => 'danger-full-access',
  }
  assert.equal(isGatedSession(hoistedCurrent, { id: 's' }, gatePresetNames('modern')), true)
  assert.equal(rawPresetOf(hoistedCurrent, { id: 's' }), GATED_PRESET)
  // The same state through derive-derived current() is not the gate input.
  assert.equal(hoistedCurrent.current({ id: 's' }), 'danger-full-access')
})

test('T4/T-G2: own-spec enforcement restores effective never to ask exactly once', () => {
  const h = harness({ initial: { preset: GATED_PRESET, sandbox: 'danger-full-access', approval: 'never' } })
  assert.equal(enforceOwnSpec(h.session, h.deps), 'restored')
  assert.deepEqual(h.appends, [{ type: 'approval/policy', data: { policy: 'ask' } }])
  assert.equal(h.stateRef.value.approval, 'ask')
  const restore = h.audits.find((line) => line.type === 'preset-spec-restore')
  assert.ok(restore, 'a preset-spec-restore audit line is written')
  assert.equal(restore.from, 'never')
  assert.equal(restore.to, 'ask')
  assert.equal(restore.preset, GATED_PRESET)
  assert.equal(restore.reason, 'effective-never')

  // Idempotent: the second run sees ask and appends nothing.
  assert.equal(enforceOwnSpec(h.session, h.deps), 'ok')
  assert.equal(h.appends.length, 1)
  assert.equal(h.audits.length, 1)
})

test('T4/T-G4: a null override over a never base policy is effective never', () => {
  const h = harness({
    initial: { preset: GATED_PRESET, sandbox: 'danger-full-access', approval: null },
    approval: { config: { policy: 'never' } },
  })
  assert.equal(effectiveApprovalNever(h.stateRef.value, h.deps.approval), true)
  assert.equal(enforceOwnSpec(h.session, h.deps), 'restored')
  assert.deepEqual(h.appends, [{ type: 'approval/policy', data: { policy: 'ask' } }])

  // The same null override over an ask base policy is not never.
  const askBase = harness({
    initial: { preset: GATED_PRESET, sandbox: 'danger-full-access', approval: null },
    approval: { config: { policy: 'ask' } },
  })
  assert.equal(enforceOwnSpec(askBase.session, askBase.deps), 'ok')
  assert.equal(askBase.appends.length, 0)
})

test('T-G3: foreign raw auto is never normalized, on every capability', () => {
  for (const capability of ['modern', 'unknown']) {
    const h = harness({ capability, initial: { preset: LEGACY_AUTO_PRESET, sandbox: 'danger-full-access', approval: 'never' } })
    assert.equal(enforceOwnSpec(h.session, h.deps), 'skip-foreign', `${capability}: foreign auto stays untouched`)
    assert.equal(h.appends.length, 0, `${capability}: zero appends`)
    assert.equal(h.audits.length, 0, `${capability}: zero restore audit lines`)
  }
})

test('T-G5: enforcement re-reads the raw state, so a raced move is skipped', () => {
  // The deferred callback re-reads: preset moved away meanwhile -> skip.
  const raced = harness({ initial: { preset: GATED_PRESET, sandbox: 'danger-full-access', approval: 'never' } })
  raced.stateRef.value = { preset: LEGACY_AUTO_PRESET, sandbox: 'danger-full-access', approval: 'never' }
  assert.equal(enforceOwnSpec(raced.session, raced.deps), 'skip-foreign')
  assert.equal(raced.appends.length, 0)

  // Policy already moved to ask meanwhile -> nothing to do.
  const settled = harness({ initial: { preset: GATED_PRESET, sandbox: 'danger-full-access', approval: 'never' } })
  settled.stateRef.value = { preset: GATED_PRESET, sandbox: 'danger-full-access', approval: 'ask' }
  assert.equal(enforceOwnSpec(settled.session, settled.deps), 'ok')
  assert.equal(settled.appends.length, 0)
})

test('enforcement failure is audited and never throws', () => {
  const h = harness({
    initial: { preset: GATED_PRESET, sandbox: 'danger-full-access', approval: 'never' },
    append: () => { throw new Error('cannot reenter') },
  })
  assert.equal(enforceOwnSpec(h.session, h.deps), 'failed')
  assert.equal(h.audits.length, 1)
  assert.equal(h.audits[0].type, 'preset-spec-restore')
  assert.equal(h.audits[0].ok, false)
  assert.match(h.audits[0].error, /cannot reenter/)
  assert.equal(h.warns.length, 1)
})

test('T6: only the same signature migrates; every other auto shape is skipped', () => {
  const nonSignature = [
    { preset: LEGACY_AUTO_PRESET, sandbox: 'danger-full-access', approval: 'never' },
    { preset: LEGACY_AUTO_PRESET, sandbox: 'workspace-write', approval: 'ask' },
    { preset: LEGACY_AUTO_PRESET, sandbox: 'read-only', approval: null },
    { preset: LEGACY_AUTO_PRESET, sandbox: null, approval: 'ask' },
  ]
  for (const capability of ['modern']) {
    for (const initial of nonSignature) {
      const h = harness({ capability, initial })
      assert.equal(runPresetMigration(h.session, h.deps), 'skipped', `${capability} ${JSON.stringify(initial)}`)
      assert.equal(h.appends.length, 0, `${capability}: no identity append for a non-signature auto`)
    }
  }
  for (const capability of ['modern']) {
    const h = harness({ capability })
    assert.equal(runPresetMigration(h.session, h.deps), 'migrated')
    assert.deepEqual(h.appends, [{ type: 'permission/preset', data: { preset: GATED_PRESET } }])
  }
  // capability unknown disables migration entirely, even for the signature.
  const unknown = harness({ capability: 'unknown' })
  assert.equal(runPresetMigration(unknown.session, unknown.deps), 'skipped')
  assert.equal(unknown.appends.length, 0)
})

test('T7: migration rewrites identity through append only, never set() and never knobs', () => {
  const h = harness()
  assert.equal(typeof h.deps.permissionPresets.set, 'undefined', 'the fake host exposes no set()')
  assert.equal(runPresetMigration(h.session, h.deps), 'migrated')
  assert.deepEqual(h.appends, [{ type: 'permission/preset', data: { preset: GATED_PRESET } }], 'exactly one identity append, zero knob writes')
  const source = compile('../lib/auto/preset-migration.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/permissionPresets\s*\.\s*set\s*\(/.test(source), 'the migration module never calls permissionPresets.set')
  assert.ok(!/\.set\s*\(/.test(source), 'the migration module contains no setter call at all')
})

test('T8: idempotency is the raw identity, never the derived current()', () => {
  const already = harness({ initial: { preset: GATED_PRESET, sandbox: 'danger-full-access', approval: 'ask' } })
  assert.equal(runPresetMigration(already.session, already.deps), 'skipped')
  assert.equal(already.appends.length, 0)

  // current() reports the target even though raw identity is still auto (the
  // exact set()-short-circuit trap); migration must still run.
  const hoisted = harness({ current: () => GATED_PRESET })
  assert.equal(hoisted.deps.permissionPresets.current(hoisted.session), GATED_PRESET)
  assert.equal(runPresetMigration(hoisted.session, hoisted.deps), 'migrated')
  assert.equal(hoisted.appends.length, 1)
})

test('T9: target resolve, post-append raw and current asserts fail loud without retry', () => {
  const missingTarget = harness({ targetSpec: null })
  assert.equal(runPresetMigration(missingTarget.session, missingTarget.deps), 'failed')
  assert.equal(missingTarget.appends.length, 0)
  assert.equal(missingTarget.audits[0].stage, 'resolve')
  assert.equal(missingTarget.audits[0].ok, false)

  const wrongTarget = harness({ targetSpec: { sandbox: 'workspace-write', approval: 'ask' } })
  assert.equal(isUsableTargetSpec(wrongTarget.deps.permissionPresets.resolve(GATED_PRESET)), false)
  assert.equal(runPresetMigration(wrongTarget.session, wrongTarget.deps), 'failed')
  assert.equal(wrongTarget.appends.length, 0)

  // Append succeeds but the raw identity did not move -> verify-raw failure.
  const noMove = harness({
    append: (session, type, data) => { noMoveAppends.push({ type, data }) },
  })
  const noMoveAppends = noMove.appends
  assert.equal(runPresetMigration(noMove.session, noMove.deps), 'failed')
  assert.equal(noMove.audits[0].stage, 'verify-raw')

  // Raw moved but current() still resolves to the alias -> verify-current.
  const tie = harness({ current: () => LEGACY_AUTO_PRESET })
  assert.equal(runPresetMigration(tie.session, tie.deps), 'failed')
  assert.equal(tie.appends.length, 1, 'the identity append happened')
  assert.equal(tie.audits[0].stage, 'verify-current')
})

test('T10: append throw never escapes; an ungated dfa+never session is degraded to ask', () => {
  const throwing = harness({ append: () => { throw new Error('reenter guard') } })
  let outcome
  assert.doesNotThrow(() => { outcome = runPresetMigration(throwing.session, throwing.deps) })
  assert.equal(outcome, 'failed')
  assert.equal(throwing.audits[0].stage, 'append')
  assert.match(throwing.audits[0].reason, /reenter guard/)
  assert.equal(throwing.warns.length, 1)

  // Direct degradation: a live, ungated dfa+never session must not stay silent.
  const degraded = harness({ capability: 'unknown', initial: { preset: LEGACY_AUTO_PRESET, sandbox: 'danger-full-access', approval: 'never' } })
  assert.equal(degradeAfterFailedMigration(degraded.session, degraded.deps), 'degraded-ask')
  assert.deepEqual(degraded.appends, [{ type: 'approval/policy', data: { policy: 'ask' } }])
  assert.equal(degraded.audits[0].stage, 'degraded-ask')

  // A modern upstream auto+never is covered by the upstream integration.
  const covered = harness({ capability: 'modern', initial: { preset: LEGACY_AUTO_PRESET, sandbox: 'danger-full-access', approval: 'never' } })
  assert.equal(degradeAfterFailedMigration(covered.session, covered.deps), 'covered')
  assert.equal(covered.appends.length, 0)
})

test('T11: audit lines carry the scan and per-session fields', () => {
  const ok = JSON.parse(migrationAuditLine({
    ok: true,
    sessionId: 's1',
    from: LEGACY_AUTO_PRESET,
    to: GATED_PRESET,
    branch: 'rescue-dfa-ask',
    knobs: { sandbox: 'danger-full-access', approval: 'ask' },
    at: AT,
  }))
  assert.equal(ok.type, 'preset-migration')
  assert.equal(ok.at, AT)
  assert.equal(ok.sessionId, 's1')
  assert.equal(ok.ok, true)
  assert.equal(ok.from, LEGACY_AUTO_PRESET)
  assert.equal(ok.to, GATED_PRESET)
  assert.equal(ok.branch, 'rescue-dfa-ask')
  assert.deepEqual(ok.knobs, { sandbox: 'danger-full-access', approval: 'ask' })

  const failed = JSON.parse(migrationAuditLine({ ok: false, stage: 'append', reason: 'append-threw', at: AT }))
  assert.equal(failed.stage, 'append')
  assert.equal(failed.reason, 'append-threw')

  const scan = JSON.parse(scanAuditLine({ candidates: 2, foreign: 1, never: 3, unknown: 4 }, AT))
  assert.deepEqual(scan, { type: 'preset-migration-scan', at: AT, candidates: 2, foreign: 1, never: 3, unknown: 4, unmigrated: 8 })

  // Classification drives those counts.
  assert.equal(classifyForMigration({ preset: LEGACY_AUTO_PRESET, sandbox: 'danger-full-access', approval: 'ask' }) , 'candidate')
  assert.equal(classifyForMigration({ preset: LEGACY_AUTO_PRESET, sandbox: 'danger-full-access', approval: 'never' }), 'never')
  assert.equal(classifyForMigration({ preset: LEGACY_AUTO_PRESET, sandbox: 'workspace-write', approval: 'ask' }), 'foreign')
  assert.equal(classifyForMigration({ preset: GATED_PRESET, sandbox: 'danger-full-access', approval: 'ask' }), 'foreign')
  assert.equal(classifyForMigration(undefined), 'unknown')
})

test('T12/T-S1..S4: the authority key walks to the parent-chain root', () => {
  const parentAgent = (id) => {
    if (id === 'root-1') return { session: { id: 'root-1' } }
    if (id === 'mid-1') return { session: { id: 'mid-1', header: { origin: 'subagent', parentSession: 'root-1' } } }
    return undefined
  }
  const root = { id: 'root-1' }
  const mid = { id: 'mid-1', header: { origin: 'subagent', parentSession: 'root-1' } }
  const child = { id: 'child-1', header: { origin: 'subagent', parentSession: 'mid-1' } }
  const gatedExec = (session) => ({ agent: { session } })

  // T-S1: the child's own gate still keys on the root.
  assert.equal(rootAuthoritySessionId(gatedExec(child), parentAgent), 'root-1')
  // T-S2: a non-gated child of a gated parent keys on the same root.
  assert.equal(rootAuthoritySessionId({ agent: { session: mid } }, parentAgent), 'root-1')
  // T-S3: a broken parent link stops at the last resolvable node.
  assert.equal(rootAuthoritySessionId(gatedExec({ id: 'orphan', header: { origin: 'subagent', parentSession: 'gone' } }), parentAgent), 'orphan')
  // T-S4: a plain session is its own root.
  assert.equal(rootAuthoritySessionId({ agent: { session: root } }, parentAgent), 'root-1')
  assert.equal(rootAuthoritySessionId({ agent: undefined }, parentAgent), undefined)
  // Cycles are cut by the visited set: the walk stops on the second sighting of
  // 'b' and the last resolved node is 'a'.
  const cyclicParent = (id) => (id === 'a' ? { session: { id: 'a', header: { origin: 'subagent', parentSession: 'b' } } } : { session: { id: 'b', header: { origin: 'subagent', parentSession: 'a' } } })
  assert.equal(rootAuthoritySessionId({ agent: { session: { id: 'a', header: { origin: 'subagent', parentSession: 'b' } } } }, cyclicParent), 'a')
})

test('safeResolveSpec and migrationDecision are shape checks, not guesses', () => {
  assert.deepEqual(safeResolveSpec({ resolve: () => OK_SPEC }, GATED_PRESET), OK_SPEC)
  assert.equal(safeResolveSpec({ resolve: () => { throw new Error('unknown') } }, GATED_PRESET), undefined)
  assert.equal(safeResolveSpec({}, GATED_PRESET), undefined)
  assert.deepEqual(migrationDecision({ preset: LEGACY_AUTO_PRESET, sandbox: 'danger-full-access', approval: 'ask' }), { eligible: true, branch: 'rescue-dfa-ask', reason: 'signature' })
  assert.deepEqual(migrationDecision({ preset: GATED_PRESET, sandbox: 'danger-full-access', approval: 'ask' }), { eligible: false, reason: 'not-auto' })
})

test('T13: compiled wiring anchors (retired symbols gone, raw gate and migration wired)', () => {
  const lib = compile('../lib/index.js')
  // Retired ensureAsk / foreign-auto flip is gone.
  assert.ok(!lib.includes('ensureAsk'), 'ensureAsk is deleted from the compiled host')
  assert.ok(!lib.includes('auto-switch-never-to-ask'), 'the retired debug event is gone')
  assert.ok(!lib.includes('approval.setPolicy(flip'), 'the foreign-auto flip is gone')
  assert.ok(!lib.includes('permissionFlipSessions'), 'the old suppression set name is gone')
  // Raw gate + migration + enforcement are wired.
  assert.ok(lib.includes('rawPresetOf('), 'the gate reads the raw preset helper')
  assert.ok(lib.includes('permissionState'), 'the baseline reads the host projection')
  assert.ok(lib.includes('enforceOwnSpec('), 'own-spec restore is wired into the host')
  assert.ok(lib.includes('runPresetMigration('), 'the migration is wired into the host')
  // The migration registration's option object, anchored as a shape rather than
  // as a whole call string (a parameter rename, an extra space or a missing
  // semicolon is not the defect). The product carries a second
  // `prepend: true, global: true` listener (the answerer), so two independent
  // option lookups would stay green after this registration lost its options —
  // the runLifecycleMigration prefix is what makes the match discriminating.
  assert.equal(
    [...lib.matchAll(/runLifecycleMigration\(\w+\),\s*\{\s*prepend: true,\s*global: true\s*\}/g)].length,
    1,
    'exactly one migration registration carries prepend+global',
  )
  assert.ok(lib.includes('rootAuthoritySessionId('), 'the authority key walks to the root')
  assert.ok(lib.includes('pluginInitiatedSessions'), 'plugin-initiated suppression is wired')
  assert.ok(lib.includes('scanAuditLine('), 'the startup scan audit is wired into the host')
  const moduleLib = compile('../lib/auto/preset-migration.js')
  assert.ok(moduleLib.includes('preset-spec-restore'), 'the restore audit line is emitted by the decision layer')
  assert.ok(moduleLib.includes('preset-migration-scan'), 'the scan audit line is emitted by the decision layer')
  // The retired key has no behavioral read: the only occurrence is the
  // resolveConfig warn + normalize, and the schema/default passthrough.
  assert.ok(!lib.includes('autoSwitchPolicyToAsk ||') && !lib.includes('!config.autoSwitchPolicyToAsk'))
})
