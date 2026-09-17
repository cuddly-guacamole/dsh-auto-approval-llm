/**
 * Drive the plugin's exact HTTP routes the way a carrier does.
 *
 * Every route registers on the connection plugin's carrier-neutral Fetch
 * registry (`connection.fetch.register`), so a test builds a context whose
 * `connection` service captures the specs and then calls `spec.fetch` with a
 * WHATWG Request. `callSpec` also accepts the Node-shaped request descriptors
 * the pre-Fetch handler tests used and translates them onto a Request, so a
 * suite can keep its request fixtures while the transport moves to Fetch.
 *
 * This helper is not a host emulator: it models only the registration seam a
 * route test drives. Behavior tests that need apply() use host-ctx.mjs.
 */
import assert from "node:assert/strict";

const ORIGIN = "http://127.0.0.1:3080";

/**
 * A context whose `connection` service captures every registered Fetch spec.
 * Extra services (settings, credentials, llm, agents, permissionPresets, …)
 * ride in through `services`.
 */
export function carrierContext(services = {}) {
  const specs = new Map();
  const ctx = {
    get: (name) => {
      if (name === "connection") {
        return { fetch: { register: (spec) => { specs.set(spec.path, spec); return () => {}; } } };
      }
      return services[name];
    },
    effect: (fn) => { fn(); return () => {}; },
  };
  return { ctx, specs };
}

/** Capture the specs a list of [installer, ...args] entries register. */
export function installRoutes(entries, services = {}) {
  const { ctx, specs } = carrierContext(services);
  for (const [install, ...args] of entries) install(ctx, ...args);
  return { ctx, specs, registrations: [...specs.values()] };
}

/** The first captured spec whose path contains `pathPart`. */
export function findSpec(registrations, pathPart) {
  const spec = registrations.find((r) => r.path.includes(pathPart));
  assert.ok(spec, `no route matching ${pathPart}`);
  return spec;
}

/**
 * Call a captured spec with a Fetch Request and decode the JSON response.
 *
 * `req` may be a Request (passed straight to the spec, which lets a test
 * instrument the Request) or a plain descriptor (`method`, `headers`, `url`,
 * and a body via `[Symbol.asyncIterator]`, `body`, or nothing). `url` is
 * resolved against the loopback origin so a query-string fixture keeps working.
 */
export async function callSpec(spec, req = {}) {
  const request = req instanceof Request ? req : await buildRequest(spec, req);
  const response = await spec.fetch(request);
  return readResponse(response);
}

async function buildRequest(spec, req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers ?? {})) headers.set(name, String(value));
  let body;
  let duplex;
  if (req.body instanceof ReadableStream || typeof req.body?.getReader === "function") {
    // A streaming body lets a test observe whether the handler actually reads
    // it (the 403 paths must reject before consuming the body).
    body = req.body;
    duplex = { duplex: "half" };
  } else if (req.body !== undefined && req.body !== null) {
    body = req.body;
  } else if (req[Symbol.asyncIterator] !== undefined) {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    body = Buffer.concat(chunks);
  }
  const url = req.url === undefined ? `${ORIGIN}${spec.path}` : new URL(req.url, ORIGIN).toString();
  return new Request(url, {
    method: req.method ?? "GET",
    headers,
    ...(duplex ?? {}),
    ...(body === undefined ? {} : { body }),
  });
}

async function readResponse(response) {
  const text = await response.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* keep raw text */ }
  return { status: response.status, statusCode: response.status, headers: response.headers, body: parsed, json: parsed, text };
}
