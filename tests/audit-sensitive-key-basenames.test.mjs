/**
 * Private-key basenames must participate in the sensitive-name fuse.
 *
 * The sensitive basename table covered `.env`/rc families and credential
 * directories, but bare key files (`id_rsa`, `*.pem`, `*.key`) were fused only
 * by the shell exfiltration marker — and only when paired with an exfil
 * command. A workspace-relative read, copy or structured write of a private
 * key was a static allow on both planes, while the same file inside `.ssh/`
 * hits the credential floor. The floor's contract (real-credential reads stay
 * locked) now holds at any position; the public half of a key pair stays
 * routine.
 *
 * Run: node --test tests/audit-sensitive-key-basenames.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessShell } from '../lib/auto/shell.js'
import { assessTool } from '../lib/auto/policy.js'
import { sensitiveBasenameAt } from '../lib/auto/category.js'
import { resolveRoots } from '../lib/auto/paths.js'

const HOME = 'C:/Users/u'
const roots = resolveRoots('C:/ws')
const owner = { id: 'session-key-basenames' }
const artifacts = new (await import('../lib/auto/artifacts.js')).ArtifactRegistry()

const assess = (command) => assessShell(command, 'bash', roots, artifacts, owner)
const tool = (name, args) => assessTool({ name, arguments: args }, roots, artifacts)

const notStaticAllow = (verdict, label) => {
  assert.ok(verdict !== undefined && verdict !== null, `${label} must not be a static allow`)
  assert.notEqual(verdict.decision, 'allow', `${label} must not be a static allow`)
}

test('bare private-key reads leave the static fast path at any position', () => {
  notStaticAllow(assess('cat ./id_rsa'), 'workspace id_rsa read')
  notStaticAllow(assess('cat C:/ws/server.pem'), 'pem read')
  notStaticAllow(assess('cat C:/ws/app.key'), 'key read')
})

test('copying a bare private key is judged like copying one out of .ssh', () => {
  notStaticAllow(assess('cp ./id_rsa ./copy.pem'), 'id_rsa copy')
  notStaticAllow(assess('cp ~/.ssh/id_rsa ./copy.pem'), '.ssh id_rsa copy')
})

test('a structured write of a key basename is not a routine edit', () => {
  notStaticAllow(tool('write', { file_path: 'C:/ws/id_rsa' }), 'structured id_rsa write')
  notStaticAllow(tool('write', { file_path: 'C:/ws/ca.key' }), 'structured .key write')
})

test('the public half of a key pair and ordinary files stay routine', () => {
  assert.equal(assess('cat ./id_rsa.pub').decision, 'allow', 'id_rsa.pub stays a static allow')
  assert.equal(assess('cat C:/ws/notes.txt').decision, 'allow', 'ordinary reads stay static allows')
})

test('the single sensitive-name owner sees the key basenames (table drift guard)', () => {
  for (const name of ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'host.pem', 'host.key']) {
    assert.equal(sensitiveBasenameAt(`C:/ws/${name}`, roots), true, `${name} must be sensitive`)
  }
  assert.equal(sensitiveBasenameAt('C:/ws/id_rsa.pub', roots), false, 'public key stays routine')
})
