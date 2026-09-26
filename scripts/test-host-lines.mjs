#!/usr/bin/env node
// Re-runnable entry for the promised host lines. Each line is installed into a
// scratch prefix under os.tmpdir() and driven through the shipped migration
// decision layer against the real permission-presets service of that exact
// line. Every installed dsh-* must equal the requested version and the observed
// capability must equal the line expectation, so a prefix that resolved the
// wrong line goes red instead of certifying itself. A line the plugin does not
// take over is registered as inert and asserts exactly that: it loads there,
// gates nothing and writes nothing. The checkout node_modules is never touched.
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const LF = String.fromCharCode(10)
const CR = String.fromCharCode(13)

/** The plugin's own preset name; the shipped patch composes it and only it. */
export const GATED_PRESET = "auto-approval"

/** The legacy `auto` preset name; on a modern host it belongs to the upstream integration. */
const LEGACY_AUTO_PRESET = "auto"

/**
 * One row per promised host line. The entry asserts the version exactly and
 * states the capability the probe must read on that line: a `modern` line
 * carries the reserved `auto` surface and is driven through the migration,
 * while any other reading means the plugin is registered there as inert — the
 * entry then asserts that nothing is gated and nothing is written.
 *
 * Exactly one line is promised: the host the user actually runs. A further line
 * is appended only when upstream enters the alpha of a new tuple.
 */
export const HOST_LINES = {
  rc2: { version: "0.1.7-rc.2", capability: "modern" },
}

/**
 * A counterfactual line the live reverse controls assert against. It is
 * deliberately NOT a row of `HOST_LINES`: it promises nothing and is never
 * installed. It carries the two readings a promised line can never carry — a
 * version off the line and the retired `legacy` capability — so asserting it
 * against a tree that does sit on the promised line must throw. Keeping it
 * outside the table is what lets the reverse controls stay live while the
 * promise stays a single line.
 */
export const FOREIGN_HOST_LINE = { version: "0.1.7-alpha.2", capability: "legacy" }

/** The reason an inert line reads: no reserved `auto` surface, nothing recognisable. */
const INERT_CAPABILITY_REASON = "unrecognized-shape"

/** Decision-layer exports the probe drives; a module that loads without them is not this build. */
const MIGRATION_SURFACE = ["detectHostCapability", "gatePresetNames", "isGatedSession", "runPresetMigration", "safeResolveSpec"]

/** The dsh packages this plugin declares as host peers, read from the manifest. */
export function dshPeers(root = ROOT) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  return Object.keys(manifest.peerDependencies || {}).filter(name => name.startsWith("@deepseek-ai/dsh-"))
}

/**
 * The scratch manifest: exact versions for every declared peer, plus the same
 * versions as overrides. `extraPins` adds overrides only — a transitive
 * `dsh-*` that resolved above the line (the registry can publish a newer
 * prerelease inside the same tuple) is pinned without becoming a dependency.
 */
export function scratchManifest(line, peers = dshPeers(), extraPins = []) {
  const pinned = Object.fromEntries(peers.map(name => [name, line.version]))
  const overrides = Object.fromEntries([...new Set([...peers, ...extraPins])].map(name => [name, line.version]))
  return { name: "dsh-host-line-scratch", private: true, type: "module", dependencies: pinned, overrides }
}

/** name -> version for every top-level @deepseek-ai package in a prefix. */
export function installedVersions(app) {
  const scope = join(app, "node_modules", "@deepseek-ai")
  const versions = {}
  if (!existsSync(scope)) return versions
  for (const name of readdirSync(scope)) {
    const manifest = join(scope, name, "package.json")
    if (!existsSync(manifest)) continue
    versions["@deepseek-ai/" + name] = JSON.parse(readFileSync(manifest, "utf8")).version
  }
  return versions
}

