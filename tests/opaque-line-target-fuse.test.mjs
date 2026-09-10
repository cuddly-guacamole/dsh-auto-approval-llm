/**
 * Opaque command lines must not lose the per-target hard-deny fuses.
 *
 * `hardDenyShellReason` runs four whole-line fuses and then decomposes the
 * line. When decomposition reports `opaque` (grouping / brace expansion /
 * command substitution / here-document / unbalanced quote) the function used
 * to return `undefined` immediately, which put EVERY per-target fuse out of
 * reach for the entire line:
 *
 *   printf x > package.json; (:)
 *
 * is a write to the plugin's own contract file, denied when written plainly.
 * Appending an opaque tail made the same write a classifier-eligible MEDIUM
 * ask — and under `timeoutAction=allow`, or an unattended review mode, that ask
 * is settled by the countdown, so the plugin's strongest verdict silently
 * became its weakest.
 *
 * The fix scans an opaque line for redirect targets (a best-effort recovery,
 * not a second lexer) and applies the same three fuse predicates the
 * decomposed path uses. Two properties are pinned here:
 *
 *   - a fuse target on an opaque line hard-denies, classifier-ineligible;
 *   - an opaque line whose redirects are ordinary paths keeps abstaining, so
 *     the semantic classifier still gets it.
 *
 * The second property is the one that keeps the first from degenerating into
 * "deny every opaque line", so both directions are asserted, including the
 * here-document split (body is data, the command line is not).
 *
 * Run: node --test tests/opaque-line-target-fuse.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assessShell, hardDenyShellReason } from '../lib/auto/shell.js'
import { normalizePath, resolveRoots } from '../lib/auto/paths.js'

// Derived from THIS file's location, never hardcoded: the plugin-zone fuse keys
// off the compiled module's own zone root (lib/auto/paths.js), so a constant
// naming one absolute checkout makes the `FUSED` vectors point at a tree that
// is not the one under test. `../` from this file is the plugin root. The
// forward-slash spelling is deliberate — normalizePath keeps the separator
// style of its input, and a workspace whose separators disagree with the
// command's makes the target unreadable to the fuse.
const toSlash = (path) => path.replaceAll('\\', '/')
const PLUGIN_REPO = toSlash(fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, ''))

function makeRoots(workspace = PLUGIN_REPO) {
  const roots = resolveRoots(workspace, {})
  roots.allowedDshSubpaths = [normalizePath(PLUGIN_REPO, roots.workspace, roots.home)]
  roots.maintenanceDshPaths = []
  roots.mode = 'aggressive'
  roots.trustedDirs = []
  return roots
}

const roots = makeRoots()
// A workspace outside DSH_HOME, so "ordinary target" really means ordinary: in
// the plugin-repo workspace above, even a plain `printf x > out.txt` is fused by
// the DSH_HOME rule (the workspace itself sits inside DSH_HOME).
const plainRoots = makeRoots('C:/ws')
const artifacts = { has: () => false }
const CONTRACT_FILE_REASON = "the plugin's own contract/build file"

/** Opaque lines that write to a target another vector already hard-denies. */
const FUSED = [
  // The motivating shape: an opaque tail after a plain contract-file write.
  String.raw`printf x > package.json; (:)`,
  String.raw`printf x > package.json; { :; }`,
  String.raw`printf x > package.json; (cd /tmp)`,
  // Command substitution makes the line opaque; the redirect is still real.
  String.raw`printf x > package.json; $(echo)`,
  // A grouped write, no tail needed.
  String.raw`(printf x > package.json)`,
  // `>` hides inside the group only because the group is unreadable.
  String.raw`{ printf x > tsconfig.json; }`,
  // The redirect sits on the here-document's own command line.
  String.raw`cat <<'EOF' > package.json`,
  // DSH_HOME and credential targets are fused the same way.
  String.raw`printf x > ~/.dsh/plugins/other-probe/lib/index.js; (:)`,
  String.raw`printf x > ~/.ssh/authorized_keys; (:)`,
]

/** Opaque lines with no fused target at all: they must keep abstaining. */
const ABSTAINING = [
  String.raw`(cd sub && ls)`,
  String.raw`echo "$(date)"`,
  String.raw`for f in *; do printf '%s\n' "$f"; done`,
  String.raw`cat > /tmp/opaque-out.txt <<'EOF'`,
  String.raw`printf x > out.txt; (:)`,
  String.raw`printf x > report.md; (cd /tmp)`,
  String.raw`(printf x > notes.txt)`,
]

