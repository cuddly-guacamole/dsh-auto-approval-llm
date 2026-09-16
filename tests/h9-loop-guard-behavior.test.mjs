/**
 * H9 behavior: the third identical auto-allowed call must escalate.
 *
 * With loopDetectionThreshold=3 the pre-execute listener must allow the first
 * two identical calls and turn the third into a loop-guard ask. Driving the
 * answerer with that callId must then settle into the pinned reject countdown,
 * not the ordinary static allow. The audit trail keeps the non-decision
 * loop-guard provenance row.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHostContext } from "./helpers/host-ctx.mjs";

test("H9: the third identical auto-allowed call escalates to a pinned reject countdown", async (t) => {
  const host = createHostContext({ config: { categoryMode: "aggressive", loopDetectionThreshold: 3, highRiskSeconds: 20 } });
  t.after(() => host.dispose());

  const sessionId = "h9-session";
  let third;
  for (let index = 0; index < 3; index += 1) {
    const callId = "h9-ls-" + index;
    const args = { command: "ls" };
    const session = host.makeSession({ id: sessionId, callId, args });
    const exec = host.makeExec({ name: "bash", args, callId, session });
    const result = await host.invokePreExecute(exec);
    if (index < 2) {
      assert.equal(result.kind, "allow", "call " + index + " is still auto-allowed");
    } else {
      assert.equal(result.kind, "ask", "the threshold call escalates");
      assert.match(String(result.reason), /loop guard/, "the escalation names the loop guard");
      third = { callId, args, session };
    }
  }

  const guardRows = host.readAuditLines().filter((line) => line.type === "loop-guard");
  assert.equal(guardRows.length, 1, "exactly one loop-guard provenance row is written");
  assert.equal(guardRows[0].callId, third.callId);
  assert.equal(guardRows[0].sessionId, sessionId);
  assert.equal(guardRows[0].consecutive, 3);
  assert.equal(guardRows[0].threshold, 3);

  let resolveNext = () => {};
  const nextPromise = new Promise((resolve) => { resolveNext = resolve; });
  const req = {
    callId: third.callId,
    toolName: "bash",
    agent: { session: third.session },
    signal: undefined,
    reason: "loop guard behavior test",
  };
  const askPromise = host.invokeApprovalRequest(req, () => nextPromise);

  let statusError;
  try {
    const status = await host.waitFor(async () => {
      const response = await host.readReviewStatus(third.callId);
      return response.body?.ok === true ? response.body.value : undefined;
    }, "loop-guard countdown status");
    assert.equal(status.phase, "countdown", "the escalated ask carries a countdown");
    assert.equal(status.action, "reject", "the countdown is pinned to reject");
    assert.equal(status.lockedAsk, undefined, "the loop-guard countdown is not the locked-category shape");
    assert.ok(typeof status.seconds === "number" && status.seconds > 0, "the countdown has a positive window");
  } catch (error) {
    statusError = error;
  } finally {
    resolveNext("rejected");
  }
  const outcome = await askPromise;
  if (statusError) throw statusError;
  assert.equal(outcome, "rejected", "the answerer resolves with the delegated outcome");
});
