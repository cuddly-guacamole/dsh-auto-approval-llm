/**
 * Host-line contract: exactly one line is promised — the `0.2.0-rc.2` line the
 * user actually runs, which carries the modern shape (`catalog` +
 * `registerAuto`) and is driven through the same-signature migration. One line
 * per tuple, appended when upstream enters a new tuple's alpha. The peer range
 * is an installation-admission surface, not a support claim, so the promise
 * lives here in `HOST_LINES` and nowhere else. This file pins the promised
 * table, the exact version pinning, the reverse controls that make a wrong-tree
 * acceptance impossible, and the shipped preset composition. The last case
 * drives the locally installed host line through the real permission-presets
 * service, so the harness itself cannot rot into a pure fake.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  FOREIGN_HOST_LINE,
  GATED_PRESET,
  HOST_LINES,
  ROOT,
  assertCapability,
  assertInstalledLine,
  assertLineOutcome,
  assertTreeLine,
  dshPeers,
  installedVersions,
  mustReject,
  packageEntry,
  presetTableFromPatch,
  probeInstalledLine,
  scratchManifest,
} from "../scripts/test-host-lines.mjs"

const patch = readFileSync(join(ROOT, "cordis.patch.yml"), "utf8")

/**
 * A host line the promise no longer covers — the retired `0.1.5-rc.2` line,
 * whose probe reads `unknown` / `unrecognized-shape` (measured on the real
 * install tree). It is deliberately not a row of `HOST_LINES`; it survives here
 * as the control for the inert branch of `assertLineOutcome`, so that branch
 * stays falsifiable after the promise was narrowed to the lines the user runs.
 * The line the live reverse controls use is `FOREIGN_HOST_LINE`.
 */
const INERT_CONTROL_LINE = { version: "0.1.5-rc.2", capability: "unknown" }

/** The key each promised tuple is addressed by, so a drift between them is a failure. */
const KEY_OF_TUPLE = { "0.2.0": "line020" }

test("the promised line table carries the line the user runs", () => {
  assert.deepEqual(Object.keys(HOST_LINES).sort(), ["line020"])
  assert.equal(HOST_LINES.line020.version, "0.2.0-rc.2")
  assert.equal(HOST_LINES.line020.capability, "modern")
})

test("the promise spans one line per tuple, and every key names its own tuple", () => {
  // The key convention is the line family, so the next ordinal inside a tuple
  // cannot collide with a row that already exists: the tuple is what keeps the
  // table addressable, and `version` already carries the ordinal. A row in a
  // tuple with no key of its own would be unaddressable from the CLI, so the
  // mapping below is closed rather than a lookup that silently misses.
  const tuples = Object.values(HOST_LINES).map(line => line.version.split("-")[0])
  assert.equal(new Set(tuples).size, tuples.length, "a tuple is promised on more than one line")
  for (const [key, line] of Object.entries(HOST_LINES)) {
    const tuple = line.version.split("-")[0]
    assert.equal(KEY_OF_TUPLE[tuple], key, "the key " + key + " does not name the tuple of " + line.version)
  }
  assert.deepEqual(Object.keys(HOST_LINES).sort(), Object.values(KEY_OF_TUPLE).sort(), "the table and the key convention disagree")
})

test("the foreign line used by the reverse controls is not a registered line", () => {
  assert.equal(Object.values(HOST_LINES).some(row => row.version === FOREIGN_HOST_LINE.version), false)
  for (const line of Object.values(HOST_LINES)) {
    assert.notEqual(line.version, FOREIGN_HOST_LINE.version)
    assert.notEqual(line.capability, FOREIGN_HOST_LINE.capability)
  }
  assert.equal(Object.values(HOST_LINES).some(row => row.version === INERT_CONTROL_LINE.version), false)
})

test("every declared dsh peer is pinned exactly on the promised line", () => {
  const peers = dshPeers()
  assert.ok(peers.length > 0, "the manifest declares no dsh peer")
  for (const line of Object.values(HOST_LINES)) {
    const manifest = scratchManifest(line, peers)
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), peers.slice().sort())
    assert.deepEqual(manifest.dependencies, manifest.overrides)
    for (const name of peers) assert.equal(manifest.dependencies[name], line.version)
  }
})

test("a transitively floated dsh package is pinned by an override only", () => {
  const peers = dshPeers()
  const floated = "@deepseek-ai/dsh-agent"
  for (const line of Object.values(HOST_LINES)) {
    const manifest = scratchManifest(line, peers, [floated])
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), peers.slice().sort())
    assert.equal(manifest.dependencies[floated], undefined)
    assert.equal(manifest.overrides[floated], line.version)
    for (const name of peers) assert.equal(manifest.overrides[name], line.version)
  }
})

