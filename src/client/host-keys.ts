/**
 * Read-only display rows for the config-file-only settings keys.
 *
 * Kept dependency-free (no React, no DSH objects) so the derivation is
 * unit-testable: the card imports this, the contract test imports the compiled
 * module. The key list is HOST_ONLY_KEYS — the same owner `preserveHostKeys`
 * reads, so the card can never advertise a set the save path disagrees with.
 */
import { HOST_ONLY_KEYS } from '../auto/decision.js'

export interface HostKeyRow {
  key: string
  /** Display text, or null when the key carries no effective value. */
  value: string | null
}

/**
 * Render one effective value as display text, or null when it is unset.
 *
 * `false` and `0` are VALUES, not emptiness: both are the fail-closed defaults
 * of keys in this set (rulesDryRun / loopDetectionThreshold), so a truthiness
 * check here would show them as unset and misreport the active configuration.
 */
export function formatHostKeyValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value.trim() === '' ? null : value
  if (Array.isArray(value)) {
    const joined = value.map((item) => (typeof item === 'string' ? item : String(item))).join(', ')
    return joined.trim() === '' ? null : joined
  }
  if (typeof value === 'object') {
    let json: string | undefined
    try {
      json = JSON.stringify(value)
    } catch {
      return null
    }
    return json === undefined || json === '{}' ? null : json
  }
  return String(value)
}

/** One display row per host-only key, in owner order, read from the effective config. */
export function hostOnlyRows(effective: unknown): HostKeyRow[] {
  const source = typeof effective === 'object' && effective !== null ? (effective as Record<string, unknown>) : {}
  return HOST_ONLY_KEYS.map((key) => ({ key, value: formatHostKeyValue(source[key]) }))
}
