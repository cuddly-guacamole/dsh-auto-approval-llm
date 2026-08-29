// Protocol presence detection — diagnostics and contract tests only. Never
// consulted by the running watchers: both watchers are always mounted and
// idle whenever their source is absent (fail-closed by construction, 0.0.12
// design §2). Deliberately does NOT look at `ctx.remote`: rc.2 ships a
// remote service whose approval/request event is absent from its allowlist,
// so its mere presence says nothing about which protocol is live.
export type ClientProtocol = 'legacy' | 'remote' | 'none'

export function detectClientProtocol(ctx: any): ClientProtocol {
  const sessions = ctx.get('sessions')
  const currentId = sessions?.list?.getSnapshot?.()?.current
  const snapshot = sessions?.binding?.(currentId)?.session?.getSnapshot?.()
  const pending = snapshot?.pending
  if (Array.isArray(pending) && pending.some((i: any) => typeof i?.respond === 'function')) {
    return 'legacy'
  }
  const snapshotMap = ctx.get('uiSession')?.pendingInteractions?.getSnapshot?.()
  if (snapshotMap instanceof Map && [...snapshotMap.values()].some((i: any) => typeof i?.answer === 'function' && 'result' in i)) {
    return 'remote'
  }
  return 'none'
}