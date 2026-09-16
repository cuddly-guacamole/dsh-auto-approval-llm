/**
 * M1 behavior: the feedback route must only write for callIds the host issued.
 *
 * A real locked-category countdown ask is driven to in-flight; posting its
 * callId to the feedback route must arm the timeout notice that
 * tools/post-execute injects into the errored result. A forged callId must
 * write nothing, so its post-execute still falls through to the host.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHostContext } from "./helpers/host-ctx.mjs";

test("M1: feedback for a live callId arms the post-execute timeout notice", async (t) => {
  const host = createHostContext({ config: { categoryMode: "aggressive", highRiskSeconds: 20 } });
  t.after(() => host.dispose());

  const realCallId = "m1-real-ask";
  const args = { command: "rm never-created.txt" };
  const session = host.makeSession({ id: "m1-session", callId: realCallId, args });
  const req = { callId: realCallId, toolName: "bash", agent: { session }, signal: undefined, reason: "locked ask behavior test" };

  let resolveNext = () => {};
  const nextPromise = new Promise((resolve) => { resolveNext = resolve; });
  const askPromise = host.invokeApprovalRequest(req, () => nextPromise);

  let statusError;
  try {
    const status = await host.waitFor(async () => {
      const response = await host.readReviewStatus(realCallId);
      return response.body?.ok === true ? response.body.value : undefined;
    }, "locked countdown status");
    assert.equal(status.phase, "countdown");
    assert.equal(status.action, "reject");
    assert.equal(status.lockedAsk, true, "the locked category ask is the locked countdown shape");
  } catch (error) {
    statusError = error;
  }

  let ack;
  try {
    ack = await host.postFeedback(realCallId, "rejected");
  } finally {
    resolveNext("rejected");
  }
  const outcome = await askPromise;
  if (statusError) throw statusError;
  assert.equal(ack.statusCode, 200, "the feedback ACK stays a 200");
  assert.equal(ack.body.ok, true);
  assert.equal(outcome, "rejected", "the human side wins the race with the delegated rejection");

  const post = await host.invokePostExecute({ callId: realCallId, name: "bash", agent: { session } }, { isError: true });
  assert.ok(post, "the errored result must be blocked");
  assert.equal(post.kind, "block");
  assert.match(String(post.feedback?.[0]?.text), /auto-rejected by the configured timeout action/, "the injected text proves the route wrote the timeout feedback");
  assert.notEqual(String(post.feedback?.[0]?.text).indexOf("not a user denial"), -1, "the notice keeps its honest provenance wording");

  // Negative: a callId the plugin never issued writes nothing, so post-execute
  // must fall through to the host (the next stub resolves undefined).
  const forgedCallId = "m1-forged-callid";
  const forgedAck = await host.postFeedback(forgedCallId, "rejected");
  assert.equal(forgedAck.statusCode, 200, "the forged ACK is still a 200 no-op");
  assert.equal(forgedAck.body.ok, true);
  const forgedPost = await host.invokePostExecute({ callId: forgedCallId, name: "bash", agent: { session } }, { isError: true });
  assert.equal(forgedPost, undefined, "a forged callId must not block any later result");
});
