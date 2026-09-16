/**
 * dsh-auto-approval-llm · session workspace as a development zone.
 *
 * The plugin install root is a constant opening; a session whose workspace is
 * another plugin repo under DSH_HOME/plugins had none, so structured write/edit
 * and shell writes were all hard-denied. The workspace now joins the constant
 * development zones when it is one plugin repo directly under the plugins
 * root, and the shell fuse extends the same structural rule
 * (zoneOpeningTrusted) to it. The plugins root itself, deeper paths, operator
 * trees and every other DSH_HOME tree stay fenced, and the workspace keeps the
 * execution-code / contract / runtime-state denies.
 *
 * Run: node --test tests/dev-zone-workspace-opening.test.mjs
 */
import test from "node:test"
import assert from "node:assert/strict"
import { devZoneRootsFor, isGrantedDevZoneTarget, normalizePath } from "../lib/auto/paths.js"
import { assessTool, hardDenyReason } from "../lib/auto/policy.js"
import { hardDenyShellReason } from "../lib/auto/shell.js"

const SELF = process.cwd().split(String.fromCharCode(92)).join("/")
const USERROOT = "C:/Users/u"
const DSH_HOME = `${USERROOT}/.dsh`
const OTHER = `${DSH_HOME}/plugins/other-plugin`
const OPERATOR = `${DSH_HOME}/opened`
const artifacts = { has: () => false, plan: () => {} }
const norm = (p) => normalizePath(p, DSH_HOME, USERROOT)
const rootsFor = (workspace, openings = []) => {
  const devZoneRoots = devZoneRootsFor(workspace, DSH_HOME, USERROOT)
  return {
    workspace,
    home: USERROOT,
    dshHome: DSH_HOME,
    tempRoots: [],
    trustedDirs: [],
    devZoneRoots,
    allowedDshSubpaths: [...devZoneRoots, ...openings],
    maintenanceDshPaths: [],
    mode: "aggressive",
  }
}
const write = (path) => ({ name: "write", arguments: { file_path: path, content: "x" }, agent: {} })

test("the workspace joins the constant zones only as one plugin repo directly under the plugins root", () => {
  const included = (ws) => devZoneRootsFor(ws, DSH_HOME, USERROOT).some((root) => root === norm(ws))
  assert.equal(included(OTHER), true)
  assert.equal(included(`${OTHER}/sub`), false)
  assert.equal(included(`${DSH_HOME}/plugins`), false)
  assert.equal(included(`${DSH_HOME}/sessions`), false)
  assert.equal(included(`${DSH_HOME}/credentials`), false)
  assert.equal(included(DSH_HOME), false)
  assert.equal(included("C:/Users/u/proj"), false)
  assert.equal(included(SELF), true)
})

test("the granted-zone predicate keys on the injected set, not the install root", () => {
  const roots = { devZoneRoots: [norm(OTHER)] }
  assert.equal(isGrantedDevZoneTarget(`${OTHER}/src/a.ts`, roots), true)
  assert.equal(isGrantedDevZoneTarget(`${OTHER}/lib/index.js`, roots), true)
  assert.equal(isGrantedDevZoneTarget(`${SELF}/src/a.ts`, roots), false)
  assert.equal(isGrantedDevZoneTarget(`${DSH_HOME}/sessions/x.jsonl`, roots), false)
})

test("structured writes get the workspace opening with the same clamps", () => {
  const roots = rootsFor(OTHER)
  for (const path of [`${OTHER}/src/a.ts`, `${OTHER}/.agents/doc.md`, `${OTHER}/tests/x.test.mjs`]) {
    assert.equal(hardDenyReason(write(path), roots), undefined, `${path} must not hard-deny`)
    assert.notEqual(assessTool(write(path), roots, artifacts).decision, "deny", `${path} must be writable`)
  }
  for (const path of [`${OTHER}/lib/index.js`, `${OTHER}/node_modules/x.js`, `${OTHER}/dist/x.js`, `${OTHER}/package.json`, `${OTHER}/tsconfig.json`, `${OTHER}/cordis.patch.yml`]) {
    assert.match(hardDenyReason(write(path), roots) ?? "", /not writable from agent sessions/, `${path} must stay fused`)
  }
  for (const path of [`${OTHER}/history.jsonl`, `${OTHER}/audit.jsonl`, `${OTHER}/learning.json`]) {
    assert.equal(assessTool(write(path), roots, artifacts).decision, "deny", `${path} must be denied`)
  }
  assert.equal(assessTool(write(`${OTHER}/.env`), roots, artifacts).decision, "ask")
  for (const path of [`${DSH_HOME}/plugins/other2/src/a.ts`, `${DSH_HOME}/sessions/x.jsonl`, `${DSH_HOME}/settings.yaml`]) {
    assert.match(hardDenyReason(write(path), roots) ?? "", /DSH_HOME path/, `${path} must stay fenced`)
  }
  assert.match(hardDenyReason(write(`${SELF}/lib/index.js`), roots) ?? "", /not writable from agent sessions/)
})

test("the shell fuse extends the same structural rule to the workspace", () => {
  const roots = rootsFor(OTHER)
  const deny = (cmd) => hardDenyShellReason(cmd, "bash", roots)
  for (const cmd of ["printf x > .agents/out.md", "mkdir -p src/gen", "grep -n x README.md > out.txt"]) {
    assert.equal(deny(cmd), undefined, `${cmd} must clear the shell fuse`)
  }
  for (const cmd of [
    `cd ${OTHER} && printf x > .agents/out.md`,
    "printf x > lib/index.js",
    "printf x > package.json",
    "printf x > node_modules/x.js",
    "printf x > history.jsonl",
    "ln -s lib .agents/link",
    `tee ${DSH_HOME}/outside.txt`,
    `printf x > ${DSH_HOME}/plugins/other2/src/a.ts`,
  ]) {
    assert.match(deny(cmd) ?? "", /DSH_HOME|not writable from agent sessions|runtime state/, `${cmd} must stay fused`)
  }
})

test("operator openings stay structured-tool only under the new roots", () => {
  const roots = rootsFor(OTHER, [OPERATOR])
  assert.equal(hardDenyReason(write(`${OPERATOR}/x.md`), roots), undefined)
  assert.match(hardDenyShellReason(`printf x > ${OPERATOR}/x.md`, "bash", roots) ?? "", /DSH_HOME/)
})
