/**
 * dsh-auto-approval-llm · apply() inline-declaration guard.
 *
 * apply() is the host wiring surface: it registers the guard/pre-execute hooks,
 * the approval/request answerer, the routes and the slash commands. The
 * structural rule for helpers that live inside it is `const` arrow or a
 * function moved out to src/auto/; a `function` declaration at the body's top
 * level is the shape this guard refuses.
 *
 * Both ends of the window are asserted (the signature must match, the column-0
 * closing brace must be found, and the slice must reach the body's last
 * statement), so a moved or renamed apply() fails here instead of producing an
 * empty window that matches nothing.
 * Run: node --test tests/apply-inline-guard.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

// The declarations already inside apply() when this guard landed. The guard
// forbids additions, so a later migration that moves one of these out is fine.
const PRE_EXISTING = ['installStatsRoute']

const APPLY_OPEN = /^export function apply\(ctx: Context, rawConfig: Config\): void \{/m

const declarationPattern = () => /^ {2}(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*\(/gm

function applyBody(source) {
  const open = APPLY_OPEN.exec(source)
  assert.notEqual(open, null, 'the apply() signature must be present in src/index.ts')
  const bodyStart = open.index + open[0].length
  const closeAt = source.indexOf('\n}', bodyStart)
  assert.notEqual(closeAt, -1, 'apply() must end with a column-0 closing brace')
  assert.ok(closeAt > bodyStart, 'the closing brace must follow the signature')
  const body = source.slice(bodyStart, closeAt)
  assert.ok(body.includes('const anyCtx = ctx as any'), 'the window must open at the first statement of apply()')
  assert.ok(body.includes('commands service unavailable'), 'the window must reach the last statement of apply()')
  return body
}

function inlineDeclarations(body) {
  return [...body.matchAll(declarationPattern())].map(match => match[1])
}

test('apply() grows no new top-level function declaration', () => {
  const added = inlineDeclarations(applyBody(SOURCE)).filter(name => !PRE_EXISTING.includes(name))
  assert.deepEqual(added, [], 'declare the helper as a const arrow or move it to src/auto/')
})

test('the detector reads a planted declaration and ignores a const arrow', () => {
  const body = applyBody(SOURCE)
  const baseline = inlineDeclarations(body)
  assert.deepEqual(inlineDeclarations(`${body}\n  const probeGuard = () => {}\n`), baseline)
  assert.deepEqual(inlineDeclarations(`${body}\n  function probeGuard() {}\n`), [...baseline, 'probeGuard'])
})
