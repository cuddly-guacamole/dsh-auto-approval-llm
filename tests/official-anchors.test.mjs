// Contract for the read-only official-anchor check. The check reports four
// cross-artifact facts, so every case here builds a minimal stand-in for both
// sides (the repository sources and the official client artifacts) and then
// removes exactly one anchor to prove the check has teeth.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = join(repoRoot, 'scripts', 'check-official-anchors.mjs')
const gatePath = join(repoRoot, 'scripts', 'gate.mjs')

/** Minimal repository sources the check reads. */
const REPO_FILES = {
  'package.json': JSON.stringify({
    name: '@quill507/dsh-auto-approval-llm',
    dsh: {
      client: {
        inject: [
          '@deepseek-ai/dsh-client-ui-slots',
          '@deepseek-ai/dsh-client-ui-settings',
          '@deepseek-ai/dsh-client-ui-primitives',
        ],
      },
    },
  }, null, 2),
  'tsdown.config.ts': [
    'const CLIENT_EXTERNALS = [',
    "  'react',",
    "  'react/jsx-runtime',",
    "  '@deepseek-ai/dsh-client-ui-slots',",
    "  '@deepseek-ai/dsh-client-ui-primitives',",
    "  '@deepseek-ai/dsh-client-ui-unlisted',",
    ']',
    '',
    'const clientBundle = {',
    "  entry: { client: 'src/client/index.ts' },",
    "  outDir: 'lib',",
    '}',
    '',
    'export default [clientBundle]',
    '',
  ].join('\n'),
  'lib/client.js': [
    'window.__ModuleLoader__.load({',
    "  id: '@quill507/dsh-auto-approval-llm',",
    '  factory: (require) => {',
    "    const slots = require('@deepseek-ai/dsh-client-ui-slots')",
    "    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')",
    "    const react = require('react')",
    '    return { slots, primitives, react }',
    '  },',
    '})',
    '',
  ].join('\n'),
  'cordis.patch.yml': [
    '- id: permission',
    '  config:',
    '    presets:',
    '      auto:',
    '        sandbox: danger-full-access',
    '        name: Auto',
    '',
  ].join('\n'),
  'src/client/approvals/shared.ts': [
    'const buttons: any[] = Array.from(panel.querySelectorAll("button"))',
    "const reject = buttons.find((b: any) => /^(拒绝|Reject)$/i.test((b.textContent ?? '').trim()))",
    "const allow = buttons.find((b: any) => /^(允许一次|Allow once)$/i.test((b.textContent ?? '').trim()))",
    'export const guard = { buttons, reject, allow }',
    '',
  ].join('\n'),
  'src/client/auto-icon.ts': [
    'export const PERMISSION_LABEL_SETS = {',
    "    readOnly: ['Read Only', '仅可查看'],",
    "    workspaceWrite: ['Workspace Write', '工作区内修改'],",
    "    auto: ['Auto', '自动审批'],",
    "    fullAccess: ['Full access', '完全权限'],",
    '};',
    '',
  ].join('\n'),
  'src/client/index.ts': [
    'export function apply(ctx: any): void {',
    "  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({",
    "    name: 'plugins.bundle.config',",
    "    key: '@quill507/dsh-auto-approval-llm',",
    '  }))',
    "  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({",
    "    name: 'settings.plugin.item',",
    "    id: 'auto-approval-llm-card',",
    '  }))',
    "  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({",
    "    name: 'conversation.session.header.utilities',",
    "    id: 'auto-approval-llm-status-chip',",
    '  }))',
    "  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({",
    "    name: 'conversation.input.dock',",
    "    id: 'auto-approval-llm-capsule',",
    '  }))',
    '}',
    '',
  ].join('\n'),
}

