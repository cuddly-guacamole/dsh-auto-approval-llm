/**
 * Minimal host context fake for behavior tests.
 *
 * The plugin registers its whole behavior inside apply(): tools/pre-execute,
 * tools/result, tools/post-execute and approval/request listeners, plus the
 * HTTP routes. Those handlers live in closure and are unreachable from a test
 * unless a ctx object is fed to apply(). This helper builds the smallest ctx
 * that boots apply() and exposes the registered handlers and routes.
 *
 * Scope is deliberately narrow: only the seams the behavior tests drive are
 * modeled. It is not a host emulator, and the stubs are contract-shaped, not
 * feature-complete. Every runtime write is redirected into a fresh os.tmpdir
 * directory before apply() runs, so no test can touch the live runtime state
 * under DSH_HOME.
 *
 * The node --test glob does not treat this file as a test case: it has no
 * test() calls and its name is not a .test.mjs file.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../../lib/index.js";
import { setRuntimePathsForTests } from "../../lib/auto/runtime-paths.js";

export const FEEDBACK_ROUTE = "/api/auto-approval-llm/feedback";
export const REVIEW_STATUS_ROUTE = "/api/auto-approval-llm/review-status";

/** Config keys that resolveConfig consumes or that gate the driven branches. */
export function baseConfig(overrides = {}) {
  return {
    enabled: true,
    timeoutAction: "reject",
    categoryMode: "standard",
    // List keys are read with .some() by staticListDecision; undefined throws.
    denyList: [],
    allowlist: [],
    humanOnlyList: [],
    rulesText: "",
    // Keep the driven asks free of review/onboarding/learning side channels.
    onboardingMessageEnabled: false,
    learningEnabled: false,
    directHumanEnabled: false,
    redactResults: false,
    editDiffPreview: false,
    // findToolCallArguments receives this directly; undefined truncates wrong.
    maxArgsChars: 20000,
    highRiskSeconds: 30,
    loopDetectionThreshold: 0,
    ...overrides,
  };
}

function getRequest(options = {}) {
  const headers = options.headers ?? {};
  const host = options.host ?? "localhost:8080";
  const ip = options.ip ?? "127.0.0.1";
  return { method: "GET", headers: { host, ...headers }, socket: { remoteAddress: ip } };
}

function postRequest(body, options = {}) {
  const host = options.host ?? "localhost:8080";
  const ip = options.ip ?? "127.0.0.1";
  const bytes = Buffer.from(JSON.stringify(body));
  return {
    method: "POST",
    headers: { host, "content-type": "application/json" },
    socket: { remoteAddress: ip },
    [Symbol.asyncIterator]: async function* () { yield bytes; },
  };
}

