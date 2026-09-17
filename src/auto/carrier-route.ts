/**
 * Carrier-neutral registration for the plugin's exact HTTP routes.
 *
 * Every route registers on the connection plugin's carrier-neutral Fetch
 * registry (`connection.fetch.register`): the web carrier mounts that registry
 * under `/api` on its web server, and a shell-owned carrier dispatches the same
 * Fetch handler directly. Handlers are natively `(request: Request) => Response`
 * — there is no Node-shaped fallback, because a carrier only dispatches Fetch.
 *
 * One carrier fact is normalized here:
 *
 * - `POST` with `x-auto-approval-op: delete` is exposed to handlers as `DELETE`,
 *   because the Fetch registry carries `GET`/`HEAD`/`POST` only.
 */

/** The subset of a route descriptor both carriers understand. */
export interface CarrierRouteSpec {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody?: 'buffered' | 'streaming'
  readonly label: string
}

const DELETE_OP_HEADER = 'x-auto-approval-op'
const DELETE_OP_VALUE = 'delete'

/**
 * The method a Handler sees: the delete op rides a POST because the Fetch
 * registry carries GET/HEAD/POST only, so a client sends
 * `POST` + `x-auto-approval-op: delete` for a delete.
 */
export function methodOf(request: Request): string {
  if (request.method === 'POST' && request.headers.get(DELETE_OP_HEADER) === DELETE_OP_VALUE) return 'DELETE'
  return request.method
}

/**
 * Register one exact route as a native Fetch handler.
 *
 * The binding waits for `connection.fetch` instead of probing once: composition
 * rows mount in dependency order, so the carrier registry may not be up when
 * apply() runs. A context with neither the registry nor `ctx.inject` registers
 * nothing; a native registration cannot be expressed on the web server directly,
 * and doing so would shadow the carrier's `/api` prefix route and bypass its
 * request fence.
 */
export function registerCarrierFetchRoute(
  ctx: any,
  spec: CarrierRouteSpec,
  handler: (request: Request) => Promise<Response> | Response,
): void {
  const connection = ctx?.get?.('connection')
  if (connection?.fetch?.register !== undefined) {
    bindFetch(ctx, connection, spec, handler)
    return
  }
  if (typeof ctx?.inject !== 'function') return
  ctx.inject(['connection'], (connCtx: any) => {
    bindFetch(connCtx, connCtx.get('connection'), spec, handler)
  })
}

function bindFetch(
  ctx: any,
  connection: any,
  spec: CarrierRouteSpec,
  handler: (request: Request) => Promise<Response> | Response,
): void {
  ctx.effect(() => connection.fetch.register({
    path: spec.path,
    methods: [...spec.methods],
    requestBody: spec.requestBody ?? 'buffered',
    fetch: (request: Request) => handler(request),
  }), spec.label)
}