/** Assert the whole installed dsh-* family sits on one line. Throws otherwise. */
export function assertInstalledLine(line, installed) {
  const seen = []
  for (const name of Object.keys(installed)) {
    if (!name.startsWith("@deepseek-ai/dsh-")) continue
    if (installed[name] !== line.version) throw new Error("host line " + line.version + ": " + name + " is installed at " + installed[name])
    seen.push(name + "@" + installed[name])
  }
  if (seen.length === 0) throw new Error("host line " + line.version + ": no @deepseek-ai/dsh-* package was installed")
  return seen.sort()
}

/** Assert the observed capability is the line expectation. Throws otherwise. */
export function assertCapability(line, capability) {
  if (capability !== line.capability) throw new Error("host line " + line.version + ": capability is " + capability + ", expected " + line.capability)
  return capability
}

/**
 * Assert the observations a line must produce.
 *
 * A `modern` line carries the reserved `auto` surface, so the same-signature
 * session must migrate onto the plugin's own preset. A line whose capability
 * probe reads anything else is inert by construction — the plugin loads there,
 * gates nothing and writes nothing — so that same session must stay exactly
 * where the host left it. Both readings share this one check so the reverse
 * controls in tests/host-lines.test.mjs can falsify either of them.
 */
export function assertLineOutcome(line, observed) {
  const prefix = "host line " + line.version + ": "
  if (observed.capability !== line.capability)
    throw new Error(prefix + "capability is " + observed.capability + ", expected " + line.capability)
  if (observed.gateNames.length !== 1 || observed.gateNames[0] !== GATED_PRESET)
    throw new Error(prefix + "gate names are " + JSON.stringify(observed.gateNames) + ", expected " + JSON.stringify([GATED_PRESET]))
  if (observed.neverOutcome !== "skipped" || observed.neverState.preset !== LEGACY_AUTO_PRESET || observed.neverState.approval !== "never")
    throw new Error(prefix + "dfa+never changed (" + observed.neverOutcome + " / " + JSON.stringify(observed.neverState) + ")")
  if (observed.gatedBefore !== false)
    throw new Error(prefix + "the legacy auto identity is gated: isGatedSession(\"auto\") = " + observed.gatedBefore)
  if (line.capability === "modern") {
    if (observed.outcome !== "migrated")
      throw new Error(prefix + "same-signature migration returned " + observed.outcome + " (" + observed.audits.join(" | ") + ")")
    if (observed.state.preset !== GATED_PRESET || observed.state.sandbox !== "danger-full-access" || observed.state.approval !== "ask")
      throw new Error(prefix + "migrated state is " + JSON.stringify(observed.state))
    if (observed.current !== GATED_PRESET) throw new Error(prefix + "current() reads " + observed.current)
    return observed
  }
  if (observed.reason !== INERT_CAPABILITY_REASON)
    throw new Error(prefix + "an inert line read reason " + observed.reason + ", expected " + INERT_CAPABILITY_REASON)
  if (observed.outcome !== "skipped")
    throw new Error(prefix + "an inert line must not migrate; the same-signature run returned " + observed.outcome)
  if (observed.audits.length !== 0)
    throw new Error(prefix + "an inert line wrote " + observed.audits.length + " audit line(s): " + observed.audits.join(" | "))
  if (observed.state.preset !== LEGACY_AUTO_PRESET || observed.state.sandbox !== "danger-full-access" || observed.state.approval !== "ask")
    throw new Error(prefix + "an inert line moved the session to " + JSON.stringify(observed.state))
  if (observed.gatedAfter !== false)
    throw new Error(prefix + "an inert line left isGatedSession(\"auto\") = " + observed.gatedAfter)
  return observed
}

/** Run a check that must throw. Used for the live reverse controls. */
export function mustReject(what, check) {
  try {
    check()
  } catch {
    return true
  }
  throw new Error("reverse control failed: " + what + " was accepted")
}

