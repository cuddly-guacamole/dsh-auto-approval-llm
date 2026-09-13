/**
 * Win32 long-path (`\\?\`) targets and the glob-root reduction.
 *
 * `globRootOf` split the target on separators and looked for the first segment
 * containing `*`/`?`. A supported namespace alias (`\\?\C:\…`, `\\?\UNC\…`,
 * and their `//?/` spellings) puts a literal `?` segment in front of the real
 * path, so every long-path target reduced to a lone backslash — the
 * destructive fuse then reported it as `filesystem root \` and hard-denied
 * ordinary workspace paths written the way Windows asks for paths beyond
 * MAX_PATH.
 *
 * The reduction now runs on the canonical spelling of a supported alias, while
 * an alias the namespace guard rejects keeps its own spelling so that guard
 * still owns the verdict and its reason.
 *
 * Backslashes are built from char codes: shell/heredoc layers fold literal
 * backslashes, and a folded probe would test a different string than claimed.
 *
 * Run: node --test tests/audit-r4-longpath-glob-root.test.mjs (tsc first)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'
import { assessShell } from '../lib/auto/shell.js'
import { globRootOf, hardDestructiveTargetReason, resolveRoots } from '../lib/auto/paths.js'

const B = String.fromCharCode(92)
const q = (value) => value.replaceAll('/', B)

const LONG_FILE = q('//?/C:/ws/src/a.ts')
const LONG_GLOB = q('//?/C:/ws/src/*.ts')
const LONG_UNC = q('//?/UNC/server/share/sub/x.ts')
const LONG_UNC_GLOB = q('//?/UNC/server/share/*.ts')
const PLAIN_UNC_GLOB = q('//server/share/*.ts')
const ALT_ALIAS = q('//??/C:/ws/src/*.ts')
const VOLUME = q('//?/Volume{11111111-2222-3333-4444-555555555555}/x.ts')
const PLAIN_GLOB = q('C:/ws/src/*.ts')

const WORKSPACE = 'C:/ws'
const roots = resolveRoots(WORKSPACE, {})
roots.allowedDshSubpaths = []
roots.maintenanceDshPaths = []
roots.mode = 'aggressive'
roots.trustedDirs = []
const registry = new ArtifactRegistry()
const owner = { id: 'session-a' }

test('a supported alias reduces to the real glob root', () => {
  assert.equal(globRootOf(LONG_GLOB), q('C:/ws/src'))
  assert.equal(globRootOf(ALT_ALIAS), q('C:/ws/src'))
  assert.equal(globRootOf(LONG_UNC_GLOB), q('//server/share'))
  assert.equal(globRootOf(LONG_FILE), q('C:/ws/src/a.ts'))
})

test('the destructive fuse no longer reads a long path as the filesystem root', () => {
  for (const target of [LONG_FILE, LONG_GLOB, LONG_UNC, ALT_ALIAS]) {
    assert.equal(
      hardDestructiveTargetReason(target, roots),
      undefined,
      `${JSON.stringify(target)} names an ordinary path`,
    )
  }
})

test('the alias prefix never launders or invents a root', () => {
  // A share root is a root in both spellings: the alias must not change that.
  assert.equal(
    hardDestructiveTargetReason(LONG_UNC_GLOB, roots),
    hardDestructiveTargetReason(PLAIN_UNC_GLOB, roots),
  )
  assert.match(String(hardDestructiveTargetReason(q('//?/C:/'), roots)), /filesystem root/)
  assert.match(String(hardDestructiveTargetReason(q('//?/C:/*'), roots)), /drive-relative|filesystem root/)
})

test('a namespace the guard rejects keeps its own reason', () => {
  assert.match(String(hardDestructiveTargetReason(VOLUME, roots)), /extended device namespace/)
})

test('shell: a quoted long-path delete keeps the ordinary delete verdict', () => {
  // Quoting is how a shell actually carries the prefix; an unquoted backslash
  // run is folded by the lexer before the plugin ever sees it.
  const inside = assessShell(`rm -rf '${LONG_FILE}'`, 'bash', roots, registry, owner)
  assert.notEqual(inside.decision, 'deny', `a workspace long path must not be a filesystem-root deny: ${inside.reason}`)
  assert.doesNotMatch(String(inside.reason ?? ''), /filesystem root/)
  // Negative control: the alias prefix must not launder a real drive-root sweep.
  const rootSweep = assessShell(`rm -rf '${q('//?/C:/*')}'`, 'bash', roots, registry, owner)
  assert.equal(rootSweep.decision, 'deny')
})

test('plain spellings are untouched', () => {
  assert.equal(globRootOf(PLAIN_GLOB), q('C:/ws/src'))
  assert.equal(hardDestructiveTargetReason(PLAIN_GLOB, roots), undefined)
})
