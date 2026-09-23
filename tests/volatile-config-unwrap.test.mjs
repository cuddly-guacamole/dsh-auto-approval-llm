/**
 * Volatile config unwrap contract.
 *
 * The host config plane resolves the Config schema before it hands the value to
 * the plugin, and schemastery hands out a volatile (card-owned) field as a
 * `{ get(), [Symbol.for('cosmokit.volatile.write')] }` reference rather than as
 * the configured scalar. `resolveConfig` therefore unwraps its whole input once
 * at the entry point. These tests pin that contract on the compiled lib:
 *
 *  - the unwrapped values are real scalars, so `resolveConfig` resolves instead
 *    of throwing `unknown timeoutAction "[object Object]"`;
 *  - the unwrap is REQUIRED: a build of the compiled `resolveConfig` without the
 *    unwrap line still throws on the same input, so a future edit that drops
 *    the unwrap reddens here;
 *  - the unwrap is idempotent and does not mutate its argument;
 *  - the reference shape and the marked key set stay pinned.
 *
 * Run: node --test tests/volatile-config-unwrap.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { Config, resolveConfig } from '../lib/index.js'
import { EDITABLE_CONFIG_KEYS, isVolatileConfig, plainConfigValue } from '../lib/auto/decision.js'

const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')
const TIMEOUT_ACTIONS = ['reject', 'allow', 'low-risk-allow']
/** The one line the whole contract rests on, pinned by text in the reverse test. */
const UNWRAP_STATEMENT = 'raw = plainConfigValue(raw);'

/** The card-owned keys the resolved schema hands out as references. */
const referenceKeys = (resolved) => Object.keys(resolved).filter((key) => isVolatileConfig(resolved[key]))

/** The reference shape the schema resolves a volatile field to. */
const referenceOf = (read) => Object.freeze({ get: read, [VOLATILE_WRITE]: () => {} })

/** Count the volatile references anywhere in a plain data tree. */
const countReferences = (value) => {
  if (isVolatileConfig(value)) return 1
  if (Array.isArray(value)) return value.reduce((total, item) => total + countReferences(item), 0)
  if (value !== null && typeof value === 'object') {
    return Object.values(value).reduce((total, child) => total + countReferences(child), 0)
  }
  return 0
}

test('the resolved schema hands out every card-owned key as a volatile reference', () => {
  const resolved = Config({})
  const marked = referenceKeys(resolved)
  assert.deepEqual(
    [...marked].sort(),
    [...EDITABLE_CONFIG_KEYS].sort(),
    'the volatile key set must be exactly the card-owned key set',
  )
  // The reference protocol: a `get()` reader plus the shared write symbol, on a
  // frozen object. Dropping the marking (or the marking loop) reddens here: the
  // host refuses `settings.replace` for an entry with no volatile field.
  for (const key of marked) {
    const reference = resolved[key]
    assert.equal(typeof reference.get, 'function', `${key} must expose get()`)
    assert.equal(typeof reference[VOLATILE_WRITE], 'function', `${key} must carry the shared write symbol`)
    assert.ok(Object.isFrozen(reference), `${key} must be a frozen reference`)
  }
})

test('resolveConfig: an unwrapped resolved config carries real scalars and never throws', () => {
  const resolved = Config({})
  const config = resolveConfig(plainConfigValue(resolved))
  assert.equal(typeof config.enabled, 'boolean', 'enabled must be a real boolean, not a reference')
  assert.equal(config.enabled, true)
  assert.equal(typeof config.debug, 'boolean', 'debug must be a real boolean, not a reference')
  assert.equal(config.debug, false)
  assert.equal(typeof config.timeoutAction, 'string', 'timeoutAction must be a real string, not a reference')
  assert.ok(
    TIMEOUT_ACTIONS.includes(config.timeoutAction),
    `timeoutAction must be one of ${TIMEOUT_ACTIONS.join('/')}, got ${String(config.timeoutAction)}`,
  )
})