/** Boot apply() against a tmp-only runtime and return the seams the tests drive. */
export function createHostContext(options = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "host-ctx-state-"));
  const workspaceRoot = mkdtempSync(join(tmpdir(), "host-ctx-ws-"));
  const dshHome = mkdtempSync(join(tmpdir(), "host-ctx-dsh-"));
  const routes = new Map();
  const handlers = new Map();
  const disposers = [];
  const permissionPresets = {
    names: ["auto-approval"],
    permissionState: () => ({ preset: "auto-approval", sandbox: "danger-full-access", approval: "ask" }),
    resolve: () => ({ sandbox: "danger-full-access", approval: "ask" }),
    // No registerAuto/catalog: detectHostCapability must return the legacy
    // capability so the gate name set matches a legacy host.
    specOf: () => undefined,
  };
  // `deferConnection` models a carrier whose Fetch registry mounts only later
  // (or never): until arriveConnection() runs, ctx.inject(['connection'], ...)
  // callbacks queue instead of firing.
  let connectionReady = options.deferConnection !== true;
  const connectionService = {
    fetch: { register: (spec) => { routes.set(spec.path, spec); return () => {}; } },
  };
  const get = (name) => {
    if (name === "approval") return { config: { policy: "ask" } };
    if (name === "permissionPresets") return permissionPresets;
    if (name === "tools") return {};
    if (name === "llm") return {};
    if (name === "connection") return connectionReady ? connectionService : undefined;
    return undefined;
  };
  const pendingInjects = [];
  const ctx = {
    get,
    on: (event, fn) => {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
      return () => {};
    },
    effect: (fn) => {
      const disposer = fn();
      if (typeof disposer === "function") disposers.push(disposer);
    },
    // Contract-shaped stand-in for cordis ctx.inject(deps, cb): the callback
    // runs as soon as every listed service resolves, on a child ctx that keeps
    // the same handlers/effects so route disposers stay collectable.
    inject: (deps, callback) => {
      const names = Array.isArray(deps) ? deps : Object.keys(deps ?? {});
      const childCtx = { get, on: ctx.on, effect: ctx.effect, inject: ctx.inject };
      if (names.every((name) => get(name) !== undefined)) callback(childCtx, undefined);
      else pendingInjects.push({ names, callback: (c) => callback(c, undefined), childCtx });
      return { dispose: () => {} };
    },
  };
  const arriveConnection = () => {
    connectionReady = true;
    for (const pending of pendingInjects.splice(0)) {
      if (pending.names.every((name) => get(name) !== undefined)) pending.callback(pending.childCtx);
    }
  };
  setRuntimePathsForTests({ stateDir });
  const config = baseConfig({ workspaceRoot, dshHome, ...(options.config ?? {}) });
  apply(ctx, config);

  let tokenSeq = 0;
  const makeSession = (input = {}) => {
    const id = input.id ?? "session-a";
    const cwd = input.cwd ?? workspaceRoot;
    const origin = input.origin ?? "user";
    const events = [];
    if (input.callId !== undefined) {
      events.push({ type: "tool/call", data: { callId: input.callId, arguments: JSON.stringify(input.args ?? {}) } });
    }
    return { id, header: { cwd, origin }, events, snapshotEvents: () => events };
  };
  const makeExec = (input = {}) => ({
    name: input.name,
    arguments: input.args,
    callId: input.callId,
    token: input.token ?? ("token-" + (++tokenSeq)),
    agent: { session: input.session },
  });

  const handlersFor = (event) => handlers.get(event) ?? [];
  const invokePreExecute = (exec) => {
    const list = handlersFor("tools/pre-execute");
    if (list.length === 0) throw new Error("no tools/pre-execute handler registered");
    return list[0](exec, async () => ({ kind: "allow" }));
  };
  const invokeToolsResult = async (exec, result) => {
    const list = handlersFor("tools/result");
    if (list.length === 0) throw new Error("no tools/result handler registered");
    for (const handler of list) await handler(exec, result);
  };
  const invokePostExecute = (exec, result) => {
    const list = handlersFor("tools/post-execute");
    if (list.length === 0) throw new Error("no tools/post-execute handler registered");
    return list[0](exec, result, async () => undefined);
  };
  const invokeApprovalRequest = (req, next) => {
    const list = handlersFor("approval/request");
    if (list.length === 0) throw new Error("no approval/request handler registered");
    return list[0](req, next);
  };

  const callRoute = async (path, req) => {
    const desc = routes.get(path);
    if (desc === undefined) throw new Error("route not registered: " + path);
    if (typeof desc.fetch !== "function") throw new Error("route is not registered on the Fetch registry: " + path);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers ?? {})) headers.set(name, String(value));
    let payload;
    if (req[Symbol.asyncIterator] !== undefined) {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      payload = Buffer.concat(chunks);
    }
    const response = await desc.fetch(new Request(`http://127.0.0.1:3080${path}`, {
      method: req.method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
    }));
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* keep raw text */ }
    return { statusCode: response.status, body };
  };
  const readReviewStatus = (callId) => callRoute(REVIEW_STATUS_ROUTE, getRequest({ headers: { "x-auto-approval-call-id": callId } }));
  const postFeedback = (callId, outcome = "rejected") => callRoute(FEEDBACK_ROUTE, postRequest({ callId, outcome, auto: true }));

  const readAuditLines = () => {
    const file = join(stateDir, "audit.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
  };
  const waitFor = async (predicate, what, timeoutMs = 4000) => {
    const started = Date.now();
    for (;;) {
      const value = await predicate();
      if (value) return value;
      if (Date.now() - started > timeoutMs) throw new Error("timeout waiting for: " + what);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const dispose = () => {
    for (const disposer of disposers.splice(0)) {
      try { disposer(); } catch { /* best effort */ }
    }
    setRuntimePathsForTests(undefined);
    for (const dir of [stateDir, workspaceRoot, dshHome]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };

  return {
    ctx,
    stateDir,
    workspaceRoot,
    dshHome,
    permissionPresets,
    config,
    makeSession,
    makeExec,
    invokePreExecute,
    invokeToolsResult,
    invokePostExecute,
    invokeApprovalRequest,
    callRoute,
    readReviewStatus,
    postFeedback,
    readAuditLines,
    waitFor,
    dispose,
    routes,
    handlers,
    arriveConnection,
  };
}
