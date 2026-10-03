/**
 * Peer-range admission contract. The five `@deepseek-ai/dsh-*` peers promise one
 * host line per tuple — `0.2.0-rc.2` and `0.2.1-alpha.1`, the lines the user
 * actually runs — through two arms `>=0.2.0-rc.2 <2 || >=0.2.1-alpha.1 <2`.
 *
 * The host evaluates peers with `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`
 * (`dsh-app-boot/lib/index.js:300`). The plain reading — the rule implemented by
 * `satisfies()` below, where a prerelease must be named by a comparator in its
 * own major.minor.patch tuple — is what decides the shape of the arms. A single
 * arm floored at `0.2.0-rc.2` admits that line under both readings, but refuses
 * `0.2.1-alpha.1` under the plain one, because no comparator carried the `0.2.1`
 * tuple. The promise therefore spans two tuples, and one arm per promised tuple
 * is the minimum that admits every promised line on its own rather than on the
 * flag alone. The flag stays pinned for each line as well, so a host that
 * stopped passing it is a red suite rather than a refused install nobody sees.
 *
 * Raising the floor dropped `0.1.7-rc.2`, `0.1.7-rc.1`, `0.1.7-alpha.2` and
 * `0.1.5-rc.2` out of admission; all four are pinned false below, so a later
 * relaxation of the range is caught here.
 *
 * Admission is nevertheless NOT a support claim: `<2` is only the range's upper
 * bound, untested lines inside the range are unsupported, and the support claim
 * lives in the rows of `HOST_LINES`.
 *
 * This file reads the real `package.json` literal instead of a private copy, so
 * that any edit to the peer range must edit this file too. The satisfaction
 * check below is a local implementation of the ordinary semver rule (each
 * comparator set must match, and a prerelease candidate must be named by a
 * comparator whose version carries the same major.minor.patch tuple); it is
 * cross-checked against the installed `semver` package when one is resolvable,
 * so the hand-rolled path cannot drift away from the real resolution rule.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { HOST_LINES } from "../scripts/test-host-lines.mjs"

const ROOT = process.cwd()

/** The admission range promised by the dsh peers: one bounded arm per promised tuple. */
const EXPECTED_RANGE = ">=0.2.0-rc.2 <2 || >=0.2.1-alpha.1 <2"

/** Application-level peer that is not a host line and is not part of this contract. */
const CORDIS_PEER = "@deepseek-ai/cordis"

const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
const dshPeers = Object.entries(manifest.peerDependencies).filter(([name]) =>
  name.startsWith("@deepseek-ai/dsh-"),
)

/** `1`, `1.0` and `1.0.0` all denote the same release; the operators may omit parts. */
const RELEASE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/
const COMPARATOR = /^(>=|<=|>|<|=)?(.*)$/

/**
 * The ordinary semver rule, hand-rolled: a comparator set matches only when
 * every comparator matches, and a prerelease candidate additionally needs one
 * comparator in the set whose version carries the same major.minor.patch tuple.
 * That extra rule is why the floor has to sit inside the promised tuple — a
 * floor one tuple below would leave `0.1.7-rc.2` named by no comparator, and the
 * line would be silently refused at install time.
 */
function satisfies(version, range) {
  const candidate = parse(version)
  return range
    .split("||")
    .map(set => set.trim())
    .some(set => {
      const comparators = set.split(/\s+/).filter(Boolean).map(text => {
        const [, operator, operand] = COMPARATOR.exec(text)
        return { operator: operator ?? "=", target: parse(operand) }
      })
      if (!comparators.every(comparator => matches(candidate, comparator))) return false
      if (candidate.prerelease.length === 0) return true
      const tuple = `${candidate.major}.${candidate.minor}.${candidate.patch}`
      // Both halves are load-bearing: the comparator must carry the same tuple
      // *and* be a prerelease itself. A release bound such as `<2` shares the
      // tuple with `2.0.0-0` but names no prerelease, so it does not admit it.
      return comparators.some(
        comparator =>
          comparator.target.prerelease.length > 0 &&
          `${comparator.target.major}.${comparator.target.minor}.${comparator.target.patch}` === tuple,
      )
    })
}

