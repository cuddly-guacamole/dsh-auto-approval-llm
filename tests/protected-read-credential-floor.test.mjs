/**
 * The protected opt-out must not unlock credential material.
 *
 * `protectedAutoReview` exists to stop dead-ending workspace metadata such as
 * `.git/` and `.vscode/`, which is a real and repeated source of friction. The
 * `protected` category, however, is also what labels reads of credential
 * material — `.env`, `.npmrc`, `.netrc`, private-key trees, system roots. Those
 * two are not the same risk, and unlocking both together hands token stores and
 * private keys to an automated reviewer.
 *
 * The policy layer now marks the credential half with the structured field
 * `credentialRead`, and the clamp (`categoryDirective` and the answerer's locked
 * predicate) keeps it locked whatever the switch says. This file pins the floor
 * from three angles: the flag itself, the directive it produces, and the fact
 * that the two halves of the plugin read the same field.
 *
 * The "should NOT hold" direction matters as much as the floor: metadata that is
 * merely protected must stay unlockable, otherwise the switch is useless and the
 * friction it was meant to remove comes straight back.
 *
 * Run: node --test tests/protected-read-credential-floor.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assessTool } from '../lib/auto/policy.js'
import { categorizeTool, categoryDirective } from '../lib/auto/category.js'

const roots = {
  workspace: 'C:/ws', home: 'C:/Users/u', dshHome: 'C:/Users/u/.dsh',
  tempRoots: [], allowedDshSubpaths: [], trustedDirs: [], mode: 'aggressive',
}
const artifacts = { has: () => false }
const cfg = (overrides = {}) => ({ categoryPolicy: {}, categoryMode: 'aggressive', ...overrides })
/** The unlock is only observable through an explicit policy; without one both
 * states yield 'ask'. Setting `protected: 'auto'` is what the switch unlocks. */
const unlocked = cfg({ protectedAutoReview: true, categoryPolicy: { protected: 'auto' } })
const off = cfg({ protectedAutoReview: false, categoryPolicy: { protected: 'auto' } })

const assess = (name, args) => assessTool({ name, arguments: args }, roots, artifacts)
const directiveFor = (name, args, config) => categoryDirective(config, categorizeTool({ name, arguments: args }, roots), assess(name, args))

/**
 * Standard mode is a different code path for reads: the position gate rejects
 * anything outside the workspace BEFORE the protected-metadata and sensitive-name
 * checks, so the floor has to be applied on that early branch too. Under
 * `aggressive` every path is "routine" and the later branches do the work, which
 * is why this case needs its own roots.
 */
const standardRoots = { ...roots, mode: 'standard' }
const assessStandard = (name, args) => assessTool({ name, arguments: args }, standardRoots, artifacts)
const directiveForStandard = (name, args, config) => categoryDirective(config, categorizeTool({ name, arguments: args }, standardRoots), assessStandard(name, args))
const standardUnlocked = { categoryPolicy: { protected: 'auto' }, categoryMode: 'standard', protectedAutoReview: true }

/** Reads that carry real credential material: sensitive names and critical trees. */
const CREDENTIAL_READS = [
  ['read', { file_path: 'C:/ws/.env' }],
  ['read', { file_path: 'C:/Users/u/.npmrc' }],
  ['read', { file_path: 'C:/Users/u/.ssh/config' }],
  ['read', { file_path: 'C:/Users/u/.aws/credentials' }],
  ['read', { file_path: 'C:/ws/.env.production' }],
  ['str_replace_editor', { command: 'view', path: 'C:/ws/.env' }],
  ['str_replace_editor', { command: 'view', path: 'C:/Users/u/.npmrc' }],
]

/** Reads that are protected only as workspace metadata — the switch's purpose. */
const METADATA_READS = [
  ['read', { file_path: 'C:/ws/.git/config' }],
  ['read', { file_path: 'C:/ws/.vscode/settings.json' }],
  ['str_replace_editor', { command: 'view', path: 'C:/ws/.git/config' }],
]

/**
 * A write head that reads a credential SOURCE. `tee out < secret` echoes stdin
 * to stdout and `dd if=secret of=out` copies it, so these are reads of
 * credential material even though the command is a writer. They must not get
 * the write-family static allow: without this the bytes reach the tool result
 * (and the model context) with no approval, no reviewer and no verdict naming
 * the read.
 */
const WRITE_HEAD_CREDENTIAL_READS = [
  ['bash', { command: 'tee C:/Temp/out.bin < C:/Users/u/.npmrc' }],
  ['bash', { command: 'tee C:/Temp/out.bin < C:/Users/u/.ssh/config' }],
  ['bash', { command: 'dd if=C:/Users/u/.npmrc of=C:/Temp/leak.bin' }],
  ['bash', { command: 'cat C:/Temp/out.bin < C:/Users/u/.npmrc' }],
  ['bash', { command: 'cp C:/Users/u/.npmrc C:/Temp/copy.txt' }],
  ['bash', { command: 'mv C:/ws/.env C:/Temp/moved.txt' }],
]

