/**
 * An opaque / interpreter-hidden destructive program must take the locked ask.
 *
 * The category layer labels every line the lexer cannot read `unknown`, and
 * `categoryDirective` maps `unknown` to `inherit`. The shell plane's manual
 * review tier (`classifierEligible:false`) only skips the classifier fast path;
 * the online reviewer still settles the ask, which is how `bash <<EOF` with a
 * destructive body reached `llm-allow` while the plain spelling took the delete
 * hard lock. The fix carries a structured `opaqueLocked` flag from the shell
 * plane; the category directive and the answerer's locked predicate read it and
 * pin the call to the reject-only countdown.
 *
 * Run: node --test tests/opaque-hidden-program-lock.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assessShell } from '../lib/auto/shell.js'
import { categorizeCommand, categoryDirective } from '../lib/auto/category.js'
import { nameChannelLockRefusal } from '../lib/index.js'
import { resolveRoots } from '../lib/auto/paths.js'
import { ArtifactRegistry } from '../lib/auto/artifacts.js'

const roots = resolveRoots('C:/ws', {})
roots.allowedDshSubpaths = []
roots.maintenanceDshPaths = []
roots.mode = 'aggressive'
roots.trustedDirs = []
const artifacts = new ArtifactRegistry()
const owner = { id: 'session-a' }
const config = { categoryMode: 'aggressive', categoryPolicy: {} }

function verdict(command, shell = 'bash') {
  const assessment = assessShell(command, shell, roots, artifacts, owner)
  const { category } = categorizeCommand(command, shell, roots, config)
  return { assessment, category, directive: categoryDirective(config, category, assessment) }
}

test('a destructive here-document program takes the locked ask', () => {
  for (const command of [
    "bash <<'EOF'\nrm -rf C:/ws/scratch\nEOF",
    "sh <<'EOF'\nrm -rf C:/ws/scratch\nEOF",
    "$SHELL <<'EOF'\nrm -rf C:/ws/scratch\nEOF",
  ]) {
    const v = verdict(command)
    assert.equal(v.assessment.opaqueLocked, true, command)
    assert.equal(v.assessment.decision, 'ask')
    assert.equal(v.assessment.classifierEligible, false)
    assert.equal(v.directive, 'ask', `opaque program must be locked, got ${v.directive}`)
    assert.equal(v.category, 'unknown', 'the category stays honestly unknown')
  }
})

test('a destructive program inside a non-shell interpreter body is locked too', () => {
  const v = verdict("python3 <<'EOF'\nimport shutil\nshutil.rmtree('C:/ws/scratch')\nEOF")
  assert.equal(v.assessment.opaqueLocked, true)
  assert.equal(v.directive, 'ask')
})

test('a visible nested deletion no longer rides the online reviewer', () => {
  const v = verdict('bash -c "rm -rf C:/ws/scratch"')
  assert.equal(v.assessment.opaqueLocked, true)
  assert.equal(v.assessment.classifierEligible, false)
})

test('an opaque credential read carries the credential floor and the lock', () => {
  const v = verdict('cat .env; (:)')
  assert.equal(v.assessment.credentialRead, true)
  assert.equal(v.assessment.opaqueLocked, true)
  assert.equal(v.directive, 'ask')
})

test('name-based channels cannot pre-authorize a locked opaque program', () => {
  assert.notEqual(nameChannelLockRefusal({ opaqueLocked: true }), undefined)
  assert.notEqual(nameChannelLockRefusal({ category: 'delete' }), undefined)
})

test('benign opaque shapes keep their previous tier', () => {
  const echo = verdict('bash -c "echo hi"')
  assert.notEqual(echo.assessment.opaqueLocked, true)
  assert.equal(echo.assessment.classifierEligible, true)

  const data = verdict("cat <<'EOF'\nsee > package.json for the config\nEOF")
  assert.notEqual(data.assessment.opaqueLocked, true)
  assert.equal(data.directive, 'inherit')

  const commit = verdict(`git commit -m "$(cat <<'EOF'\nfix: mention rm -rf in the body\nEOF\n)"`)
  assert.notEqual(commit.assessment.opaqueLocked, true)
  assert.equal(commit.directive, 'inherit')
})

test('the plain deletion spelling is unchanged', () => {
  const v = verdict('rm -rf C:/ws/scratch')
  assert.notEqual(v.assessment.opaqueLocked, true)
  assert.equal(v.category, 'delete')
  assert.equal(v.directive, 'ask')
})

test('the answerer locked predicate reads the same structured flag', () => {
  const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const start = host.indexOf('const isLockedCategory = (')
  assert.notEqual(start, -1, 'the locked-category predicate is present')
  const end = host.indexOf('classifyStaticRisk', start)
  const body = host.slice(start, end === -1 ? start + 1200 : end)
  assert.ok(body.includes('opaqueLocked === true'), `the predicate must read the flag:\n${body.slice(0, 400)}`)
  assert.ok(
    host.includes('isLockedCategory(classified.category, classified.assessment?.sessionArtifactDeletion === true, classified.assessment?.credentialRead === true, classified.assessment?.opaqueLocked === true)'),
    'the flag must be passed at the locked-ask call site',
  )
})
