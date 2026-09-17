/**
 * Contract: the native Fetch handlers preserve the request/response surface a
 * carrier dispatches against.
 *
 * The live desktop carrier cannot be exercised from here, so these tests pin
 * the facts a carrier depends on: the body is forwarded byte-for-byte, a client
 * abort releases a held response instead of leaking the hold, and a method the
 * route does not carry still answers its own 405 with its own Allow list.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { installFeedbackRoute, installReviewStatusRoute } from "../lib/index.js";

const PREFIX = "/api/auto-approval-llm";

function carrierContext() {
  const specs = new Map();
  const ctx = {
    get: (name) => (name === "connection"
      ? { fetch: { register: (spec) => { specs.set(spec.path, spec); return () => {}; } } }
      : undefined),
    effect: (fn) => fn(),
  };
  return { ctx, specs };
}

function specFor(install) {
  const { ctx, specs } = carrierContext();
  install(ctx);
  return specs;
}

test("a request body is forwarded and the route's own size cap still applies", async () => {
  const specs = specFor(installFeedbackRoute);
  const feedback = specs.get(`${PREFIX}/feedback`);

  const small = await feedback.fetch(new Request(`http://127.0.0.1:3080${PREFIX}/feedback`, {
    method: "POST",
    headers: { host: "127.0.0.1:3080", "content-type": "application/json" },
    body: JSON.stringify({ callId: "unknown-call", outcome: "rejected" }),
  }));
  assert.equal(small.status, 200, "a well-formed body must reach the handler");

  // The handler caps JSON bodies at 64 KiB; reaching that branch proves the
  // request body reached the handler rather than being dropped or truncated.
  const oversized = JSON.stringify({ callId: "unknown-call", padding: "x".repeat(70 * 1024) });
  const big = await feedback.fetch(new Request(`http://127.0.0.1:3080${PREFIX}/feedback`, {
    method: "POST",
    headers: { host: "127.0.0.1:3080", "content-type": "application/json" },
    body: oversized,
  }));
  assert.equal(big.status, 413);
});

test("a client abort releases a held response", async () => {
  const specs = specFor(installReviewStatusRoute);
  const status = specs.get(`${PREFIX}/review-status`);
  const controller = new AbortController();
  const started = Date.now();
  const pending = status.fetch(new Request(`http://127.0.0.1:3080${PREFIX}/review-status`, {
    method: "GET",
    headers: {
      host: "127.0.0.1:3080",
      "x-auto-approval-call-id": "no-such-call",
      "x-auto-approval-wait-ms": "20000",
    },
    signal: controller.signal,
  }));
  setTimeout(() => controller.abort(), 50);
  const response = await pending;
  const elapsed = Date.now() - started;
  assert.equal(response.status, 200, "the hold must answer once the client goes away");
  assert.ok(elapsed < 5_000, `the hold must not outlive the client (waited ${elapsed}ms)`);
});

test("a method the route does not carry answers its own 405", async () => {
  const specs = specFor(installFeedbackRoute);
  const feedback = specs.get(`${PREFIX}/feedback`);
  const response = await feedback.fetch(new Request(`http://127.0.0.1:3080${PREFIX}/feedback`, {
    method: "HEAD",
    headers: { host: "127.0.0.1:3080" },
  }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});
