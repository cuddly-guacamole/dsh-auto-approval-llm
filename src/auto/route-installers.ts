/**
 * dsh-auto-approval-llm · web route installers that own no entry-local state.

 * These three register their routes from the shared route table and the shared
 * HTTP pipeline alone: no approval-state map, no audit writer, no settings
 * plane. They therefore sit outside the entry, which imports them back by name
 * and re-exports them so the package export surface is unchanged.
 */
import { methodOf, registerCarrierFetchRoute } from './carrier-route.js'
import { isTrustedFetchRequest } from './trust.js'
import {
  LLM_MODELS_ROUTE,
  PROVIDERS_ROUTE,
  REASONING_EFFORTS_ROUTE,
  REVIEWER_CREDENTIAL_REF,
  REVIEWER_CREDENTIAL_ROUTE,
  clearReviewerKeyFromCredentialFile,
} from './route-table.js'
import { json, readJson } from './http-pipeline.js'

export function installReviewerCredentialRoute(ctx: any): void {
  registerCarrierFetchRoute(ctx, {
    path: REVIEWER_CREDENTIAL_ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: reviewer credential route',
  }, async (request: Request): Promise<Response> => {
      const method = methodOf(request)
      // Credential plane: loopback-same-origin only (privileged domain).
      if (!isTrustedFetchRequest(request, [])) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      // Resolve the service per request: the provider mounts asynchronously
      // after apply(), so a closure captured earlier would stay undefined and
      // report "unavailable" even when the store is up.
      const credentials = ctx.get('credentials')
      try {
        if (method === 'GET') {
          if (!credentials) {
            return json(200, { ok: true, value: { configured: false, source: undefined, writable: false } })
          }
          const info = await credentials.describe(REVIEWER_CREDENTIAL_REF)
          return json(200, {
            ok: true,
            value: {
              configured: info?.configured === true,
              source: info?.source ?? undefined,
              writable: info?.writable === true,
            },
          })
        }
        if (method === 'DELETE') {
          // DELETEs carry no body, so this branch must run before the JSON
          // body reader (which requires a JSON content type).
          // Never report a cleared credential unless the store actually
          // dropped it: an unset failure (read-only store, backend error)
          // must surface to the settings card instead of a silent ok:true
          // that leaves the API key live and still being sent (M3).
          if (credentials) {
            const cleared = await credentials.unset(REVIEWER_CREDENTIAL_REF).then(() => true).catch(() => false)
            if (!cleared) {
              return json(400, { ok: false, error: 'credential clear failed on the store' })
            }
          }
          // Also drop the shared-file fallback source (the line this plugin
          // appended earlier): a cleared reviewer key must not resurrect from
          // the credential file on the next review. The removal is reported
          // honestly — a 200 here means the key is gone from every source, so a
          // failure to rewrite the file is a 400 rather than a silent ok the
          // next review would contradict by sending the key again.
          const fileClear = clearReviewerKeyFromCredentialFile()
          if (fileClear === 'failed') {
            return json(400, { ok: false, error: 'credential clear failed on the shared credential file' })
          }
          return json(200, { ok: true })
        }
        const body = await readJson(request)
        if (method !== 'POST') {
          return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'GET, POST' })
        }
        if (!credentials) {
          return json(400, { ok: false, error: 'credential service unavailable' })
        }
        const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
        if (!apiKey) throw new TypeError('apiKey is required')
        await credentials.set(REVIEWER_CREDENTIAL_REF, apiKey)
        return json(200, { ok: true })
      } catch (error) {
        return json(400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
  })
}


/**
 * Hold a response until `current()` changes or the hold budget elapses. The
 * check runs in-process (no HTTP traffic), the timer is released on client
 * disconnect (the request signal aborts), and the caller answers with the
 * current state either way — a hold timeout is a heartbeat, never a resolution.
 */
