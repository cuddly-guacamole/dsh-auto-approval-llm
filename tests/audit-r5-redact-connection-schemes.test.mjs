/**
 * Connection-string masking was a scheme whitelist, so the userinfo of every
 * scheme the list had not seen (mssql, clickhouse, s3, cassandra,
 * elasticsearch, couchdb, influxdb, sqlserver, ...) reached the classifier and
 * reviewer requests in clear text, while the listed schemes were masked. A
 * second shape leaked part of a password: with a bare '@' inside the password
 * only the part up to the first '@' was masked.
 *
 * The predicate is structural now (a ':' before the '@' inside the authority,
 * stopping at '/', '?', '#' and whitespace), which is what keeps a plain URL
 * whose path contains '@' untouched. Pins both directions.
 *
 * Run: node --test tests/audit-r5-redact-connection-schemes.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { redactSecrets } from '../lib/auto/redact.js'

const SECRET = 'hunter2SHOULDNOTAPPEAR'

test('userinfo is masked for schemes outside the old whitelist', () => {
  for (const scheme of [
    'postgres',
    'postgresql',
    'redis',
    'rediss',
    'mongodb',
    'mysql',
    'mssql',
    'sqlserver',
    'clickhouse',
    's3',
    'cassandra',
    'elasticsearch',
    'couchdb',
    'influxdb',
    'amqp',
    'nats',
    'https',
    'smtp',
    'ftp',
    'ws',
    'ssh',
    'git',
    'kafka',
    'ldap',
  ]) {
    const source = `connect ${scheme}://service:${SECRET}@db.internal:5432/app`
    const masked = redactSecrets(source)
    assert.ok(!masked.includes(SECRET), `${scheme} userinfo must be masked (got ${masked})`)
    assert.ok(masked.includes(scheme + '://'), `${scheme} scheme stays readable`)
    assert.ok(masked.includes('db.internal'), `${scheme} host stays readable`)
  }
})

test('a password that itself contains @ is masked whole', () => {
  for (const source of [
    `postgres://service:${SECRET}@tail@db.internal/app`,
    `https://service:${SECRET}@tail@db.internal/app`,
  ]) {
    const masked = redactSecrets(source)
    assert.ok(!masked.includes(SECRET), `the whole userinfo must be masked (got ${masked})`)
    assert.ok(!masked.includes('@tail'), `no password tail may survive (got ${masked})`)
    assert.ok(masked.includes('db.internal'), 'the host stays readable')
  }
})

test('the redis spelling with an empty user is still masked', () => {
  const masked = redactSecrets(`redis://:${SECRET}@cache.internal:6379`)
  assert.ok(!masked.includes(SECRET), `redis :password@ must be masked (got ${masked})`)
})

test('ordinary text and @ that is not userinfo are untouched', () => {
  for (const source of [
    'https://example.com/path@x',
    'https://user@host/without/password',
    'git@github.com:org/repo.git',
    'echo "mail me at someone@example.com"',
    'scp ./file user@host:/tmp/',
    'https://example.com/a/b?x=1#@frag',
  ]) {
    assert.equal(redactSecrets(source), source, `${source} must be untouched`)
  }
})