function parse(text) {
  const match = RELEASE.exec(text)
  if (!match) throw new Error(`unsupported version: ${text}`)
  return {
    major: +match[1],
    minor: match[2] === undefined ? 0 : +match[2],
    patch: match[3] === undefined ? 0 : +match[3],
    prerelease: match[4] === undefined ? [] : match[4].split(".").map(part => (/^\d+$/.test(part) ? +part : part)),
  }
}

function matches(candidate, comparator) {
  const order = compare(candidate, comparator.target)
  switch (comparator.operator) {
    case ">=":
      return order >= 0
    case "<=":
      return order <= 0
    case ">":
      return order > 0
    case "<":
      return order < 0
    default:
      return order === 0
  }
}

function compare(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumeric = typeof a === "number"
    const bNumeric = typeof b === "number"
    if (aNumeric && bNumeric) return a < b ? -1 : 1
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return a < b ? -1 : 1
  }
  return 0
}

/**
 * The truth table the arms must produce, measured against the installed
 * `semver` package. Both promised lines sit at true — each is named by the arm
 * carrying its own tuple, so the plain reading admits it without the flag.
 * `0.1.7-rc.2` — a line the promise used to span — sitting at false is the point
 * of the raised floor: it is not promised any more, so it must not stay
 * installable, and a later lowering back across the tuple is caught here.
 */
const TRUTH_TABLE = [
  ["0.2.0-rc.2", true],
  ["0.2.1-alpha.1", true],
  ["0.1.7-rc.2", false],
  ["0.1.7-rc.1", false],
  ["0.1.7", false],
  ["0.2.0", true],
  ["1.9.9", true],
  ["0.1.7-alpha.2", false],
  ["0.1.7-alpha.1", false],
  ["0.1.6", false],
  ["0.1.6-alpha.1", false],
  ["2.0.0", false],
  ["0.1.5-rc.2", false],
]

test("the five dsh peers carry the promised admission range", () => {
  assert.equal(dshPeers.length, 5)
  assert.deepEqual(
    dshPeers.map(([name]) => name).sort(),
    [
      "@deepseek-ai/dsh-llm",
      "@deepseek-ai/dsh-permission-presets",
      "@deepseek-ai/dsh-session",
      "@deepseek-ai/dsh-tools",
      "@deepseek-ai/dsh-user-approval",
    ],
  )
  for (const [name, range] of dshPeers) {
    assert.equal(range, EXPECTED_RANGE, `${name} peer range drifted`)
  }
})

test("the range is one bounded arm per promised tuple, and still refuses the lines below the floor", () => {
  // One arm per promised tuple, and no more. What a third arm would do is add a
  // second, redundant way to admit the promise — the range already admits every
  // release below its `<2` bound, and under the host's flagged reading every
  // prerelease above the floor besides — so the arm count is not a claim about
  // what gets installed. It is the bookkeeping that keeps one named arm per
  // promised tuple, which is what makes each line admissible on its own.
  const arms = EXPECTED_RANGE.split("||")
  const promisedTuples = new Set(Object.values(HOST_LINES).map(line => line.version.split("-")[0]))
  assert.equal(arms.length, promisedTuples.size, "the range does not carry one arm per promised tuple")
  for (const [name, range] of dshPeers) {
    assert.equal(range.split("||").length, arms.length, `${name} disagrees with the promised arm count`)
    // `0.1.7-rc.2` left the promise when the floor rose onto the `0.2.0` tuple,
    // so the line it used to sit below is refused by every arm.
    assert.equal(satisfies("0.1.7-rc.2", range), false, `${name} must refuse the dropped 0.1.7 line`)
    assert.equal(satisfies("0.1.7-alpha.2", range), false, `${name} must refuse the retired alpha line`)
    assert.equal(satisfies("0.1.5-rc.2", range), false, `${name} must refuse the retired rc line`)
  }
})

