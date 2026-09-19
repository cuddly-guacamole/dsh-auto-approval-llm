/**
 * The client sends `auto: true` on the feedback POST when it answers a
 * countdown on the host's behalf. The host used to drop that flag and label
 * every settled ask `human-*`, crediting an automatic resolution to a person.
 *
 * Run: node --test tests/audit-auto-answer-provenance.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHostContext } from './helpers/host-ctx.mjs'

async function driveAsk(host, { callId, sessionId }) {
  const args = { command: 'rm never-created.txt' }
  const session = host.makeSession({ id: sessionId, callId, args })
  const req = { callId, toolName: 'bash', agent: { session }, signal: undefined, reason: 'auto provenance test' }
  let resolveNext = () => {}
  const nextPromise = new Promise((resolve) => { resolveNext = resolve })
  const askPromise = host.invokeApprovalRequest(req, () => nextPromise)
  await host.waitFor(async () => {
    const response = await host.readReviewStatus(callId)
    return response.body?.ok === true ? response.body.value : undefined
  }, `review status for ${callId}`)
  return { askPromise, settle: (outcome) => resolveNext(outcome) }
}

function lastHistorySource(host, sessionId) {
  const file = join(host.stateDir, 'history.jsonl')
  const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const own = rows.filter((row) => row.sessionId === sessionId)
  assert.ok(own.length > 0, 'the settlement must be recorded in history')
  return own[own.length - 1].source
}

test('a client auto-answer is labelled auto-*, not human-*', async (t) => {
  const host = createHostContext({ config: { categoryMode: 'aggressive', highRiskSeconds: 5 } })
  t.after(() => host.dispose())

  const { askPromise, settle } = await driveAsk(host, { callId: 'auto-1', sessionId: 'auto-1-session' })
  const ack = await host.postFeedback('auto-1', 'allowed-once')
  assert.equal(ack.statusCode, 200)
  settle('allowed-once')
  await askPromise

  assert.equal(lastHistorySource(host, 'auto-1-session'), 'auto-allow', 'the auto answer must not be credited to a human')
})

test('an answer without the auto marker stays human-*', async (t) => {
  const host = createHostContext({ config: { categoryMode: 'aggressive', highRiskSeconds: 5 } })
  t.after(() => host.dispose())

  const { askPromise, settle } = await driveAsk(host, { callId: 'human-1', sessionId: 'human-1-session' })
  settle('allowed-once')
  await askPromise

  assert.equal(lastHistorySource(host, 'human-1-session'), 'human-allow')
})
