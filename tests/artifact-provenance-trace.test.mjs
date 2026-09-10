/**
 * Artifact-provenance trace contract tests.
 *
 * The session-artifact delete exemption is an ALLOW layer whose effect has no
 * trace of its own: when the provenance chain breaks, the only visible symptom
 * is a deletion falling back to a locked countdown, which looks identical to a
 * deletion the session never made. That is how the chain stayed broken in
 * production through a green test suite — the live audit held zero occurrences
 * of the exemption ever firing.
 *
 * `plan`/`settle` therefore report what they actually recorded/promoted, and the
 * host writes an `artifact-provenance` observation record when either is
 * non-empty. These tests pin the return contract and the wiring, so a silent
 * regression in either is visible instead of inferred.
 *
 * Run: node --test tests/artifact-provenance-trace.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'

const WORKSPACE = 'C:/ws'
const roots = { workspace: WORKSPACE, home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: [] }
const artifacts = () => new ArtifactRegistry()
const owner = { id: 'session-trace' }
const execFor = (token, name = 'write') => ({ name, token, callId: `call-${token}`, agent: { session: owner } })

test('plan reports the paths it recorded', () => {
  const registry = artifacts()
  const target = 'C:/ws/fresh-artifact.txt'
  assert.equal(existsSync(target), false, 'precondition: the fixture path must not exist')
  const recorded = registry.plan(execFor('t1'), [target], roots)
  assert.deepEqual(recorded, ['c:\\ws\\fresh-artifact.txt'], 'the recorded path is reported, normalized')
})

test('plan reports nothing when it records nothing', () => {
  const registry = artifacts()
  // No owner: nothing can be attributed, so nothing is recorded.
  assert.deepEqual(registry.plan({ token: 't1', agent: {} }, ['C:/ws/a.txt'], roots), [])
  // Outside the artifact area: the registry only tracks workspace/temp creates.
  assert.deepEqual(registry.plan(execFor('t2'), ['D:/elsewhere/a.txt'], roots), [])
  // Already existing: plan keeps only not-yet-existing paths.
  const dir = mkdtempSync(join(tmpdir(), 'artifact-trace-'))
  try {
    const existing = join(dir, 'already.txt')
    writeFileSync(existing, 'x')
    const localRoots = { workspace: dir, home: dir, dshHome: join(dir, '.dsh'), tempRoots: [] }
    assert.deepEqual(registry.plan({ name: 'write', token: 't3', agent: { session: owner } }, [existing], localRoots), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settle reports the paths it promoted, and only on success', () => {
  const registry = artifacts()
  const target = 'C:/ws/promoted.txt'
  const ok = execFor('t1')
  registry.plan(ok, [target], roots)
  assert.deepEqual(
    registry.settle(ok, { isError: false, value: { operation: 'create', path: target } }, roots),
    ['c:\\ws\\promoted.txt'],
    'a successful create is promoted and reported',
  )

  const failed = execFor('t2')
  registry.plan(failed, ['C:/ws/failed.txt'], roots)
  assert.deepEqual(registry.settle(failed, { isError: true, value: undefined }, roots), [], 'an error result promotes nothing')

  const exit1 = execFor('t3', 'bash')
  registry.plan(exit1, ['C:/ws/exit1.txt'], roots)
  assert.deepEqual(registry.settle(exit1, { isError: false, value: { exitCode: 1 } }, roots), [], 'a non-zero exit promotes nothing')
})

test('a settled path is what has() later recognises (the whole point)', () => {
  const registry = artifacts()
  const target = 'C:/ws/chain.txt'
  const exec = execFor('t1')
  registry.plan(exec, [target], roots)
  const promoted = registry.settle(exec, { isError: false, value: { operation: 'create', path: target } }, roots)
  assert.equal(promoted.length, 1)
  assert.equal(registry.has(owner, target, roots), true, 'the reported promotion is the one has() sees')
})

test('the host writes an observation record for both phases', () => {
  // The trace is the only way to tell "the chain broke" from "the session never
  // created this". Anchor both emitters and the phase values in the compiled
  // host, and require that the record never becomes a decision record (it must
  // not enter verdict or statistics counting).
  const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const records = [...host.matchAll(/type: 'artifact-provenance'/g)]
  assert.equal(records.length, 2, 'plan and settle each emit their own trace record')
  for (const match of records) {
    const window = host.slice(match.index, match.index + 260)
    assert.ok(/phase: '(plan|promote)'/.test(window), `the trace must carry its phase:\n${window.slice(0, 200)}`)
    assert.ok(/paths: (recorded|promoted)/.test(window), `the trace must carry the recorded paths:\n${window.slice(0, 200)}`)
    assert.ok(!/type: 'decision'/.test(window), 'a trace record must never masquerade as a verdict')
  }
  assert.ok(host.includes("phase: 'plan'") && host.includes("phase: 'promote'"), 'both phases are reachable')
})

test('the trace is emitted only when something actually happened', () => {
  // Guarding on a non-empty result is what keeps this low-noise: a write that
  // records nothing must not append an audit line on every tool call.
  const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  assert.ok(/if \(recorded\.length > 0\)/.test(host), 'the plan trace is guarded on a non-empty result')
  assert.ok(/if \(promoted\.length > 0\)/.test(host), 'the promote trace is guarded on a non-empty result')
})
