/**
 * dsh-auto-approval-llm · the client's marker fence must read the host reason.
 *
 * The panel scan used to build its marker text from every panel text node
 * (minus the edit-diff preview). The panel also renders the tool command echo,
 * which the model controls, so a command argument spelling the breaker marker
 * armed the guard (disabling the human's Reject / Allow buttons) and a forged
 * awaiting marker made the client render the status-less copy. The markers now
 * come from the host reason recorded by the approval watcher, keyed by the same
 * `data-approval-key` the panel carries; the panel text is only where a genuine
 * marker is rewritten.
 *
 * The preview helpers that used to sit on that fence are retired; the sweep
 * below is what keeps them retired (a deleted module is listed nowhere, so a
 * removal that misses a reference has to fail here rather than pass silently).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  forgetPendingReason,
  pendingReasonFor,
  rememberPendingReason,
  subscribePendingReasons,
} from '../lib/client/approvals/shared.js'

const at = (relative) => fileURLToPath(new URL(relative, import.meta.url))
const client = readFileSync(at('../src/client/index.ts'), 'utf8')

/** Every file under a directory, recursively, as `dir/name` paths. */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(at(`../${dir}`), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(rel))
    else out.push(rel)
  }
  return out
}

test('the retired preview module and its helpers are referenced nowhere', () => {
  const files = walk('src')
  // Nothing under src/ may name the retired module or its exported helpers:
  // the file itself is gone, so a leftover import would be a build error, but
  // a leftover CALL through a re-exported alias is exactly the silent kind of
  // revival this sweep exists to catch.
  for (const token of ['marker-text', 'markerTextOutsidePreview', 'MarkerTextNode']) {
    const hits = files.filter((file) => readFileSync(at(`../${file}`), 'utf8').includes(token))
    assert.deepEqual(hits, [], `${token} must have no reference left under src/`)
  }
  assert.ok(!existsSync(at('../src/client/approvals/marker-text.ts')), 'the retired module file must stay deleted')
  // The compiled client bundle is what a browser actually loads, so the sweep
  // covers the artifact too (a stale build output would keep shipping it).
  const bundle = readFileSync(at('../lib/client.js'), 'utf8')
  assert.ok(!bundle.includes('markerTextOutsidePreview'), 'the compiled client bundle must not carry it either')
})

test('the trusted reason store records, updates, bounds and clears', () => {
  rememberPendingReason(['s:1', null, undefined, ''], 'host reason')
  assert.equal(pendingReasonFor('s:1'), 'host reason')
  assert.equal(pendingReasonFor(null), undefined)
  assert.equal(pendingReasonFor('missing'), undefined)
  rememberPendingReason(['s:1'], 'updated')
  assert.equal(pendingReasonFor('s:1'), 'updated')
  forgetPendingReason(['s:1'])
  assert.equal(pendingReasonFor('s:1'), undefined)
  for (let i = 0; i < 501; i += 1) rememberPendingReason([`cap:${i}`], `r${i}`)
  assert.equal(pendingReasonFor('cap:0'), undefined, 'the oldest entry is dropped')
  assert.equal(pendingReasonFor('cap:500'), 'r500')
  forgetPendingReason(['cap:500'])
})

test('the store notifies listeners only on an actual change', () => {
  let hits = 0
  const unsub = subscribePendingReasons(() => { hits += 1 })
  rememberPendingReason(['notify:1'], 'x')
  rememberPendingReason(['notify:1'], 'x')
  rememberPendingReason(['notify:1'], 'y')
  forgetPendingReason(['notify:1'])
  unsub()
  rememberPendingReason(['notify:2'], 'z')
  assert.equal(hits, 3, 'one notification per change, none after unsubscribe')
})

test('the scan reads the trusted reason, not the panel text', () => {
  const scanStart = client.indexOf('const scan = () => {')
  const scanBody = client.slice(scanStart, client.indexOf('breaker.prune(liveKeys)'))
  assert.ok(scanStart !== -1 && scanBody.length > 0, 'the scan body is located')
  assert.ok(scanBody.includes('pendingReasonFor(key)'), 'the scan must read the trusted reason for this key')
  assert.ok(scanBody.includes('hasBreakerNote(trustedReason)'), 'the breaker guard must arm from the trusted reason')
  assert.ok(scanBody.includes('trustedReason.includes(AWAITING_MARKER)'), 'the awaiting copy must read the trusted reason')
  assert.ok(scanBody.includes('hasLockedAskNote(trustedReason)'), 'the locked copy must read the trusted reason')
  assert.ok(!scanBody.includes('markerTextOutsidePreview('), 'panel text must no longer feed the marker decisions')
  // A dead path must not come back as a live one: the retired preview helpers
  // were the only readers of the panel's raw text inside this scan.
  for (const gone of ['extractDiffBlock', 'renderDiffBlock', 'hideDiffBlock', 'applyTextNodeRewrites', 'nodeInsidePreview', 'data-dsa-edit-diff']) {
    assert.ok(!scanBody.includes(gone), `${gone} must not reappear in the panel scan`)
    assert.ok(!client.includes(gone), `${gone} must not reappear anywhere in the client`)
  }
})

test('the host ownership of the marker literals is unchanged', () => {
  assert.ok(client.includes("from '../auto/decision.js'"), 'the client still imports the shared detectors')
  assert.ok(client.includes("from './approvals/shared.js'"), 'the trusted-reason store is the shared client module')
  assert.ok(client.includes('subscribePendingReasons('), 'a late-arriving host reason must trigger a rescan')
})