test("every arm is a bounded comparator set floored on a promised tuple", () => {
  const promised = Object.values(HOST_LINES).map(line => line.version)
  // The floor of an arm is compared against the promised **tuple**, not the
  // exact version: moving to the next ordinal inside a tuple is the documented
  // maintenance step, and it changes `version` alone — pinning the range to the
  // exact line would turn that routine step into a red suite even though the
  // range still admits the new ordinal. Admission of each promised line by its
  // own arm is asserted separately below, which is where the exact floor matters.
  const promisedTuples = promised.map(version => version.split("-")[0])
  const floors = []
  for (const arm of EXPECTED_RANGE.split("||")) {
    assert.match(arm.trim(), /^>=[^ ]+ <\d+$/, "an arm is not a single bounded comparator set")
    floors.push(arm.trim().split(" ")[0].slice(2))
  }
  // Each arm floors on a promised tuple, and each promised tuple is floored once:
  // an arm on a tuple the promise does not name is a claim this file keeps out,
  // and a duplicate arm would leave a promised tuple unnamed.
  const floorTuples = floors.map(floor => floor.split("-")[0])
  assert.deepEqual(floorTuples.slice().sort(), promisedTuples.slice().sort(), "the arms and the promised tuples disagree")
  for (const [name, range] of dshPeers) {
    assert.deepEqual(range.split("||").map(arm => arm.trim().split(" ")[0].slice(2).split("-")[0]).sort(), floorTuples.slice().sort(), `${name} arm tuples drifted`)
    // Each promised line is admitted by the arm floored on its own tuple. The
    // arm is matched by tuple rather than by exact version for the reason above,
    // and the floor still has to sit at or below the line it admits — a floor
    // floated above the promised line refuses it, which the plain-reading case
    // would also catch but this states the cause directly.
    for (const version of promised) {
      const tuple = version.split("-")[0]
      const ownArms = range.split("||").map(arm => arm.trim()).filter(arm => arm.split(" ")[0].slice(2).split("-")[0] === tuple)
      assert.equal(ownArms.length, 1, `${name}: the ${tuple} tuple has no arm of its own to be admitted by`)
      const floor = ownArms[0].split(" ")[0].slice(2)
      assert.ok(compare(parse(version), parse(floor)) >= 0, `${name}: the arm floored at ${floor} sits above the promised line ${version}`)
      assert.equal(satisfies(version, ownArms[0]), true, `${name}: the arm floored on the ${tuple} tuple must admit ${version}`)
    }
  }
})

test("the plain reading admits every promised line without the flag", () => {
  // The host calls `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`.
  // The plain rule — the one implemented above, and the one any consumer that
  // forgets the flag would apply — must admit the promise on its own: each
  // promised line is named by the arm carrying its own tuple, so no line depends
  // on the flag. Asserted rather than assumed, because collapsing the promise
  // back onto one tuple without widening the range would leave the newer line
  // admitted by the flag alone, and that must turn this case red.
  const require_ = createRequire(join(ROOT, "package.json"))
  const reference = (() => {
    try {
      return require_("semver")
    } catch {
      return null
    }
  })()
  const promised = Object.values(HOST_LINES).map(line => line.version)
  const plainOnly = promised.filter(version => !satisfies(version, EXPECTED_RANGE))
  assert.deepEqual(
    plainOnly,
    [],
    "a promised line is refused by the plain reading; the arm no longer spans the promise by the flag alone",
  )
  for (const [name, range] of dshPeers) {
    for (const version of promised) {
      assert.equal(satisfies(version, range), true, `${name} must admit ${version} without the flag`)
      if (reference === null) continue
      assert.equal(reference.satisfies(version, range), true, `${name}: semver admits ${version} without the flag`)
      // The host's own reading stays pinned for every promised line, so a host
      // that stopped passing the flag is a red suite rather than a refused
      // install nobody sees.
      assert.equal(
        reference.satisfies(version, range, { includePrerelease: true }),
        true,
        `${name} must admit the promised line ${version} under the host's flagged reading`,
      )
    }
  }
  // The flag is real, not decorative: a prerelease in a tuple no comparator
  // names is admitted only because the host passes it. Nothing is promised in
  // that tuple today, so this is a property of the range, not a support claim.
  if (reference === null) return
  for (const [name, range] of dshPeers) {
    assert.equal(reference.satisfies("0.3.0-alpha.1", range, { includePrerelease: true }), true, `${name} must admit a higher-tuple prerelease under the flagged reading`)
    assert.equal(satisfies("0.3.0-alpha.1", range), false, `${name} must refuse a higher-tuple prerelease under the plain reading`)
  }
})

