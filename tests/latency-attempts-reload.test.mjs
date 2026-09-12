/**
 * dsh-auto-approval-llm · latency samples keep their retry count across reload.
 *
 * Every reviewer/classifier sample carries `attempts`, the field the retry loop
 * was built to expose. The loader rebuilt each record from a fixed key set
 * instead of validating the parsed object, so the count vanished in memory —
 * and because rotation rewrites the file from the in-memory array, it vanished
 * from disk at the next 1 MiB rotation too.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLatencySamples, pushLatencySample } from '../lib/auto/latency.js'
import { setRuntimePathsForTests } from '../lib/auto/runtime-paths.js'

function withStateDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsa-latency-'))
  setRuntimePathsForTests({ stateDir: dir, legacyRoot: join(dir, 'legacy') })
  try {
    fn(dir)
  } finally {
    setRuntimePathsForTests(undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a persisted retry count survives a reload', () => {
  withStateDir((dir) => {
    writeFileSync(join(dir, 'llm-latency.jsonl'), `${JSON.stringify({ at: 1, tookMs: 8001, settled: false, attempts: 2, channel: 'reviewer' })}\n`)
    const samples = loadLatencySamples()
    assert.equal(samples.length, 1)
    assert.equal(samples[0].attempts, 2, 'the retry count must be preserved')
    assert.equal(samples[0].channel, 'reviewer')
  })
})

test('the other fields keep their values', () => {
  withStateDir((dir) => {
    writeFileSync(join(dir, 'llm-latency.jsonl'), `${JSON.stringify({ at: 7, tookMs: 12, settled: true, channel: 'classifier' })}\n`)
    const samples = loadLatencySamples()
    assert.deepEqual(samples[0], { at: 7, tookMs: 12, settled: true, channel: 'classifier' })
  })
})

test('malformed lines and unknown channels are still dropped', () => {
  withStateDir((dir) => {
    writeFileSync(join(dir, 'llm-latency.jsonl'), [
      '{"at":"nope","tookMs":1,"settled":true}',
      '{"at":2,"tookMs":3,"settled":true,"channel":"bogus"}',
      'not json at all',
      '',
    ].join('\n'))
    const samples = loadLatencySamples()
    assert.equal(samples.length, 1, 'only the well-formed sample is kept')
    assert.equal(samples[0].attempts, undefined, 'an absent retry count stays absent')
    assert.equal(samples[0].channel, undefined, 'an unknown channel is not a sample channel')
  })
})

test('the in-memory push path already carries the count', () => {
  withStateDir((dir) => {
    const samples = []
    pushLatencySample(samples, { at: 5, tookMs: 900, settled: false, attempts: 3, channel: 'reviewer' })
    assert.equal(samples[0].attempts, 3)
    assert.ok(dir.length > 0)
  })
})