test('opaque fuse: a redirect to a hard-deny target denies and never reaches the classifier', () => {
  const failures = []
  for (const command of FUSED) {
    const reason = hardDenyShellReason(command, 'bash', roots)
    if (reason === undefined) {
      failures.push(`${command}: no hard-deny reason`)
      continue
    }
    const assessment = assessShell(command, 'bash', roots, artifacts, undefined)
    if (assessment.decision !== 'deny') {
      failures.push(`${command}: decision=${assessment.decision}`)
    }
    if (assessment.classifierEligible !== false) {
      failures.push(`${command}: classifierEligible=${assessment.classifierEligible}`)
    }
  }
  assert.deepEqual(failures, [], `opaque lines that lost their fuse:\n${failures.join('\n')}`)
})

test('opaque fuse: the motivating shape is the contract-file write, not a generic refusal', () => {
  // Anchoring the reason (not just "denied") keeps the fix honest: a blanket
  // opaque deny would satisfy the decide-only assertions above.
  const reason = hardDenyShellReason(String.raw`printf x > package.json; (:)`, 'bash', roots)
  assert.ok(reason !== undefined, 'the line must be denied')
  assert.ok(reason.includes(CONTRACT_FILE_REASON), `expected the contract-file reason, got: ${reason}`)
  assert.ok(reason.startsWith('redirection overwrites '), `expected a redirect fuse, got: ${reason}`)
})

test('opaque fuse: a control line without the opaque tail was already denied', () => {
  // The control for the whole file: if the plain spelling stopped denying, the
  // change below would look like a fix for a gap that never existed.
  const plain = hardDenyShellReason(String.raw`printf x > package.json`, 'bash', roots)
  assert.ok(plain !== undefined && plain.includes(CONTRACT_FILE_REASON), `got: ${plain}`)
})

test('opaque fuse: ordinary targets still abstain so the classifier sees the line', () => {
  // "The criterion should NOT hold here" half. An opaque line whose redirects
  // are routine workspace/temp paths must not be swept into the hard deny: the
  // semantic review it reaches is the intended handling.
  const failures = []
  for (const command of ABSTAINING) {
    const reason = hardDenyShellReason(command, 'bash', plainRoots)
    if (reason !== undefined) failures.push(`${command}: unexpectedly denied with "${reason}"`)
    const assessment = assessShell(command, 'bash', plainRoots, artifacts, undefined)
    if (assessment.decision === 'deny') failures.push(`${command}: assessment denied`)
  }
  assert.deepEqual(failures, [], `opaque lines that lost their classifier path:\n${failures.join('\n')}`)
})

test('opaque fuse: an opaque line matches the plain spelling on the same target', () => {
  // Consistency with the decomposed path is the whole contract of the recovery,
  // so assert the pair rather than the opaque line alone. `out.txt` inside the
  // plugin-repo workspace is a DSH_HOME write, which the plain spelling already
  // fuses; the opaque spelling must not read differently.
  const plain = hardDenyShellReason(String.raw`printf x > out.txt`, 'bash', roots)
  const opaque = hardDenyShellReason(String.raw`printf x > out.txt; (:)`, 'bash', roots)
  assert.ok(plain !== undefined, 'the plain spelling is fused in this workspace')
  assert.equal(opaque, plain, 'the opaque spelling must reach the same verdict as the plain one')
})

test('opaque fuse: a here-document body is data, but its command line is judged', () => {
  // The split that makes the heredoc exemption precise. A `>` inside the body
  // is literal text handed to the command's stdin; a `>` on the command line
  // is a real redirect. Scanning only the first line gives both answers.
  const bodyOnly = "cat <<'EOF'\nsee > package.json for the config\nEOF"
  assert.equal(
    hardDenyShellReason(bodyOnly, 'bash', roots),
    undefined,
    'a redirect spelled inside a here-document body must not be judged as one',
  )
  const commandLine = String.raw`cat > package.json <<'EOF'` + '\nbody\nEOF'
  assert.ok(
    hardDenyShellReason(commandLine, 'bash', roots) !== undefined,
    'the here-document command line still carries a real redirect',
  )
})

test('opaque fuse: a quoted target spelling is judged like a bare one', () => {
  // `> "package.json"` and `> package.json` denote the same file; the scan must
  // not treat the quotes as part of the name.
  const quoted = hardDenyShellReason(String.raw`printf x > "package.json"; (:)`, 'bash', roots)
  assert.ok(quoted !== undefined && quoted.includes(CONTRACT_FILE_REASON), `got: ${quoted}`)
})

test('opaque fuse: a null sink on an opaque line is not a write', () => {
  const reason = hardDenyShellReason(String.raw`printf x > /dev/null; (:)`, 'bash', roots)
  assert.equal(reason, undefined, 'discarding output to /dev/null is not a fused write')
})

