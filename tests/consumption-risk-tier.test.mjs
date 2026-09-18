/**
 * Consumption points for the risk-tier boundary fields.
 *
 * These fields exist to shape an approval ask (how long it may run, whether the
 * online reviewer is consulted at all), so each one needs a test that flips it
 * and observes the production decision — not an assertion that the source text
 * mentions it. The host context drives the real `apply()` wiring, so the
 * evidence is the published review status the host itself serves.
 *
 * Covered here:
 *   - lowRiskSeconds / mediumRiskSeconds / highRiskSeconds -> the exact
 *     countdown published for a LOW, MEDIUM and HIGH ask;
 *   - llmReviewScope -> whether the LOW ask carries the reviewer lane or the
 *     fail-closed no-review countdown (observable as the timeout notice the
 *     no-review path attaches).
 *
 * Run: node --test tests/consumption-risk-tier.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHostContext } from './helpers/host-ctx.mjs'

/** Drive one ask through pre-execute and the answerer; return the published status. */
async function driveAsk(host, { name, args, callId, route = false }) {
  const session = host.makeSession({ id: `s-${callId}`, callId, args })
  if (route) session.requestHeader = () => ({ config: { provider: 'provider', model: 'model' } })
  const exec = host.makeExec({ name, args, callId, session })
  const pre = await host.invokePreExecute(exec)
  assert.equal(pre.kind, 'ask', `the fixture must reach the answerer (got ${JSON.stringify(pre)})`)

  const req = { callId, toolName: name, agent: { session }, signal: undefined, reason: 'consumption test' }
  let resolveNext = () => {}
  const nextPromise = new Promise((resolve) => { resolveNext = resolve })
  const askPromise = host.invokeApprovalRequest(req, () => nextPromise)
  try {
    return await host.waitFor(async () => {
      const response = await host.readReviewStatus(callId)
      return response.body?.ok === true ? response.body.value : undefined
    }, `review status for ${callId}`)
  } finally {
    resolveNext('rejected')
    await askPromise
  }
}

test('the three risk-tier seconds fields reach the published countdown exactly', async (t) => {
  const host = createHostContext({
    config: {
      categoryMode: 'aggressive',
      categoryPolicy: { fileEdit: 'auto' },
      lowRiskSeconds: 11,
      mediumRiskSeconds: 22,
      highRiskSeconds: 33,
    },
  })
  t.after(() => host.dispose())

  // LOW: an ask the category layer compresses to the LOW tier.
  const low = await driveAsk(host, { name: 'bash', args: { command: 'cp a.txt b.txt' }, callId: 'tier-low' })
  assert.equal(low.risk, 'LOW')
  assert.equal(low.phase, 'countdown')
  assert.equal(low.seconds, 11, 'lowRiskSeconds must be the LOW countdown')

  // MEDIUM: a MEDIUM-tier ask with no reviewer route.
  const medium = await driveAsk(host, { name: 'bash', args: { command: 'npm install lodash' }, callId: 'tier-medium' })
  assert.equal(medium.risk, 'MEDIUM')
  assert.equal(medium.phase, 'countdown')
  assert.equal(medium.seconds, 22, 'mediumRiskSeconds must be the MEDIUM countdown')

  // HIGH: a tool name the static-risk token pattern escalates to HIGH.
  const high = await driveAsk(host, { name: 'credential_dump', args: { target: 'x' }, callId: 'tier-high' })
  assert.equal(high.risk, 'HIGH')
  assert.equal(high.phase, 'countdown')
  assert.equal(high.seconds, 33, 'highRiskSeconds must be the HIGH countdown')
})

test('llmReviewScope decides whether the LOW ask carries the reviewer lane', async () => {
  // Same LOW ask and same available model route; only the scope changes. The
  // reviewer lane publishes its countdown without the no-review timeout notice,
  // so the notice's presence/absence is the observable consumption delta.
  // One host at a time: createHostContext installs process-wide runtime paths,
  // and a second live host would claim the first one's audit directory.
  const args = { command: 'cp a.txt b.txt' }
  const base = { categoryMode: 'aggressive', categoryPolicy: { fileEdit: 'auto' }, lowRiskSeconds: 11 }

  const reviewed = createHostContext({ config: { ...base, llmReviewScope: 'low-or-above' } })
  let withReview
  try {
    withReview = await driveAsk(reviewed, { name: 'bash', args, callId: 'scope-reviewed', route: true })
  } finally {
    reviewed.dispose()
  }

  const unreviewed = createHostContext({ config: { ...base, llmReviewScope: 'high' } })
  let withoutReview
  try {
    withoutReview = await driveAsk(unreviewed, { name: 'bash', args, callId: 'scope-unreviewed', route: true })
  } finally {
    unreviewed.dispose()
  }

  assert.equal(withReview.risk, 'LOW')
  assert.equal(withReview.seconds, 11)
  assert.equal(withReview.feedback, undefined, 'the reviewer lane must not claim the review failed before it ran')

  assert.equal(withoutReview.risk, 'LOW')
  assert.equal(withoutReview.seconds, 11)
  assert.equal(typeof withoutReview.feedback, 'string', 'outside the scope the ask is the no-review countdown')
  assert.ok(withoutReview.feedback.length > 0)

  // `medium-or-above` shares this LOW outcome with `high` (LOW is below both),
  // so the MEDIUM boundary is not distinguished here — registered as a residual
  // in the batch plan rather than pinned with a test that cannot see it.
})
