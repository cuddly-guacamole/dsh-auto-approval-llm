/**
 * dsh-auto-approval-llm · upstream contract surface + the raw-identity canary.
 *
 * The judgment source is the REAL installed `@deepseek-ai/*` packages resolved
 * from this checkout's `node_modules`. Every path is derived from
 * `import.meta.url`; no clone, no absolute path outside the repository, so the
 * file runs unchanged on any machine. A package that is not installed — or is
 * an unresolvable link — is reported as a skip, never as a failure: an absent
 * optional peer is not a broken contract.
 *
 * The surface probe reads the loaded modules, not their text: a row passes when
 * the name is reachable at runtime (a named export, a class static, or an own
 * prototype member) through the same ESM entry the host would mount.
 *
 * The second half is the semantic canary the name probe cannot express.
 * `PermissionPresetService.permissionState()` is declared `private` upstream and
 * the plugin reaches it through an `any`-typed capability probe, so a rename or
 * removal is visible but a change of MEANING is not. The criterion it carries is
 * `permissionState(session).preset === "auto-approval"` — the durable raw
 * identity — and `current()` folds a drifted knob away, so the two disagree on a
 * real session. The canary builds exactly that session against the real service
 * and the real projection reducer, and asserts the plugin still gates on the raw
 * side. The control case asserts the same fixture with no drift derives back to
 * the gated name, so the raw assertion cannot pass merely because raw and
 * derived always agree.
 *
 * Run: node --test tests/host-contract-surface.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { GATED_PRESET, HOST_LINES, packageEntry, presetTableFromPatch } from '../scripts/test-host-lines.mjs'
import { gatePresetNames, isGatedSession, rawPresetOf } from '../lib/auto/preset-migration.js'
import { autoPermissionAuthority } from '../lib/auto/gate-decision.js'

/** The repository root, derived from this file's own location. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The shipped preset composition; the derived name depends on this exact table. */
const PRESET_TABLE = presetTableFromPatch(readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8'))

/**
 * One row per upstream name the plugin reaches. `kind` selects how the name is
 * reached: a named export of the package entry, a static of a named class, or an
 * own member of that class's prototype. The list is the plugin's own call
 * surface, grouped by the package that carries it.
 */
const CONTRACT_SURFACE = [
  { id: 'cordis.Context', pkg: '@deepseek-ai/cordis', kind: 'export', member: 'Context' },
  { id: 'cordis.Context.effect', pkg: '@deepseek-ai/cordis', kind: 'static', owner: 'Context', member: 'effect' },
  { id: 'cordis.reflect.get', pkg: '@deepseek-ai/cordis', kind: 'proto', owner: 'RegistryService', member: 'get' },
  { id: 'cordis.reflect.inject', pkg: '@deepseek-ai/cordis', kind: 'proto', owner: 'RegistryService', member: 'inject' },
  { id: 'cordis.events.on', pkg: '@deepseek-ai/cordis', kind: 'proto', owner: 'EventsService', member: 'on' },
  { id: 'cordis.events.waterfall', pkg: '@deepseek-ai/cordis', kind: 'proto', owner: 'EventsService', member: 'waterfall' },
  { id: 'cordis.events.dispatch', pkg: '@deepseek-ai/cordis', kind: 'proto', owner: 'EventsService', member: 'dispatch' },
  { id: 'schemastery.default', pkg: '@deepseek-ai/schemastery', kind: 'export', member: 'default' },

  { id: 'llm.createUserMessage', pkg: '@deepseek-ai/dsh-llm', kind: 'export', member: 'createUserMessage' },
  { id: 'llm.BlockAssembler', pkg: '@deepseek-ai/dsh-llm', kind: 'export', member: 'BlockAssembler' },
  { id: 'llm.BlockAssembler.push', pkg: '@deepseek-ai/dsh-llm', kind: 'proto', owner: 'BlockAssembler', member: 'push' },
  { id: 'llm.BlockAssembler.assemble', pkg: '@deepseek-ai/dsh-llm', kind: 'proto', owner: 'BlockAssembler', member: 'assemble' },
  { id: 'llm.LlmRuntime.stream', pkg: '@deepseek-ai/dsh-llm', kind: 'proto', owner: 'LlmRuntime', member: 'stream' },
  { id: 'llm.LlmRuntime.prepareCall', pkg: '@deepseek-ai/dsh-llm', kind: 'proto', owner: 'LlmRuntime', member: 'prepareCall' },
  { id: 'llm.LlmRuntime.listModels', pkg: '@deepseek-ai/dsh-llm', kind: 'proto', owner: 'LlmRuntime', member: 'listModels' },
  { id: 'llm.LlmRuntime.resolveModelInfo', pkg: '@deepseek-ai/dsh-llm', kind: 'proto', owner: 'LlmRuntime', member: 'resolveModelInfo' },
  { id: 'llm.LlmRuntime.listProviders', pkg: '@deepseek-ai/dsh-llm', kind: 'proto', owner: 'LlmRuntime', member: 'listProviders' },

  { id: 'tools.ToolRuntime.guard', pkg: '@deepseek-ai/dsh-tools', kind: 'proto', owner: 'ToolRuntime', member: 'guard' },
  { id: 'tools.ToolRuntime.register', pkg: '@deepseek-ai/dsh-tools', kind: 'proto', owner: 'ToolRuntime', member: 'register' },
  { id: 'tools.ToolRuntime.schemas', pkg: '@deepseek-ai/dsh-tools', kind: 'proto', owner: 'ToolRuntime', member: 'schemas' },

  { id: 'session.Session', pkg: '@deepseek-ai/dsh-session', kind: 'export', member: 'Session' },
  { id: 'session.Session.append', pkg: '@deepseek-ai/dsh-session', kind: 'proto', owner: 'Session', member: 'append' },
  { id: 'session.Session.snapshotEvents', pkg: '@deepseek-ai/dsh-session', kind: 'proto', owner: 'Session', member: 'snapshotEvents' },
  { id: 'session.Session.requestHeader', pkg: '@deepseek-ai/dsh-session', kind: 'proto', owner: 'Session', member: 'requestHeader' },
  { id: 'session.KNOWN_SESSION_EVENT_TYPES', pkg: '@deepseek-ai/dsh-session', kind: 'export', member: 'KNOWN_SESSION_EVENT_TYPES' },

  { id: 'agent.AgentRegistry', pkg: '@deepseek-ai/dsh-agent', kind: 'export', member: 'AgentRegistry' },
  { id: 'agent.AgentRegistry.get', pkg: '@deepseek-ai/dsh-agent', kind: 'proto', owner: 'AgentRegistry', member: 'get' },
  { id: 'agent.AgentRegistry.list', pkg: '@deepseek-ai/dsh-agent', kind: 'proto', owner: 'AgentRegistry', member: 'list' },

  { id: 'permissionPresets.PermissionPresetService', pkg: '@deepseek-ai/dsh-permission-presets', kind: 'export', member: 'PermissionPresetService' },
  { id: 'permissionPresets.permissionState', pkg: '@deepseek-ai/dsh-permission-presets', kind: 'proto', owner: 'PermissionPresetService', member: 'permissionState' },
  { id: 'permissionPresets.current', pkg: '@deepseek-ai/dsh-permission-presets', kind: 'proto', owner: 'PermissionPresetService', member: 'current' },
  { id: 'permissionPresets.set', pkg: '@deepseek-ai/dsh-permission-presets', kind: 'proto', owner: 'PermissionPresetService', member: 'set' },
  { id: 'permissionPresets.registerAuto', pkg: '@deepseek-ai/dsh-permission-presets', kind: 'proto', owner: 'PermissionPresetService', member: 'registerAuto' },
  { id: 'permissionPresets.catalog', pkg: '@deepseek-ai/dsh-permission-presets', kind: 'proto', owner: 'PermissionPresetService', member: 'catalog' },
  { id: 'permissionPresets.names', pkg: '@deepseek-ai/dsh-permission-presets', kind: 'proto', owner: 'PermissionPresetService', member: 'names' },
  { id: 'permissionPresets.specOf', pkg: '@deepseek-ai/dsh-permission-presets', kind: 'proto', owner: 'PermissionPresetService', member: 'specOf' },
  { id: 'permissionPresets.resolve', pkg: '@deepseek-ai/dsh-permission-presets', kind: 'proto', owner: 'PermissionPresetService', member: 'resolve' },
  { id: 'permissionPresets.derive', pkg: '@deepseek-ai/dsh-permission-presets', kind: 'proto', owner: 'PermissionPresetService', member: 'derive' },
  { id: 'permissionPresets.AUTO_PRESET', pkg: '@deepseek-ai/dsh-permission-presets', kind: 'export', member: 'AUTO_PRESET' },
  { id: 'permissionPresets.CUSTOM_PRESET', pkg: '@deepseek-ai/dsh-permission-presets', kind: 'export', member: 'CUSTOM_PRESET' },

  { id: 'approval.APPROVAL_POLICIES', pkg: '@deepseek-ai/dsh-user-approval', kind: 'export', member: 'APPROVAL_POLICIES' },
  { id: 'approval.setApprovalPolicy', pkg: '@deepseek-ai/dsh-user-approval', kind: 'export', member: 'setApprovalPolicy' },
  { id: 'approval.ApprovalService', pkg: '@deepseek-ai/dsh-user-approval', kind: 'export', member: 'ApprovalService' },
  { id: 'approval.ApprovalService.setPolicy', pkg: '@deepseek-ai/dsh-user-approval', kind: 'proto', owner: 'ApprovalService', member: 'setPolicy' },
  { id: 'approval.ApprovalService.request', pkg: '@deepseek-ai/dsh-user-approval', kind: 'proto', owner: 'ApprovalService', member: 'request' },
  { id: 'approval.ApprovalService.effectivePolicy', pkg: '@deepseek-ai/dsh-user-approval', kind: 'proto', owner: 'ApprovalService', member: 'effectivePolicy' },
  { id: 'approval.ApprovalService.decide', pkg: '@deepseek-ai/dsh-user-approval', kind: 'proto', owner: 'ApprovalService', member: 'decide' },

  { id: 'typert.TypertRemoteService', pkg: '@deepseek-ai/dsh-typert-protocol', kind: 'export', member: 'TypertRemoteService' },

  { id: 'primitives.Button', pkg: '@deepseek-ai/dsh-client-ui-primitives', kind: 'export', member: 'Button' },
  { id: 'primitives.Input', pkg: '@deepseek-ai/dsh-client-ui-primitives', kind: 'export', member: 'Input' },
]

/**
 * Names the plugin never reads and the service must therefore never grow: a
 * client-side field that would bind a duck-typed probe to the wrong object, and
 * a placeholder. Both keep the row reader falsifiable — a reader that reported
 * every name as present would satisfy every row above as well.
 */
const ABSENT_ON_SERVICE = ['pendingInteractions', 'thisMemberDoesNotExist']

/** Load one installed package entry. Returns the reason instead of throwing. */
const loaded = new Map()
async function loadPackage(pkg) {
  if (loaded.has(pkg)) return loaded.get(pkg)
  const result = await (async () => {
    if (!existsSync(join(ROOT, 'node_modules', ...pkg.split('/'), 'package.json')))
      return { ok: false, reason: 'not installed in this checkout' }
    let entry
    try {
      entry = packageEntry(ROOT, pkg)
    } catch (error) {
      return { ok: false, reason: 'no resolvable ESM entry: ' + error.message }
    }
    try {
      return { ok: true, mod: await import(pathToFileURL(entry).href) }
    } catch (error) {
      return { ok: false, reason: 'entry failed to load: ' + String(error && error.message).split('\n')[0] }
    }
  })()
  loaded.set(pkg, result)
  return result
}

/** Whether a row's name is reachable at runtime through the package entry. */
function reaches(mod, row) {
  if (row.kind === 'export') return mod[row.member] !== undefined
  const owner = mod[row.owner]
  if (typeof owner !== 'function') return false
  if (row.kind === 'static') return Object.getOwnPropertyNames(owner).includes(row.member)
  return owner.prototype !== undefined && Object.getOwnPropertyNames(owner.prototype).includes(row.member)
}

test('every resolvable upstream contract name is reachable at runtime', async t => {
  const unresolved = new Map()
  for (const row of CONTRACT_SURFACE) {
    const pkg = await loadPackage(row.pkg)
    await t.test(row.id, { skip: pkg.ok ? false : row.pkg + ': ' + pkg.reason }, () => {
      assert.equal(reaches(pkg.mod, row), true, row.id + ' is not reachable in ' + row.pkg)
    })
    if (!pkg.ok) unresolved.set(row.pkg, pkg.reason)
  }
  t.diagnostic('packages not installed here, rows skipped: ' + (unresolved.size === 0
    ? 'none'
    : [...unresolved].map(([pkg, reason]) => pkg + ' (' + reason + ')').join(', ')))
})

test('the contract reader reports an absent name as absent', async t => {
  const pkg = await loadPackage('@deepseek-ai/dsh-permission-presets')
  await t.test('service rows', { skip: pkg.ok ? false : pkg.reason }, () => {
    for (const absent of ABSENT_ON_SERVICE) {
      assert.equal(reaches(pkg.mod, { kind: 'proto', owner: 'PermissionPresetService', member: absent }), false, absent + ' is present on the service')
    }
  })
  await t.test('a row naming a package that is not installed', async () => {
    const missing = await loadPackage('@deepseek-ai/dsh-not-a-real-package')
    assert.equal(missing.ok, false)
    assert.equal(typeof missing.reason, 'string')
  })
})

/**
 * Mount the real permission-presets service of the installed host line over a
 * cordis context, and return it. `ctx.sessions.list()` is empty so the service
 * pins nothing on its own: every session below is built from explicit events.
 */
async function mountService() {
  const cordis = await loadPackage('@deepseek-ai/cordis')
  if (!cordis.ok) return { ok: false, reason: cordis.reason }
  const presets = await loadPackage('@deepseek-ai/dsh-permission-presets')
  if (!presets.ok) return { ok: false, reason: presets.reason }
  const { Context } = cordis.mod
  const { PermissionPresetService } = presets.mod
  const ctx = new Context()
  ctx.provide('shell', { sandboxMode: 'workspace-write' })
  ctx.provide('approval', { config: { policy: 'ask' }, setPolicy() {}, setPolicyForInitialization() {} })
  ctx.provide('sessions', { list: () => [] })
  ctx.provide('events', { dispatch: () => [] })
  let unit
  ctx.provide('sessionProjections', {
    register(registered) { unit = registered },
    stateOf(session) {
      if (unit === undefined) throw new Error('the permissions projection was never registered')
      let state = unit.init()
      for (const event of session.events) state = unit.apply(state, event)
      return state
    },
  })
  ctx.plugin(PermissionPresetService, { presets: PRESET_TABLE, defaultPreset: GATED_PRESET })
  for (let attempt = 0; attempt < 100 && ctx.permissionPresets === undefined; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  if (ctx.permissionPresets === undefined) return { ok: false, reason: 'the permission-presets service did not register' }
  return { ok: true, service: ctx.permissionPresets }
}

/** A session whose log is exactly the given events. */
function sessionOf(events, id = 'contract-1') {
  return { id, events, append(type, data) { this.events.push({ type, data }) } }
}

/** The plugin's own preset selected, at the composition sandbox, asking for approval. */
const ON_OWN_PRESET = [
  { type: 'permission/preset', data: { preset: GATED_PRESET } },
  { type: 'sandbox/mode', data: { mode: 'danger-full-access' } },
  { type: 'approval/policy', data: { policy: 'ask' } },
]

test('permissionState reports the durable raw identity where the derived name differs', async t => {
  const mounted = await mountService()
  await t.test('the service mounts', { skip: mounted.ok ? false : mounted.reason }, async () => {
    const { service } = mounted
    const gate = gatePresetNames(HOST_LINES.rc2.capability)
    assert.deepEqual([...gate], [GATED_PRESET])

    // (1) no drift: the raw name and the derived name agree.
    const aligned = sessionOf(ON_OWN_PRESET, 'contract-aligned')
    assert.equal(service.current(aligned), GATED_PRESET)
    assert.equal(rawPresetOf(service, aligned), GATED_PRESET)
    assert.equal(isGatedSession(service, aligned, gate), true)

    // (2) a never override lands on the knobs while the recorded preset stays put.
    //     derive() drops the recorded name once its bundle no longer matches and
    //     the table scan returns the host's own danger-full-access entry.
    const neverOverride = sessionOf([...ON_OWN_PRESET, { type: 'approval/policy', data: { policy: 'never' } }], 'contract-never')
    assert.equal(service.current(neverOverride), 'danger-full-access')
    assert.equal(gate.includes(service.current(neverOverride)), false)
    assert.equal(rawPresetOf(service, neverOverride), GATED_PRESET)
    assert.equal(isGatedSession(service, neverOverride, gate), true)
    assert.equal(autoPermissionAuthority({ agent: { session: neverOverride } }, () => undefined, service, gate)?.session, neverOverride)

    // (3) a sandbox change alone produces the same split.
    const sandboxDrift = sessionOf([...ON_OWN_PRESET, { type: 'sandbox/mode', data: { mode: 'workspace-write' } }], 'contract-sandbox')
    assert.equal(service.current(sandboxDrift), 'workspace-write')
    assert.equal(gate.includes(service.current(sandboxDrift)), false)
    assert.equal(rawPresetOf(service, sandboxDrift), GATED_PRESET)
    assert.equal(isGatedSession(service, sandboxDrift, gate), true)
  })
})

test('the divergence fixture is one where raw and derived decide the gate differently', async t => {
  const mounted = await mountService()
  await t.test('reporting the derived name ungates the same session', { skip: mounted.ok ? false : mounted.reason }, () => {
    const { service } = mounted
    const gate = gatePresetNames(HOST_LINES.rc2.capability)
    const session = sessionOf([...ON_OWN_PRESET, { type: 'approval/policy', data: { policy: 'never' } }], 'contract-counterfactual')
    // A facade over the real service that keeps the name and the declared shape
    // and changes only which value is reported — the upstream edit this file
    // detects. It is a control on the fixture, not the subject under test.
    const derivedReading = { permissionState: target => ({ ...service.permissionState(target), preset: service.current(target) }) }
    assert.equal(rawPresetOf(service, session), GATED_PRESET)
    assert.equal(rawPresetOf(derivedReading, session), 'danger-full-access')
    assert.equal(isGatedSession(service, session, gate), true)
    assert.equal(isGatedSession(derivedReading, session, gate), false)
    assert.equal(autoPermissionAuthority({ agent: { session } }, () => undefined, derivedReading, gate), undefined)
  })
})