export function holdWhile(request: Request, current: () => unknown, holdMs: number): Promise<void> {
  const startedAt = Date.now()
  const initial = current()
  return new Promise((resolve) => {
    let done = false
    let timer: any
    const finish = () => {
      if (done) return
      done = true
      if (timer !== undefined) clearInterval(timer)
      request.signal.removeEventListener('abort', finish)
      resolve()
    }
    request.signal.addEventListener('abort', finish, { once: true })
    timer = setInterval(() => {
      if (done) return
      if (current() !== initial || Date.now() - startedAt >= holdMs) finish()
    }, 200)
  })
}


// Provider/model catalog for the Issue #5 model-source pickers. Read-only
// display metadata (adapter route ids + discovered models), no credentials and
// no adapter internals cross the wire (dsh-llm already detaches these). Sits
// on the same loopback-only plane as the settings card that consumes it.
export function installLlmCatalogRoutes(ctx: any, llm: any): void {
  registerCarrierFetchRoute(ctx, {
    path: PROVIDERS_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: providers route',
  }, async (request: Request): Promise<Response> => {
      const method = methodOf(request)
      if (!isTrustedFetchRequest(request, [])) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      if (method !== 'GET') {
        return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'GET' })
      }
      try {
        const providers = (llm?.listProviders?.() ?? []).map((p: any) => ({ id: p.id, name: p.name ?? p.id }))
        return json(200, { ok: true, value: { providers } })
      } catch (error) {
        return json(400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
  })
  registerCarrierFetchRoute(ctx, {
    path: LLM_MODELS_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: llm-models route',
  }, async (request: Request): Promise<Response> => {
      const method = methodOf(request)
      if (!isTrustedFetchRequest(request, [])) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      if (method !== 'GET') {
        return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'GET' })
      }
      const url = new URL(request.url, 'http://x')
      const provider = url.searchParams.get('provider') ?? ''
      if (!provider) {
        return json(400, { ok: false, error: 'provider is required' })
      }
      try {
        const models = await llm.listModels(provider)
        return json(200, {
          ok: true,
          value: { models: models.map((m: any) => ({ provider: m.provider, id: m.id, name: m.name ?? m.id })) },
        })
      } catch (error) {
        // Unregistered provider surfaces as NO_ADAPTER — a 400 with the
        // adapter's message beats a bare stack in the picker.
        return json(400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
  })
  registerCarrierFetchRoute(ctx, {
    path: REASONING_EFFORTS_ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    label: 'dsh-auto-approval-llm: reasoning-efforts route',
  }, async (request: Request): Promise<Response> => {
      const method = methodOf(request)
      if (!isTrustedFetchRequest(request, [])) {
        return json(403, { ok: false, error: 'forbidden' })
      }
      if (method !== 'GET') {
        return json(405, { ok: false, error: 'method-not-allowed' }, { Allow: 'GET' })
      }
      const url = new URL(request.url, 'http://x')
      const provider = url.searchParams.get('provider') ?? ''
      const model = url.searchParams.get('model') ?? ''
      if (!provider || !model) {
        return json(400, { ok: false, error: 'provider and model are required' })
      }
      try {
        // Resolve the exact model's metadata from its owning adapter — the
        // adapter's own declared reasoning efforts drive the picker, so the
        // plugin never maintains a per-provider effort table.
        const info = await llm.resolveModelInfo(provider, model)
        const reasoning = info?.reasoning
        const efforts = Array.isArray(reasoning?.efforts)
          ? reasoning.efforts.map((e: any) => ({ id: e.id, name: e.name ?? e.id }))
          : []
        return json(200, {
          ok: true,
          value: { efforts, defaultEffort: reasoning?.defaultEffort ?? null },
        })
      } catch (error) {
        // Unknown provider/model or an adapter without resolveModel support —
        // an empty effort list (default-only picker) beats a hard error here.
        return json(200, { ok: true, value: { efforts: [], defaultEffort: null } })
      }
  })
}