/**
 * Whether an npm tree node is an optional peer that was simply not installed.
 * npm renders such a node as an empty object: no `version` and, unlike a real
 * resolution or installation failure, no `problem` either. The conjunction is
 * deliberate — a node that carries a `problem` is a genuine failure and must
 * never be skipped, a node that carries a `version` is a resolved copy that
 * must still be checked against the line, and a node that is not a plain
 * dependency object is malformed input rather than npm's own rendering. The
 * fields are read defensively because the raw JSON is external input.
 */
function isUninstalledOptionalPeer(entry) {
  if (entry === undefined || entry === null || typeof entry !== "object" || Array.isArray(entry)) return false
  return entry.version === undefined && entry.problem === undefined
}

/**
 * Every @deepseek-ai/dsh-* version in an npm ls tree. Throws when a copy sits
 * on another line or when npm reports problems, so a nested duplicate cannot
 * hide behind a clean top level (npm ls exits 0 for pure-extraneous trees). An
 * uninstalled optional peer contributes no copy to the line, so it is skipped
 * rather than read as a copy of "undefined"; its own dependencies are still
 * walked, and everything else keeps the exact-match rule.
 */
export function assertTreeLine(line, tree) {
  const problems = Array.isArray(tree && tree.problems) ? tree.problems : []
  if (problems.length > 0) throw new Error("host line " + line.version + ": npm reported problems: " + problems.slice(0, 3).join(" | "))
  const seen = []
  const walk = deps => {
    if (deps === undefined || deps === null) return
    for (const name of Object.keys(deps)) {
      const entry = deps[name]
      if (name.startsWith("@deepseek-ai/dsh-") && !isUninstalledOptionalPeer(entry)) {
        const version = entry && entry.version
        if (version !== line.version) throw new Error("host line " + line.version + ": " + name + " resolves to " + version + " somewhere in the tree")
        seen.push(name + "@" + version)
      }
      walk(entry && entry.dependencies)
    }
  }
  walk(tree && tree.dependencies)
  if (seen.length === 0) throw new Error("host line " + line.version + ": the npm tree carries no @deepseek-ai/dsh-* package")
  return seen.sort()
}

/** Assert the full installed prefix tree is one line and problem free. */
function assertNpmTree(app, line) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm"
  let raw
  try {
    raw = execFileSync(npm, ["ls", "--all", "--json"], { cwd: app, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" })
  } catch (error) {
    raw = error && error.stdout
  }
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new Error("host line " + line.version + ": npm ls emitted nothing; the prefix is not inspectable")
  }
  let tree
  try {
    tree = JSON.parse(String(raw))
  } catch {
    throw new Error("host line " + line.version + ": npm ls emitted no parseable JSON")
  }
  return assertTreeLine(line, tree)
}

/** The shipped preset composition, read from cordis.patch.yml instead of restated. */
export function presetTableFromPatch(patch) {
  const table = {}
  let inPresets = false
  let current = null
  for (const raw of patch.split(LF)) {
    const line = raw.endsWith(CR) ? raw.slice(0, -1) : raw
    const body = line.trim()
    if (body === "" || body.startsWith("#")) continue
    const indent = line.length - line.trimStart().length
    if (indent === 4 && body === "presets:") { inPresets = true; current = null; continue }
    if (!inPresets) continue
    if (indent <= 4) { inPresets = false; current = null; continue }
    if (indent === 6 && body.endsWith(":")) { current = body.slice(0, -1); table[current] = {}; continue }
    if (indent === 8 && current !== null) {
      const at = body.indexOf(":")
      if (at <= 0) continue
      const key = body.slice(0, at)
      const value = body.slice(at + 1).trim()
      if (key === "sandbox" || key === "approval" || key === "name" || key === "description") table[current][key] = value
    }
  }
  return table
}

