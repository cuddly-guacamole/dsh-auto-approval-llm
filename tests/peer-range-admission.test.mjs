/**
 * Peer-range admission contract. The five `@deepseek-ai/dsh-*` peers promise
 * one line — `0.2.1-rc.2`, the line the user actually runs — through a single
 * arm `>=0.2.1-rc.2 <2`. One promised tuple carries one arm, and the promise is
 * one tuple, so the range is one arm and the arm count is the tuple count.
 *
 * The host evaluates peers with `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`
 * (the `satisfies()` helper in `dsh-app-boot/lib/index.js`). The plain reading —
 * the rule implemented by `satisfies()` below, where a prerelease must be named
 * by a comparator in its own major.minor.patch tuple — is what decides the shape
 * of the arm. The floor `>=0.2.1-rc.2` carries the `0.2.1` tuple and a
 * prerelease, so the promised line is admitted under both readings and nothing
 * about the promise rests on the flag. The flag stays pinned for the promised
 * line as well, so a host that stopped passing it is a red suite rather than a
 * refused install nobody sees.
 *
 * The arm is single because the promise is: an arm is added when a further tuple
 * is promised, and no second tuple is. The earlier two-arm shape existed to make
 * a promise spanning `0.2.0` and `0.2.1` admissible under the plain reading; with
 * that promise retired, a second arm would name a tuple nothing is promised on.
 *
 * Retiring the earlier lines is a strengthening, not only a narrowing. Under the
 * two-arm range the retired `0.2.1` alphas were refused by the plain reading but
 * still admitted by the host's flagged one, because the first arm spanned `<2`
 * and so carried every prerelease of that tuple. The single arm floored at
 * `0.2.1-rc.2` refuses them under **both** readings, and refuses `0.2.0-rc.2`
 * under both as well — the line is below the floor and no comparator names its
 * tuple. Both halves are pinned below: the retired lines are refused by the
 * plain reading and by the flagged one, so a later relaxation of the floor is
 * caught here whichever reading it relaxes.
 *
 * The floor also dropped `0.1.7-rc.2`, `0.1.7-rc.1`, `0.1.7-alpha.2` and
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
 * cross-checked against the installed `semver` package on every run, so the
 * hand-rolled path cannot drift away from the real resolution rule.
 *
 * `semver` is a declared devDependency, and the flagged reading cannot be
 * checked without it, so a run that cannot resolve it fails instead of
 * skipping: a skipped assertion is indistinguishable from a passing one, and
 * this file's whole point is the difference between the two readings.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { HOST_LINES, RETIRED_HOST_LINES } from "../scripts/test-host-lines.mjs"

const ROOT = process.cwd()

/**
 * The real `semver` package, resolved from the repository and required.
 *
 * The host's flagged reading (`includePrerelease: true`) is the half of this
 * contract that the hand-rolled `satisfies()` above cannot express, so every
 * assertion about it needs this package. A missing package must therefore fail
 * the run loudly rather than skip the assertion: a skipped assertion passes,
 * and a passing suite that never checked the flagged reading is exactly the
 * regression this resolver exists to make impossible. `semver` is declared in
 * `devDependencies`, so any `npm ci` in this repository provides it.
 */
const requireFromRoot = createRequire(join(ROOT, "package.json"))
function referenceSemver() {
  try {
    return requireFromRoot("semver")
  } catch (error) {
    assert.fail(
      "semver must be resolvable from the repository: the host's flagged reading cannot be checked without it ("
        + (error && error.message ? error.message : String(error)) + ")",
    )
  }
}

/** The admission range promised by the dsh peers: one bounded arm on the one promised tuple. */
const EXPECTED_RANGE = ">=0.2.1-rc.2 <2"

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
 * The truth table the arm must produce, measured against the installed `semver`
 * package under both readings.
 *
 * Every row carries its two expectations as separate literals: `[version,
 * plainExpected, flaggedExpected]`. Neither value is computed from the other.
 * That is deliberate and load-bearing — a rule that derived one side from the
 * other would make the two assertions a single assertion written twice, so a
 * wrong expectation would satisfy both at once, and the table would stop being
 * able to tell the readings apart.
 *
 * `0.2.1-rc.2` sits at true under both readings because the arm's floor names its
 * own tuple and a prerelease in it; `0.2.1` and `1.9.9` sit at true as plain
 * releases above that floor. Every line the promise retired sits at false under
 * both: `0.2.1-rc.1` and the `0.2.1` alphas are prereleases below the floor, so
 * no comparator names their tuple; `0.2.0-rc.2` and `0.2.0` are below the floor
 * and in an earlier tuple, refused for two reasons at once; `0.1.7-rc.2` — a
 * line the promise used to span — is refused too, which is what catches a later
 * lowering of the floor back across it; and `2.0.0` is refused by the `<2`
 * bound alone.
 *
 * Three rows are the rows the two readings *disagree* on — `0.3.0-alpha.1`,
 * `1.9.9-alpha.1` and `0.2.2-alpha.1`, the fourth through sixth entries below —
 * and they are here because that disagreement is the only reason the flag is
 * modelled at all. They are prereleases whose major.minor.patch tuple no
 * comparator names, so the plain reading refuses them and the host's flagged
 * reading admits them. The case below asserts that at least one such row exists,
 * so the table cannot quietly degenerate back into a table where the two
 * readings agree and the flagged side is a copy of the plain one.
 */
