/**
 * The policy hard-deny is a code-enforced terminal and must answer before any
 * declared rule on both planes. Pre-execute already ordered it that way; the
 * answerer evaluated declared rules first, so a `reason`-dimension allow rule
 * (invisible to pre-execute, which never sees the approval reason) could turn a
 * hard deny into an allowed-once when the primary plane did not settle the call.
 *
 * Run: node --test tests/audit-policy-deny-before-rules.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createHostContext } from './helpers/host-ctx.mjs'

function askAnswerer(host, { callId, toolName, args, reason }) {
  const session = host.makeSession({ id: `${callId}-session`, callId, args })
  const req = { callId, toolName, agent: { session }, signal: undefined, reason }
  return host.invokeApprovalRequest(req, async () => 'next')
}

test('a reason allow rule cannot turn the answerer policy hard-deny into an allow', async (t) => {
  const host = createHostContext({ config: { categoryMode: 'aggressive', rulesText: 'write(.*) | allow | reason' } })
  t.after(() => host.dispose())

  const args = { file_path: join(host.dshHome, 'learning.json'), content: '{}' }
  const session = host.makeSession({ id: 'pd-session', callId: 'pd-hard', args })
  const pre = await host.invokePreExecute(host.makeExec({ name: 'write', args, callId: 'pd-hard', session }))
  assert.equal(pre.kind, 'deny', 'the primary plane must hard-deny before the rule block')

  const out = await askAnswerer(host, { callId: 'pd-hard', toolName: 'write', args, reason: 'mutation targets DSH_HOME runtime state' })
  assert.equal(out, 'rejected', 'the answerer plane must keep the hard-deny')

  const rows = host.readAuditLines()
  assert.equal(rows.some((line) => line.source === 'policy-deny' && line.outcome === 'rejected'), true, 'the answerer records the policy deny')
  assert.equal(rows.some((line) => line.source === 'rule-allow' || line.outcome === 'allowed-once'), false, 'no rule-allow settle may survive the hard deny')
})

test('the same reason rule still settles a call the policy does not hard-deny', async (t) => {
  // Positive control: proves the rule is effective and the deny above is what
  // blocked it, not a broken rule/answerer wiring.
  const host = createHostContext({ config: { categoryMode: 'aggressive', rulesText: 'write(.*) | allow | reason' } })
  t.after(() => host.dispose())

  const args = { file_path: join(host.workspaceRoot, 'note.txt'), content: 'x' }
  const out = await askAnswerer(host, { callId: 'pd-control', toolName: 'write', args, reason: 'routine project edit' })
  assert.equal(out, 'allowed-once', 'the rule-allow channel must still settle an ordinary call')
  assert.equal(host.readAuditLines().some((line) => line.source === 'rule-allow' && line.outcome === 'allowed-once'), true)
})