/** A write head reading ordinary project content: the control. */
const WRITE_HEAD_ORDINARY_READS = [
  ['bash', { command: 'tee C:/Temp/out.bin < C:/ws/src/app.ts' }],
]
const SHELL_CREDENTIAL_READS = [
  ['bash', { command: 'cat ~/.npmrc' }],
  ['bash', { command: 'cat ~/.ssh/config' }],
  ['bash', { command: 'cat C:/Users/u/.aws/credentials' }],
  ['bash', { command: 'grep -r token ~/.aws/' }],
  ['bash', { command: 'cat C:/ws/.env' }],
  ['pwsh', { command: 'Get-Content C:/Users/u/.npmrc' }],
]

/** A shell command that reads ordinary project content: the control. */
const SHELL_ORDINARY_READS = [
  ['bash', { command: 'cat C:/ws/src/app.ts' }],
  ['bash', { command: 'ls C:/ws/src' }],
]

test('floor: a write head reading a credential source is not statically allowed', () => {
  // The control first: the write fast path is genuinely reachable here, so a
  // credential source being refused is the change under test rather than a
  // generic "writes are never statically allowed".
  for (const [name, args] of WRITE_HEAD_ORDINARY_READS) {
    assert.equal(
      assess(name, args).decision,
      'allow',
      `control: ${args.command} must still be a static allow`,
    )
  }
  const failures = []
  for (const [name, args] of WRITE_HEAD_CREDENTIAL_READS) {
    const result = assess(name, args)
    if (result.decision === 'allow') failures.push(`${args.command}: static allow (${result.reason})`)
    if (result.classifierEligible !== true) failures.push(`${args.command}: classifierEligible=${result.classifierEligible}`)
  }
  assert.deepEqual(failures, [], `credential sources that rode the write fast path:\n${failures.join('\n')}`)
})

test('floor: a credential SOURCE on a write head is flagged, so the unlock cannot reach it', () => {
  // The refusal above keeps the static allow away, but a refusal alone is not
  // the whole floor: an ask can still be answered automatically. Where the
  // category layer labels the command `protected`, the flag is what keeps the
  // unlocked switch from turning that ask into an auto/classifier answer, so
  // flag and clamp are asserted together for exactly those commands.
  //
  // Commands the category layer labels otherwise (a `tee` whose only sensitive
  // operand is a redirect source is `fileEdit`) are not governed by this switch
  // at all; their protection is the refusal tested above. The test therefore
  // requires at least one protected case, so it cannot pass by covering none.
  const failures = []
  const protectedCases = []
  for (const [name, args] of WRITE_HEAD_CREDENTIAL_READS) {
    const label = categorizeTool({ name, arguments: args }, roots)
    const result = assess(name, args)
    if (result.credentialRead !== true) failures.push(`${args.command}: credentialRead=${result.credentialRead}`)
    if (label === 'protected') {
      protectedCases.push(args.command)
      const dir = directiveFor(name, args, unlocked)
      if (dir !== 'ask') failures.push(`${args.command}: unlocked to ${dir}`)
    }
  }
  assert.ok(protectedCases.length > 0, 'at least one credential source must carry the protected label for this check to bite')
  assert.deepEqual(failures, [], `credential sources the unlock reached:\n${failures.join('\n')}`)
})

test('floor: standard mode locks out-of-workspace credential reads too', () => {
  // In standard mode the position gate answers first ("reading outside the
  // workspace"), which used to leave the credential flag unset — so with the
  // switch on and an explicit auto policy that read could be answered by the
  // pipeline. The floor must be applied on that branch as well.
  const failures = []
  for (const target of ['C:/Users/u/.npmrc', 'C:/Users/u/.ssh/config', 'C:/Users/u/.aws/credentials', 'C:/ws/.env']) {
    const result = assessStandard('read', { file_path: target })
    if (result.credentialRead !== true) failures.push(`${target}: credentialRead=${result.credentialRead}`)
    const dir = directiveForStandard('read', { file_path: target }, standardUnlocked)
    if (dir !== 'ask') failures.push(`${target}: unlocked to ${dir}`)
  }
  // Control: an ordinary file outside the workspace is still an ask (the
  // position gate), but it must NOT be flagged as credential material, or the
  // floor would lock every external read with no way to unlock it.
  const ordinary = assessStandard('read', { file_path: 'C:/Users/u/notes.txt' })
  assert.notEqual(ordinary.credentialRead, true, 'an ordinary external read carries no credential flag')
  assert.equal(ordinary.decision, 'ask', 'and it keeps the position-gate ask')
  // The `view` reader takes its own position gate, so it needs the same floor.
  const viaView = assessStandard('str_replace_editor', { command: 'view', path: 'C:/Users/u/.npmrc' })
  assert.equal(viaView.credentialRead, true, 'view of an out-of-workspace credential file is flagged too')
  assert.equal(
    directiveForStandard('str_replace_editor', { command: 'view', path: 'C:/Users/u/.npmrc' }, standardUnlocked),
    'ask',
    'and the unlock cannot reach it',
  )
  assert.deepEqual(failures, [], `standard-mode credential reads the unlock reached:\n${failures.join('\n')}`)
})