const TRUTH_TABLE = [
  ["0.2.1-rc.2", true, true],
  ["0.2.1", true, true],
  ["1.9.9", true, true],
  ["0.3.0-alpha.1", false, true],
  ["1.9.9-alpha.1", false, true],
  ["0.2.2-alpha.1", false, true],
  ["0.2.1-rc.1", false, false],
  ["0.2.0-rc.2", false, false],
  ["0.2.0", false, false],
  ["0.2.1-alpha.1", false, false],
  ["0.2.1-alpha.2", false, false],
  ["0.2.1-alpha.3", false, false],
  ["0.2.1-alpha.4", false, false],
  ["0.2.1-alpha.5", false, false],
  ["0.1.7-rc.2", false, false],
  ["0.1.7-rc.1", false, false],
  ["0.1.7", false, false],
  ["0.1.7-alpha.2", false, false],
  ["0.1.7-alpha.1", false, false],
  ["0.1.6", false, false],
  ["0.1.6-alpha.1", false, false],
  ["2.0.0", false, false],
  ["0.1.5-rc.2", false, false],
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
  // One arm per promised tuple, and no more — and the promise is one tuple, so
  // the range is one arm. What a second arm would do is add a redundant way to
  // admit the promise — the range already admits every release below its `<2`
  // bound, and under the host's flagged reading every prerelease above the
  // floor besides — so the arm count is not a claim about what gets installed.
  // It is the bookkeeping that keeps one named arm per promised tuple, which is
  // what makes the promised line admissible on its own. The tuple count is a
  // Set, so a tuple promising several lines would still carry one arm.
  const arms = EXPECTED_RANGE.split("||")
  const promisedTuples = new Set(Object.values(HOST_LINES).map(line => line.version.split("-")[0]))
  assert.equal(arms.length, promisedTuples.size, "the range does not carry one arm per promised tuple")
  for (const [name, range] of dshPeers) {
    assert.equal(range.split("||").length, arms.length, `${name} disagrees with the promised arm count`)
    // `0.1.7-rc.2` left the promise when the floor rose onto the `0.2.x` tuples,
    // so the line it used to sit below is refused by the arm.
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
  // range still admits the new ordinal. Admission of the promised line by its
  // own arm is asserted separately below, which is where the exact floor matters.
  //
  // The tuples are de-duplicated because the arm rule counts tuples, not rows: a
  // tuple promising two lines would still carry one arm, so comparing a per-arm
  // list against a per-row list would assert a one-arm-per-row rule that the
  // project never held.
  const promisedTuples = [...new Set(promised.map(version => version.split("-")[0]))]
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
  // forgets the flag would apply — must admit the promise on its own: the
  // promised line is named by the arm carrying its own tuple and a prerelease in
  // it, so it depends on no flag. Asserted rather than assumed, because an arm
  // floored a tuple below the promise (as the retired `>=0.2.0-rc.2` arm was)
  // would leave the promised line admitted by the flag alone, and that must turn
  // this case red.
  const reference = referenceSemver()
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
  for (const [name, range] of dshPeers) {
    assert.equal(reference.satisfies("0.3.0-alpha.1", range, { includePrerelease: true }), true, `${name} must admit a higher-tuple prerelease under the flagged reading`)
    assert.equal(satisfies("0.3.0-alpha.1", range), false, `${name} must refuse a higher-tuple prerelease under the plain reading`)
  }
})

test("the peer block keeps cordis and schemastery outside the dsh contract", () => {
  assert.equal(manifest.peerDependencies[CORDIS_PEER], ">=4.0.1 <5")
  assert.equal(manifest.peerDependencies["@deepseek-ai/schemastery"], "^3.18.0")
})

