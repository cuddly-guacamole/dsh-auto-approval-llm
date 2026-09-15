/**
 * Session-panel visibility predicate, consumed by the session header control.
 * Kept as its own module so the contract is unit-testable without a DOM.
 *
 * The host session-mode route normalises a legacy `auto` session to
 * `auto-approval` and leaves the modern upstream `auto` untouched, so only
 * the plugin-owned machine value shows the panel; every other mode (upstream
 * Auto review, a foreign preset, an unknown session) hides it in `auto` mode.
 */
export const PANEL_GATED_SESSION_MODES = ['auto-approval'] as const

/**
 * @param panelMode - user preference: always show, follow the session tier, or hide.
 * @param sessionMode - raw session identity reported by the host; null/undefined
 *   both mean "no resolvable preset".
 * @returns whether the approval status panel should render for the session.
 */
export function computePanelVisible(panelMode: 'on' | 'auto' | 'off', sessionMode: string | undefined): boolean {
  if (panelMode === 'off') return false
  if (panelMode === 'auto' && !(PANEL_GATED_SESSION_MODES as readonly string[]).includes(sessionMode ?? '')) return false
  return true
}
