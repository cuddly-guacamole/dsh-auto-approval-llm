/**
 * dsh-auto-approval-llm · POSIX platform contract tests.
 *
 * The plugin ships cross-platform; Windows paths dominate the existing
 * fixtures, so these tests pin the POSIX-side verdicts (Linux/macOS plus the
 * macOS /tmp→/private/tmp alias) that previously had zero coverage:
 * isCriticalPath on system paths, isFilesystemRoot, canonicalizePosixSystemAlias,
 * normalizePath/isWithin, the hard-deny strings, POSIX command classification,
 * and the fail-closed ask fallback for unrecognized POSIX commands.
 *
 * Expectations mirror real verdicts probed against the compiled lib
 * (2026-09-03, node posix-probe.mjs).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalizePosixSystemAlias, hardDestructiveTargetReason, isCriticalPath,
  isFilesystemRoot, isWithin, normalizePath, resolveRoots,
} from '../lib/auto/paths.js'
import { assessShell, hardDenyShellReason } from '../lib/auto/shell.js'
import { categorizeCommand } from '../lib/auto/category.js'

const roots = { workspace: '/home/u/ws', home: '/home/u', dshHome: '/home/u/.dsh', tempRoots: ['/tmp'] }
const stdCfg = { categoryPolicy: {}, categoryMode: 'standard' }
const cat = (src) => categorizeCommand(src, 'bash', roots, stdCfg).category
const shell = (src) => assessShell(src, 'bash', roots, { has: () => false }, undefined)

// ── path predicates on POSIX inputs ─────────────────────────────────────

test('isCriticalPath: POSIX system directories are critical, user trees are not', () => {
  assert.equal(isCriticalPath('/etc', roots), true)
  assert.equal(isCriticalPath('/usr/bin', roots), true)
  assert.equal(isCriticalPath('/home/u/x', roots), false)
  assert.equal(isCriticalPath('/tmp/x', roots), false)
})

test('canonicalizePosixSystemAlias: macOS /tmp /var /etc → /private/*', () => {
  assert.equal(canonicalizePosixSystemAlias('/tmp/x', 'darwin'), '/private/tmp/x')
  assert.equal(canonicalizePosixSystemAlias('/var/log', 'darwin'), '/private/var/log')
  assert.equal(canonicalizePosixSystemAlias('/etc', 'darwin'), '/private/etc')
  assert.equal(canonicalizePosixSystemAlias('/etc', 'linux'), '/etc', 'non-darwin platforms leave the path alone')
  assert.equal(canonicalizePosixSystemAlias('/usr/bin/env', 'darwin'), '/usr/bin/env')
})

test('isFilesystemRoot: / is a root, /home is not', () => {
  assert.equal(isFilesystemRoot('/'), true)
  assert.equal(isFilesystemRoot('/home'), false)
})

test('normalizePath: POSIX inputs pass through unchanged', () => {
  assert.equal(normalizePath('/etc/passwd', roots.dshHome, roots.home), '/etc/passwd')
  assert.equal(normalizePath('/home/u/.ssh/id_rsa', roots.dshHome, roots.home), '/home/u/.ssh/id_rsa')
})

test('isWithin: workspace containment works on POSIX roots and rejects traversal/mixed styles', () => {
  assert.equal(isWithin('/home/u/ws', '/home/u/ws/a'), true)
  assert.equal(isWithin('/home/u/ws', '/etc'), false)
  assert.equal(isWithin('/home/u/ws', '/home/u/ws/../etc'), false, 'traversal escapes are not contained')
  assert.equal(isWithin('/home/u/ws', 'C:/ws/x'), false, 'a Windows-style path is not inside a POSIX root')
})

test('resolveRoots: explicit POSIX roots are preserved through normalization', () => {
  const r = resolveRoots('/home/u/ws', { home: '/home/u', dshHome: '/home/u/.dsh', tempRoots: ['/tmp'] })
  assert.deepEqual(r, { workspace: '/home/u/ws', home: '/home/u', dshHome: '/home/u/.dsh', tempRoots: ['/tmp'], allowedDshSubpaths: [] })
})

// ── hard-deny gates on POSIX targets ────────────────────────────────────

test('hardDestructiveTargetReason: POSIX system paths and the root are hard-denied', () => {
  assert.match(hardDestructiveTargetReason('/etc/fstab', roots), /critical/, '/etc/fstab is critical')
  assert.match(hardDestructiveTargetReason('/', roots), /root/, 'filesystem root is refused')
  assert.equal(hardDestructiveTargetReason('/home/u/ws/a', roots), undefined, 'workspace files are not hard-denied')
})

test('hardDenyShellReason: POSIX redirection/write targets are gated', () => {
  assert.match(hardDenyShellReason('echo x > /etc/passwd', 'bash', roots), /critical/)
  assert.equal(hardDenyShellReason('echo x > /dev/null', 'bash', roots), undefined, 'discard sink stays allowed')
  assert.match(hardDenyShellReason('find / -name x -exec rm {} \\;', 'bash', roots), /root/)
  assert.equal(hardDenyShellReason('chmod +x /tmp/a', 'bash', roots), undefined, 'a routine chmod on a temp file is not a hard deny (it still asks)')
})

// ── POSIX command classification ─────────────────────────────────────────

test('categorizeCommand: service/package commands map to expected categories', () => {
  assert.equal(cat('systemctl restart nginx'), 'privilege')
  assert.equal(cat('curl -o /tmp/x http://example.com/a'), 'networkExec')
})

test('categorizeCommand: POSIX package/permission commands stay unknown (anchored current behavior)', () => {
  // apt/brew/apk/chmod/chown have no category mapping yet; the anchor locks
  // the CURRENT verdict so a future mapping change is a deliberate edit.
  assert.equal(cat('apt install jq'), 'unknown')
  assert.equal(cat('brew install jq'), 'unknown')
  assert.equal(cat('apk add vim'), 'unknown')
  assert.equal(cat('chmod 777 /tmp/a'), 'unknown')
  assert.equal(cat('chown root /opt/x'), 'unknown')
})

// ── fail-closed fallback for unrecognized POSIX commands ─────────────────

test('assessShell: unrecognized POSIX commands still ask (fail closed), never auto-allow', () => {
  assert.equal(shell('apt install jq').decision, 'ask', 'package install requires a decision')
  assert.equal(shell('brew install jq').decision, 'ask')
  assert.equal(shell('chmod 777 /tmp/a').decision, 'ask')
  assert.equal(shell('chown root /opt/x').decision, 'ask')
  assert.equal(shell('dd if=/dev/zero of=/opt/x').decision, 'ask', 'external write target asks')
  assert.equal(shell('systemctl restart nginx').decision, 'ask')
  assert.equal(shell('ls /').decision, 'ask', 'a read reference outside the workspace asks')
})

test('assessShell: static read-only POSIX commands keep the fast path', () => {
  assert.equal(shell('uname -a').decision, 'allow')
})