/** Resolve the ESM entry of an installed package from its own manifest. */
export function packageEntry(app, name) {
  const dir = join(app, "node_modules", ...name.split("/"))
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
  const exported = manifest.exports && manifest.exports["."]
  const rel = typeof exported === "string" ? exported : (exported && (exported.default || exported.import)) || manifest.main || "index.js"
  return join(dir, rel.replace(/^\.\//, ""))
}

/** Drive one installed line through the real service and the shipped decision layer. */
export async function probeInstalledLine({ line, contextEntry, serviceEntry, migrationEntry, presetTable }) {
  const { Context } = await import(pathToFileURL(contextEntry).href)
  const { PermissionPresetService } = await import(pathToFileURL(serviceEntry).href)
  const migration = await import(pathToFileURL(migrationEntry).href)
  if (typeof Context !== "function") throw new Error("host line " + line.version + ": cordis exports no Context")
  if (typeof PermissionPresetService !== "function") throw new Error("host line " + line.version + ": permission-presets exports no service class")
  const ctx = new Context()
  const captured = {}
  ctx.provide("shell", { sandboxMode: "workspace-write" })
  ctx.provide("approval", { config: { policy: "ask" }, setPolicy() {}, setPolicyForInitialization() {} })
  ctx.provide("sessions", { list: () => [] })
  ctx.provide("events", { dispatch: () => [] })
  ctx.provide("sessionProjections", {
    register(unit) { captured.projection = unit },
    stateOf(session) {
      if (captured.projection === undefined) throw new Error("permissions projection was never registered")
      let state = captured.projection.init()
      for (const event of session.events) state = captured.projection.apply(state, event)
      return state
    },
  })
  ctx.plugin(PermissionPresetService, { presets: presetTable, defaultPreset: GATED_PRESET })
  for (let attempt = 0; attempt < 100 && ctx.permissionPresets === undefined; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  const service = ctx.permissionPresets
  if (service === undefined) throw new Error("host line " + line.version + ": permission-presets did not register")

  const missing = MIGRATION_SURFACE.filter(name => typeof migration[name] !== "function")
  if (missing.length > 0) throw new Error("host line " + line.version + ": the compiled decision layer loaded without " + missing.join(", "))

  const capability = migration.detectHostCapability(service)
  assertCapability(line, capability.capability)
  const gateNames = [...migration.gatePresetNames(capability.capability)]
  const target = migration.safeResolveSpec(service, GATED_PRESET)
  if (target === undefined || target.sandbox !== "danger-full-access" || target.approval !== "ask")
    throw new Error("host line " + line.version + ": " + GATED_PRESET + " resolved to " + JSON.stringify(target))

  const makeSession = events => ({ id: "host-line-1", events, append(type, data) { this.events.push({ type, data }) } })
  const audits = []
  const deps = {
    permissionPresets: service,
    capability: capability.capability,
    append: (session, type, data) => session.append(type, data),
    audit: entry => audits.push(entry),
    warn: message => audits.push(JSON.stringify({ warn: message })),
  }
  const rescue = makeSession([
    { type: "permission/preset", data: { preset: LEGACY_AUTO_PRESET } },
    { type: "sandbox/mode", data: { mode: "danger-full-access" } },
    { type: "approval/policy", data: { policy: "ask" } },
  ])
  // The gate predicate on the legacy identity itself, read before anything runs.
  const gatedBefore = migration.isGatedSession(service, rescue, gateNames)
  const outcome = migration.runPresetMigration(rescue, deps)
  // Read the audit writes of the same-signature run before the second session
  // runs, so "wrote nothing" is measured on that run alone.
  const rescueAudits = audits.slice()
  const state = service.permissionState(rescue)
  const current = service.current(rescue)
  const gatedAfter = migration.isGatedSession(service, rescue, gateNames)

  const never = makeSession([
    { type: "permission/preset", data: { preset: LEGACY_AUTO_PRESET } },
    { type: "sandbox/mode", data: { mode: "danger-full-access" } },
    { type: "approval/policy", data: { policy: "never" } },
  ])
  const neverOutcome = migration.runPresetMigration(never, deps)
  const neverState = service.permissionState(never)

  const observed = {
    capability: capability.capability,
    reason: capability.reason,
    gateNames,
    outcome,
    audits: rescueAudits,
    state,
    current,
    gatedBefore,
    gatedAfter,
    neverOutcome,
    neverState,
  }
  assertLineOutcome(line, observed)
  return observed
}

/** Install one line into a scratch prefix and drive it. Returns the observations. */
export async function runLine(key, options = {}) {
  const line = HOST_LINES[key]
  if (line === undefined) throw new Error("unknown host line " + key + " (known: " + Object.keys(HOST_LINES).join(", ") + ")")
  if (!existsSync(join(ROOT, "lib", "auto", "preset-migration.js"))) throw new Error("lib/ is not built; run npm test or npx tsc first")
  const app = mkdtempSync(join(tmpdir(), "dsh-host-line-" + key + "-"))
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm"
    const install = () => execFileSync(npm, ["install", "--no-audit", "--no-fund"], { cwd: app, stdio: "inherit", shell: process.platform === "win32" })
    writeFileSync(join(app, "package.json"), JSON.stringify(scratchManifest(line), null, 2))
    install()
    // A transitive dsh-* can resolve above the line when the registry publishes a
    // newer prerelease of the same tuple; pin every floated name and install
    // again so the whole tree lands on the requested line.
    const floated = Object.entries(installedVersions(app))
      .filter(([name, version]) => name.startsWith("@deepseek-ai/dsh-") && version !== line.version)
      .map(([name]) => name)
    if (floated.length > 0) {
      writeFileSync(join(app, "package.json"), JSON.stringify(scratchManifest(line, dshPeers(), floated), null, 2))
      install()
    }
    const versions = installedVersions(app)
    const packages = assertInstalledLine(line, versions)
    assertNpmTree(app, line)
    const other = FOREIGN_HOST_LINE
    mustReject("the foreign host line", () => assertInstalledLine(other, versions))
    cpSync(join(ROOT, "lib"), join(app, "lib"), { recursive: true })
    const observed = await probeInstalledLine({
      line,
      contextEntry: packageEntry(app, "@deepseek-ai/cordis"),
      serviceEntry: packageEntry(app, "@deepseek-ai/dsh-permission-presets"),
      migrationEntry: join(app, "lib", "auto", "preset-migration.js"),
      presetTable: presetTableFromPatch(readFileSync(join(ROOT, "cordis.patch.yml"), "utf8")),
    })
    mustReject("the foreign capability", () => assertCapability(other, observed.capability))
    return Object.assign({ key, version: line.version, packages: packages.length }, observed)
  } finally {
    if (options.keep === true) process.stdout.write("kept " + app + LF)
    else rmSync(app, { recursive: true, force: true })
  }
}

export function parseArgs(argv) {
  const options = { lines: Object.keys(HOST_LINES), keep: false, help: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--line") {
      const value = argv[++index]
      options.lines = value === "all" ? Object.keys(HOST_LINES) : [value]
    } else if (arg === "--keep") options.keep = true
    else if (arg === "--help") options.help = true
    else throw new Error("unknown argument " + arg)
  }
  return options
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write("usage: node scripts/test-host-lines.mjs [--line " + Object.keys(HOST_LINES).join("|") + "|all] [--keep]" + LF)
  } else {
    for (const key of options.lines) {
      const result = await runLine(key, { keep: options.keep })
      process.stdout.write(result.key + ": " + result.version + " -> " + result.capability + " (" + result.reason + "); " + result.packages + " dsh packages; migration " + result.outcome + "; dfa+never " + result.neverOutcome + "; gated[auto] " + result.gatedBefore + "->" + result.gatedAfter + "; " + result.audits.length + " audit lines" + LF)
    }
  }
}
