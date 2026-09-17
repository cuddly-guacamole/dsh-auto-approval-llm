/**
 * Contract: the routes register on the carrier-neutral Fetch registry and the
 * native Fetch handlers keep their behaviour end to end.
 *
 * The web carrier mounts that registry under `/api` on its web server; a
 * shell-owned carrier dispatches the same handler directly. These tests drive
 * the registry the way a carrier does: register through the installer, then
 * call the returned `fetch` with a WHATWG Request.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installFeedbackRoute,
  installHistoryRoute,
  installLatencyRoute,
  installReviewStatusRoute,
  setHistoryFilePathForTests,
} from "../lib/index.js";
import { setAuditFilePathForTests } from "../lib/auto/audit.js";

const PREFIX = "/api/auto-approval-llm";

/** A context that offers only the carrier-neutral Fetch registry. */
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

function callFetch(spec, url, init) {
  return spec.fetch(new Request(url, init));
}

test("every route registers on the Fetch registry with its path and methods", () => {
  const { ctx, specs } = carrierContext();
  installFeedbackRoute(ctx);
  installHistoryRoute(ctx);
  installLatencyRoute(ctx);
  installReviewStatusRoute(ctx);

  assert.deepEqual([...specs.keys()].sort(), [
    `${PREFIX}/feedback`,
    `${PREFIX}/history`,
    `${PREFIX}/llm-latency`,
    `${PREFIX}/review-status`,
  ]);
  assert.deepEqual(specs.get(`${PREFIX}/feedback`).methods, ["POST"]);
  assert.deepEqual(specs.get(`${PREFIX}/history`).methods, ["GET", "POST"]);
  assert.deepEqual(specs.get(`${PREFIX}/llm-latency`).methods, ["POST"]);
  assert.deepEqual(specs.get(`${PREFIX}/review-status`).methods, ["GET"]);
  for (const spec of specs.values()) {
    assert.equal(spec.requestBody, "buffered", `${spec.path} must declare its body mode`);
    assert.equal(typeof spec.fetch, "function");
  }
});

test("a carrier-owned URL is judged as a loopback caller", async () => {
  const { ctx, specs } = carrierContext();
  installFeedbackRoute(ctx);
  // A non-HTTP scheme cannot come from a network peer, so the privileged plane
  // must not reject it; without that normalization this answers 403.
  const response = await callFetch(specs.get(`${PREFIX}/feedback`), `dsh-app://app${PREFIX}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callId: "unknown-call", outcome: "rejected" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("a foreign network authority stays on the privileged plane's outside", async () => {
  const { ctx, specs } = carrierContext();
  installFeedbackRoute(ctx);
  const response = await callFetch(specs.get(`${PREFIX}/feedback`), `http://10.0.0.7:3080${PREFIX}/feedback`, {
    method: "POST",
    headers: { host: "10.0.0.7:3080", "content-type": "application/json" },
    body: JSON.stringify({ callId: "unknown-call", outcome: "rejected" }),
  });
  assert.equal(response.status, 403);
});

test("the delete op reaches the DELETE branch over a POST", async () => {
  // The DELETE branch truncates history.jsonl and appends an audit tombstone;
  // both seams must point at a scratch path or running this suite would clear
  // the live runtime state of a running dsh.
  const dir = mkdtempSync(join(tmpdir(), "carrier-history-delete-"));
  const historyFile = join(dir, "history.jsonl");
  const auditFile = join(dir, "audit.jsonl");
  // The history seed MUST be non-empty: an empty seed makes the truncation
  // assertion vacuous (an untouched file also reads ""), so a regression that
  // stopped honoring the override would silently truncate the live file while
  // this test stayed green. The audit seed stays empty because its guard is
  // the appended tombstone, which an untouched file cannot produce.
  writeFileSync(historyFile, '{"id":"a"}\n')
  writeFileSync(auditFile, "");
  setHistoryFilePathForTests(historyFile);
  setAuditFilePathForTests(auditFile);
  try {
    const { ctx, specs } = carrierContext();
    installHistoryRoute(ctx);
    const response = await callFetch(specs.get(`${PREFIX}/history`), `http://127.0.0.1:3080${PREFIX}/history`, {
      method: "POST",
      headers: { host: "127.0.0.1:3080", "x-auto-approval-op": "delete" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.value, { records: [] });
    assert.equal(readFileSync(historyFile, "utf8"), "", "the DELETE truncates the scratch history file");
    assert.match(readFileSync(auditFile, "utf8"), /"type":"clear"/, "the DELETE writes its tombstone to the scratch audit file");
  } finally {
    setHistoryFilePathForTests(undefined);
    setAuditFilePathForTests(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a method the route does not carry still answers its own 405", async () => {
  const { ctx, specs } = carrierContext();
  installFeedbackRoute(ctx);
  const response = await callFetch(specs.get(`${PREFIX}/feedback`), `http://127.0.0.1:3080${PREFIX}/feedback`, {
    method: "GET",
    headers: { host: "127.0.0.1:3080" },
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

test("a context with neither carrier registers nothing", () => {
  const registered = [];
  const ctx = {
    get: () => undefined,
    effect: (fn) => fn(),
    __registered: registered,
  };
  installFeedbackRoute(ctx);
  installHistoryRoute(ctx);
  assert.deepEqual(registered, []);
});
