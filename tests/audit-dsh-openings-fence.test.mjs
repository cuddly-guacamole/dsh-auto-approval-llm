/**
 * The DSH_HOME openings fence must name the trees the DSH tree actually uses.
 * It listed `credentials/` and `credentials.json`, neither of which exists —
 * the credential store is the dotted file, and the operator configuration is
 * `settings.yaml` — so a `trustedDshSubpaths` entry naming either of those
 * re-opened it and the structured tools got a static `allow` on the file that
 * holds this plugin's own reviewer credential and security switches.
 * Run: node --test tests/audit-dsh-openings-fence.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../lib/index.js'

// resolveConfig derives the effective DSH_HOME the same way the host does, so
// the subpaths have to be expressed under the machine's own tree.
const DSH_HOME = (process.env.DSH_HOME ?? join(homedir(), '.dsh')).replace(/\\/g, '/')
const openings = (subpath) => resolveConfig({ timeoutAction: 'reject', trustedDshSubpaths: [`${DSH_HOME}/${subpath}`] }).trustedDshSubpaths

test('the real credential and settings files are inside the fence', () => {
  for (const name of ['.credentials.yaml', 'settings.yaml']) {
    assert.deepEqual(openings(name), [], `${name} must not become an opening`)
  }
})

test('the credential tree and transcript tree stay fenced', () => {
  for (const name of ['credentials', 'credentials.json', 'sessions', 'plugins']) {
    assert.deepEqual(openings(name), [], `${name} must stay fenced`)
  }
})

test('an ordinary subtree stays openable (no fence over-reach)', () => {
  for (const name of ['skills', 'profiles', 'llm-catalog']) {
    assert.equal(openings(name).length, 1, `${name} must remain openable`)
  }
})

test('DSH_HOME itself and outside paths stay refused', () => {
  assert.deepEqual(openings('.'), [], 'DSH_HOME itself is never an opening')
  const outside = resolveConfig({ timeoutAction: 'reject', trustedDshSubpaths: ['C:/definitely/outside/tree'] }).trustedDshSubpaths
  assert.deepEqual(outside, [], 'a path outside DSH_HOME is never an opening')
})
