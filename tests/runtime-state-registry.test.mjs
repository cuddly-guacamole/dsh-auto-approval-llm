/**
 * dsh-auto-approval-llm · RUNTIME_STATE_BASENAMES registry test (B3-F4/S3).
 *
 * The fuse list is enumeration-based: a runtime-state file the plugin writes
 * but forgets to register would be writable from agent sessions inside the
 * plugin zone (the zone opening skips the DSH_HOME deny, and only these
 * basenames re-arm it). This test pins the known state files — a new state
 * file must be added here AND to the set, making the omission a red test
 * instead of a silent write path. Run: node --test
 * tests/runtime-state-registry.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { RUNTIME_STATE_BASENAMES } from '../lib/auto/paths.js'

test('RUNTIME_STATE_BASENAMES: every plugin-written state file is registered', () => {
  // The durable state files the plugin itself writes at the repo root:
  // - history.jsonl      approval history (index.ts pushHistory)
  // - audit.jsonl        durable adjudication gate (auto/audit.ts)
  // - approval-debug.jsonl  debug timeline (index.ts debug trail)
  // - review-mode.json   session mode persistence (auto/review-mode.ts)
  // - llm-latency.jsonl  reviewer latency telemetry (auto/latency.ts)
  // - learning.json      confirmation learning store (auto/learning.ts)
  const knownStateFiles = [
    'history.jsonl',
    'audit.jsonl',
    'approval-debug.jsonl',
    'review-mode.json',
    'llm-latency.jsonl',
    'learning.json',
  ]
  for (const name of knownStateFiles) {
    assert.ok(RUNTIME_STATE_BASENAMES.has(name), `${name} must stay registered as runtime state`)
  }
})

test('RUNTIME_STATE_BASENAMES: the registry stays minimal and exact', () => {
  // Anything in the set is unconditionally unwritable from agent sessions in
  // the plugin zone — an entry that no state file uses would be dead deny
  // surface. Keep the set exactly the real state files.
  assert.deepEqual([...RUNTIME_STATE_BASENAMES].sort(), [
    'approval-debug.jsonl',
    'audit.jsonl',
    'history.jsonl',
    'learning.json',
    'llm-latency.jsonl',
    'review-mode.json',
  ])
})
