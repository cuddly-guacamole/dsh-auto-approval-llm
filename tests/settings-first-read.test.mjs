/**
 * First stored-config read: deterministic signal + bounded retry.
 *
 * `settings.describe()` lists only the entries whose fiber is ACTIVE, and this
 * plugin's own fiber reaches ACTIVE only after `apply()` returns, so the first
 * stored read cannot succeed synchronously. A single next-tick read is not
 * enough either: a sibling entry or a config reload can push that transition
 * later, and a missed read would silently pin every card-owned key to the
 * shipped loader defaults for the whole process life. These tests pin the
 * contract on the compiled bundle:
 *
 *  - a row that appears only after several empty reads is still applied
 *    (bounded retry, not one next-tick shot);
 *  - an empty `describe()` after a successful read never writes the entry base
 *    back over the loaded config — the host emits `settings/document-updated`
 *    when the entry LEAVES the active set, so that case is reachable in normal
 *    use, not just at startup;
 *  - the retry budget is bounded and spending it is reported through the
 *    settings error channel instead of silently keeping the shipped defaults;
 *  - `settings/document-updated` only reacts to this plugin's own namespace;
 *  - the effect disposer stops the polling for good, including after a later
 *    signal.
 *
 * Every behavior is paired with a reverse control that removes exactly one
 * statement from an in-memory copy of the compiled module, so each assertion is
 * attributable to that statement and not to the fixture. The variant is served
 * from the module loader; nothing is written to disk.
 *
 * The pre-execute plane is the observable: a stored `denyList` entry turns a
 * call that the entry-config base allows into a hard denial, so "the stored
 * config is live" and "the entry base is live" are two different verdicts.
 *
 * Run: node --test tests/settings-first-read.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import { apply } from '../lib/index.js'
import { setRuntimePathsForTests } from '../lib/auto/runtime-paths.js'

const LIB_URL = new URL('../lib/index.js', import.meta.url)
const SETTINGS_NS = 'auto-approval-llm'
const OTHER_NS = 'some-other-plugin'
const STORED_TOOL = 'read'
const UNAVAILABLE =
  'settings plane unavailable: the host never listed this plugin entry, so the stored configuration could not be read; running on the shipped defaults'
const EMPTY_READS = 5

/** A stored row shaped like the host projection: our ns, our card-owned keys. */
const storedRow = () => [{ ns: SETTINGS_NS, value: { denyList: [STORED_TOOL] }, revision: 3, applies: 'live' }]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, what, timeoutMs = 6000) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value !== undefined && value !== false && value !== null) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for: ${what}`)
    await sleep(10)
  }
}

/**
 * Boot apply() against a fake host that adds a settings plane to the seams
 * tests/helpers/host-ctx.mjs models.
 *
 * `readRow` answers every describe() call, so a test can make the row appear
 * late (retry), disappear again (downgrade guard) or never appear (budget).
 * `plugin` selects the bundle instance under test, which is how the reverse
 * controls drive a build with one statement removed.
 */
function startHost({ readRow, config = {}, plugin = apply } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'first-read-state-'))
  const workspace = mkdtempSync(join(tmpdir(), 'first-read-ws-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'first-read-dsh-'))
  const routes = new Map()
  const handlers = new Map()
  const disposers = []
  // Counted here rather than in the test body: the settings projection reads
  // describe() too, so a caller that measures the polling has to be able to
  // take a fresh count after it has read the projection.
  let describeCalls = 0
  const settings = { describe: () => { describeCalls += 1; return readRow() }, writable: true }
  const permissionPresets = {
    names: ['auto-approval'],
    permissionState: () => ({ preset: 'auto-approval', sandbox: 'danger-full-access', approval: 'ask' }),
    resolve: () => ({ sandbox: 'danger-full-access', approval: 'ask' }),
    specOf: () => undefined,
  }
  const get = (name) => {
    if (name === 'approval') return { config: { policy: 'ask' } }
    if (name === 'permissionPresets') return permissionPresets
    if (name === 'tools') return {}
    if (name === 'llm') return {}
    if (name === 'settings') return settings
    if (name === 'connection') return { fetch: { register: (spec) => { routes.set(spec.path, spec); return () => {} } } }
    return undefined
  }
  const ctx = {
    get,
    on: (event, fn) => {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
      return () => {}
    },
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
    },
  }
  setRuntimePathsForTests({ stateDir })
  plugin(ctx, {
    enabled: true,
    timeoutAction: 'reject',
    categoryMode: 'standard',
    denyList: [],
    allowlist: [],
    humanOnlyList: [],
    rulesText: '',
    onboardingMessageEnabled: false,
    learningEnabled: false,
    directHumanEnabled: false,
    redactResults: false,
    maxArgsChars: 20000,
    highRiskSeconds: 30,
    loopDetectionThreshold: 0,
    workspaceRoot: workspace,
    dshHome,
    ...config,
  })

  const emitDocumentUpdated = (ns, revision) => {
    const list = handlers.get('settings/document-updated') ?? []
    assert.ok(list.length > 0, 'the document-updated listener must be registered')
    for (const fn of list) fn(ns, revision)
  }

  /** The settings GET projection is the only channel that carries configError. */
  const settingsProjection = async () => {
    const spec = routes.get('/api/auto-approval-llm/settings')
    assert.ok(spec, 'the settings route must be registered')
    const response = await spec.fetch(new Request('http://127.0.0.1:3080/api/auto-approval-llm/settings', {
      headers: { host: 'localhost:3080' },
    }))
    const body = await response.json()
    return { status: response.status, configError: body?.value?.configError ?? null }
  }

  let callId = 0
  const preExecuteVerdict = async () => {
    const list = handlers.get('tools/pre-execute') ?? []
    assert.ok(list.length > 0, 'the pre-execute plane must be registered')
    const id = `first-read-${++callId}`
    const session = { id: `${id}-session`, header: { cwd: workspace, origin: 'user' }, events: [], snapshotEvents: () => [] }
    const exec = {
      name: STORED_TOOL,
      arguments: { file_path: join(workspace, 'note.txt') },
      callId: id,
      token: `token-${id}`,
      agent: { session },
    }
    return list[0](exec, async () => ({ kind: 'allow' }))
  }

  const waitForDenied = () => waitFor(async () => {
    const verdict = await preExecuteVerdict()
    return verdict?.kind === 'deny' ? verdict : undefined
  }, 'the stored denyList to reach the pre-execute plane')

  const waitForConfigError = () => waitFor(async () => {
    const { configError } = await settingsProjection()
    return configError === null ? undefined : configError
  }, 'the settings error channel to report the unreadable settings plane')

  const runDisposers = () => {
    for (const disposer of disposers.splice(0)) disposer()
  }

  const dispose = () => {
    runDisposers()
    setRuntimePathsForTests(undefined)
    for (const dir of [stateDir, workspace, dshHome]) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  return { workspace, dshHome, emitDocumentUpdated, settingsProjection, preExecuteVerdict, waitForDenied, waitForConfigError, runDisposers, readCount: () => describeCalls, resetReads: () => { describeCalls = 0 }, dispose }
}

/**
 * Run `body` against a build of the compiled bundle with one statement removed
 * or replaced. The anchor must occur exactly once, so a renamed statement fails
 * loudly instead of silently patching the wrong place.
 */
async function withVariant(label, from, to, body) {
  const real = readFileSync(LIB_URL, 'utf8')
  assert.equal(real.split(from).length - 1, 1, `the compiled bundle must carry exactly one \`${from}\``)
  const patched = real.replace(from, to)
  const patchedUrl = `${LIB_URL.href}?variant=${label}`
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context)
      return resolved.url === LIB_URL.href ? { ...resolved, url: patchedUrl } : resolved
    },
    load(url, context, nextLoad) {
      if (url === patchedUrl) return { format: 'module', source: patched, shortCircuit: true }
      return nextLoad(url, context)
    },
  })
  try {
    const { apply: variantApply } = await import(LIB_URL.href)
    await body(variantApply)
  } finally {
    hook.deregister()
  }
}