test('the unwrap is required: a build without the unwrap line still throws', async () => {
  // The reverse control needs a build whose `resolveConfig` skips the unwrap.
  // Rather than writing that build anywhere, the compiled module is served from
  // memory with the single unwrap line removed and the rest byte-identical, so
  // the throw it produces is attributable to that line alone.
  const libUrl = new URL('../lib/index.js', import.meta.url)
  const real = readFileSync(libUrl, 'utf8')
  assert.equal(
    real.split(UNWRAP_STATEMENT).length - 1,
    1,
    `the compiled resolveConfig must carry exactly one \`${UNWRAP_STATEMENT}\``,
  )
  const patched = real.replace(UNWRAP_STATEMENT, '')
  const patchedUrl = `${libUrl.href}?without-unwrap`
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context)
      return resolved.url === libUrl.href ? { ...resolved, url: patchedUrl } : resolved
    },
    load(url, context, nextLoad) {
      if (url === patchedUrl) return { format: 'module', source: patched, shortCircuit: true }
      return nextLoad(url, context)
    },
  })
  try {
    const { Config: PatchedConfig, resolveConfig: patchedResolveConfig } = await import(libUrl.href)
    // The production shape: the resolved schema handed straight to resolveConfig.
    const resolved = PatchedConfig({})
    assert.ok(isVolatileConfig(resolved.timeoutAction), 'the fixture must carry a reference')
    assert.throws(
      () => patchedResolveConfig(resolved),
      /unknown timeoutAction/,
      'without the unwrap, the resolved schema must still throw',
    )
    assert.throws(
      () => patchedResolveConfig({ ...resolved, timeoutAction: referenceOf('reject') }),
      /unknown timeoutAction/,
      'without the unwrap, an explicit reference must still throw',
    )
    // And the exported build — the one that ships — does not.
    const config = resolveConfig(Config({}))
    assert.equal(typeof config.timeoutAction, 'string')
    assert.ok(TIMEOUT_ACTIONS.includes(config.timeoutAction))
  } finally {
    hook.deregister()
  }
})

test('plainConfigValue: unwrapping is idempotent and leaves the argument untouched', () => {
  const resolved = Config({})
  const once = plainConfigValue(resolved)
  const twice = plainConfigValue(once)
  assert.deepEqual(twice, once, 'unwrapping an unwrapped value must change nothing')
  assert.deepEqual(plainConfigValue(Config({})), once, 'a fresh resolve must unwrap to the same value')
  // No in-place rewrite: the argument keeps its references.
  assert.ok(referenceKeys(resolved).length > 0, 'the argument must keep its references')
  assert.equal(referenceKeys(once).length, 0, 'the result must carry no references')
})

test('plainConfigValue: scalars, null, undefined and plain data are idempotent', () => {
  const plain = {
    enabled: true,
    timeoutAction: 'reject',
    nested: { list: [1, 'two', null, undefined], deeper: { level: 3 } },
    nothing: null,
    missing: undefined,
  }
  const copy = plainConfigValue(plain)
  assert.deepEqual(copy, plain)
  assert.deepEqual(plainConfigValue(copy), copy)
  assert.equal(plainConfigValue('reject'), 'reject')
  assert.equal(plainConfigValue(7), 7)
  assert.equal(plainConfigValue(null), null)
  assert.equal(plainConfigValue(undefined), undefined)
  assert.notEqual(copy, plain, 'plain data is copied, not returned by identity')
  assert.notEqual(copy.nested, plain.nested, 'nested plain objects are copied too')
})

test('plainConfigValue: nested references inside arrays and objects are unwrapped', () => {
  const resolved = Config({})
  const nested = { outer: { list: [resolved.timeoutAction, resolved.enabled], inner: { flag: resolved.debug } } }
  const unwrapped = plainConfigValue(nested)
  assert.equal(unwrapped.outer.list[0], 'reject')
  assert.equal(unwrapped.outer.list[1], true)
  assert.equal(unwrapped.outer.inner.flag, false)
  assert.equal(countReferences(nested), 3, 'the source keeps its references')
  assert.equal(countReferences(unwrapped), 0, 'the result must carry no references')
})

test('plainConfigValue: a repeated plain sibling is copied, a cycle is kept as-is', () => {
  const shared = { value: 1 }
  const copied = plainConfigValue({ first: shared, second: shared })
  assert.deepEqual(copied, { first: { value: 1 }, second: { value: 1 } })
  assert.notEqual(copied.first, shared)

  const cyclic = { name: 'root' }
  cyclic.self = cyclic
  const guarded = plainConfigValue(cyclic)
  assert.equal(guarded.name, 'root')
  assert.equal(guarded.self, cyclic, 'a cycle is kept as-is instead of recursing forever')
})

test('plainConfigValue: a data object carrying the write symbol without get() is not a reference', () => {
  const decoy = { [VOLATILE_WRITE]: () => {}, value: 1 }
  assert.equal(isVolatileConfig(decoy), false, 'the predicate requires a callable get()')
  const unwrapped = plainConfigValue(decoy)
  assert.deepEqual(unwrapped, { value: 1 })
})
