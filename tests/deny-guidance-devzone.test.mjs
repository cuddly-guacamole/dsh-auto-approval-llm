/**
 * The deny feedback must not contradict its own reason. A shell write into
 * DSH_HOME used to answer "use the write or edit tool instead" while the
 * appended anti-circumvention guidance claimed the same target stays denied
 * "regardless of tool, wording, or alias" - false for the plugin development
 * zone, where the structured tools (and a single literally readable content
 * write) are the sanctioned recourse. The reason now names a recourse only
 * when one exists, and the guidance anchors the denial to the operation as
 * issued instead of claiming universal tool/alias independence.
 * Run: node --test tests/deny-guidance-devzone.test.mjs
 */
import test from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { hardDenyShellReason } from "../lib/auto/shell.js"
import { DENY_CIRCUMVENTION_GUIDANCE, formatDenyFeedback } from "../lib/auto/decision.js"
import { buildRejectGuidanceText } from "../lib/index.js"

const REPO = process.cwd().split(String.fromCharCode(92)).join("/")
const DSH_HOME = REPO.slice(0, REPO.indexOf("/plugins/"))
const HOME = "C:/Users/u"
const zoneRoots = (allowed) => ({
  workspace: REPO,
  home: HOME,
  dshHome: DSH_HOME,
  tempRoots: [],
  trustedDirs: [],
  allowedDshSubpaths: allowed,
  maintenanceDshPaths: [],
  mode: "aggressive",
})

test("the guidance anchors the denial as issued and forbids evasion", () => {
  assert.ok(DENY_CIRCUMVENTION_GUIDANCE.includes("as issued"))
  assert.ok(!/regardless of tool/i.test(DENY_CIRCUMVENTION_GUIDANCE))
  assert.ok(/evade/i.test(DENY_CIRCUMVENTION_GUIDANCE))
  assert.ok(!/\b(?:try|retry)\b/i.test(DENY_CIRCUMVENTION_GUIDANCE))
  assert.ok(formatDenyFeedback("policy", { toolName: "bash" }).includes(DENY_CIRCUMVENTION_GUIDANCE))
  assert.ok(!formatDenyFeedback("timeout", {}).includes(DENY_CIRCUMVENTION_GUIDANCE))
})

test("an in-opening form-level shell deny names its real recourse", () => {
  const reason = hardDenyShellReason(`cd ${REPO} && printf x > .agents/out.md`, "bash", zoneRoots([REPO]))
  assert.match(reason ?? "", /use the write or edit tool/)
  assert.match(reason ?? "", /single-segment/)
})

test("a target outside every opening names no sanctioned recourse", () => {
  const reason = hardDenyShellReason(`tee ${DSH_HOME}/outside.txt`, "bash", zoneRoots([REPO]))
  assert.match(reason ?? "", /DSH_HOME/)
  assert.ok(!/use the write or edit tool/.test(reason ?? ""))
})

test("reject-guidance carries the same corrected wording", () => {
  const text = buildRejectGuidanceText("policy", "fileEdit")
  assert.ok(text.includes("Do not repeat, reword, or switch tools to evade the decision"))
  assert.ok(!/stays denied under any wording or tool/.test(text))
  assert.ok(!/\b(?:try|retry)\b/i.test(text))
})
