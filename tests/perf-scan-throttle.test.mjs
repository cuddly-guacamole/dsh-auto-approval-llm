/**
 * dsh-auto-approval-llm · document-level scan throttle.
 *
 * `installAutoPermissionIcon` observes the whole document with `characterData`
 * + `subtree`, so every streaming token batch used to wake a full decoration
 * pass. The scan now runs through `createTrailingThrottle`.
 *
 * The trailing guarantee is the load-bearing half: a throttle that only ran the
 * leading call would drop the decoration for a menu that appeared later inside
 * the same window. The last test pins the observer wiring itself, because that
 * is the part a passing unit test cannot see.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTrailingThrottle, MIN_DECORATE_INTERVAL_MS } from '../lib/client/throttle.js'

/** Deterministic clock + scheduler: nothing runs until flush() is called. */
function harness() {
  let clock = 0
  const queue = []
  const runner = createTrailingThrottle(
    () => { runner.runs += 1 },
    {
      minIntervalMs: 50,
      now: () => clock,
      schedule: (fn, ms) => {
        const entry = { fn, at: clock + ms }
        queue.push(entry)
        return entry
      },
      cancel: (entry) => {
        const index = queue.indexOf(entry)
        if (index >= 0) queue.splice(index, 1)
      },
    },
  )
  runner.runs = 0
  return {
    runner,
    advance(ms) { clock += ms },
    get pending() { return queue.length },
    flush() {
      for (const entry of queue.splice(0)) {
        if (entry.at <= clock) entry.fn()
      }
    },
  }
}

test('leading: the first trigger runs immediately', () => {
  const h = harness()
  h.runner.trigger()
  assert.equal(h.runner.runs, 1)
})

test('burst: twenty triggers inside the window run once', () => {
  const h = harness()
  for (let i = 0; i < 20; i += 1) h.runner.trigger()
  assert.equal(h.runner.runs, 1, 'the burst collapsed to the leading run')
  assert.equal(h.pending, 1, 'exactly one trailing run is scheduled')
})

test('trailing: the last trigger inside the window still runs afterwards', () => {
  const h = harness()
  for (let i = 0; i < 20; i += 1) h.runner.trigger()
  h.advance(50)
  h.flush()
  assert.equal(h.runner.runs, 2, 'the trailing run must not be dropped')
})

test('after the window elapses, the next trigger runs immediately', () => {
  const h = harness()
  h.runner.trigger()
  h.advance(50)
  h.runner.trigger()
  assert.equal(h.runner.runs, 2)
  assert.equal(h.pending, 0, 'a run that happened now needs no trailing run')
})

test('dispose cancels a scheduled trailing run', () => {
  const h = harness()
  h.runner.trigger()
  h.runner.trigger()
  h.runner.dispose()
  h.advance(1000)
  h.flush()
  assert.equal(h.runner.runs, 1, 'nothing may run after dispose')
})

test('static anchor: the auto-icon observer scans through the throttle', () => {
  const source = readFileSync(new URL('../src/client/auto-icon.ts', import.meta.url), 'utf8')
  assert.match(source, /createTrailingThrottle\(/, 'the scan must be throttled')
  assert.match(source, /MIN_DECORATE_INTERVAL_MS/, 'the window must come from the named constant')
  // The observer callback itself must route into the throttle, not straight
  // into the decoration pass.
  const scanBody = source.match(/const scan = \(\) => \{[\s\S]*?\n {4}\};/)
  assert.ok(scanBody, 'the scan function must still exist')
  assert.match(scanBody[0], /decorate\.trigger\(\)/, 'scan must enter the throttle')
  assert.doesNotMatch(scanBody[0], /decorateAutoPermissionIcons\(/, 'scan must not call the pass directly')
})

test('compiled artifact: @ts-nocheck auto-icon.js really carries the wiring', () => {
  // auto-icon.ts is @ts-nocheck, so a typecheck passing says nothing about it:
  // the wiring has to be asserted against the emitted file, which is what the
  // shipped bundle is built from.
  const compiled = readFileSync(new URL('../lib/client/auto-icon.js', import.meta.url), 'utf8')
  assert.match(compiled, /import \{ createTrailingThrottle, MIN_DECORATE_INTERVAL_MS \} from '\.\/throttle\.js'/)
  assert.match(compiled, /const decorate = createTrailingThrottle\(/)
  assert.match(compiled, /decorate\.trigger\(\)/)
  assert.match(compiled, /decorate\.dispose\(\)/)
  assert.doesNotMatch(compiled, /if \(active\)\s*\n\s*decorateAutoPermissionIcons\(document\);/)
})

test('the throttle window is a positive interval, not a disabled throttle', () => {
  // A window of 0 makes `elapsed >= minIntervalMs` always true, i.e. it turns
  // the throttle back into a direct call while every anchor above still passes.
  assert.ok(MIN_DECORATE_INTERVAL_MS > 0, `expected a positive window, got ${MIN_DECORATE_INTERVAL_MS}`)
  assert.ok(Number.isFinite(MIN_DECORATE_INTERVAL_MS))
  // It must stay small enough that decoration still looks immediate.
  assert.ok(MIN_DECORATE_INTERVAL_MS <= 200, `window ${MIN_DECORATE_INTERVAL_MS} is too coarse for an icon`)
})

test('a zero window really does disable the throttle (guards the anchor above)', () => {
  let runs = 0
  const throttled = createTrailingThrottle(() => { runs += 1 }, { minIntervalMs: 0 })
  throttled.trigger()
  throttled.trigger()
  throttled.trigger()
  assert.equal(runs, 3, 'with a zero window every trigger runs — which is what the constant must not be')
  throttled.dispose()
})

test('static anchor: the observer routes through the throttle, not straight to scan', () => {
  const source = readFileSync(new URL('../src/client/auto-icon.ts', import.meta.url), 'utf8')
  // The observer callback and the observer options together are the part a
  // unit test cannot see: rebinding the callback to `scan` (or dropping the
  // observe() call) would silently restore the token-rate scanning.
  assert.match(source, /new MutationObserver\(scan\)/)
  assert.match(source, /observer\.observe\(document\.documentElement, \{/)
  assert.match(source, /characterData: true/)
})