test('a stored row that appears only after several empty reads is still applied', async (t) => {
  let reads = 0
  const host = startHost({
    readRow: () => {
      reads += 1
      return reads > EMPTY_READS ? storedRow() : []
    },
  })
  t.after(host.dispose)

  const verdict = await host.waitForDenied()
  assert.match(verdict.reason, /denyList read/, 'the stored row decides the verdict')
  assert.ok(reads > EMPTY_READS, `the read must be retried past the next tick (describe calls: ${reads})`)
  assert.equal((await host.settingsProjection()).configError, null)
})

test('an empty describe() after a successful read never downgrades the loaded config', async (t) => {
  let readable = true
  const host = startHost({ readRow: () => (readable ? storedRow() : []) })
  t.after(host.dispose)

  assert.equal((await host.preExecuteVerdict()).kind, 'deny', 'precondition: the stored row is live')
  // The entry leaving the active set is reported by the host as the same
  // document-updated signal, so this is the reachable downgrade path.
  readable = false
  host.emitDocumentUpdated(SETTINGS_NS, 4)
  await sleep(250)

  assert.equal((await host.preExecuteVerdict()).kind, 'deny', 'an empty describe() must not write the entry base back')
  assert.equal((await host.settingsProjection()).configError, null, 'an empty describe() is not an error')
})

