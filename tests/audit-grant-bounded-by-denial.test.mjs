/**
 * G · 「授权永不比产生它的否决更大」—— 行为化契约。
 *
 * Ruler: a grant must never exceed the decision that produced it, in
 * persistence, lifetime, tier/scope and subject. This file pins the boundary
 * that is mechanically observable end to end: a NAME-based pre-authorization
 * (declared allow rule, allowlist) must not settle a call a hard lock keeps
 * away from names. Each case pairs the gated call with a positive control on
 * the SAME channel, so "no allow record" cannot pass vacuously.
 *
 * Registry — invariant -> existing evidence (reused, not duplicated):
 *   - guard deny overrides a same-call allowed-once, append-only audit:
 *     tests/guard-deny-decision.test.mjs; tests/audit-guard-deny.test.mjs
 *   - migration writes raw identity only; permissionPresets.set() banned:
 *     tests/preset-migration.test.mjs:269-290
 *   - an effective-never preset normalizes back to ask:
 *     tests/preset-migration.test.mjs:172,190
 *   - the name-channel floor predicate and its four wiring sites:
 *     tests/audit-name-channel-lock-floor.test.mjs:18-47
 *   - rule-allow's locked gate sits before its settle in both planes:
 *     tests/audit-rule-allow-locked-gate.test.mjs:21-57
 *   - a LOCKED ask ignores timeoutAction=allow:
 *     tests/consumption-wiring.test.mjs:90-120
 *   - policy-deny precedes the learned-allow query (exact ordering only):
 *     tests/category.test.mjs:782-795
 * Boundaries: learned-allow is unreachable in host-ctx (no session model
 * route, src/index.ts:4942); static-allow IS reachable and unused here; for a
 * delete without sessionArtifactDeletion the pre-execute allowlist mirror is
 * unreachable (category ask returns first, src/index.ts:4088), so the
 * allowlist case pins the answerer gate only; config write-back is not
 * observable here (no settings service, no permissionPresets.set, no
 * session.append on the allow path).
 * Acknowledged amplifications (user-configured, explicit; registered, not
 * blessed): timeoutAction=allow covers non-locked HIGH (src/index.ts:619-624);
 * unattended settles LOW/MEDIUM regardless of reject; standard-mode
 * protected/privilege inherit (src/auto/category.ts:833-842) and settle by
 * timeoutAction unless the directive is 'ask' (src/index.ts:5352-5370).
 *
 * Run: node --test tests/audit-grant-bounded-by-denial.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHostContext } from './helpers/host-ctx.mjs'
import { staticListDecision } from '../lib/auto/decision.js'
import { parseRulesText, evaluateRules } from '../lib/auto/rules.js'

/** Drive one ask to its published status; returns { pre, status, audit }. */
async function drive(host, { callId, command }) {
  const args = { command }
  const session = host.makeSession({ id: `${callId}-session`, callId, args })
  const exec = host.makeExec({ name: 'bash', args, callId, session })
  const pre = await host.invokePreExecute(exec)
  assert.equal(pre.kind, 'ask', `the gated call must not settle as allow (got ${JSON.stringify(pre)})`)

  const req = { callId, toolName: 'bash', agent: { session }, signal: undefined, reason: 'grant-bounded test' }
  let resolveNext = () => {}
  const nextPromise = new Promise((resolve) => { resolveNext = resolve })
  const askPromise = host.invokeApprovalRequest(req, () => nextPromise)
  try {
    const status = await host.waitFor(async () => {
      const response = await host.readReviewStatus(callId)
      return response.body?.ok === true ? response.body.value : undefined
    }, `review status for ${callId}`)
    return { pre, status, audit: host.readAuditLines() }
  } finally {
    resolveNext('rejected')
    await askPromise
  }
}

/** Run fn against a fresh host, then dispose it (one host at a time). */
async function withHost(config, fn) {
  const host = createHostContext({ config })
  try {
    return await fn(host)
  } finally {
    host.dispose()
  }
}

