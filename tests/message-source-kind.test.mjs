/**
 * dsh-auto-approval-llm · producer-owned message source.
 *
 * The harness vocabulary has no shared catch-all `plugin` source kind, and the
 * durable log refuses a message whose source kind is still `plugin`. Every
 * message this plugin builds must therefore carry its own declared kind; these
 * cases pin the declaration and the compiled wiring that a live session would
 * otherwise be the only place to observe.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_MESSAGE_SOURCE } from '../lib/auto/message-source.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const read = relative => readFileSync(join(ROOT, relative), 'utf8')

test('the declared source is producer-owned', () => {
  assert.equal(PLUGIN_MESSAGE_SOURCE.kind, 'dsh-auto-approval-llm')
  assert.equal('plugin' in PLUGIN_MESSAGE_SOURCE, false, 'the retired plugin field is absent')
})

test('the compiled host carries no retired plugin source', () => {
  const lib = read('lib/index.js')
  assert.equal(
    /source:\s*\{\s*kind:\s*["']plugin["']/.test(lib),
    false,
    'no message source is built with the retired kind',
  )
  assert.equal(/plugin:\s*["']dsh-auto-approval-llm["']/.test(lib), false, 'the retired plugin field is gone')
  assert.equal(
    [...lib.matchAll(/source:\s*PLUGIN_MESSAGE_SOURCE/g)].length,
    3,
    'every createUserMessage call in the host passes the declared source',
  )
})

test('the compiled classifier carries the declared source', () => {
  const classifier = read('lib/auto/dsh-classifier.js')
  assert.equal(/kind:\s*["']plugin["']/.test(classifier), false, 'the retired kind is gone')
  assert.ok(classifier.includes('PLUGIN_MESSAGE_SOURCE'), 'the classifier uses the declared source')
})

test('the declared source module stays dependency free', () => {
  const module = read('lib/auto/message-source.js')
  assert.equal(/^import .*from ['"][^.]/m.test(module), false, 'the module imports no runtime dependency')
  assert.ok(module.includes('dsh-auto-approval-llm'), 'the producer kind is a literal in the compiled module')
})