test('floor: credential reads are flagged by the policy layer', () => {
  const failures = []
  for (const [name, args] of CREDENTIAL_READS) {
    const result = assess(name, args)
    if (result.credentialRead !== true) failures.push(`${args.file_path}: credentialRead=${result.credentialRead}`)
  }
  assert.deepEqual(failures, [], `credential reads that were not flagged:\n${failures.join('\n')}`)
})

test('floor: the switch does NOT unlock credential reads', () => {
  // The core assertion. With the switch fully on and an explicit auto policy,
  // credential material must still be clamped to the locked ask.
  const failures = []
  for (const [name, args] of CREDENTIAL_READS) {
    const withSwitch = directiveFor(name, args, unlocked)
    if (withSwitch !== 'ask') failures.push(`${args.file_path}: unlocked to ${withSwitch}`)
    const withoutSwitch = directiveFor(name, args, off)
    if (withoutSwitch !== 'ask') failures.push(`${args.file_path}: off state ${withoutSwitch}`)
  }
  assert.deepEqual(failures, [], `credential reads the unlock reached:\n${failures.join('\n')}`)
})

test('floor: it really is the flag doing the clamping, not the category', () => {
  // Discrimination check: the same `protected` category DOES unlock when the
  // credential flag is absent. Without this the test above would pass for the
  // wrong reason (e.g. if the switch did nothing at all).
  const [, metadataArgs] = METADATA_READS[0]
  assert.equal(directiveFor('read', metadataArgs, unlocked), 'auto', 'metadata unlocks')
  assert.equal(directiveFor('read', metadataArgs, off), 'ask', 'and stays locked with the switch off')
  const [, credentialArgs] = CREDENTIAL_READS[0]
  assert.equal(directiveFor('read', credentialArgs, unlocked), 'ask', 'the credential read does not')
})

test('floor: the shell read vector is covered, not just the structured readers', () => {
  // The category layer labels these `protected` from its own read-target check,
  // so a floor that missed this vector would leave the widest reader unlocked.
  const failures = []
  for (const [name, args] of SHELL_CREDENTIAL_READS) {
    const label = categorizeTool({ name, arguments: args }, roots)
    if (label !== 'protected') failures.push(`${args.command}: category=${label} (fixture is not exercising the protected clamp)`)
    const result = assess(name, args)
    if (result.credentialRead !== true) failures.push(`${args.command}: credentialRead=${result.credentialRead}`)
    const dir = directiveFor(name, args, unlocked)
    if (dir !== 'ask') failures.push(`${args.command}: unlocked to ${dir}`)
  }
  assert.deepEqual(failures, [], `shell credential reads the unlock reached:\n${failures.join('\n')}`)
})

test('floor: ordinary shell reads are not swept into the floor', () => {
  // "The criterion should NOT hold here" half for the shell vector: a floor
  // that flagged every shell read would lock ordinary work with no way out.
  const failures = []
  for (const [name, args] of SHELL_ORDINARY_READS) {
    const result = assess(name, args)
    if (result.credentialRead === true) failures.push(`${args.command}: wrongly flagged as credential material`)
    if (result.decision !== 'allow') failures.push(`${args.command}: ordinary read is not allowed (${result.decision})`)
  }
  assert.deepEqual(failures, [], failures.join('\n'))
})

test('floor: the switch still does its job for protected metadata', () => {
  // "The criterion should NOT hold here" half — the friction the switch was
  // introduced to remove must actually be removed, or the clamp has eaten the
  // feature.
  const failures = []
  for (const [name, args] of METADATA_READS) {
    const result = assess(name, args)
    if (result.credentialRead === true) failures.push(`${args.file_path}: wrongly flagged as credential material`)
    const dir = directiveFor(name, args, unlocked)
    if (dir !== 'auto') failures.push(`${args.file_path}: switch did not lift the clamp (${dir})`)
  }
  assert.deepEqual(failures, [], failures.join('\n'))
})

test('floor: an ordinary project file is untouched by all of this', () => {
  const result = assess('read', { file_path: 'C:/ws/src/app.ts' })
  assert.equal(result.decision, 'allow', 'ordinary reads stay allowed')
  assert.equal(result.credentialRead, undefined, 'and carry no credential flag')
})

test('floor: both planes read the same flag', () => {
  // The clamp has to hold in `categoryDirective` AND in the answerer's locked
  // predicate; a disagreement between them is exactly what made the protected
  // read unanswerable in the first place. The predicate is a closure inside the
  // plugin function, so anchor the compiled host.
  const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const start = host.indexOf('const isLockedCategory = (')
  assert.notEqual(start, -1, 'the locked-category predicate is present in the compiled host')
  const body = host.slice(start, start + 900)
  assert.ok(
    /category === ['"]protected['"] && config\.protectedAutoReview === true && !credentialRead/.test(body),
    `the answerer must apply the credential floor too:\n${body.slice(0, 400)}`,
  )
  assert.ok(
    /classified\.assessment\?\.credentialRead === true/.test(host),
    'and the call site must pass the flag through',
  )
})
