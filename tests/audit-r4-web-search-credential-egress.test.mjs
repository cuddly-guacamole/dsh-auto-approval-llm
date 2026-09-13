/**
 * Credential material on an egress channel covers web_search.
 *
 * The credential/private-key fuse fires when a call's arguments carry
 * credential material AND the tool can send it off-host. Its egress name set
 * listed web_fetch/curl/wget but not web_search, while web_search holds a
 * blanket read-only static allow — so the same payload that was hard-denied
 * through web_fetch was allowed, unreviewed, through web_search.
 *
 * Run: node --test tests/audit-r4-web-search-credential-egress.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'
import { assessTool } from '../lib/auto/policy.js'
import { resolveRoots } from '../lib/auto/paths.js'

const roots = resolveRoots('C:/ws', { home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh' })
roots.allowedDshSubpaths = []
roots.maintenanceDshPaths = []
roots.mode = 'aggressive'
roots.trustedDirs = []
const registry = new ArtifactRegistry()
const assess = (name, args) => assessTool({ name, arguments: args, agent: undefined }, roots, registry)

const CREDENTIAL_PAYLOADS = [
  { query: 'sk-1234567890abcdefghijklmn' },
  { query: 'api_key=AKIAIOSFODNN7EXAMPLE' },
  { query: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' },
]

test('a credential-bearing search is denied like the same fetch payload', () => {
  for (const args of CREDENTIAL_PAYLOADS) {
    const fetched = assess('web_fetch', args)
    const searched = assess('web_search', args)
    assert.equal(fetched.decision, 'deny', 'precondition: the payload trips the credential egress fuse')
    assert.equal(searched.decision, 'deny', `${JSON.stringify(args)} must not leave through web_search`)
    assert.equal(searched.decision, fetched.decision, 'both egress spellings must share the verdict')
  }
})

test('an ordinary search keeps its static allow', () => {
  const verdict = assess('web_search', { query: 'dsh plugin approval pipeline' })
  assert.equal(verdict.decision, 'allow')
})

test('host-internal orchestration stays outside the egress set', () => {
  assert.notEqual(assess('send_message', { text: 'sk-1234567890abcdefghijklmn' }).decision, 'deny')
})
