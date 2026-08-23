/**
 * dsh-auto-approval-llm · deterministic workspace-facts probe for the
 * structured review context (metadata only; no file content is ever read).
 */

import { lstatSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ContextSummary } from './decision.js'
import { isWithin, normalizePath } from './paths.js'

/** Resolve the realpath of the deepest existing ancestor of `input`. */
function resolveDeepest(input: string): string | undefined {
  let probe = input
  while (true) {
    try {
      return realpathSync(probe)
    } catch {
      const parent = dirname(probe)
      if (parent === probe) return undefined
      probe = parent
    }
  }
}

/**
 * Probe a target path for structured facts: existence, kind and size.
 *
 * Safety contract:
 * - lstat (never follows a symlink) supplies existence/kind/size metadata.
 * - A target that is textually inside the workspace is re-checked with the
 *   realpath of its deepest existing ancestor; when that resolution escapes
 *   the (resolved) workspace — a workspace symlink/junction pointing outside —
 *   the whole probe is omitted (undefined), never partially reported.
 * - A target textually outside the workspace is reported with existence and
 *   kind only; size stays null so an external file's scale is not disclosed.
 * - Any fs failure or invalid input returns undefined (fail closed): a probe
 *   error must never surface as fabricated facts.
 */
export function probeTargetFacts(
  targetPath: string | undefined,
  workspaceRoot: string | undefined,
): ContextSummary | undefined {
  if (typeof targetPath !== 'string' || targetPath === ''
    || typeof workspaceRoot !== 'string' || workspaceRoot === '') {
    return undefined
  }
  try {
    const target = normalizePath(targetPath, workspaceRoot, workspaceRoot)
    const workspace = normalizePath(workspaceRoot, workspaceRoot, workspaceRoot)
    const inside = isWithin(workspace, target)
    if (inside) {
      const resolved = resolveDeepest(target)
      if (resolved === undefined) return undefined
      const realWorkspace = resolveDeepest(workspace) ?? workspace
      const resolvedNorm = normalizePath(resolved, realWorkspace, realWorkspace)
      const realWorkspaceNorm = normalizePath(realWorkspace, realWorkspace, realWorkspace)
      if (!isWithin(realWorkspaceNorm, resolvedNorm)) return undefined
    }
    let stats
    try {
      stats = lstatSync(target)
    } catch {
      return { targetExists: false, targetKind: 'missing', targetSize: null }
    }
    return {
      targetExists: true,
      targetKind: stats.isDirectory() ? 'dir' : 'file',
      targetSize: inside ? stats.size : null,
    }
  } catch {
    return undefined
  }
}