/**
 * dsh-auto-approval-llm · direct-human-approval channel (dsa_request_human).
 *
 * The agent calls dsa_request_human to route a follow-up operation to a human
 * instead of the LLM classifier; a granted approval trains the confirmation
 * layer against the TARGET operation's signature. These contracts pin the
 * policy special case (pure-human ask plane, never the classifier) and the
 * host wiring anchors (answerer branch, target-signature learnable).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DIRECT_HUMAN_TOOL } from '../lib/auto/constants.js'
import { assessTool } from '../lib/auto/policy.js'

const roots = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: [] }
const artifacts = { has: () => false }

// ── policy layer: the tool is pinned to the pure-human ask plane ──────────

test('assessTool: dsa_request_human is a classifier-ineligible ask (never the LLM)', () => {
  const verdict = assessTool({ name: DIRECT_HUMAN_TOOL, arguments: { toolName: 'memory_update' } }, roots, artifacts)
  assert.equal(verdict.decision, 'ask')
  assert.equal(verdict.classifierEligible, false)
})

test('assessTool: dsa_request_human with no args still routes to the human plane', () => {
  const verdict = assessTool({ name: DIRECT_HUMAN_TOOL, arguments: {} }, roots, artifacts)
  assert.equal(verdict.decision, 'ask')
  assert.equal(verdict.classifierEligible, false)
})

test('assessTool: the tool name avoids the risk-name patterns (no HIGH by name)', () => {
  // If the name matched destructive/external-write/security-change the reason
  // would flip to a risk-labeled ask; the special case must win regardless.
  const verdict = assessTool({ name: DIRECT_HUMAN_TOOL, arguments: { toolName: 'write' } }, roots, artifacts)
  assert.match(verdict.reason ?? '', /direct human request/)
})

test('assessTool: other unknown plugin tools keep the ordinary classifier-eligible ask', () => {
  const verdict = assessTool({ name: 'some_other_plugin_tool', arguments: {} }, roots, artifacts)
  assert.equal(verdict.decision, 'ask')
  assert.equal(verdict.classifierEligible, true)
})

// ── static wiring anchors (compile the fail-closed route in place) ────────

test('static anchors: answerer routes dsa_request_human before the static lists', () => {
  const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const directIdx = host.indexOf('direct-human-approval channel (dsa_request_human)')
  const staticIdx = host.indexOf('const staticDecision = staticListDecision(config, toolName)')
  assert.ok(directIdx !== -1, 'answerer direct-human branch exists')
  assert.ok(staticIdx !== -1, 'static list decision still exists after the branch')
  assert.ok(directIdx < staticIdx, 'direct-human branch runs before denyList/allowlist')
})

test('static anchors: the ask builds a learnable from the TARGET tool signature', () => {
  const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(host, /const targetReq = \{ \.\.\.req, toolName: targetTool \}/, 'target request is synthesized')
  assert.match(host, /learnableContextFor\(targetReq/, 'learnable is built from the target request')
  assert.match(host, /const directOutcome = await askHuman\(req, undefined, next, false, undefined, undefined, false, undefined\)/, 'status-less human ask resolves first (learnable recorded after)')
  assert.match(host, /recordConfirm\(learningStore, targetLearnable\.key/, 'a grant records the confirmation on the target signature')
  assert.match(host, /resetConfirmation\(learningStore, targetLearnable\.key/, 'a denial resets the target confirmation count')
})

test('static anchors: absent target args are normalized so a coarse signature is still learned', () => {
  // signatureFor returns undefined for an undefined args payload, which made
  // an args-less dsa_request_human grant silently skip the confirmation
  // record (verified live: history showed human-allow, learning.json did not
  // move). Normalizing to {} yields a stable `toolName()` signature.
  const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(host, /const targetArgsPayload = targetArgs \?\? targetArgsText \?\? \{\}/, 'args-less requests fall back to an empty-object payload')
  assert.match(host, /classifyStaticRisk\(targetReq, targetArgsPayload\)/, 'risk grade uses the normalized payload')
  assert.match(host, /learnableContextFor\(targetReq, targetArgsPayload,/, 'learnable uses the normalized payload')
})

test('static anchors: high-risk targets are refused before the human ask', () => {
  const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(host, /targetRisk !== 'LOW' && targetRisk !== 'MEDIUM'/, 'HIGH/DENY/unknown targets are refused')
  assert.match(host, /direct-human-refused/, 'refusal leaves a distinct history source')
})

test('static anchors: the tool registers through the host tools service', () => {
  const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(host, /anyCtx\.tools\?\.register/, 'tool registers through the tools service')
  assert.match(host, /name: DIRECT_HUMAN_TOOL/, 'registration uses the shared constant')
})

test('static anchors: parameters are a full JSON Schema object (register stores it verbatim)', () => {
  // tools.register stores the definition as-is — parameters is NOT compiled
  // from the defineTool spec shorthand, so it must already be a JSON Schema
  // with a top-level `type: "object"`. Shipping the shorthand shape produced
  // a live 400 ("Invalid schema ... got 'type: null'") when the model API
  // consumed the tool.
  const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const regStart = host.indexOf('name: DIRECT_HUMAN_TOOL,')
  const regBlock = host.slice(regStart, regStart + 1600)
  assert.match(regBlock, /parameters: \{\s*\n\s*type: 'object',/, 'parameters declares a top-level JSON Schema object type')
  assert.match(regBlock, /required: \['toolName'\]/, 'parameters declares the required target toolName')
  assert.match(regBlock, /additionalProperties: false/, 'parameters rejects unknown keys')
})

test('static anchors: render returns a ContentBlock array, never a bare string', () => {
  // Official render contract is ContentBlock[] ({type:'text',...}); a bare
  // string made the host call .some() on it and crash at runtime
  // ("content.some is not a function").
  const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const regStart = host.indexOf('name: DIRECT_HUMAN_TOOL,')
  const regBlock = host.slice(regStart, regStart + 2600)
  assert.match(regBlock, /return \[\{ type: 'text', text: /, 'render returns a text ContentBlock array')
})

test('static anchors: the new switch defaults to off (fail closed)', () => {
  const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(host, /directHumanEnabled: z\.boolean\(\)\.default\(false\)/, 'schema defaults off')
  assert.match(host, /config\.directHumanEnabled === true/, 'answerer branch is gated on the switch')
})

test('static anchors: execute refuses non-Auto sessions with a direct-execute error', () => {
  // The tool is registered globally, so it is visible to every session; in a
  // session without Auto takeover (or with the channel disabled) reaching
  // execute must throw a clear "execute directly" error instead of returning
  // a fake grant the agent would mistake for a human pre-approval.
  const host = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(host, /config\.directHumanEnabled !== true \|\| !isAutoExecution\(\{ agent: exec\?\.agent \}\)/, 'execute gates on the switch and Auto takeover')
  assert.match(host, /execute the target operation directly/, 'the error tells the agent to execute directly')
  assert.match(host, /do not request escalation/, 'the error forbids further escalation attempts')
})
