/**
 * dsh-auto-approval-llm · host-side symlink/junction escape guard (core).
 *
 * Extracted from index.ts so the resolution discipline is contract-testable:
 * every target and the workspace root are resolved FRESH per call through the
 * injected `resolve` function (realpath of the deepest existing ancestor).
 *
 * Why per-call resolution matters: `dsh web` serves every workspace from one
 * process, and a workspace directory can be re-created under a different
 * realpath during a long process lifetime. A process-wide cached anchor made
 * every OTHER workspace's targets look like escapes (their realpaths are not
 * inside the first-resolved workspace) and hard-denied all of their file
 * mutations (multi-workspace regression, 2026-09-03 audit). editdiff.ts and
 * probe.ts already resolve per call; this module keeps the guard on the same
 * discipline.
 */
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { isCriticalPath, isWithin, normalizePath, runtimeStateTargetInZone } from './paths.js'
import { realpathCriticalReason } from './category.js'
import { symlinkGuardTargets } from './policy.js'

/**
 * Realpath of the deepest existing ancestor of `input` (probe.ts-style).
 * `realpathSync` anchors a relative spelling to `process.cwd()` — the dsh
 * process's directory, not the session workspace — so callers only ever pass
 * already-normalized absolute paths (a raw tool argument must never reach
 * this function; the guard resolves `textual` instead, see symlinkEscapeReason).
 */
export function resolveDeepest(input: string): string | undefined {
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
 * Symlink-escape verdict for one tool call. The pure policy layer is
 * deliberately fs-free and only compares textual paths, so a workspace
 * symlink pointing outside (e.g. `ws/ln -> ~/.bashrc`) would let a
 * write/read that is textually "inside the workspace" actually hit an
 * external file and defeat the home/DSH_HOME/credential fuses. This guard
 * resolves the deepest existing ancestor of each target and hard-denies when
 * its realpath leaves the allowed zones. Best-effort: any fs failure returns
 * undefined and the normal (textual) policy decides.
 *
 * `resolve` is injected and called FRESH for the workspace root and for every
 * target inside one invocation — never cached across calls or workspaces (see
 * the module comment).
 */
export function symlinkEscapeReason(
  exec: any,
  roots: any,
  resolve: (input: string) => string | undefined,
): string | undefined {
  const args = (typeof exec.arguments === 'object' && exec.arguments !== null && !Array.isArray(exec.arguments)) ? exec.arguments : undefined
  if (args === undefined) return undefined
  const name = String(exec.name ?? '')
  const targets = symlinkGuardTargets(name, args)
  if (targets === undefined || targets.length === 0) return undefined
  const workspaceReal = resolve(roots.workspace)
  if (workspaceReal === undefined) return undefined
  const realWsNormalized = normalizePath(workspaceReal, roots.workspace, roots.home)
  const aggressive = roots.mode === 'aggressive'
  // Custom trusted directories join both zone checks (G8): a target that is
  // textually inside a trustedDir is still hard-denied when its realpath
  // escapes every allowed zone (workspace ∪ plugin zone ∪ trustedDirs).
  const trustedZone: string[] = [...(roots.allowedDshSubpaths ?? []), ...(roots.trustedDirs ?? [])]
  for (const target of targets) {
    const textual = normalizePath(target, roots.workspace, roots.home)
    // Only a target that is textually inside the workspace (or inside a
    // trusted plugin-development path, which the policy auto-allows) is this
    // guard's business: a realpath escaping it is worth hard-denying only
    // when the textual target pretended to be local/trusted. Any other
    // textually-external target is judged by the normal hard-deny / 'ask'
    // escalation instead of being turned into an unconditional hard deny.
    // Under aggressive the position gate is relaxed, so the realpath re-check
    // covers every textual target — the remaining credential/system fence.
    const inTrustedZone = trustedZone.some(root => isWithin(root, textual))
    if (!isWithin(roots.workspace, textual) && !inTrustedZone && !aggressive) continue
    // Resolve the NORMALIZED path, never the raw argument: `resolve` ends in
    // realpathSync, which anchors a relative spelling ('hello.txt', '.') to
    // `process.cwd()` — the dsh process's directory, not the session
    // workspace. `dsh web` serves every workspace from one process, so the
    // raw form turned each relative target into a realpath rooted outside the
    // workspace and hard-denied it. Resolving `textual` keeps the guard's
    // intent (compare the judged target against where it actually lands)
    // while making the resolution independent of the process cwd.
    const resolved = resolve(textual)
    if (resolved === undefined) continue
    const normalized = normalizePath(resolved, roots.workspace, roots.home)
    // Independent runtime-state re-check, orthogonal to zone escape: a
    // textual workspace/trusted-zone target whose RESOLVED landing spot is a
    // plugin runtime-state file must hard-deny even when the realpath stays
    // inside every allowed zone (the escape check below stays silent there).
    // Mode-independent on purpose: mutating approval/audit/learning state is
    // never a routine write under either position mode.
    if (runtimeStateTargetInZone(normalized, roots.allowedDshSubpaths)) {
      return `target resolves into plugin runtime state via a symlink: ${normalized}`
    }
    const escape = realpathCriticalReason(textual, normalized, roots, roots.trustedDirs, realWsNormalized)
    if (escape === undefined) continue
    if (aggressive) {
      // An escape outside every allowed zone keeps its hard deny only when
      // it lands on a critical tree, DSH_HOME, or plugin runtime state; a
      // plain external target is the aggressive design goal and stays open.
      if (isCriticalPath(normalized, roots) || isWithin(roots.dshHome, normalized) || runtimeStateTargetInZone(normalized, roots.allowedDshSubpaths)) {
        return escape
      }
      continue
    }
    return escape
  }
  return undefined
}