test('opaque fuse: the recovery runs before the opaque early return', () => {
  // Structural anchor for the call order. The behaviour tests above would still
  // pass if a future edit re-introduced a second copy of the fuse elsewhere, so
  // pin that the one implementation is reached on the opaque branch itself.
  const source = readFileSync(fileURLToPath(new URL('../lib/auto/shell.js', import.meta.url)), 'utf8')
  const opaqueBranch = source.indexOf("if (decomposition.kind === 'opaque')")
  assert.notEqual(opaqueBranch, -1, 'the opaque branch is present in the compiled module')
  const call = source.indexOf('opaqueHardDenyReason(compact, shell, roots)')
  assert.notEqual(call, -1, 'the opaque branch calls the recovery helper')
  assert.ok(call > opaqueBranch, 'the recovery is inside the opaque branch')
  assert.ok(
    source.indexOf('if (decomposition.kind === \'opaque\') return undefined') === -1,
    'the bare early return that dropped every per-target fuse must be gone',
  )
})

test('opaque fuse: a redirect attached to the preceding word is judged too', () => {
  // Shell allows `printf x>file` with no space, which is the idiomatic spelling.
  // An earlier version of the recovery required a separator before `>`, so the
  // whole fix was bypassable by deleting one space.
  const failures = []
  for (const command of [
    String.raw`printf x>package.json; (:)`,
    String.raw`printf x>>package.json; (:)`,
    String.raw`printf x2>package.json; (:)`,
    String.raw`printf x "a">package.json; (:)`,
  ]) {
    const reason = hardDenyShellReason(command, 'bash', roots)
    if (reason === undefined || !reason.includes(CONTRACT_FILE_REASON)) failures.push(`${command}: ${reason}`)
  }
  assert.deepEqual(failures, [], `attached-redirect spellings that escaped:\n${failures.join('\n')}`)
})

test('opaque fuse: the deletion and write-operand fuses are reachable too', () => {
  // The redirect scan alone covers only `>` targets. Deleting a critical tree or
  // truncating a runtime-state file is hard-denied when written plainly, so the
  // opaque spelling must not lose those verdicts.
  const failures = []
  for (const command of [
    String.raw`rm -rf /etc; (:)`,
    String.raw`tee history.jsonl < /dev/null; (:)`,
    String.raw`truncate -s 0 audit.jsonl; (:)`,
  ]) {
    const plain = command.replace('; (:)', '')
    assert.notEqual(hardDenyShellReason(plain, 'bash', roots), undefined, `control: ${plain} is fused when written plainly`)
    const reason = hardDenyShellReason(command, 'bash', roots)
    if (reason === undefined) failures.push(`${command}: no hard-deny reason (plain spelling is denied)`)
  }
  assert.deepEqual(failures, [], `opaque spellings that lost a non-redirect fuse:\n${failures.join('\n')}`)
})

test('opaque fuse: a here-document body is exempt even when the lexer blames another cause', () => {
  // The exemption used to be keyed to the lexer's message string, so a command
  // that is opaque for a different reason (a command substitution wrapping a
  // heredoc) kept its BODY in the scan. Commit messages in this repo name fuse
  // targets, so that showed up as a false refusal on ordinary `git commit`.
  const commit = `git commit -m "$(cat <<'EOF'\nfix: mention > package.json in the body\nEOF\n)"`
  assert.equal(
    hardDenyShellReason(commit, 'bash', roots),
    undefined,
    'a redirect spelled inside a here-document body must not be judged',
  )
  // The same line with a real redirect after the body must still be caught: the
  // old first-line-only truncation made anything after a heredoc invisible.
  const afterBody = `cat <<'EOF'\nx\nEOF\nprintf x > package.json`
  assert.ok(
    hardDenyShellReason(afterBody, 'bash', roots) !== undefined,
    'a fused redirect after a here-document must still be judged',
  )
})

test('opaque fuse: the recovery reuses the shared fuse owners, not a private copy', () => {
  // A second, parallel re-derivation of DSH_HOME / credential targets would
  // drift from the `allowedDshSubpaths` openings the shared predicates honour.
  const source = readFileSync(fileURLToPath(new URL('../lib/auto/shell.js', import.meta.url)), 'utf8')
  const body = source.slice(
    source.indexOf('function stripHeredocBodies'),
    source.indexOf('export function hardDenyShellReason'),
  )
  assert.ok(body.length > 0, 'the recovery helpers are present')
  // The redirect half applies the three shared predicates; the non-redirect
  // half delegates to the decomposed path's own per-segment fuse rather than
  // restating deletion/write-operand rules.
  for (const shared of ['hardDestructiveTargetReason(', 'runtimeStateWriteReason(', 'shellWriteToDshHomeDenied(', 'segmentHardDenyReason(']) {
    assert.ok(body.includes(shared), `${shared} is reused instead of re-implemented`)
  }
})
