/**
 * dsh-auto-approval-llm · 断线暂停倒计时 contracts.
 *
 * Freeze is render-only: while the wire is down the panel keeps its
 * last-known remaining with a `·断线` marker instead of walking a stale
 * local deadline; the host timer and the poller verdict path are untouched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  formatCountdownSuffix,
  isLinkDown,
  parseCountdown,
  setLinkDown,
} from '../lib/client/approvals/shared.js'

test('formatCountdownSuffix: walking shape stays `（Ns）`', () => {
  assert.equal(formatCountdownSuffix(8), '（8s）')
  assert.equal(formatCountdownSuffix(8, false), '（8s）')
})

test('formatCountdownSuffix: frozen shape carries the offline marker', () => {
  assert.equal(formatCountdownSuffix(8, true), '（8s·断线）')
})

test('frozen suffix never parses as a countdown (no forged re-arm)', () => {
  // parseCountdown reads panel text; the frozen suffix must not match its
  // marker regex or a frozen panel could re-arm an answer from text.
  assert.equal(parseCountdown('允许一次（8s·断线）'), null)
  assert.equal(parseCountdown('拒绝（8s·断线）'), null)
})

test('link-state cell: set/is round-trip, defaults to up', () => {
  setLinkDown(false)
  assert.equal(isLinkDown(), false)
  setLinkDown(true)
  assert.equal(isLinkDown(), true)
  setLinkDown(false)
  assert.equal(isLinkDown(), false)
})

test('static anchors: updatePanel freezes on link-down, render only', () => {
  const client = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.match(
    client,
    /if \(isLinkDown\(\)\) \{\r?\n\s*if \(frozen === undefined\) frozen = /,
    'apply() captures the last-known remaining once while down',
  )
  assert.match(
    client,
    /renderSuffix\(frozen, true\)/,
    'frozen ticks render the offline suffix, never the walking deadline',
  )
  assert.match(
    client,
    /poller owns answers and is/,
    'the freeze branch documents the render-only contract (verdict path untouched)',
  )
  assert.match(
    client,
    /the host timer never pauses/,
    'the freeze branch documents that the host timer never pauses',
  )
})

test('static anchors: connection watcher publishes the wire state', () => {
  const remote = readFileSync(new URL('../src/client/approvals/remote.ts', import.meta.url), 'utf8')
  assert.match(
    remote,
    /setLinkDown\(next === 'disconnected' \|\| next === 'connecting'\)/,
    'every connection transition publishes the link state',
  )
  assert.match(
    remote,
    /Per-tab local only — never sent to the host/,
    'multi-tab safety is documented at the publish site',
  )
})
