/**
 * Relative-target anchoring under a directory changer.
 *
 * The hard-deny fuses resolve a relative target against `roots.workspace`, the
 * session's directory. That is right until the line moves somewhere first:
 *
 *   mkdir -p /tmp/x && cd /tmp/x && printf … > package.json
 *
 * writes /tmp/x/package.json, but the fuse read the bare name as a write to the
 * workspace's own package.json — the plugin's contract file — and hard-denied
 * the line. The denial is final (no countdown, no reviewer), so the workaround
 * was to rewrite the command.
 *
 * The fix substitutes the changer's target as the resolution base for the
 * segments that follow it, so every fuse keeps running and a relative name is
 * judged by the path it really denotes. These tests pin the fix AND its
 * boundaries: an unreadable changer must not widen anything, a `..` traversal
 * must still resolve to its true destination, and a changer that runs *after*
 * the write must not retroactively re-anchor it.
 *
 * Run: node --test tests/cd-relative-anchor.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { hardDenyShellReason } from '../lib/auto/shell.js'
import { normalizePath, resolveRoots } from '../lib/auto/paths.js'

// The workspace IS the plugin repo in this scenario: it holds the contract
// files whose names the fuse recognises, which is what made the false positive
// fire at all.
const PLUGIN_REPO = 'C:/Users/Administrator/.dsh/plugins/dsh-auto-approval-llm'

function makeRoots(workspace = PLUGIN_REPO) {
  const roots = resolveRoots(workspace, {})
  roots.allowedDshSubpaths = [normalizePath(PLUGIN_REPO, roots.workspace, roots.home)]
  roots.maintenanceDshPaths = []
  roots.mode = 'aggressive'
  roots.trustedDirs = []
  return roots
}

const roots = makeRoots()
const deny = (command) => hardDenyShellReason(command, 'bash', roots)

const CONTRACT_FILE_REASON = "the plugin's own contract/build file (package.json)"

test('precondition: the bare relative write is still denied in the workspace', () => {
  // Without a changer the name really does denote the workspace file, so the
  // fuse must fire. This is the behaviour the fix must not have removed.
  const reason = deny(String.raw`printf '{"name":"x"}' > package.json`)
  assert.ok(reason !== undefined && reason.includes(CONTRACT_FILE_REASON), `got: ${reason}`)
})

test('the changer re-anchors the relative target, so the tmp write is allowed through', () => {
  const command = String.raw`mkdir -p /tmp/probe-backslash && cd /tmp/probe-backslash && printf '{"name":"probe","private":true}' > package.json`
  assert.equal(deny(command), undefined, 'the write lands in /tmp, not in the workspace')
})

test('a pwsh directory changer re-anchors too', () => {
  const command = String.raw`Set-Location C:/Windows/Temp; Set-Content -Path package.json -Value x`
  assert.equal(hardDenyShellReason(command, 'pwsh', roots), undefined)
})

test('boundary: a changer inside the workspace re-anchors to the same place', () => {
  // `cd .` is a no-op, so the fuse must still see the workspace file.
  const reason = deny(String.raw`cd . && printf x > package.json`)
  assert.ok(reason !== undefined && reason.includes(CONTRACT_FILE_REASON), `got: ${reason}`)
})

test('boundary: an unreadable changer keeps the workspace reading', () => {
  // A dynamic or globbed target cannot be resolved statically, so the base must
  // not move on a guess — otherwise `cd $DIR` would become a way to point
  // relative writes anywhere unchallenged.
  for (const command of [
    String.raw`cd $DIR && printf x > package.json`,
    String.raw`cd * && printf x > package.json`,
    String.raw`cd && printf x > package.json`, // no operand: goes to the home directory
  ]) {
    const reason = deny(command)
    assert.ok(reason !== undefined && reason.includes(CONTRACT_FILE_REASON), `${command} must keep the workspace reading, got: ${reason}`)
  }
})

test('boundary: an opaque line abstains from the fuse, as it did before this change', () => {
  // `${DIR}` is an opaque grouping form, so decomposeCommandLine reports
  // `opaque` and hardDenyShellReason returns undefined before any per-segment
  // check. That abstention is pre-existing (the line goes to semantic review
  // instead) and is asserted here so it is not mistaken for something the
  // re-anchoring introduced.
  assert.equal(deny(String.raw`cd \${DIR} && printf x > package.json`), undefined)
})

test('boundary: a win32 traversal re-anchors to its true destination and still denies', () => {
  // This is why the fix substitutes the base instead of skipping the fuse:
  // `..` from the temp directory resolves to the real path, so a traversal back
  // into the plugin tree is still caught rather than waved through.
  const command = `cd C:/Users/Administrator/AppData/Local/Temp/probe-bs && printf x > ../../../../.dsh/plugins/dsh-auto-approval-llm/package.json`
  const reason = deny(command)
  assert.ok(reason !== undefined && reason.includes(CONTRACT_FILE_REASON), `got: ${reason}`)
})

test('known limit: a POSIX changer target cannot be re-anchored onto win32 paths', () => {
  // On Windows a `/tmp` changer target normalizes as a posix path, and a posix
  // base cannot be compared against the win32 plugin root, so the traversal
  // below is not caught. Asserted rather than hidden: the pre-change code could
  // not judge it either (it resolved the relative name against the win32
  // workspace, which is a different wrong answer), and Git Bash's translation
  // of /tmp is not something the analyzer can read. Documented, not fixed here.
  const command = String.raw`cd /tmp && printf x > ../Administrator/.dsh/plugins/dsh-auto-approval-llm/package.json`
  assert.equal(deny(command), undefined)
})

test('boundary: a changer placed after the write does not re-anchor it', () => {
  // The write runs before the changer, so it really does hit the workspace
  // file. Order is part of the semantics.
  const command = String.raw`printf x > package.json && cd /tmp`
  const reason = deny(command)
  assert.ok(reason !== undefined && reason.includes(CONTRACT_FILE_REASON), `got: ${reason}`)
})

test('boundary: an absolute target is judged by itself under a changer', () => {
  // Re-anchoring is only about resolving relative names; an absolute target
  // means the same thing wherever the line is standing.
  const command = String.raw`cd /tmp && printf x > C:/Users/Administrator/.dsh/plugins/dsh-auto-approval-llm/package.json`
  const reason = deny(command)
  assert.ok(reason !== undefined && reason.includes(CONTRACT_FILE_REASON), `got: ${reason}`)
})

test('the unconditional fuses are untouched by re-anchoring', () => {
  // Privilege, OS-policy and exfiltration fuses are whole-line and must not
  // become order- or directory-sensitive.
  assert.ok(deny('cd /tmp && sudo ls') !== undefined)
  assert.ok(deny('cd /tmp && bcdedit /set x y') !== undefined)
})

test('chained changers compose the way a shell would', () => {
  // `cd a && cd b` resolves b against a. The second changer must therefore be
  // resolved against the first, not against the workspace — a build that
  // re-anchored only the first would leave `deeper` pointing into the plugin
  // tree and deny this line.
  assert.equal(deny(`cd C:/Users/Administrator/AppData/Local/Temp/probe-bs && cd deeper && printf x > package.json`), undefined)
  assert.equal(deny(String.raw`cd /tmp && cd deeper && printf x > package.json`), undefined)
})
