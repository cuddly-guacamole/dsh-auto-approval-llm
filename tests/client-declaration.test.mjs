// dsh.client.inject is an informational declaration, not Cordis service
// injection: names that miss the boot graph are skipped in silence. That makes
// it easy for the declaration to drift away from what the bundle actually
// requires without any symptom. This contract states both sides and pins them
// to each other, so the declaration stays a claim about the real module set.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const clientJs = readFileSync(join(root, 'lib/client.js'), 'utf8')
const tsdownSource = readFileSync(join(root, 'tsdown.config.ts'), 'utf8')

/** The declared intent set: the packages whose slot/service surface we build against. */
const DECLARED_INTENT = [
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/**
 * Bare specifiers the web boot facade supplies to every client bundle. Read from
 * the platform's own seed table, not inferred from our bundler configuration:
 * `<dsh>/@deepseek-ai/dsh-web-frontend/dist/assets/index-BKQ_L1z6.js` defines
 * `function by(){ return { react: …, "react/jsx-runtime": …, … } }` and hands it
 * to `__ModuleLoader__.create({ staticModules: by() })`. A specifier that is
 * neither here nor in the declaration is one the browser cannot resolve.
 */
const PLATFORM_SEED_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

function literalArray(source, name) {
  const match = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(source)
  assert.ok(match, `${name} not found`)
  return [...match[1].matchAll(/'([^']+)'/g)].map(entry => entry[1])
}

function requiredSpecifiers(bundle) {
  return [...new Set([...bundle.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]))]
}

/** Specifiers the platform must supply but that the plugin does not declare. */
function unresolvableRequests(specifiers, declared, seedModules) {
  return specifiers.filter(spec => !spec.startsWith('.') && !declared.includes(spec) && !seedModules.includes(spec))
}

const declared = packageJson.dsh?.client?.inject ?? []
const externals = literalArray(tsdownSource, 'CLIENT_EXTERNALS')
const specifiers = requiredSpecifiers(clientJs)

test('the client entry declares itself as a web bundle with a bundle export', () => {
  assert.equal(packageJson.dsh?.client?.platform, 'web')
  assert.equal(packageJson.exports?.['./client']?.default, './lib/client.js')
  assert.equal(packageJson.exports?.['./client']?.types, './lib/types/client/index.d.ts')
})

test('the declared inject set is the documented intent set', () => {
  // A change here is deliberate: the list states which official slot surfaces
  // this client is written against, so it moves only with the client itself.
  assert.deepEqual([...declared].sort(), [...DECLARED_INTENT].sort())
  assert.equal(new Set(declared).size, declared.length, 'no duplicate declarations')
})

test('the bundle never reaches for a relative module', () => {
  const relative = specifiers.filter(spec => spec.startsWith('.'))
  assert.deepEqual(relative, [], 'the tsdown bundle must be self-contained')
})

test('every absolute request is either supplied by the boot facade or declared', () => {
  const unresolvable = unresolvableRequests(specifiers, declared, PLATFORM_SEED_MODULES)
  assert.deepEqual(unresolvable, [], 'a required module that is neither seeded by the platform nor declared')
})

test('every externalised module the bundle actually requests is resolvable', () => {
  // Internals of the bundler and of the platform can disagree without any
  // symptom: a module the bundle inlines still works, but one it externalises
  // without the platform supplying it breaks at load time. Only requested
  // specifiers matter — externalising a module the bundle never imports is inert.
  const requestedExternals = externals.filter(spec => specifiers.includes(spec))
  assert.ok(requestedExternals.length > 0, 'the bundle is expected to request at least one externalised module')
  for (const spec of requestedExternals) {
    assert.ok(
      PLATFORM_SEED_MODULES.includes(spec) || declared.includes(spec),
      `${spec} is requested and externalised but neither seeded by the platform nor declared`,
    )
  }
})

test('a request the plugin actually makes is declared, not merely assumed', () => {
  const official = specifiers.filter(spec => spec.startsWith('@deepseek-ai/'))
  assert.ok(official.length > 0, 'the bundle is expected to use at least one official client package')
  for (const spec of official) {
    assert.ok(declared.includes(spec), `${spec} is required at runtime but absent from dsh.client.inject`)
  }
})

test('the check flags an undeclared official request', () => {
  // Reverse direction: without this the contract above could pass on a list
  // that simply happens to contain everything.
  const synthetic = ['react', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-unlisted']
  assert.deepEqual(unresolvableRequests(synthetic, declared, PLATFORM_SEED_MODULES), ['@deepseek-ai/dsh-client-ui-unlisted'])
})
