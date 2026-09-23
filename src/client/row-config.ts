/**
 * Client contract for the Plugins page's row configuration seat.
 *
 * The Plugins page keys a row's configuration by `<package name>#<row id>` and
 * hands that entry the Host form of the row's settings namespace. Both facts
 * are the page owner's, so they are mirrored here as literals: a client bundle
 * may not import the owner package (the client bundle purity gate forbids
 * cross-plugin value imports) and a key that differs by one character renders
 * nothing at all, with no error anywhere.
 *
 * The form is ABSENT whenever the Host does not serve this namespace to the
 * client — the profile entry is not ACTIVE yet, or it exposes no volatile
 * fields — while the page still renders the entry. Routing every read of the
 * form through this module keeps that case one decision with one place to
 * test, instead of a condition repeated at each control.
 */
import { EDITABLE_CONFIG_KEYS, HOST_ONLY_KEYS } from '../auto/decision.js'

/** Package name the Plugins page keys a bundle's rows by. */
export const PLUGIN_PACKAGE_NAME = '@quill507/dsh-auto-approval-llm'
/** Row id this bundle's patch declares; the settings plane calls the same string the namespace. */
export const PLUGIN_ROW_ID = 'auto-approval-llm'
/** Slot one row's own configuration registers under. */
export const ROW_CONFIG_SLOT = 'plugins.row.config'

/** Key a row's configuration registers under. Mirrors the page owner's rule. */
export function rowConfigKey(bundle: string, rowId: string): string {
  return `${bundle}#${rowId}`
}

/** Key the Plugins page dispatches for this bundle's row. */
export const ROW_CONFIG_KEY = rowConfigKey(PLUGIN_PACKAGE_NAME, PLUGIN_ROW_ID)

