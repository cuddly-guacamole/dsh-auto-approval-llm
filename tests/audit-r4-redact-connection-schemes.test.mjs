/**
 * Connection-string userinfo on every carrier the plugin sees.
 *
 * The mask table listed postgres/redis/mongo/mysql/mariadb/amqp/nats/http(s),
 * so `smtp://user:pw@host`, `ftp://…` and `ws://…` travelled unredacted even
 * though the parameter-side mask (default on) is what feeds the classifier and
 * reviewer request. The prefilter already recognized `://`; only the rule's
 * scheme table was short.
 *
 * Run: node --test tests/audit-r4-redact-connection-schemes.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets } from '../lib/auto/redact.js'

const SCHEMES = [
  'postgres', 'postgresql', 'redis', 'rediss', 'mongodb', 'mongodb+srv', 'mysql',
  'mariadb', 'amqp', 'amqps', 'nats', 'http', 'https', 'smtp', 'smtps', 'ftp',
  'ftps', 'sftp', 'ws', 'wss', 'imap', 'imaps', 'pop3s', 'ldap', 'ldaps', 'ssh',
  'git', 'kafka', 'nsq',
]

test('every listed carrier masks its userinfo', () => {
  for (const scheme of SCHEMES) {
    const uri = `${scheme}://user:hunter2@host.example.com/path`
    const masked = redactSecrets(uri)
    assert.ok(masked.includes('[redacted:connection-string]'), `${scheme} must be recognized as a connection string`)
    assert.equal(masked.includes('hunter2'), false, `${scheme} must not leak the password`)
    assert.ok(masked.includes(`${scheme}://`), `${scheme} keeps its scheme readable`)
  }
})

test('a plain URL whose path contains @ is untouched', () => {
  const url = 'https://example.com/path@x'
  assert.equal(redactSecrets(url), url)
})

test('ordinary text is untouched', () => {
  assert.equal(redactSecrets('echo hello world'), 'echo hello world')
})
