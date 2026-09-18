/**
 * Consumption points for the wiring-level safety fields.
 *
 * These fields are consumed deep inside the host wiring (post-execute result
 * masking, the pre-execute rule evaluation, the answerer's LOCKED clamp), so
 * each test drives the real registered handler and asserts the production
 * return shape / audit row — never a source-text match, and never a stub's
 * return value used as the oracle.
 *
 * Covered here:
 *   - redactResults -> masks a successful auto-session result and audits it;
 *     off forwards the untouched value;
 *   - rulesDryRun -> an enforced deny is a deny, while dry-run must not enforce;
 *   - timeoutAction + LOCKED ask -> a deliberate no-delta pin: the LOCKED
 *     countdown stays pinned to reject even when the user configured allow.
 *
 * Run: node --test tests/consumption-wiring.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHostContext } from './helpers/host-ctx.mjs'

test('redactResults gates result masking and its audit row', async (t) => {
  // One host at a time: the harness installs process-wide runtime paths, so two
  // live hosts would write each other's audit rows into the newer state dir.
  const forwarded = { kind: 'forwarded-to-host' }
  const on = createHostContext({ config: { redactResults: true } })
  try {
    const session = on.makeSession({ id: 'redact-on-session', callId: 'redact-on-call', args: {} })
    const exec = on.makeExec({ name: 'bash', args: {}, callId: 'redact-on-call', session })
    exec.toolName = 'bash' // the post-execute listener audits exec.toolName
    const masked = await on.invokePostExecute(exec, { isError: false, value: { token: 'x' } })
    assert.deepEqual(masked, { kind: 'accept', value: { token: '[redacted:field]' } }, 'the secret-shaped field is replaced, not the whole result')
    const redactRows = on.readAuditLines().filter((line) => line.type === 'result-redacted')
    assert.equal(redactRows.length, 1, 'the masking is audited exactly once')
    assert.equal(redactRows[0].callId, 'redact-on-call')
    assert.equal(redactRows[0].toolName, 'bash')

    // An errored result is never rewritten into an accept by the masking gate.
    // The sentinel proves the handler forwarded to `next`, not that it happened
    // to equal the harness stub's undefined.
    const errored = await on.invokePostExecute(exec, { isError: true, value: { token: 'x' } }, async () => forwarded)
    assert.equal(errored, forwarded, 'an errored result falls through to the host')
  } finally {
    on.dispose()
  }

  const off = createHostContext({ config: { redactResults: false } })
  try {
    const offSession = off.makeSession({ id: 'redact-off-session', callId: 'redact-off-call', args: {} })
    const offExec = off.makeExec({ name: 'bash', args: {}, callId: 'redact-off-call', session: offSession })
    const untouched = await off.invokePostExecute(offExec, { isError: false, value: { token: 'x' } }, async () => forwarded)
    assert.equal(untouched, forwarded, 'with the switch off the host result is forwarded untouched')
    assert.equal(off.readAuditLines().some((line) => line.type === 'result-redacted'), false)
  } finally {
    off.dispose()
  }
})

test('rulesDryRun: an enforced deny denies, a dry-run deny does not', async (t) => {
  const rulesText = 'bash(rm.*) | deny | arguments'
  const run = (host, callId) => {
    const args = { command: 'rm -rf /tmp/consumption-dryrun' }
    const session = host.makeSession({ id: `${callId}-session`, callId, args })
    return host.invokePreExecute(host.makeExec({ name: 'bash', args, callId, session }))
  }

  const enforced = createHostContext({ config: { rulesDryRun: false, rulesText } })
  try {
    const denied = await run(enforced, 'dry-enforced')
    assert.equal(denied.kind, 'deny', 'a live rule must enforce')
  } finally {
    enforced.dispose()
  }

  const dry = createHostContext({ config: { rulesDryRun: true, rulesText } })
  try {
    const notEnforced = await run(dry, 'dry-not-enforced')
    assert.equal(notEnforced.kind, 'ask', 'a dry-run rule must not enforce; the call falls through')
    assert.equal(
      dry.readAuditLines().some((line) => line.source === 'rule-deny'),
      false,
      'dry-run must not write a rule-deny decision',
    )
  } finally {
    dry.dispose()
  }
})

test('LOCKED ask ignores timeoutAction=allow (deliberate no-delta)', async (t) => {
  // Not a bug fix: the LOCKED categories are an authorization boundary, so the
  // user's timeout action does not apply. The pin exists so a refactor that
  // wires `config.timeoutAction` into a locked status goes red.
  const host = createHostContext({ config: { categoryMode: 'aggressive', timeoutAction: 'allow', highRiskSeconds: 20 } })
  t.after(() => host.dispose())

  const callId = 'locked-allow'
  const args = { command: 'rm never-created.txt' }
  const session = host.makeSession({ id: 'locked-allow-session', callId, args })
  const pre = await host.invokePreExecute(host.makeExec({ name: 'bash', args, callId, session }))
  assert.equal(pre.kind, 'ask', 'the locked category ask must reach the answerer')

  const req = { callId, toolName: 'bash', agent: { session }, signal: undefined, reason: 'locked no-delta test' }
  let resolveNext = () => {}
  const nextPromise = new Promise((resolve) => { resolveNext = resolve })
  const askPromise = host.invokeApprovalRequest(req, () => nextPromise)
  try {
    const status = await host.waitFor(async () => {
      const response = await host.readReviewStatus(callId)
      return response.body?.ok === true ? response.body.value : undefined
    }, 'locked countdown status')
    assert.equal(status.action, 'reject', 'timeoutAction=allow must not flip a LOCKED ask')
    assert.equal(status.lockedAsk, true, 'the LOCKED shape is preserved')
    assert.equal(status.phase, 'countdown')
    assert.equal(status.seconds, 20)
  } finally {
    resolveNext('rejected')
    await askPromise
  }
})