/** One ordered field operation inside the namespace section. */
export type ConfigPathOp =
  | { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unset'; readonly path: readonly string[] }

/** The form face the Plugins page hands a row configuration entry. */
export interface RowConfigForm {
  readonly state: {
    /** `ready` once the Host answered with a section this client may edit. */
    readonly status: 'loading' | 'ready' | 'unavailable'
    /** Accepted Host values for the namespace. */
    readonly value?: Record<string, unknown> | undefined
    /** Revision fencing the next write. */
    readonly revision?: number | undefined
    /** Whether the Host document accepts writes. */
    readonly writable?: boolean | undefined
  }
  /** Queue one atomic namespace mutation fenced with the revision the editor read. */
  mutate(ops: readonly ConfigPathOp[], expectedRevision?: number): Promise<boolean>
}

/**
 * The form to read and write through, or undefined when the page handed none or
 * the one it handed cannot do both. `undefined` is the read-only state: the
 * page renders the stored values and no control, because a control whose write
 * has no channel would silently discard the edit.
 */
export function usableForm(form: RowConfigForm | undefined | null): RowConfigForm | undefined {
  if (form === undefined || form === null) return undefined
  const state = form.state
  if (state === undefined || state === null) return undefined
  if (state.status !== 'ready') return undefined
  if (state.value === undefined || state.value === null) return undefined
  if (state.writable === false) return undefined
  if (typeof form.mutate !== 'function') return undefined
  return form
}

/** One settings write: the fields to set, and the fields to return to their base. */
export interface ConfigWrite {
  /** Field values to write, keyed by config key. */
  value?: Record<string, unknown> | undefined
  /** Fields to revert to the inherited value. */
  unset?: readonly string[] | undefined
}

/** Keys the settings plane refuses: never named by an op this client builds. */
const HOST_OWNED = new Set<string>(HOST_ONLY_KEYS)

/**
 * Path ops for one write, restricted to the keys the Host config plane accepts.
 *
 * The plane projects only fields under a volatile ancestor and refuses a write
 * to any other key, so a host-derived value such as `trustedDirs` is dropped
 * here rather than failing the whole save: the page shows those keys read-only
 * and never submits them. The host-owned keys are dropped by name as well as by
 * the card's own list, so a payload that carries one anyway — a dirty answer
 * from the route, a future key the two lists disagree about — still cannot reach
 * the plane and cannot reach the operator's configuration.
 *
 * A field whose value is `undefined` is dropped too — an op serialized without
 * its value clears the field on the Host, so an unset stays something the caller
 * asks for by name.
 */
export function buildMutateOps(write: ConfigWrite): ConfigPathOp[] {
  const ops: ConfigPathOp[] = []
  const value = write.value ?? {}
  const editable = new Set<string>(EDITABLE_CONFIG_KEYS)
  for (const key of EDITABLE_CONFIG_KEYS) {
    if (HOST_OWNED.has(key)) continue
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (value[key] === undefined) continue
    ops.push({ op: 'set', path: [key], value: value[key] })
  }
  for (const key of write.unset ?? []) {
    if (!editable.has(key)) continue
    if (HOST_OWNED.has(key)) continue
    if (Object.prototype.hasOwnProperty.call(value, key)) continue
    ops.push({ op: 'unset', path: [key] })
  }
  return ops
}

/** One batch of stored values the read-only route offers from the retired document. */
export interface LegacyImport {
  /** Fields the route offers, in the host's own order. */
  readonly keys: readonly string[]
  /** The offered values, keyed by config key. */
  readonly value: Record<string, unknown>
}

/** The write one import submits, and the fields it can name. */
export interface LegacyImportWrite {
  /** The fields the plane owns, with the values the retired document stored. */
  readonly write: ConfigWrite
  /** The fields that write names, in the offered order. */
  readonly keys: string[]
}

/**
 * The import batch off a route snapshot, or undefined when it offers none.
 *
 * The payload crosses a wire and is re-read on every snapshot refresh, so it is
 * validated here rather than trusted: a batch that is absent, empty, not an
 * object, or carries a non-array key list reads as "nothing to import", which
 * renders no banner instead of a button that would write nothing.
 */
export function legacyImportOf(snapshot: unknown): LegacyImport | undefined {
  const raw = (snapshot as { legacyImport?: unknown } | null | undefined)?.legacyImport
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const offered = raw as { keys?: unknown; value?: unknown }
  const keys = Array.isArray(offered.keys) ? offered.keys.filter((key): key is string => typeof key === 'string') : []
  if (keys.length === 0) return undefined
  const value = offered.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return { keys, value: value as Record<string, unknown> }
}

/**
 * The write one import submits, projected to the fields the plane owns.
 *
 * The host-owned keys are dropped HERE, not only where the route filtered them:
 * a payload is data, and one dirty key would make the plane refuse the whole
 * batch (`Config field "x" is not volatile`) or, worse, write a field the
 * operator owns. `buildMutateOps` applies the same projection again when the
 * write becomes ops, so neither layer is the only thing standing between a
 * retired file and the live namespace.
 */
export function legacyImportWrite(imported: LegacyImport): LegacyImportWrite {
  const value: Record<string, unknown> = {}
  const keys: string[] = []
  for (const key of imported.keys) {
    if (HOST_OWNED.has(key)) continue
    if (!Object.prototype.hasOwnProperty.call(imported.value, key)) continue
    if (imported.value[key] === undefined) continue
    if (!EDITABLE_CONFIG_KEYS.includes(key)) continue
    value[key] = imported.value[key]
    keys.push(key)
  }
  return { write: { value }, keys }
}

/**
 * The values the named fields carried before an import, for the undo.
 *
 * Only own keys are recorded: a field the configuration did not carry is absent
 * rather than present-and-undefined, and the undo has to tell those two apart to
 * choose between writing a value back and returning the field to its base.
 */
export function legacyImportBefore(current: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = typeof current === 'object' && current !== null ? (current as Record<string, unknown>) : {}
  const before: Record<string, unknown> = {}
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    before[key] = source[key]
  }
  return before
}

/**
 * The write that undoes an import, naming the imported fields alone.
 *
 * A field the pre-import configuration carried is written back to the value it
 * had; one it did not carry is returned to its base with an `unset`, which is
 * what the page showed before the import. Every other field stays unnamed, so no
 * op touches it: path ops change only the paths they name.
 */
export function legacyUndoWrite(before: Record<string, unknown>, keys: readonly string[]): ConfigWrite {
  const value: Record<string, unknown> = {}
  const unset: string[] = []
  for (const key of keys) {
    if (HOST_OWNED.has(key)) continue
    if (!EDITABLE_CONFIG_KEYS.includes(key)) continue
    if (Object.prototype.hasOwnProperty.call(before, key) && before[key] !== undefined) value[key] = before[key]
    else unset.push(key)
  }
  return { value, unset }
}
