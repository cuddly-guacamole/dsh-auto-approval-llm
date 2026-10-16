/**
 * dsh-auto-approval-llm · the custom-endpoint protocol hint copy.
 *
 * settings.reviewer.endpointHint renders directly above the protocol dropdown
 * and is the only text telling the operator which protocols the custom endpoint
 * accepts. It still named two (OpenAI/Anthropic) after the vocabulary grew to
 * four, so both locales are pinned here against the compiled bundle.
 * Run: node --test tests/audit-client-endpoint-hint.test.mjs (tsdown first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const KEY = '"settings.reviewer.endpointHint": "'
const BACKSLASH = String.fromCharCode(92)

/** Every bundled declaration of the hint, unescaped, in bundle order. */
function hintDeclarations() {
  const found = []
  let from = 0
  for (;;) {
    const at = client.indexOf(KEY, from)
    if (at === -1) break
    let i = at + KEY.length
    let text = ''
    while (i < client.length) {
      const ch = client[i]
      if (ch === BACKSLASH) {
        text += client[i + 1]
        i += 2
        continue
      }
      if (ch === '"') break
      text += ch
      i += 1
    }
    found.push(text)
    from = i + 1
  }
  return found
}

const PROTOCOLS = ['OpenAI Chat Completions', 'Anthropic Messages', 'OpenAI Responses', 'System One']

test('client bundle: the endpoint hint names all four protocols in both locales', () => {
  const hints = hintDeclarations()
  assert.equal(hints.length, 2, 'both locales declare the hint')
  for (const hint of hints) {
    // The two-protocol wording is the defect: the dropdown offers four.
    assert.ok(!hint.includes('OpenAI/Anthropic'), `the hint must not name only two protocols: ${hint}`)
    for (const protocol of PROTOCOLS) {
      assert.ok(hint.includes(protocol), `the hint must name ${protocol}: ${hint}`)
    }
  }
})

test('client bundle: the endpoint hint renders above the protocol control it documents', () => {
  const hintAt = client.indexOf('t("settings.reviewer.endpointHint")')
  const protocolAt = client.indexOf('t("settings.reviewer.protocol")')
  assert.ok(hintAt !== -1, 'the hint is rendered')
  assert.ok(protocolAt !== -1, 'the protocol label is rendered')
  assert.ok(hintAt < protocolAt, 'the hint precedes the protocol control it documents')
})