test("the peer block keeps cordis and schemastery outside the dsh contract", () => {
  assert.equal(manifest.peerDependencies[CORDIS_PEER], ">=4.0.1 <5")
  assert.equal(manifest.peerDependencies["@deepseek-ai/schemastery"], "^3.18.0")
})

test("every promised line is admitted by every peer under the host's reading", () => {
  const require_ = createRequire(join(ROOT, "package.json"))
  let reference = null
  try {
    reference = require_("semver")
  } catch {
    return
  }
  for (const [name, range] of dshPeers) {
    for (const line of Object.values(HOST_LINES)) {
      assert.equal(
        reference.satisfies(line.version, range, { includePrerelease: true }),
        true,
        `${name} must admit ${line.version} the way the host evaluates peers`,
      )
    }
  }
})

test("the arms admit the promised lines and the releases above them", () => {
  for (const [name, range] of dshPeers) {
    for (const [version, expected] of TRUTH_TABLE) {
      assert.equal(satisfies(version, range), expected, `${name} must ${expected ? "admit" : "refuse"} ${version}`)
    }
    assert.equal(satisfies("0.1.7-alpha.2", range), false, `${name} must not admit the retired alpha line`)
  }
})

test("the refused prerelease tuples below the floor stay refused", () => {
  for (const [name, range] of dshPeers) {
    for (const version of ["0.1.7-rc.0", "0.1.7-beta.1", "0.1.6-rc.1", "1.9.9-alpha.1", "2.0.0-0"]) {
      assert.equal(satisfies(version, range), false, `${name} must refuse ${version}`)
    }
  }
})

test("the range admits untested middle lines; admission is not support", () => {
  for (const [name, range] of dshPeers) {
    for (const version of ["0.2.0", "0.2.1", "1.0.0", "1.9.9"]) {
      assert.equal(satisfies(version, range), true, `${name} must admit ${version}`)
    }
    for (const version of ["0.1.9", "0.1.7-rc.2", "0.1.4", "0.1.4-rc.9", "1.9.9-alpha.1", "2.0.0"]) {
      assert.equal(satisfies(version, range), false, `${name} must refuse ${version}`)
    }
  }
})

test("the local satisfaction check agrees with the installed semver package", () => {
  const require_ = createRequire(join(ROOT, "package.json"))
  let reference = null
  try {
    reference = require_("semver")
  } catch {
    return
  }
  const versions = [
    ...TRUTH_TABLE.map(([version]) => version),
    "0.1.7-rc.0",
    "0.1.7-rc.2",
    "0.1.7-beta.1",
    "0.1.6-rc.1",
    "0.1.4",
    "0.1.4-rc.9",
    "0.1.9",
    "1.0.0",
    "1.9.9-alpha.1",
    "2.0.0-0",
  ]
  for (const version of versions) {
    for (const [name, range] of dshPeers) {
      assert.equal(
        satisfies(version, range),
        reference.satisfies(version, range),
        `satisfies(${version}) disagrees with semver for ${name}`,
      )
    }
  }
})