test("the installed-tree check rejects a foreign line and an empty tree", () => {
  for (const line of Object.values(HOST_LINES)) {
    const good = {
      "@deepseek-ai/cordis": "4.0.3",
      "@deepseek-ai/dsh-llm": line.version,
      "@deepseek-ai/dsh-session": line.version,
    }
    assert.deepEqual(assertInstalledLine(line, good), [
      "@deepseek-ai/dsh-llm@" + line.version,
      "@deepseek-ai/dsh-session@" + line.version,
    ].sort())
    // Every line the promise does not cover — the inert one, the foreign
    // sentinel, and any other promised line — must be refused by the tree
    // check, not merely unlisted: a tree on a different promised line is still
    // the wrong tree for the line under test.
    const notThis = [INERT_CONTROL_LINE.version, FOREIGN_HOST_LINE.version]
      .concat(Object.values(HOST_LINES).filter(row => row.version !== line.version).map(row => row.version))
    for (const other of notThis) {
      mustReject("a tree on " + other + " checked against " + line.version, () => assertInstalledLine(line, { "@deepseek-ai/dsh-session": other }))
    }
    mustReject("a tree with no dsh package", () => assertInstalledLine(line, { "@deepseek-ai/cordis": "4.0.3" }))
  }
})

test("the npm-tree check rejects problems and nested foreign copies", () => {
  const line = HOST_LINES.line020
  const good = { dependencies: { "@deepseek-ai/dsh-session": { version: line.version } } }
  assert.deepEqual(assertTreeLine(line, good), ["@deepseek-ai/dsh-session@" + line.version])
  const nested = {
    dependencies: {
      "@deepseek-ai/dsh-tools": {
        version: line.version,
        dependencies: { "@deepseek-ai/dsh-session": { version: FOREIGN_HOST_LINE.version } },
      },
    },
  }
  mustReject("a nested copy on a foreign line", () => assertTreeLine(line, nested))
  mustReject("an npm problem list", () => assertTreeLine(line, { problems: ["extraneous: @deepseek-ai/dsh-llm"], dependencies: good.dependencies }))
  mustReject("an empty npm tree", () => assertTreeLine(line, { dependencies: {} }))
  // A nested copy on the other promised line is a foreign copy for this one.
  for (const other of Object.values(HOST_LINES)) {
    if (other.version === line.version) continue
    mustReject("a nested copy on the other promised line " + other.version, () => assertTreeLine(line, {
      dependencies: { "@deepseek-ai/dsh-tools": { version: line.version, dependencies: { "@deepseek-ai/dsh-session": { version: other.version } } } },
    }))
  }
})

test("the capability check rejects the retired legacy reading", () => {
  assert.equal(assertCapability(HOST_LINES.line020, "modern"), "modern")
  mustReject("a legacy reading on the promised line", () => assertCapability(HOST_LINES.line020, "legacy"))
  for (const line of Object.values(HOST_LINES)) assert.notEqual(line.capability, "legacy")
  // `legacy` is the reading the shipped probe never returns (it answers `modern`
  // or `unknown`), so the rejection above cannot be satisfied by a value some
  // host would actually produce. The sentinel carries exactly that reading.
  assert.equal(FOREIGN_HOST_LINE.capability, "legacy")
  assert.equal(assertCapability(FOREIGN_HOST_LINE, "legacy"), "legacy")
})

test("a line's capability field is load-bearing in both directions", () => {
  for (const line of Object.values(HOST_LINES)) {
    mustReject(line.version + " re-read as inert", () => assertCapability(line, "unknown"))
    mustReject(line.version + " re-read as the retired legacy shape", () => assertCapability(line, "legacy"))
    mustReject(line.version + " re-read as a capability nobody returns", () => assertCapability(line, "modern-typo"))
  }
  // The promise is a single line, so there is no second promised reading left
  // for the sentinel to be refused against; the loop above already walked every
  // promised line, and a table whose capability drifted onto the sentinel's
  // `legacy` reading — which would make the control below pass vacuously — is
  // refused by the `assert.notEqual` in the "not a registered line" case.
  mustReject("the foreign sentinel read as the promised reading", () => assertCapability(FOREIGN_HOST_LINE, HOST_LINES.line020.capability))
})

/**
 * The observations an inert line must produce, mirrored from a live run of the
 * harness against the retired `0.1.5-rc.2` tree: the probe reads `unknown` /
 * `unrecognized-shape`, the gate name set
 * stays the plugin's own preset, the same-signature session is skipped without
 * a single audit write, `auto` is not gated and the dfa+never session is
 * skipped too.
 */
