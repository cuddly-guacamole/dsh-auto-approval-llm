/**
 * The audit rotation's temp file must carry the pid, like the other rotations.
 *
 * history/latency rotations name their temp file `${file}.tmp.${process.pid}`;
 * the audit rotation used a bare `${file}.tmp`, so two dsh processes sharing a
 * state directory could rename each other's temp file away mid-rotation.
 *
 * Run: node --test tests/audit-rotate-tmp-pid.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

test('the audit rotation temp name carries the pid like the sibling rotations', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/auto/audit.ts', import.meta.url)), 'utf8')
  assert.match(source, /`\$\{file\}\.tmp\.\$\{process\.pid\}`/,
    'the audit rotation must use the pid-suffixed temp name')
  assert.doesNotMatch(source, /`\$\{file\}\.tmp`/,
    'the bare temp name must be gone')
})

test('the sibling rotations keep the pid convention (drift guard)', () => {
  // The history rotation's tmp+rename helper lives in the route table module;
  // the entry re-exports it, so the convention is read where it is written.
  const routeTable = readFileSync(fileURLToPath(new URL('../src/auto/route-table.ts', import.meta.url)), 'utf8')
  const latency = readFileSync(fileURLToPath(new URL('../src/auto/latency.ts', import.meta.url)), 'utf8')
  assert.match(routeTable, /tmp\.\$\{process\.pid\}/)
  assert.match(latency, /tmp\.\$\{process\.pid\}/)
})
