/**
 * The plugin must never probe the tools/pre-execute waterfall at boot by
 * dispatching a synthetic execution: the only way to observe whether a peer
 * listener short-circuits the waterfall is to run a real dispatch, which
 * would actually execute every peer listener (user hooks, job tools) and
 * leave dangling invariant phases in the host. The plugin registers a plain
 * listener instead — pinned here as a regression guard for that design
 * decision, with the positive registration shape as the non-vacuous anchor.
 * Run: node --test tests/no-boot-probe-dispatch.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const host = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
const built = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')

test('the pre-execute surface is a registered listener, not a dispatched waterfall', () => {
  assert.match(host, /anyCtx\.on\('tools\/pre-execute'/, 'the listener registration must exist')
  assert.doesNotMatch(host, /waterfall\(\s*'tools\/pre-execute'/, 'no boot-time dispatch of the pre-execute waterfall')
})

test('the compiled bundle keeps the listener-only shape', () => {
  assert.ok(built.includes("'tools/pre-execute'"), 'the compiled bundle must carry the listener registration')
  assert.doesNotMatch(built, /waterfall\(\s*['"]tools\/pre-execute['"]/, 'no dispatch call site in the bundle')
})
