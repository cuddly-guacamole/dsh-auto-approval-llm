// The package must state the Node range it actually needs: a host that installs
// on an older runtime fails at load time, and npm cannot warn without this field.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const DECLARED_RANGE = '^22.19.0 || >=24.0.0'

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim())
  assert.ok(match, `not a plain version: ${text}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compare(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return 0
}

// Minimal matcher for the two shapes this project uses: caret and lower bound,
// joined by `||`. Kept dependency free so the test states the semantics itself.
function satisfies(version, range) {
  const target = parseVersion(version)
  return range.split('||').map(part => part.trim()).some(part => {
    if (part.startsWith('^')) {
      const lower = parseVersion(part.slice(1))
      if (lower[0] === 0) {
        const upper = lower[1] === 0 ? [0, 0, lower[2] + 1] : [0, lower[1] + 1, 0]
        return compare(target, lower) >= 0 && compare(target, upper) < 0
      }
      return compare(target, lower) >= 0 && target[0] === lower[0]
    }
    if (part.startsWith('>=')) return compare(target, parseVersion(part.slice(2))) >= 0
    throw new Error(`unsupported range clause: ${part}`)
  })
}

test('package.json declares the supported Node range', () => {
  assert.equal(packageJson.engines?.node, DECLARED_RANGE)
})

test('the declared range admits the runtime this project is built and tested on', () => {
  assert.equal(satisfies(process.versions.node, DECLARED_RANGE), true, `node ${process.versions.node} must satisfy the range`)
})

test('the declared range rejects runtimes below the floor', () => {
  // Reverse direction: if the range were loosened, these become true and the
  // test fails — the range is not a tautology.
  assert.equal(satisfies('20.19.0', DECLARED_RANGE), false, 'Node 20 lacks the required host APIs')
  assert.equal(satisfies('22.18.0', DECLARED_RANGE), false, 'one patch below the floor must not satisfy')
  assert.equal(satisfies('23.11.0', DECLARED_RANGE), false, 'the odd major is not claimed')
})

test('the declared range admits the floor and the next even major', () => {
  assert.equal(satisfies('22.19.0', DECLARED_RANGE), true)
  assert.equal(satisfies('24.0.0', DECLARED_RANGE), true)
})
