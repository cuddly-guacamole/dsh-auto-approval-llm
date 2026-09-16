/**
 * H2 behavior: the host pre-execute listener must feed the artifact registry.
 *
 * The policy plane can only exempt a deletion of a session artifact if the
 * registry learned about the create. This test drives the production apply()
 * listeners: pre-execute plans the write, tools/result promotes it, and the
 * later rm of the same path is allowed by the provenance exemption while an
 * unobserved rm still asks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createHostContext } from "./helpers/host-ctx.mjs";

const provenance = (lines, phase) => lines.find((line) => line.type === "artifact-provenance" && line.phase === phase);
const tail = (path) => path.replaceAll(String.fromCharCode(92), "/").toLowerCase();

test("H2: plan + promote make rm of the session artifact allow", async (t) => {
  const host = createHostContext({ config: { categoryMode: "aggressive" } });
  t.after(() => host.dispose());

  const target = join(host.workspaceRoot, "scratch.txt");
  const writeArgs = { file_path: target, content: "x" };
  const session = host.makeSession({ id: "h2-session", callId: "h2-write", args: writeArgs });
  const writeExec = host.makeExec({ name: "write", args: writeArgs, callId: "h2-write", session });

  const writeResult = await host.invokePreExecute(writeExec);
  assert.equal(writeResult.kind, "allow", "the workspace write is a static allow");

  const plan = provenance(host.readAuditLines(), "plan");
  assert.ok(plan, "pre-execute must leave an artifact-provenance plan record");
  assert.equal(plan.callId, "h2-write", "the plan record names the write call");
  assert.equal(plan.sessionId, "h2-session", "the plan record is keyed on the session");
  assert.equal(plan.toolName, "write");
  assert.ok(Array.isArray(plan.paths) && plan.paths.some((path) => tail(path).endsWith("/scratch.txt")), "the plan record names the planned artifact");

  await host.invokeToolsResult(writeExec, { isError: false, value: { operation: "create", path: target } });
  const promote = provenance(host.readAuditLines(), "promote");
  assert.ok(promote, "tools/result must leave an artifact-provenance promote record");
  assert.equal(promote.callId, "h2-write");
  assert.ok(promote.paths.some((path) => tail(path).endsWith("/scratch.txt")), "the promote record names the settled artifact");

  // The same session OBJECT is required: the registry is a WeakMap keyed by owner.
  const ownExec = host.makeExec({ name: "bash", args: { command: "rm scratch.txt" }, callId: "h2-rm-own", session });
  const ownResult = await host.invokePreExecute(ownExec);
  assert.equal(ownResult.kind, "allow", "rm of the session artifact must ride the provenance exemption");

  const otherExec = host.makeExec({ name: "bash", args: { command: "rm never-created.txt" }, callId: "h2-rm-other", session });
  const otherResult = await host.invokePreExecute(otherExec);
  assert.equal(otherResult.kind, "ask", "rm of an unobserved path stays locked");
  assert.match(String(otherResult.reason), /category ask|approval required|delete/, "the unobserved deletion is a category ask");
});
