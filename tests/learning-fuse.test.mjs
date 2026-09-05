/**
 * dsh-auto-approval-llm · learning sensitive-area fuse contracts.
 *
 * The fuse decides "this call must never be learned" independent of the risk
 * tier and category gates. It reads the same sources as the other gates so
 * the planes cannot drift: risky-name tokens from risk-tokens.ts, shell
 * commands through the category layer's own segment classifier, and path
 * arguments under the same key surface the policy layer reads (including
 * apply_patch's nested patches[].file_path).
 *
 * Run: node --test tests/learning-fuse.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { learningFuseDecision } from '../lib/auto/learning.js'

const roots = {
  workspace: 'C:/ws',
  home: 'C:/Users/u',
  dshHome: 'C:/Users/u/.dsh',
  tempRoots: [],
  trustedDirs: [],
  allowedDshSubpaths: [],
}
const config = { categoryPolicy: {}, categoryMode: 'standard' }
const fuse = (toolName, args) => learningFuseDecision({ toolName, args, roots, config })

test('fuse: a risky tool-name token fuses regardless of arguments', () => {
  assert.equal(fuse('mcp__x__credential_rotate', '{}'), true)
  assert.equal(fuse('bash', JSON.stringify({ command: 'ls C:/ws' })), false, 'an ordinary shell name is not a token hit')
})

test('fuse: shell commands are judged through the category segment classifier', () => {
  // The tool name carries no risk token and there is no path argument — the
  // sensitive target hides inside the command text, which the flat probe
  // never saw before this fuse grew the shell branch.
  assert.equal(fuse('bash', JSON.stringify({ command: 'cp x C:/ws/.env' })), true, 'writing a protected basename is fused')
  assert.equal(fuse('bash', JSON.stringify({ command: 'cp x ~/.ssh/authorized_keys' })), true, 'a credential dir target is fused')
  assert.equal(fuse('pwsh', JSON.stringify({ command: 'echo x > C:/ws/.env' })), true, 'pwsh redirections are fused the same way')
  assert.equal(fuse('bash', JSON.stringify({ command: 'ls C:/ws/src' })), false, 'ordinary project commands stay learnable')
  assert.equal(fuse('bash', JSON.stringify({ command: 'cp x C:/backup/' })), false, 'an unsensitive external write stays with its category gate')
  assert.equal(fuse('bash', '{}'), false, 'a shell call without a command is not fused')
})

test('fuse: structured tools are judged on the same key surface as policy', () => {
  assert.equal(fuse('write', JSON.stringify({ file_path: 'C:/ws/.env', content: 'x' })), true)
  assert.equal(fuse('write', JSON.stringify({ file_path: 'C:/ws/src/a.ts', content: 'x' })), false, 'ordinary project writes stay learnable')
  assert.equal(fuse('read', JSON.stringify({ file_path: 'C:/Users/u/.aws/credentials' })), true, 'a sensitive read target is fused')
  // apply_patch nests its targets; the flat top-level probe misses them.
  const patch = JSON.stringify({ patches: [{ file_path: 'C:/ws/.env', kind: 'update', content: 'x' }] })
  assert.equal(fuse('apply_patch', patch), true, 'a nested patch target on a protected path is fused')
  const benignPatch = JSON.stringify({ patches: [{ file_path: 'C:/ws/src/a.ts', kind: 'update', content: 'x' }] })
  assert.equal(fuse('apply_patch', benignPatch), false, 'ordinary nested patch targets stay learnable')
  // Arguments may arrive as the raw JSON string (as the approval request
  // carries them) or as a parsed object — same verdict either way.
  assert.equal(fuse('apply_patch', { patches: [{ file_path: 'C:/ws/.env' }] }), true)
})

test('fuse: unknown tools without path arguments are not fused', () => {
  assert.equal(fuse('some_future_plugin_tool', '{"answer":42}'), false)
  assert.equal(fuse('some_future_plugin_tool', undefined), false)
})