test('disposing the effect stops the first-read polling, including on a later signal', async (t) => {
  let reads = 0
  const host = startHost({ readRow: () => { reads += 1; return [] } })
  t.after(host.dispose)

  await sleep(120)
  const seen = reads
  assert.ok(seen > 1, `precondition: the polling chain ran (describe calls: ${seen})`)
  host.runDisposers()
  await sleep(200)
  assert.equal(reads, seen, 'a disposed effect must not keep polling')
  // A signal still reads the row once (the listener is not disposed with the
  // effect), but it must not re-arm the polling chain.
  host.emitDocumentUpdated(SETTINGS_NS, 5)
  await sleep(200)
  const afterSignal = reads
  assert.ok(afterSignal <= seen + 1, `a later signal must not restart the chain (describe calls: ${afterSignal})`)
  await sleep(250)
  assert.equal(reads, afterSignal, 'and the chain must stay stopped after that read')
})

test('settings/document-updated only reacts to this plugin namespace', async (t) => {
  let readable = false
  const host = startHost({ readRow: () => (readable ? storedRow() : []) })
  t.after(host.dispose)

  // Spend the budget first: from here the signal is the only thing that can
  // still apply the row, so the namespace filter is observed in isolation.
  assert.equal(await host.waitForConfigError(), UNAVAILABLE)
  readable = true
  host.emitDocumentUpdated(OTHER_NS, 7)
  await sleep(250)
  assert.notEqual((await host.preExecuteVerdict()).kind, 'deny', 'another namespace must not re-read our row')
  assert.equal((await host.settingsProjection()).configError, UNAVAILABLE, 'another namespace must not touch our error')

  host.emitDocumentUpdated(SETTINGS_NS, 8)
  const verdict = await host.waitForDenied()
  assert.match(verdict.reason, /denyList read/)
  assert.equal((await host.settingsProjection()).configError, null, 'a successful read clears the reported error')
})

test('a settings plane that never lists the entry is bounded, reported and stays fail-closed', async (t) => {
  // The entry-config base already denies this call: whatever the unreadable
  // settings plane does, that base has to stay live.
  const host = startHost({ readRow: () => [], config: { denyList: [STORED_TOOL] } })
  t.after(host.dispose)

  // Mid-budget the chain is still retrying, and the attempts already made are
  // within the shipped budget.
  await sleep(1200)
  assert.ok(host.readCount() > 3, `the first read must be retried (describe calls: ${host.readCount()})`)
  assert.ok(host.readCount() < 45, `mid-budget polling must stay within the budget (describe calls: ${host.readCount()})`)

  assert.equal(await host.waitForConfigError(), UNAVAILABLE)
  // Spending the budget settles the chain for good, rather than leaving a poll
  // loop behind the error banner. (The projection read above bumps the count,
  // so the settle window starts from a fresh count.)
  host.resetReads()
  await sleep(400)
  assert.equal(host.readCount(), 0, 'the spent budget must stop the polling')

  const verdict = await host.preExecuteVerdict()
  assert.equal(verdict.kind, 'deny', 'the entry-config base stays live')
  assert.match(verdict.reason, /denyList read/)
  assert.equal((await host.settingsProjection()).status, 200, 'the card channel still answers')
})

