/**
 * The learning fuse must have the same domain as the faces it learns from.
 *
 * The policy credential-read face and the shell read-source fuse pair the
 * sensitive-name table with the critical-path set (own-home rc files like
 * `.zshrc`, the autostart trees); learningFuseDecision consulted only the
 * sensitive table and the workspace-protected list, so a structured write to
 * an own-home rc file was learnable — three human allows and the signature
 * replays forever — on a target every other face treats as locked.
 *
 * Run: node --test tests/audit-learning-fuse-critical-path.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { learningFuseDecision } from '../lib/auto/learning.js'

const HOME = 'C:/Users/u'
const roots = {
  workspace: 'C:/ws',
  home: HOME,
  dshHome: `${HOME}/.dsh`,
  tempRoots: [],
  allowedDshSubpaths: [],
  trustedDirs: [],
  mode: 'standard',
}
const config = { categoryPolicy: {}, categoryMode: 'standard' }
const fuse = (toolName, args) => learningFuseDecision({ toolName, args, roots, config })

test('own-home rc files and autostart trees are outside the learning domain', () => {
  for (const [toolName, args] of [
    ['write', JSON.stringify({ file_path: `${HOME}/.zshrc` })],
    ['write', JSON.stringify({ file_path: `${HOME}/.bash_login` })],
    ['edit', JSON.stringify({ path: `${HOME}/.profile` })],
    ['write', JSON.stringify({ file_path: `${HOME}/.config/autostart/evil.desktop` })],
  ]) {
    assert.equal(fuse(toolName, args), true, `${toolName} → ${args} must be fuse-hit`)
  }
})

test('the sensitive-table and workspace-protected shapes keep their hits (control)', () => {
  assert.equal(fuse('write', JSON.stringify({ file_path: `${HOME}/.env` })), true)
  assert.equal(fuse('write', JSON.stringify({ file_path: `${HOME}/.ssh/x` })), true)
  assert.equal(fuse('write', JSON.stringify({ file_path: 'C:/ws/.mcp.json' })), true)
})

test('ordinary project content stays learnable (no over-block)', () => {
  assert.equal(fuse('write', JSON.stringify({ file_path: 'C:/ws/src/index.ts' })), false)
  assert.equal(fuse('write', JSON.stringify({ file_path: 'C:/other/project/file.md' })), false,
    'an ordinary external path is gated by the ask itself, not by the fuse')
})