/** Official artifacts with the shape the real packages ship. */
const OFFICIAL_FILES = {
  'dsh-web-frontend/dist/assets/index-abc123.js': [
    'const page = { fail(error) { console.error(error) } };',
    'function by(){return{react:ec,"react/jsx-runtime":ic,"react-dom":cc,"react-dom/client":fc,',
    '"@deepseek-ai/cordis":Ha,"@deepseek-ai/dsh-client-store":Hc,"@deepseek-ai/dsh-client-ui-slots":Ac,',
    '"@deepseek-ai/dsh-client-ui-primitives":Zg,"@deepseek-ai/dsh-client-ui-dockkit":Ey}}',
    'const loader = { create({ staticModules: by() }) { return staticModules } };',
    'page.fail(loader)',
    '',
  ].join('\n'),
  'dsh-client-ui-approval/lib/client.js': [
    'const labels = ["Reject", "Allow once", "拒绝", "允许一次"];',
    'const en = { "approval.reject": "Reject", "approval.allowOnce": "Allow once" };',
    'const zh = { "approval.reject": "拒绝", "approval.allowOnce": "允许一次" };',
    'export { labels, en, zh }',
    '',
  ].join('\n'),
  'dsh-client-ui-permission-presets/lib/client.js': [
    'const zh = {',
    '  "preset.readOnly": "仅可查看",',
    '  "preset.workspaceWrite": "工作区内修改",',
    '  "preset.fullAccess": "完全权限",',
    '  "preset.custom": "自定义",',
    '};',
    'const en = {',
    '  "preset.readOnly": "Read Only",',
    '  "preset.workspaceWrite": "Workspace Write",',
    '  "preset.fullAccess": "Full access",',
    '};',
    'const mode = "danger-full-access";',
    'export { zh, en, mode }',
    '',
  ].join('\n'),
  'dsh-permission-presets/lib/index.js': [
    'const presets = z$1.union([',
    '  z$1.literal("read-only"),',
    '  z$1.literal("workspace-write"),',
    '  z$1.object({ preset: z$1.literal("danger-full-access") }),',
    ']);',
    'const custom = "custom";',
    'export { presets, custom }',
    '',
  ].join('\n'),
  'dsh-cordis-client-runner/lib/client.js': [
    'const directory = [',
    '  "conversation.session.header",',
    '  "conversation.session.header.utilities",',
    '  "conversation.input.dock",',
    '  "plugins.bundle.config",',
    '  "plugins.item",',
    '  "settings.plugin.usage",',
    '  "settings.general.item",',
    '];',
    'export { directory }',
    '',
  ].join('\n'),
}

