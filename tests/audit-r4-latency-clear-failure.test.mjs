/**
 * The llm-latency DELETE route reports truncation honestly.
 *
 * `clearLatencySamples` emptied the in-memory window and swallowed a failed
 * file truncation, and the route answered 200 unconditionally: the next boot
 * reloaded llm-latency.jsonl and the samples came back. That is the same false
 * success the history DELETE refuses with a 500 (truncate first, clear memory
 * only after the file agrees).
 *
 * Run: node --test tests/audit-r4-latency-clear-failure.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installLatencyRoute } from '../lib/index.js'
import { clearLatencySamples } from '../lib/auto/latency.js'
import { setRuntimePathsForTests } from '../lib/auto/runtime-paths.js'
import { carrierContext, findSpec, callSpec } from './helpers/carrier-route.mjs'

const sample = (ms) => ({ at: Date.now(), source: 'reviewer', ms, settled: true })

test('a failing truncation leaves the window intact and reports false', () => {
  const missing = join(tmpdir(), `r4-latency-missing-${process.pid}-${Date.now()}`, 'llm-latency.jsonl')
  const samples = [sample(200)]
  assert.equal(clearLatencySamples(samples, missing), false, 'an unwritable file is a failure')
  assert.equal(samples.length, 1, 'the in-memory window must not be cleared when the file still holds the samples')
})

test('control: a writable file is truncated and the window cleared', () => {
  const file = join(tmpdir(), `r4-latency-clear-${process.pid}-${Date.now()}.jsonl`)
  writeFileSync(file, `${JSON.stringify(sample(200))}\n`)
  const samples = [sample(200), sample(50)]
  assert.equal(clearLatencySamples(samples, file), true)
  assert.equal(samples.length, 0)
  assert.equal(readFileSync(file, 'utf8'), '')
  rmSync(file, { force: true })
})

test('the route answers 500 when the latency file cannot be truncated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r4-latency-route-'))
  const stateDir = join(dir, 'auto-approval-llm')
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(join(stateDir, 'llm-latency.jsonl'), { recursive: true })
  try {
    setRuntimePathsForTests({ stateDir })
    const { ctx, specs } = carrierContext()
    installLatencyRoute(ctx)
    const registrations = [...specs.values()]
    assert.equal(registrations.length, 1, 'the latency installer registers exactly one route')
    const spec = findSpec(registrations, 'llm-latency')
    const res = await callSpec(spec, {
      method: 'DELETE',
      headers: { host: 'localhost:8080' },
    })
    assert.equal(res.status, 500, 'an untruncatable latency file must not answer success')
    assert.match(res.json.error, /could not be truncated/)
  } finally {
    setRuntimePathsForTests(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
})