test('reverse control: without the retry budget a row after the first next-tick read is lost', async (t) => {
  await withVariant('single-attempt', 'retryAttempts >= SETTINGS_FIRST_READ_MAX_ATTEMPTS', 'retryAttempts >= 1', async (variantApply) => {
    let reads = 0
    const host = startHost({
      plugin: variantApply,
      readRow: () => {
        reads += 1
        return reads > EMPTY_READS ? storedRow() : []
      },
    })
    t.after(host.dispose)

    assert.notEqual((await host.preExecuteVerdict()).kind, 'deny', 'the row that needs a retry is never applied')
    assert.equal(await host.waitForConfigError(), UNAVAILABLE, 'one attempt is the defect: the budget ends empty')
    host.resetReads()
    await sleep(250)
    assert.equal(host.readCount(), 0, 'the single attempt is already spent, so nothing is left to poll with')
  })
})

test('reverse control: without the empty-row guard a later empty describe() downgrades the config', async (t) => {
  await withVariant('no-guard', 'if (row === undefined)\n                return false;', '', async (variantApply) => {
    let readable = true
    const host = startHost({ plugin: variantApply, readRow: () => (readable ? storedRow() : []) })
    t.after(host.dispose)

    assert.equal((await host.preExecuteVerdict()).kind, 'deny', 'precondition: the stored row is live')
    readable = false
    host.emitDocumentUpdated(SETTINGS_NS, 4)
    await sleep(200)
    assert.notEqual((await host.preExecuteVerdict()).kind, 'deny', 'without the guard the entry base is written back')
  })
})

test('reverse control: without the spent-budget report the failure stays silent', async (t) => {
  await withVariant('no-budget-report', 'configError = SETTINGS_UNAVAILABLE_ERROR;', 'void 0;', async (variantApply) => {
    let reads = 0
    const host = startHost({ plugin: variantApply, readRow: () => { reads += 1; return [] } })
    t.after(host.dispose)

    await sleep(2600)
    assert.ok(reads > 3, `precondition: the budget was spent (describe calls: ${reads})`)
    assert.equal((await host.settingsProjection()).configError, null, 'without the report nothing reaches the card')
  })
})

test('reverse control: without the namespace filter any document update re-reads our row', async (t) => {
  await withVariant('no-ns-filter', 'if (ns !== SETTINGS_NS)\n                return;', '', async (variantApply) => {
    let readable = false
    const host = startHost({ plugin: variantApply, readRow: () => (readable ? storedRow() : []) })
    t.after(host.dispose)

    await host.waitForConfigError()
    readable = true
    host.emitDocumentUpdated(OTHER_NS, 7)
    await sleep(250)
    assert.equal((await host.preExecuteVerdict()).kind, 'deny', 'without the filter another namespace applies our row')
  })
})

test('reverse control: without the budget cap the polling never settles', async (t) => {
  await withVariant('unbounded', 'retryAttempts >= SETTINGS_FIRST_READ_MAX_ATTEMPTS', 'false', async (variantApply) => {
    const host = startHost({ plugin: variantApply, readRow: () => [] })
    t.after(host.dispose)

    await sleep(2400)
    const first = host.readCount()
    assert.ok(first >= 20, `precondition: the variant is polling (describe calls: ${first})`)
    await sleep(400)
    assert.ok(host.readCount() > first, `without the cap the chain never settles (describe calls: ${host.readCount()})`)
    assert.equal((await host.settingsProjection()).configError, null, 'and the failure is never reported')
  })
})

test('reverse control: without the disposal flag a later signal resurrects the polling chain', async (t) => {
  await withVariant('no-dispose-flag', 'retryDisposed = true;', '', async (variantApply) => {
    let reads = 0
    const host = startHost({ plugin: variantApply, readRow: () => { reads += 1; return [] } })
    t.after(host.dispose)

    await sleep(120)
    const seen = reads
    assert.ok(seen > 1, `precondition: the polling chain ran (describe calls: ${seen})`)
    host.runDisposers()
    host.emitDocumentUpdated(SETTINGS_NS, 5)
    await sleep(250)
    assert.ok(reads > seen, `without the flag the chain restarts after disposal (describe calls: ${reads})`)
  })
})