function writeTree(base, files) {
  for (const [relative, contents] of Object.entries(files)) {
    const target = join(base, relative)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
}

/**
 * Build one scenario. `mutate` receives the official file map so a case can
 * remove or reword a single anchor, and `repoMutate` does the same for the
 * repository side.
 */
function scenario(t, { officialMutate, repoMutate } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'official-anchors-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const repo = join(base, 'repo')
  const official = join(base, 'official')
  const officialFiles = { ...OFFICIAL_FILES }
  if (officialMutate !== undefined) officialMutate(officialFiles)
  const repoFiles = { ...REPO_FILES }
  if (repoMutate !== undefined) repoMutate(repoFiles)
  writeTree(repo, repoFiles)
  if (official !== null) writeTree(official, officialFiles)
  return { base, repo, official, officialFiles, repoFiles }
}

/** Run the check and return the exit status plus combined output. */
function runCheck({ repo, official, officialRoot }) {
  const environment = { ...process.env, DSA_ANCHOR_REPO_ROOT: repo }
  if (officialRoot === undefined) environment.DSA_OFFICIAL_ROOT = official
  else if (officialRoot !== null) environment.DSA_OFFICIAL_ROOT = officialRoot
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8', env: environment })
    return { status: 0, output: stdout }
  } catch (error) {
    const status = typeof error.status === 'number' ? error.status : 1
    return { status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

test('a consistent minimal tree passes every item', t => {
  const { repo, official } = scenario(t)
  const { status, output } = runCheck({ repo, official })
  assert.equal(status, 0, output)
  assert.match(output, /^check-official-anchors: ok$/m)
  for (const item of ['platform-seed-modules', 'approval-button-labels', 'slot-directory', 'permission-presets']) {
    assert.match(output, new RegExp(`^check-official-anchors: ok  ${item}  `, 'm'), `${item} did not report ok`)
  }
  assert.doesNotMatch(output, /FAIL/)
})

test('an unresolvable official root skips with exit 0', t => {
  const { repo } = scenario(t)
  // An explicit override that points nowhere must report "not resolvable"
  // instead of falling back to autodiscovery (which would find this machine's
  // install and mask the skip path).
  const { status, output } = runCheck({ repo, official: join(repo, 'no-such-official-root') })
  assert.equal(status, 0, output)
  assert.equal(output.trim(), 'check-official-anchors: WARN official packages not resolvable; skipped')
})

test('a missing approval button label fails and prints the difference', t => {
  const { repo, official } = scenario(t, {
    officialMutate(files) {
      files['dsh-client-ui-approval/lib/client.js'] = files['dsh-client-ui-approval/lib/client.js'].replaceAll('Allow once', 'Continue')
    },
  })
  const { status, output } = runCheck({ repo, official })
  assert.equal(status, 1, output)
  assert.match(output, /^check-official-anchors: FAIL {2}approval-button-labels {2}.*Allow once/m)
})

test('a missing slot fails and prints the slot name', t => {
  const { repo, official } = scenario(t, {
    officialMutate(files) {
      files['dsh-cordis-client-runner/lib/client.js'] = files['dsh-cordis-client-runner/lib/client.js'].replace('  "conversation.session.header.utilities",\n', '')
    },
  })
  const { status, output } = runCheck({ repo, official })
  assert.equal(status, 1, output)
  assert.match(output, /^check-official-anchors: FAIL {2}slot-directory {2}.*conversation\.session\.header\.utilities/m)
})

test('a retired-line slot absent from the installed directory is reported, not failed', t => {
  const { repo, official } = scenario(t)
  const { status, output } = runCheck({ repo, official })
  assert.equal(status, 0, output)
  assert.match(output, /^check-official-anchors: ok {2}slot-directory {2}.*retired-line slots not declared here: settings\.plugin\.item/m)
})

test('a seed table without a required platform specifier fails', t => {
  const { repo, official } = scenario(t, {
    // The specifier is stripped from the seed table and from the declared
    // intent set at once, so the only signal left is the bundle requirement.
    officialMutate(files) {
      files['dsh-web-frontend/dist/assets/index-abc123.js'] = files['dsh-web-frontend/dist/assets/index-abc123.js'].replace(
        '"@deepseek-ai/dsh-client-ui-slots":Ac,',
        '',
      )
    },
    repoMutate(files) {
      files['package.json'] = files['package.json'].replace('"@deepseek-ai/dsh-client-ui-slots",\n', '')
    },
  })
  const { status, output } = runCheck({ repo, official })
  assert.equal(status, 1, output)
  assert.match(output, /^check-official-anchors: FAIL {2}platform-seed-modules {2}.*dsh-client-ui-slots/m)
})

test('an unseeded and undeclared external fails instead of only being skipped', t => {
  const { repo, official } = scenario(t, {
    repoMutate(files) {
      // The specifier is externalised by the bundler configuration, requested by
      // the bundle, declared nowhere, and absent from the platform seed table.
      files['package.json'] = files['package.json'].replace(/,?\s*"@deepseek-ai\/dsh-client-ui-primitives"(?=\s*[,\]])/, '')
      files['lib/client.js'] = files['lib/client.js'].replace(
        "    const react = require('react')",
        "    const unlisted = require('@deepseek-ai/dsh-client-ui-unlisted')\n    const react = require('react')",
      )
    },
  })
  const { status, output } = runCheck({ repo, official })
  assert.equal(status, 1, output)
  assert.match(output, /^check-official-anchors: FAIL {2}platform-seed-modules {2}.*dsh-client-ui-unlisted/m)
})

test('a seed bundle without a parseable module table warns rather than fails', t => {
  const { repo, official } = scenario(t, {
    officialMutate(files) {
      files['dsh-web-frontend/dist/assets/index-abc123.js'] = 'const loader = { staticModules: build() };\n'
    },
  })
  const { status, output } = runCheck({ repo, official })
  assert.equal(status, 0, output)
  assert.match(output, /^check-official-anchors: WARN {2}platform-seed-modules {2}.*could not be parsed/m)
})

test('a permission tier with no official wording fails', t => {
  const { repo, official } = scenario(t, {
    officialMutate(files) {
      files['dsh-permission-presets/lib/index.js'] = files['dsh-permission-presets/lib/index.js'].replace(/z\$1\.literal\("workspace-write"\),\n/, '')
      files['dsh-client-ui-permission-presets/lib/client.js'] = files['dsh-client-ui-permission-presets/lib/client.js']
        .replaceAll('Workspace Write', 'Workspace Edit')
        .replaceAll('工作区内修改', '工作区内编辑')
    },
  })
  const { status, output } = runCheck({ repo, official })
  assert.equal(status, 1, output)
  assert.match(output, /^check-official-anchors: FAIL {2}permission-presets {2}.*workspaceWrite/m)
  assert.match(output, /"Workspace Write"/)
})

test('items are independent: one failure does not stop the other three', t => {
  const { repo, official } = scenario(t, {
    officialMutate(files) {
      files['dsh-client-ui-approval/lib/client.js'] = files['dsh-client-ui-approval/lib/client.js'].replaceAll('Reject', 'Deny')
    },
  })
  const { status, output } = runCheck({ repo, official })
  assert.equal(status, 1, output)
  assert.match(output, /^check-official-anchors: FAIL {2}approval-button-labels/m)
  for (const item of ['platform-seed-modules', 'slot-directory', 'permission-presets']) {
    assert.match(output, new RegExp(`^check-official-anchors: ok  ${item}  `, 'm'), `${item} was not reported independently`)
  }
})

test('the real repository resolves its own official artifacts without a FAIL', () => {
  // Every case above drives a tmp fixture, so nothing in the file proved the
  // check works against THIS tree. Run it here with the script's own default
  // repository root and its normal official-root resolution: a machine without
  // the official packages must print the documented skip, and a machine with
  // them must report every item without a FAIL.
  const environment = { ...process.env }
  delete environment.DSA_OFFICIAL_ROOT
  delete environment.DSA_ANCHOR_REPO_ROOT
  let status = 0
  let output = ''
  try {
    output = execFileSync(process.execPath, [scriptPath], { cwd: repoRoot, encoding: 'utf8', env: environment })
  } catch (error) {
    status = typeof error.status === 'number' ? error.status : 1
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  assert.equal(status, 0, `the real tree must not fail the official anchor check:\n${output}`)
  assert.doesNotMatch(output, /check-official-anchors: FAIL/, 'no item may fail on the real tree')
  const reading = /^check-official-anchors: reading official packages from (.+)$/m.exec(output)
  if (reading === null) {
    assert.equal(output.trim(), 'check-official-anchors: WARN official packages not resolvable; skipped')
    return
  }
  assert.equal(existsSync(reading[1]), true, 'the reported official root must exist')
  for (const item of ['platform-seed-modules', 'approval-button-labels', 'slot-directory', 'permission-presets']) {
    assert.match(output, new RegExp(`^check-official-anchors: (ok|WARN|FAIL) {2}${item} {2}`, 'm'), `${item} must be reported for the real tree`)
  }
  assert.match(output, /^check-official-anchors: ok$/m, 'a run with no failing item reports ok')
})

test('refactor guard: the gate keeps the check wired unconditionally after the documentation anchors', () => {
  // Not a behaviour check — this only notices if the step is renamed, moved out
  // of gate.mjs, or made conditional. The behaviour proof is the real-tree case
  // above.
  const gate = readFileSync(gatePath, 'utf8')
  const scriptsInOrder = [...gate.matchAll(/run\('[^']*',\s*'node',\s*\['scripts\/([^']+)'/g)].map(match => match[1])
  assert.deepEqual(
    scriptsInOrder.filter(script => script !== 'check-official-anchors.mjs'),
    ['clean-lib.mjs', 'check-doc-numbers.mjs', 'check-anchors.mjs'],
    'the pre-existing read-only steps and their order changed',
  )
  assert.equal(scriptsInOrder.filter(script => script === 'check-official-anchors.mjs').length, 1, 'the anchor check is not wired into the gate exactly once')
  assert.ok(
    scriptsInOrder.indexOf('check-official-anchors.mjs') > scriptsInOrder.indexOf('check-anchors.mjs'),
    'the anchor check must run after the documentation anchor step and before the release steps',
  )

  // A guarded step is not a wired step: wrapping the call in `if (…) { … }`, in
  // a `cond && run(...)` prefix, or making it the continuation of an expression
  // on the previous line leaves the call text intact, so the assertions above
  // stay green while the gate stops running it. Pin the call's own position
  // instead — the whole line must be one bare `run(...)` statement, it must sit
  // at the same indentation as the sibling read-only steps, and the nearest
  // preceding non-comment line must be a complete statement of its own (it
  // cannot open a block, and it cannot end on an operator, which is what an
  // expression continuation looks like). Trade-off: a table-driven refactor of
  // these steps reddens here and above. The shapes pinned are exactly these
  // source shapes; a step made conditional inside a callee is out of reach of
  // any text-level guard.
  const lines = gate.split(/\r?\n/)
  const bareRun = /^\s*run\('[^']*',\s*'node',\s*\['scripts\/check-official-anchors\.mjs'\]\)\s*$/
  const officialAt = lines.findIndex(line => bareRun.test(line))
  assert.notEqual(officialAt, -1, 'the official anchor step must stay a standalone run(...) statement')
  const siblingAt = lines.findIndex(line => /^\s*run\('[^']*',\s*'node',\s*\['scripts\/check-anchors\.mjs'\]\)\s*$/.test(line))
  assert.notEqual(siblingAt, -1, 'the documentation anchor step must stay a standalone run(...) statement')
  const indentOf = (line) => line.length - line.trimStart().length
  assert.equal(
    indentOf(lines[officialAt]),
    indentOf(lines[siblingAt]),
    'the official anchor step must stay a top-level statement beside the other read-only steps',
  )
  let guardAt = officialAt - 1
  while (guardAt >= 0 && (lines[guardAt].trim() === '' || /^\s*(\/\/|\*|\/\*)/.test(lines[guardAt]))) guardAt -= 1
  assert.ok(guardAt >= 0, 'the official anchor step must not be the first line of the gate')
  const guard = lines[guardAt].trim()
  assert.ok(
    !/^(?:if|for|while|switch)\s*\(/.test(guard) && !/^else\b/.test(guard) && !guard.endsWith('{'),
    `the official anchor step must not sit inside a conditional or loop block, found guard line: ${JSON.stringify(lines[guardAt])}`,
  )
  // The preceding step has to end a statement, not half of an expression. The
  // closing tokens cover both the semicolon style and this repository's
  // semicolon-free `foo()` steps; the continuation set is what an expression
  // split across lines ends on.
  const CONTINUATIONS = ['&&', '||', '??', '=>', '?', ':', ',', '=', '+', '-', '*', '/', '%', '.', '&', '|']
  const endsStatement = /[;})]$/.test(guard)
  const endsContinuation = CONTINUATIONS.some(token => guard.endsWith(token))
    || /(?:return|const|let|var|await|new)$/.test(guard)
  assert.ok(
    endsStatement && !endsContinuation,
    `the official anchor step must be a statement of its own, not the tail of an expression; preceding line: ${JSON.stringify(lines[guardAt])}`,
  )
})
