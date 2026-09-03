/**
 * dsh-auto-approval-llm · gcloud credential-fuse contracts.
 *
 * Fix: category.ts SENSITIVE_DIRS lacked the `.config/gcloud` tree that
 * paths.ts credentialRoots already fused, so under aggressive / trusted-dir
 * position relaxation `cat ~/.config/gcloud/credentials` could pass the
 * read gate with no review. The two-level marker is now an adjacent-pair
 * match in sensitiveBasenameAt.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { sensitiveBasenameAt } from '../lib/auto/category.js'
import { assessShell } from '../lib/auto/shell.js'

const roots = { workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh', tempRoots: ['C:/Temp'], allowedDshSubpaths: [] }
const aggressiveRoots = { ...roots, mode: 'aggressive' }
const artifacts = { has: () => false }

test('sensitiveBasenameAt: .config/gcloud is a sensitive two-level marker', () => {
  assert.equal(sensitiveBasenameAt('C:/Users/u/.config/gcloud/credentials', roots), true)
  assert.equal(sensitiveBasenameAt('C:/Users/u/.config/gcloud/application_default_credentials.json', roots), true)
  assert.equal(sensitiveBasenameAt('C:/Users/u/.config/other/x.json', roots), false)
  // Single-level sensitive entries keep matching.
  assert.equal(sensitiveBasenameAt('C:/Users/u/.ssh/config', roots), true)
  assert.equal(sensitiveBasenameAt('C:/ws/.env', roots), true)
})

test('assessShell: gcloud credentials stay gated under aggressive position relaxation', () => {
  for (const command of [
    'cat ~/.config/gcloud/credentials',
    'cat ~/.config/gcloud/application_default_credentials.json',
  ]) {
    const r = assessShell(command, 'bash', aggressiveRoots, artifacts, undefined)
    assert.notEqual(r.decision, 'allow', `${command} must not be statically allowed under aggressive`)
  }
  // Ordinary content under aggressive keeps its fast path (no over-block).
  assert.equal(assessShell('cat ~/notes.txt', 'bash', aggressiveRoots, artifacts, undefined).decision, 'allow')
})