test('a declared allow rule does not release a hard-locked delete', async () => {
  // The rule channel reaches its own locked gate before any other layer
  // settles, so it is where the grant could beat the denial.
  const rulesText = 'bash(rm.*) | allow | arguments'
  const parsed = parseRulesText(rulesText)
  assert.equal(parsed.errors.length, 0)
  assert.equal(
    evaluateRules(parsed.rules, { toolName: 'bash', arguments: '{"command":"rm -rf /tmp/g"}' })?.policy,
    'allow',
    'the fixture rule must allow on its own',
  )

  const gated = await withHost({ categoryMode: 'aggressive', rulesText }, (host) =>
    drive(host, { callId: 'g-rule-allow', command: 'rm -rf /tmp/g-rule-allow' }))

  assert.match(String(gated.pre.reason), /hard-locked category delete/, 'the rule allow must hit the name-channel lock gate, not settle')
  assert.equal(gated.status.phase, 'countdown')
  assert.equal(gated.status.action, 'reject', 'the hard lock pins the countdown to reject')
  assert.equal(gated.status.lockedAsk, true)
  assert.equal(
    gated.audit.some((line) => line.source === 'rule-allow'),
    false,
    'the gated call must leave no rule-allow record',
  )

  // Positive control: the same channel DOES write rule-allow when the call is
  // not locked, so the absence above is a real observation, not an empty log.
  await withHost({ categoryMode: 'aggressive', rulesText: 'bash(ls.*) | allow | arguments' }, async (control) => {
    const args = { command: 'ls' }
    const session = control.makeSession({ id: 'g-rule-control-session', callId: 'g-rule-control', args })
    const out = await control.invokePreExecute(control.makeExec({ name: 'bash', args, callId: 'g-rule-control', session }))
    assert.equal(out.kind, 'allow', 'the rule channel must allow an unlocked match')
    assert.equal(
      control.readAuditLines().some((line) => line.source === 'rule-allow'),
      true,
      'the control proves rule-allow rows are visible when they happen',
    )
  })
})

test('an allowlisted tool name does not release a hard-locked delete', async () => {
  // The pre-execute category ask returns before the allowlist mirror
  // (src/index.ts:4088), so this pins the answerer gate (src/index.ts:5305-5326).
  assert.deepEqual(
    staticListDecision({ denyList: [], allowlist: ['bash'], humanOnlyList: [] }, 'bash'),
    { kind: 'allow', source: 'allowlist-allow' },
    'the precondition must be a real allowlist-allow verdict',
  )

  const gated = await withHost({ categoryMode: 'aggressive', allowlist: ['bash'] }, (host) =>
    drive(host, { callId: 'g-allowlist', command: 'rm -rf /tmp/g-allowlist' }))

  assert.equal(gated.status.phase, 'countdown')
  assert.equal(gated.status.action, 'reject')
  assert.equal(gated.status.lockedAsk, true)
  assert.equal(
    gated.audit.some((line) => line.source === 'allowlist-allow'),
    false,
    'the gated call must leave no allowlist-allow record',
  )

  // Positive control: the same allowlist DOES settle an unlocked call, so the
  // answerer gate — not a broken allowlist lookup — is what refused the delete.
  await withHost({ categoryMode: 'aggressive', allowlist: ['bash'] }, async (control) => {
    const args = { command: 'ls' }
    const session = control.makeSession({ id: 'g-allowlist-control-session', callId: 'g-allowlist-control', args })
    const out = await control.invokePreExecute(control.makeExec({ name: 'bash', args, callId: 'g-allowlist-control', session }))
    assert.equal(out.kind, 'allow', 'the allowlist must settle an unlocked call')
    assert.equal(
      control.readAuditLines().some((line) => line.source === 'allowlist-allow'),
      true,
      'the control proves allowlist-allow rows are visible when they happen',
    )
  })
})
