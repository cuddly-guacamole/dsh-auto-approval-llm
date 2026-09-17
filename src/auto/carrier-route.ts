/**
 * Carrier-neutral registration for the plugin's exact HTTP routes.
 *
 * Routes register on the connection plugin's carrier-neutral Fetch registry
 * (`connection.fetch.register`): the web carrier mounts that registry under
 * `/api` on its web server, and a shell-owned carrier dispatches the shared
 * handler directly. A context without the registry (route unit stubs, older
 * hosts) keeps the `webServer` exact-route path.
 *
 * Handlers keep their Node-shaped `(req, res)` signature; `nodeHandlerToFetch`
 * bridges them onto the Fetch seam. Two carrier facts are normalized there:
 *
 * - A non-HTTP request URL cannot come from a network peer, so it is judged as a
 *   loopback caller and the privileged route plane keeps its loopback clamp.
 * - `POST` with `x-auto-approval-op: delete` is delivered as `DELETE`, because
 *   the Fetch registry carries `GET`/`HEAD`/`POST` only.
 */
import { isLoopbackHostname } from './trust.js'

/** The subset of a route descriptor both carriers understand. */
export interface CarrierRouteSpec {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody?: 'buffered' | 'streaming'
  readonly label: string
}

type NodeRouteHandler = (req: any, res: any) => Promise<void> | void

const DELETE_OP_HEADER = 'x-auto-approval-op'
const DELETE_OP_VALUE = 'delete'

/** The authority a Handler sees: a non-HTTP scheme is carrier-owned, not networked. */
function authorityOf(headers: Record<string, string>, url: URL): string {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '127.0.0.1'
  return headers.host ?? url.host
}

function isLoopbackAuthority(authority: string): boolean {
  const bracket = authority.indexOf(']')
  const hostname = authority.startsWith('[') && bracket !== -1
    ? authority.slice(0, bracket + 1)
    : (authority.split(':')[0] ?? '')
  return isLoopbackHostname(hostname)
}

/** The method a Handler sees: the delete op rides a POST because `DELETE` is not in the registry. */
function requestMethod(request: Request, headers: Record<string, string>): string {
  if (request.method === 'POST' && headers[DELETE_OP_HEADER] === DELETE_OP_VALUE) return 'DELETE'
  return request.method
}

function requestHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value })
  return headers
}

/** Bridge a Node-shaped handler to the Fetch seam. */
async function nodeHandlerToFetch(handler: NodeRouteHandler, request: Request): Promise<Response> {
  const headers = requestHeaders(request)
  const url = new URL(request.url)
  headers.host = authorityOf(headers, url)
  const loopback = isLoopbackAuthority(headers.host)
  const state = {
    status: 200,
    headers: new Map<string, string>(),
    chunks: [] as Buffer[],
    ended: false,
  }
  const closeListeners = new Set<() => void>()
  const onClose = () => { for (const listener of [...closeListeners]) listener() }
  request.signal.addEventListener('abort', onClose, { once: true })
  const req = {
    method: requestMethod(request, headers),
    headers,
    url: request.url,
    // The carrier owns the transport, so only a loopback authority has a proven
    // loopback peer; a network authority keeps the socket check unanswered.
    socket: { remoteAddress: loopback ? '127.0.0.1' : undefined },
    [Symbol.asyncIterator]: async function* () {
      if (request.body === null) return
      const reader = request.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return
          if (value !== undefined) yield Buffer.from(value)
        }
      } finally {
        reader.releaseLock()
      }
    },
  }
  const res = {
    setHeader: (name: string, value: unknown) => { state.headers.set(String(name), String(value)) },
    writeHead: (status: number, extra?: Record<string, string>) => {
      state.status = status
      for (const [name, value] of Object.entries(extra ?? {})) state.headers.set(name, String(value))
    },
    end: (chunk?: unknown) => {
      if (chunk !== undefined && chunk !== null) {
        state.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      }
      state.ended = true
    },
    get writableEnded() { return state.ended },
    on: (event: string, listener: () => void) => {
      if (event === 'close') closeListeners.add(listener)
    },
    off: (event: string, listener: () => void) => {
      if (event === 'close') closeListeners.delete(listener)
    },
  }
  try {
    await handler(req, res)
  } finally {
    request.signal.removeEventListener('abort', onClose)
  }
  const body = state.chunks.length === 0 ? null : Buffer.concat(state.chunks)
  return new Response(body, { status: state.status, headers: Object.fromEntries(state.headers) })
}

/**
 * Bind one exact route to the connection plugin's carrier-neutral Fetch
 * registry. Both carriers read that registry: the web carrier mounts it under
 * `/api` on its web server, and a shell-owned carrier dispatches the shared
 * handler directly.
 *
 * The binding waits for the service instead of probing once: composition rows
 * mount in dependency order, so a sibling carrier may not be up when this
 * plugin's apply() runs. Registering the exact path on the web server instead
 * would shadow the carrier's `/api` prefix route and bypass its request fence,
 * so that shape is reserved for registry-less contexts (route unit tests that
 * drive the Node-shaped handlers directly).
 */
export function registerCarrierRoute(ctx: any, spec: CarrierRouteSpec, handler: NodeRouteHandler): void {
  const connection = ctx?.get?.('connection')
  if (connection?.fetch?.register !== undefined) {
    bindFetchRegistry(ctx, connection, spec, handler)
    return
  }
  if (typeof ctx?.inject !== 'function') {
    bindWebServer(ctx, spec, handler)
    return
  }
  ctx.inject(['connection'], (connCtx: any) => {
    bindFetchRegistry(connCtx, connCtx.get('connection'), spec, handler)
  })
}

function bindFetchRegistry(ctx: any, connection: any, spec: CarrierRouteSpec, handler: NodeRouteHandler): void {
  ctx.effect(() => connection.fetch.register({
    path: spec.path,
    methods: [...spec.methods],
    requestBody: spec.requestBody ?? 'buffered',
    fetch: (request: Request) => nodeHandlerToFetch(handler, request),
  }), spec.label)
}

function bindWebServer(ctx: any, spec: CarrierRouteSpec, handler: NodeRouteHandler): void {
  const webServer = ctx?.get?.('webServer')
  if (!webServer) return
  ctx.effect(() => webServer.register({ kind: 'exact', path: spec.path, handler }), spec.label)
}