test("every retired line is refused by both readings, not merely by the plain one", () => {
  // Every line the promise ever carried and no longer does — the whole retired
  // set, not just the `0.2.1` ordinals. `0.2.1-rc.1` and `0.2.0-rc.2` belong here
  // for the same reason the alphas do: under the retired two-arm range the
  // flagged reading still admitted them, so they are the lines a widened arm
  // would silently re-admit.
  //
  // This case is the reverse of what it asserted under that two-arm range: there
  // the plain reading refused them while the host's flagged reading still
  // admitted them through the first arm `>=0.2.0-rc.2 <2`, which spanned `<2`.
  // The single arm floored at `0.2.1-rc.2` refuses them under both readings —
  // they are prereleases below the floor and no comparator names their tuple, so
  // the flagged reading has nothing to admit them with. That is a strengthening
  // the single arm bought, and pinning both readings is what keeps it: asserting
  // only the plain half would let a later arm re-admit them under the flag
  // without this suite noticing, and asserting only the flagged half would hide
  // that they are refused at install time rather than merely unsupported.
  //
  // Both readings are pinned for every retired line, and the set itself is
  // pinned by `tests/host-lines.test.mjs`, so a line cannot drop out of this loop
  // by dropping out of the list.
  const retired = RETIRED_HOST_LINES
  const reference = referenceSemver()
  for (const version of retired) {
    assert.equal(satisfies(version, EXPECTED_RANGE), false, `${version} must stay out of the plain reading`)
    for (const [name, range] of dshPeers) {
      assert.equal(satisfies(version, range), false, `${name} must refuse ${version} under the plain reading`)
      assert.equal(reference.satisfies(version, range), false, `${name}: semver must refuse ${version} under the plain reading`)
      assert.equal(
        reference.satisfies(version, range, { includePrerelease: true }),
        false,
        `${name} must also refuse ${version} under the host's flagged reading; the single arm floored at 0.2.1-rc.2 names no comparator for a lower prerelease, so a true here means the arm was widened back across the tuple`,
      )
    }
  }
  // The reason the flagged reading refuses them: the only arm floors at
  // `0.2.1-rc.2`, above every retired ordinal, and `<2` cannot pull a candidate
  // back above a floor it fails. Pinned on the arm itself so the cause is stated
  // rather than inferred from the whole range.
  const onlyArm = EXPECTED_RANGE.trim()
  for (const version of retired) {
    assert.equal(
      reference.satisfies(version, onlyArm, { includePrerelease: true }),
      false,
      `the only arm ${onlyArm} is expected to be the reason ${version} is refused under the flagged reading`,
    )
  }
})

test("every promised line is admitted by every peer under the host's reading", () => {
  const reference = referenceSemver()
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
  // Both readings are pinned for every row, and each row states its two
  // expectations as separate literals. Nothing is derived from the other side:
  // the plain half runs through the hand-rolled `satisfies()`, and the flagged
  // half needs the real package, because the flag's effect (a prerelease
  // admitted without a comparator naming its tuple) is the one rule the
  // hand-rolled path deliberately does not model.
  //
  // Both halves are load-bearing for different failures. The plain half catches
  // an arm that stopped naming the promised tuple; the flagged half catches an
  // arm widened back across a retired tuple, which the plain reading alone would
  // not see — a floor moved to `>=0.2.1-rc.1 <2` re-admits `0.2.1-rc.1` under the
  // flag while leaving it refused by the plain reading.
  const reference = referenceSemver()
  // The table must keep at least one row where the two readings disagree.
  // Without such a row the flagged side is a restatement of the plain side and
  // could not catch a flag-only admission even in principle.
  const disagreements = TRUTH_TABLE.filter(([, plain, flagged]) => plain !== flagged)
  assert.ok(
    disagreements.length > 0,
    "the truth table carries no row where the plain and flagged readings disagree; the flagged side would be a copy of the plain one",
  )
  for (const [version, plainExpected, flaggedExpected] of TRUTH_TABLE) {
    for (const [name, range] of dshPeers) {
      assert.equal(satisfies(version, range), plainExpected, `${name} must ${plainExpected ? "admit" : "refuse"} ${version} under the plain reading`)
      assert.equal(
        reference.satisfies(version, range, { includePrerelease: true }),
        flaggedExpected,
        `${name} must ${flaggedExpected ? "admit" : "refuse"} ${version} under the host's flagged reading`,
      )
    }
  }
  // The retired `0.1.7-alpha.2` sentinel stays refused by every peer, which is
  // the row-level check the table above already carries as `0.1.7-alpha.2` false.
  for (const [name, range] of dshPeers) {
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
    for (const version of ["0.2.1", "0.2.2", "1.0.0", "1.9.9"]) {
      assert.equal(satisfies(version, range), true, `${name} must admit ${version}`)
    }
    // `0.2.0` is a release below the floor, so it is refused along with the
    // prereleases under it: the floor sits at `0.2.1-rc.2`, and nothing in the
    // retired `0.2.0` tuple is above that.
    for (const version of ["0.2.0", "0.1.9", "0.1.7-rc.2", "0.1.4", "0.1.4-rc.9", "1.9.9-alpha.1", "2.0.0"]) {
      assert.equal(satisfies(version, range), false, `${name} must refuse ${version}`)
    }
  }
})

test("the local satisfaction check agrees with the installed semver package", () => {
  const reference = referenceSemver()
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
