/**
 * Directory-changer resolution base must be recomputed per segment.
 *
 * The hard-deny fuses resolve a relative target against the directory the
 * segment really sees. A `cd` moves that base only inside an `&&` chain, where
 * reaching the next segment proves the changer ran and succeeded; across
 * `;`/`|`/`&` the base resets to the workspace, which is what keeps
 * `cd /nodir; printf x > package.json` a hard deny.
 *
 * The base used to live in a variable that only ever advanced: it was assigned
 * when a changer was in effect and never rewritten when the chain guarantee was
 * broken. A `;` cleared the flag but left the last base in place, so
 *
 *   cd C:/tmp && printf a > f1.txt; cd <workspace>; printf x > package.json
 *
 * judged the final write against C:/tmp and missed the workspace's own
 * contract file — a fail-open on the strongest fuse class in the plugin. The
 * base is now recomputed from the flag on every segment.
 *
 * Both directions are pinned: the reset must deny, and the legitimate
 * `&&`-chain re-anchoring that motivated the feature must keep working.
 *
 * Run: node --test tests/changer-base-reset.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { hardDenyShellReason } from '../lib/auto/shell.js'
import { normalizePath, resolveRoots } from '../lib/auto/paths.js'

const PLUGIN_REPO = 'C:/Users/Administrator/.dsh/plugins/dsh-auto-approval-llm'
const OTHER = 'C:/Users/Administrator/AppData/Local/Temp/dsa-other-dir'
const CONTRACT_FILE_REASON = "the plugin's own contract/build file"

function makeRoots(workspace = PLUGIN_REPO) {
  const roots = resolveRoots(workspace, {})
  roots.allowedDshSubpaths = [normalizePath(PLUGIN_REPO, roots.workspace, roots.home)]
  roots.maintenanceDshPaths = []
  roots.mode = 'aggressive'
  roots.trustedDirs = []
  return roots
}

// The workspace IS the plugin repo: it holds the contract files the fuse
// recognises, so a relative `package.json` is a fused target only when the
// reading really lands there.
const roots = makeRoots()
const deny = (command) => hardDenyShellReason(command, 'bash', roots)

test('control: a plain contract-file write is denied, so the cases below are meaningful', () => {
  const reason = deny('printf x > package.json')
  assert.ok(reason !== undefined && reason.includes(CONTRACT_FILE_REASON), `got: ${reason}`)
})

test('base reset: a changer that ran earlier does not survive a `;`', () => {
  // The fail-open this file exists for.
  const exploit = `cd ${OTHER} && printf a > f1.txt; cd ${PLUGIN_REPO}; printf x > package.json`
  const reason = deny(exploit)
  assert.ok(reason !== undefined, 'the workspace contract-file write must be denied')
  assert.ok(reason.includes(CONTRACT_FILE_REASON), `got: ${reason}`)
})

test('base reset: a `;` after an `&&`-guarded changer cannot carry its base forward', () => {
  // Here the relative write after the `;` is no longer covered by the `&&`
  // guarantee, so it is judged against the workspace — the conservative answer.
  const reason = deny(`cd ${OTHER} && printf a > f1.txt; printf x > package.json`)
  assert.ok(reason !== undefined && reason.includes(CONTRACT_FILE_REASON), `got: ${reason}`)
})

test('base reset: a pipe breaks the guarantee too', () => {
  const reason = deny(`cd ${OTHER} && ls | printf x > package.json`)
  assert.ok(reason !== undefined && reason.includes(CONTRACT_FILE_REASON), `got: ${reason}`)
})

test('base reset: a background `&` breaks the guarantee', () => {
  const reason = deny(`cd ${OTHER} & printf x > package.json`)
  assert.ok(reason !== undefined && reason.includes(CONTRACT_FILE_REASON), `got: ${reason}`)
})

test('the legitimate re-anchor still works: a changer inside an `&&` chain moves the base', () => {
  // "The criterion should NOT hold here" half. This is the false positive the
  // re-anchoring was introduced to remove: writing package.json in a temp dir
  // reached through a successful `cd` is not a write to the workspace's own
  // contract file.
  for (const command of [
    `cd ${OTHER} && printf x > package.json`,
    `mkdir -p ${OTHER} && cd ${OTHER} && printf x > package.json`,
  ]) {
    assert.equal(deny(command), undefined, `${command} must not be denied as a contract-file write`)
  }
})

test('the legitimate re-anchor still works for the second changer in a chain', () => {
  // Two changers in an `&&` chain: the base must be the LAST one, and here that
  // last base leaves the plugin tree, so there is nothing to deny.
  const command = `cd C:/tmp && cd ${OTHER} && printf x > package.json`
  assert.equal(deny(command), undefined, `got: ${deny(command)}`)
})

test('structural: the base is recomputed per segment, not carried in a sticky variable', () => {
  // Behaviour tests above cover today's shapes; this pins the implementation
  // shape so the sticky variant cannot come back through a rewrite. The
  // compiled ternary is the single place the base is chosen.
  const source = readFileSync(fileURLToPath(new URL('../lib/auto/shell.js', import.meta.url)), 'utf8')
  const fn = source.slice(source.indexOf('function hardDenyShellReason'), source.indexOf('function assessSegment'))
  assert.ok(fn.length > 0, 'hardDenyShellReason is present in the compiled module')
  assert.ok(
    fn.includes('const segmentRoots = changerBase !== undefined ?'),
    'the per-segment base is computed with a const ternary inside the loop',
  )
  assert.ok(
    !fn.includes('let segmentRoots'),
    'the sticky `let segmentRoots` variable must be gone',
  )
})
