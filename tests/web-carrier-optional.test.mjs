/**
 * Contract: the plugin boots on a carrier that never provides `webServer`.
 *
 * The desktop carrier disables the only `webServer` provider, so a hard inject
 * entry would hold the whole fiber in PENDING there. The service is therefore
 * not required, and the route block is bound with ctx.inject(['webServer'], ...)
 * so the routes appear if and when the service arrives. These tests pin both
 * halves plus the route inventory.
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

/** Routes apply() registers whenever the web carrier is present. */
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
  const routes = new Map();
  const service = {
    host: undefined,
    register: (desc) => { routes.set(desc.path, desc); return () => {}; },
  };
  return { service, routes };
}

function settingsStub() {
  return {
    writable: true,
    get: () => undefined,
    describe: () => [],
    register: () => {},
  };
}

function installerContext({ webServer, settings }) {
  return {
    get: (name) => (name === "webServer" ? webServer : name === "settings" ? settings : undefined),
    effect: (fn) => { const disposer = fn(); return disposer; },
  };
}

test("webServer is not a required service dependency", () => {
  assert.equal(inject.includes("webServer"), false, "webServer must not gate the plugin");
  for (const name of REQUIRED_SERVICES) {
    assert.ok(inject.includes(name), `missing required service: ${name}`);
  }
});

test("a carrier that never provides webServer still applies the plugin", () => {
  const host = createHostContext({ deferWebServer: true });
  try {
    assert.equal(host.routes.size, 0, "routes must not register without a carrier");
    assert.ok(host.handlers.has(APPLIED_MARKER), "the plugin body must still run");
    assert.ok(host.handlers.has("approval/request"), "the approval pipeline must still be installed");
    assert.ok(host.handlers.has("tools/post-execute"), "the post-execute hooks must still be installed");
  } finally {
    host.dispose();
  }
});

test("the route block registers when webServer arrives after apply", () => {
  const host = createHostContext({ deferWebServer: true });
  try {
    assert.equal(host.routes.size, 0, "precondition: no carrier yet");
    host.arriveWebServer();
    assert.equal(host.routes.size, CARRIER_ROUTES.length, "every carrier route must register on arrival");
    for (const path of CARRIER_ROUTES) {
      assert.ok(host.routes.has(path), `route not registered on arrival: ${path}`);
    }
  } finally {
    host.dispose();
  }
});

test("a carrier with webServer at apply registers the whole route inventory", () => {
  const host = createHostContext();
  try {
    assert.equal(host.routes.size, CARRIER_ROUTES.length);
    for (const path of CARRIER_ROUTES) {
      assert.ok(host.routes.has(path), `route not registered: ${path}`);
      assert.equal(host.routes.get(path).kind, "exact", `${path} must stay an exact route`);
    }
  } finally {
    host.dispose();
  }
});

test("the settings route needs both the carrier and the settings service", () => {
  const withBoth = carrierStub();
  installSettingsRoute(installerContext({ webServer: withBoth.service, settings: settingsStub() }), settingsStub());
  assert.deepEqual([...withBoth.routes.keys()], [SETTINGS_ROUTE]);

  const noCarrier = carrierStub();
  installSettingsRoute(installerContext({ webServer: undefined, settings: settingsStub() }), settingsStub());
  assert.equal(noCarrier.routes.size, 0, "no carrier: the settings route must not register");

  const noSettings = carrierStub();
  installSettingsRoute(installerContext({ webServer: noSettings.service, settings: undefined }), undefined);
  assert.equal(noSettings.routes.size, 0, "no settings service: the settings route must not register");
});
