/**
 * Contract: the plugin boots without a web server and binds its routes to the
 * carrier-neutral Fetch registry.
 *
 * The desktop carrier disables the only web-server provider, so a hard inject
 * entry would hold the whole fiber in PENDING there. The service is not
 * required, and each route binds itself to `connection.fetch` — waiting for the
 * registry rather than probing once, because composition rows mount in
 * dependency order.
 *
 * The apply()-level inventory below holds 15 routes. `/settings` is the 16th and
 * needs the `settings` service too; the host-context fake deliberately omits
 * that service (apply() would re-resolve its config from it), so the settings
 * route is pinned by calling its installer directly instead.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHostContext } from "./helpers/host-ctx.mjs";
import { inject, installSettingsRoute } from "../lib/index.js";

const REQUIRED_SERVICES = [
  "approval",
  "permissionPresets",
  "sessions",
  "tools",
  "llm",
  "agents",
  "settings",
  "commands",
];

const ROUTE_PREFIX = "/api/auto-approval-llm";
const SETTINGS_ROUTE = `${ROUTE_PREFIX}/settings`;

/** Routes apply() registers once the carrier registry is up. */
const CARRIER_ROUTES = [
  `${ROUTE_PREFIX}/feedback`,
  `${ROUTE_PREFIX}/history`,
  `${ROUTE_PREFIX}/llm-latency`,
  `${ROUTE_PREFIX}/learning-store`,
  `${ROUTE_PREFIX}/llm-models`,
  `${ROUTE_PREFIX}/providers`,
  `${ROUTE_PREFIX}/reasoning-efforts`,
  `${ROUTE_PREFIX}/reveal-approval`,
  `${ROUTE_PREFIX}/review-status`,
  `${ROUTE_PREFIX}/reviewer-credential`,
  `${ROUTE_PREFIX}/session-mode`,
  `${ROUTE_PREFIX}/session-review-status`,
  `${ROUTE_PREFIX}/stats`,
  `${ROUTE_PREFIX}/test`,
  `${ROUTE_PREFIX}/tool-stats`,
];

const APPLIED_MARKER = "tools/pre-execute";

function carrierStub() {
  const specs = new Map();
  const service = { fetch: { register: (spec) => { specs.set(spec.path, spec); return () => {}; } } };
  return { service, specs };
}

function installerContext({ settings }) {
  return {
    get: (name) => (name === "settings" ? settings : undefined),
    effect: (fn) => fn(),
  };
}

test("webServer is not a required service dependency", () => {
  assert.equal(inject.includes("webServer"), false, "webServer must not gate the plugin");
  for (const name of REQUIRED_SERVICES) {
    assert.ok(inject.includes(name), `missing required service: ${name}`);
  }
});

test("a carrier that never provides the registry still applies the plugin", () => {
  const host = createHostContext({ deferConnection: true });
  try {
    assert.equal(host.routes.size, 0, "routes must not register without a carrier");
    assert.ok(host.handlers.has(APPLIED_MARKER), "the plugin body must still run");
    assert.ok(host.handlers.has("approval/request"), "the approval pipeline must still be installed");
    assert.ok(host.handlers.has("tools/post-execute"), "the post-execute hooks must still be installed");
  } finally {
    host.dispose();
  }
});

test("the routes bind when the carrier registry mounts after apply", () => {
  const host = createHostContext({ deferConnection: true });
  try {
    assert.equal(host.routes.size, 0, "precondition: no carrier yet");
    host.arriveConnection();
    assert.equal(host.routes.size, CARRIER_ROUTES.length, "every route must bind on arrival");
    for (const path of CARRIER_ROUTES) {
      assert.ok(host.routes.has(path), `route not bound on arrival: ${path}`);
    }
  } finally {
    host.dispose();
  }
});

test("a carrier registry present at apply receives the whole route inventory", () => {
  const host = createHostContext();
  try {
    assert.equal(host.routes.size, CARRIER_ROUTES.length);
    for (const path of CARRIER_ROUTES) {
      assert.ok(host.routes.has(path), `route not bound: ${path}`);
      assert.equal(typeof host.routes.get(path).fetch, "function", `${path} must bind through the Fetch registry`);
      assert.equal(host.routes.get(path).requestBody, "buffered", `${path} must declare its body mode`);
    }
  } finally {
    host.dispose();
  }
});

test("the settings route needs both the carrier and the settings service", () => {
  const withBoth = carrierStub();
  const carrierOnly = {
    get: (name) => (name === "connection" ? withBoth.service : name === "settings" ? { writable: true } : undefined),
    effect: (fn) => fn(),
  };
  installSettingsRoute(carrierOnly, { writable: true, get: () => undefined, describe: () => [], register: () => {} });
  assert.deepEqual([...withBoth.specs.keys()], [SETTINGS_ROUTE]);

  const noCarrier = carrierStub();
  const queued = [];
  const serverOnly = {
    get: (name) => (name === "settings" ? { writable: true } : undefined),
    effect: (fn) => fn(),
    inject: (deps) => { queued.push(deps); return { dispose: () => {} }; },
  };
  installSettingsRoute(serverOnly, { writable: true });
  assert.deepEqual(queued, [["connection"]], "no carrier: the settings route waits for the connection service");
  assert.equal(noCarrier.specs.size, 0, "no carrier: the settings route must not register");

  const noSettings = carrierStub();
  const carrierOnlyCtx = { get: (name) => (name === "connection" ? noSettings.service : undefined), effect: (fn) => fn() };
  installSettingsRoute(carrierOnlyCtx, undefined);
  assert.equal(noSettings.specs.size, 0, "no settings service: the settings route must not register");
});