function inertObservations(line) {
  return {
    capability: line.capability,
    reason: "unrecognized-shape",
    gateNames: [GATED_PRESET],
    outcome: "skipped",
    audits: [],
    state: { preset: "auto", sandbox: "danger-full-access", approval: "ask" },
    current: "auto",
    gatedBefore: false,
    gatedAfter: false,
    neverOutcome: "skipped",
    neverState: { preset: "auto", approval: "never" },
  }
}

test("an inert line loads, gates nothing and writes nothing", () => {
  const line = INERT_CONTROL_LINE
  assert.equal(line.capability, "unknown")
  assert.equal(assertLineOutcome(line, inertObservations(line)).outcome, "skipped")
  mustReject("an inert line that migrated", () => assertLineOutcome(line, { ...inertObservations(line), outcome: "migrated" }))
  mustReject("an inert line that wrote an audit line", () => assertLineOutcome(line, { ...inertObservations(line), audits: ["preset-migration"] }))
  mustReject("an inert line that moved the session", () => assertLineOutcome(line, { ...inertObservations(line), state: { preset: GATED_PRESET, sandbox: "danger-full-access", approval: "ask" } }))
  mustReject("an inert line that gated auto", () => assertLineOutcome(line, { ...inertObservations(line), gatedAfter: true }))
  mustReject("an inert line read as the reserved shape", () => assertLineOutcome(line, { ...inertObservations(line), reason: "legacy-but-reserved-shape" }))
  mustReject("an inert line that widened its gate names", () => assertLineOutcome(line, { ...inertObservations(line), gateNames: [GATED_PRESET, "auto"] }))
  mustReject("a line that gates the legacy identity", () => assertLineOutcome(line, { ...inertObservations(line), gatedBefore: true }))
  mustReject("an inert line re-read as modern", () => assertLineOutcome(line, { ...inertObservations(line), capability: "modern" }))
  for (const promised of Object.values(HOST_LINES)) {
    mustReject(promised.version + " reported inert", () => assertLineOutcome(promised, inertObservations(promised)))
    // The three controls the live harness also runs per line, offline: a widened
    // gate set, a session left on the legacy preset, and a migration that
    // reported no work. A promised line that produced any of them must be red.
    mustReject(promised.version + " with a widened gate name set", () => assertLineOutcome(promised, { ...inertObservations(promised), gateNames: [GATED_PRESET, "auto"], capability: promised.capability, outcome: "migrated", state: { preset: GATED_PRESET, sandbox: "danger-full-access", approval: "ask" }, current: GATED_PRESET }))
    mustReject(promised.version + " left on the legacy preset", () => assertLineOutcome(promised, { ...inertObservations(promised), capability: promised.capability, outcome: "migrated", state: { preset: "auto", sandbox: "danger-full-access", approval: "ask" }, current: GATED_PRESET }))
    mustReject(promised.version + " reporting no migration work", () => assertLineOutcome(promised, { ...inertObservations(promised), capability: promised.capability }))
  }
})

test("the preset table is read from the shipped composition", () => {
  const table = presetTableFromPatch(patch)
  assert.deepEqual(Object.keys(table), ["read-only", "workspace-write", "auto-approval", "danger-full-access"])
  assert.equal(table["auto-approval"].sandbox, "danger-full-access")
  assert.equal(table["auto-approval"].approval, "ask")
  assert.equal(table["auto-approval"].name, "Auto approval")
  assert.equal(table["danger-full-access"].sandbox, "danger-full-access")
  assert.equal(table["danger-full-access"].approval, "never")
  assert.equal(typeof table["auto-approval"].description, "string")
})

test("the locally installed host line drives the real service", async () => {
  const versions = installedVersions(ROOT)
  const local = versions["@deepseek-ai/dsh-permission-presets"]
  assert.ok(local !== undefined, "no @deepseek-ai/dsh-permission-presets is installed in the checkout")
  const line = Object.values(HOST_LINES).find(row => row.version === local)
  assert.ok(line !== undefined, "the installed dsh-permission-presets line is not promised: " + local)
  const observed = await probeInstalledLine({
    line,
    contextEntry: packageEntry(ROOT, "@deepseek-ai/cordis"),
    serviceEntry: packageEntry(ROOT, "@deepseek-ai/dsh-permission-presets"),
    migrationEntry: join(ROOT, "lib", "auto", "preset-migration.js"),
    presetTable: presetTableFromPatch(patch),
  })
  assert.equal(observed.capability, line.capability)
  assert.equal(observed.outcome, "migrated")
  assert.equal(observed.neverOutcome, "skipped")
  assert.deepEqual([...observed.gateNames], ["auto-approval"])
})
