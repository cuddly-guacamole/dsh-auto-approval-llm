// Ported from @nanmicoder/dsh-auto-mode (policy.js).
// MIT License, Copyright (c) 2026 程序员阿江-Relakkes (https://github.com/NanmiCoder/dsh-auto-mode).
// Retained per the MIT License: this is a substantial portion of the original.
//
// NOTE: this file is intentionally type-checked (no `@ts-nocheck`). The
// fail-closed classifier must not escape the compiler — DSH schema drift must
// surface at build time, not at runtime. Keep the helper types below minimal so
// the logic stays the single source of truth.
import { hardDestructiveTargetReason, isCriticalPath, isProtectedProjectPath, isWithin, normalizePath, runtimeStateBasename, runtimeStateTargetInZone, runtimeStateTargetReason, } from './paths.js';
import { assessShell, hardDenyShellReason, shellReadsCredentialMaterial } from './shell.js';
import { isEffectiveRoutine, sensitiveBasenameAt } from './category.js';
import { DIRECT_HUMAN_TOOL } from './constants.js';
import * as riskTokens from './risk-tokens.js';

// Re-exported for callers/tests that referenced the policy-owned names; the
// canonical definitions now live in paths.ts so shell.ts can share them
// without a shell↔policy import cycle.
export { RUNTIME_STATE_BASENAMES, runtimeStateTargetReason } from './paths.js';

/** Runtime roots the classifier reasons about (mirrors `resolveRoots` in paths.ts). */
export interface Roots {
    workspace: string
    home: string
    dshHome?: string
    tempRoots?: string[]
    allowedDshSubpaths?: string[]
    /** Position-gate mode injected live by rootsFor; absent = standard. */
    mode?: 'standard' | 'aggressive'
    /** Extra trusted directories injected live by rootsFor (standard mode only). */
    trustedDirs?: string[]
}

/** Minimal shape of a tool execution the classifier inspects. */
export interface ExecLike {
    name: string
    arguments?: unknown
    agent?: { session?: unknown }
}

/** Deterministic first-pass classification result. */
export interface ToolAssessment {
    decision: 'allow' | 'deny' | 'ask'
    reason?: string
    classifierEligible?: boolean
    /** Files the shell classifier predicts the command will create (artifacts). */
    plannedCreates?: string[]
    /**
     * Provenance for a deletion the shell classifier proved targets only paths
     * this session created. Declared here rather than only produced inside the
     * `@ts-nocheck` shell module so the compiler tracks the signal its consumers
     * depend on: re-assembling an assessment without carrying it would quietly
     * re-lock the exemption, which is exactly the defect it was written to fix.
     */
    sessionArtifactDeletion?: boolean
    /**
     * True when a READ target is credential material rather than protected
     * workspace metadata: a sensitive basename or tree (`.env`, `.npmrc`,
     * `.ssh/…`) or a critical system tree. The `protected` category already
     * covers both, and the two halves must not be unlocked together — the
     * opt-out exists to stop dead-ending workspace metadata (`.git/`,
     * `.vscode/`), not to hand private keys and token stores to a reviewer.
     * Carried as a structured field for the same reason as
     * `sessionArtifactDeletion`: a consumer that re-derives it from a reason
     * string is exactly the coupling the plugin forbids for authorization
     * signals.
     */
    credentialRead?: boolean
}

/**
 * Whether a read operand is credential material (as opposed to metadata that is
 * merely protected). `sensitiveBasenameAt` is location-free and
 * `isCriticalPath` covers the credential trees and system roots, so the pair is
 * the same predicate the `protected` category is built from, minus the
 * workspace-metadata dirs.
 */
function credentialReadTarget(normalized: string, roots: Roots): boolean {
    return sensitiveBasenameAt(normalized, roots) || isCriticalPath(normalized, roots);
}

type JsonObject = Record<string, unknown>

function record(value: unknown): JsonObject | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as JsonObject)
        : undefined
}
function pathArgument(args: unknown): string | undefined {
    if (args === null || typeof args !== 'object') return undefined
    for (const key of ['file_path', 'path', 'cwd', 'workdir']) {
        const value = (args as JsonObject)[key]
        if (typeof value === 'string')
            return value
    }
    return undefined
}
/**
 * Resolve the concrete file-mutation targets of a tool call. `apply_patch`
 * nests its paths under `patches[].file_path` (never top-level), so the flat
 * `pathArgument` lookup would miss them and let the protected-path fuses be
 * skipped. Returns the list of patch targets, or `undefined` when any patch
 * entry lacks a readable path (callers must then fail closed).
 */
export function patchTargetPaths(args: unknown, name: string): string[] | undefined {
    if (name === 'apply_patch') {
        const rawPatches = (args as JsonObject)?.patches;
        const patches = Array.isArray(rawPatches) ? (rawPatches as unknown[]) : [];
        const targets: string[] = [];
        for (const patch of patches) {
            if (typeof (patch as JsonObject)?.file_path !== 'string' || (patch as JsonObject).file_path === '')
                return undefined;
            targets.push((patch as JsonObject).file_path as string);
        }
        return targets.length > 0 ? targets : undefined;
    }
    const path = pathArgument(args);
    return path === undefined ? undefined : [path];
}
/** Mutation/read tool names whose path call-args the host symlink guard checks. */
const SYMLINK_GUARD_MUTATION = new Set(['write', 'edit', 'apply_patch']);
/**
 * Resolve the concrete path operands the host-side symlink-escape guard must
 * check for a tool call. Returns the target list for mutation tools, the
 * `str_replace_editor` path (every command, `view` included — see below), the
 * `read`/`read_image` file path, the `grep`/`glob` path, and the `lsp` cwd;
 * `undefined` when the tool carries no checked path operand.
 *
 * `view` used to be excluded here on the reading that only mutations could
 * escape through a link. That left the one reader with no realpath re-check at
 * all: a workspace junction pointing at a credential file was read through
 * `view` with a static allow, while the same path through `read` was gated.
 * The guard's own position rule still decides whether a target is its business
 * (textually inside the workspace/trusted zone, or any target under the
 * aggressive mode), so a textually external target keeps its ordinary
 * hard-deny / ask escalation rather than becoming an unconditional deny.
 *
 * Kept pure so contract tests pin the exact per-tool spelling (grep/glob read
 * `path`, lsp reads `cwd`) and the host guard cannot silently drop a family
 * member (A-via-symlink gap).
 */
export function symlinkGuardTargets(name: string, args?: unknown): string[] | undefined {
    if (SYMLINK_GUARD_MUTATION.has(name))
        return patchTargetPaths(args, name) ?? [];
    if (name === 'str_replace_editor')
        return typeof (args as JsonObject)?.path === 'string' ? [(args as JsonObject).path as string] : [];
    if (name === 'read' || name === 'read_image')
        return typeof (args as JsonObject)?.file_path === 'string' ? [(args as JsonObject).file_path as string] : [];
    if (name === 'grep' || name === 'glob')
        return typeof (args as JsonObject)?.path === 'string' ? [(args as JsonObject).path as string] : [];
    if (name === 'lsp')
        return typeof (args as JsonObject)?.cwd === 'string' ? [(args as JsonObject).cwd as string] : [];
    return undefined;
}
/**
 * Audit-only structured read detection (pure): basenames of plugin
 * runtime-state files a structured (non-shell) read tool opens — `read` /
 * `read_image` through file_path, `grep` and `str_replace_editor` `view`
 * through path. The judgment mirrors shell.ts's runtimeStateReadHits
 * (basename membership via paths.ts runtimeStateBasename), so both planes
 * share one rule and no second membership test can drift. Faces with no
 * statically attributable single-file operand are uncovered by design:
 * glob/lsp search a root tree or pattern instead of opening one file, and
 * write/edit/apply_patch mutate rather than read. Never feeds any verdict —
 * the host uses the result strictly as an observability trail.
 */
export function structuredRuntimeStateReadHits(name: string, args: unknown, roots: Roots): string[] {
    const object = record(args);
    if (object === undefined)
        return [];
    let operand: unknown;
    if (name === 'read' || name === 'read_image') {
        operand = object['file_path'];
    }
    else if (name === 'grep') {
        operand = object['path'];
    }
    else if (name === 'str_replace_editor' && object['command'] === 'view') {
        operand = object['path'];
    }
    else {
        return [];
    }
    if (typeof operand !== 'string' || operand === '')
        return [];
    const base = runtimeStateBasename(normalizePath(operand, roots.workspace, roots.home));
    return base === undefined ? [] : [base];
}
function serializedArguments(argumentsValue: unknown): string {
    try {
        return JSON.stringify(argumentsValue);
    }
    catch {
        return '';
    }
}
function containsCredentialMaterial(argumentsValue: unknown): boolean {
    return /(?:BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b|\bAKIA[0-9A-Z]{16}\b|(?:aws_secret_access_key|aws_access_key_id|secret_access_key|access_key_id)\s*=\s*[A-Za-z0-9/+=_-]{16,}|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\.ssh[\\/](?:id_|config)|\.credentials\.yaml)/i
        .test(serializedArguments(argumentsValue));
}
const { DESTRUCTIVE_TOOL, EXTERNAL_WRITE_TOOL, SECURITY_CHANGE_TOOL } = riskTokens;
function riskyPluginToolReason(name: string): string | undefined {
    if (DESTRUCTIVE_TOOL.test(name))
        return `registered tool name indicates a destructive operation: ${name}`;
    if (EXTERNAL_WRITE_TOOL.test(name))
        return `registered tool name indicates an external write: ${name}`;
    if (SECURITY_CHANGE_TOOL.test(name))
        return `registered tool name indicates a security-boundary change: ${name}`;
    return undefined;
}
/** Exact, audited session/control-plane tools whose effects stay in Harness state. */
const SESSION_STATE_TOOLS = new Set([
    'ask_user_question',
    'todo_write',
    'get_goal',
    'create_goal',
    'update_goal',
    'exit_plan_mode',
    'skill',
]);
/** Read-only tools backed by owner/workspace-authorized Harness services. */
const HARNESS_READ_TOOLS = new Set([
    'job_output',
    'job_list',
    'schedule_list',
    'session_search',
    'session_event_search',
    'session_trace',
    'session_event_trace',
    'session_event_read',
    'terminal_read',
    'terminal_list',
    'cordis_inspect_list',
    'cordis_inspect_query',
    'cordis_inspect_self',
]);
/** Lifecycle controls that stop only owner-scoped background work. */
const OWNER_CONTROL_TOOLS = new Set([
    'job_kill',
    'terminal_signal',
    'terminal_close',
]);
/**
 * Audited AgentTeams control calls. These mutate only workspace-local team
 * coordination state. Member file/shell calls are separate tool executions
 * and inherit Auto from their captain in the runtime integration.
 *
 * Membership is driven by what the installed package actually registers
 * (`dsh-experimental-tool-agent-team` exports exactly the nine names below).
 * The nine `agent_teams_*` names inherited from the upstream dsh-auto-mode
 * project are deliberately absent: nothing in the DSH_HOME tree registers
 * them, so they only widened the static allow plane against tools that do not
 * exist. A future package that does register that spelling gets the
 * unrecognized-tool fallback (ask, fail-closed) instead of a silent allow.
 */
const AGENT_TEAMS_CONTROL_TOOLS = new Set([
    // Scoped Agent Teams shared-task board: in-memory/journal coordination
    // state only (no filesystem, no shell, no network). `write_scopes` is
    // advisory metadata the service never resolves to a path.
    //
    // team_task_update carries a `delete` action, and these names are allowed
    // without argument inspection — the destructive regex below matches tool
    // NAMES, so it cannot see an action buried in the arguments. That is safe
    // only because the service implements the action as a tombstone (the board
    // still returns the record, and refuses while a live task depends on it).
    // If a future version made that action erase, this set membership would
    // silently auto-approve an erasure: re-check the upstream behaviour before
    // trusting these four names again.
    'team_task_create',
    'team_task_get',
    'team_task_list',
    'team_task_update',
]);
/**
 * Plugin-owned approval/audit state files. They live inside the trusted
 * plugin-development zone, so a plain zone-membership check would let an Auto
 * session silently overwrite its own approval history / audit trail; mutating
 * them must land on the explicit hard-deny path instead.
 * Canonical definitions live in paths.ts (RUNTIME_STATE_BASENAMES /
 * runtimeStateTargetReason / runtimeStateTargetInZone), re-exported above.
 */

/** Synchronous hard-deny reason suitable for the monotonic tool guard. */
export function hardDenyReason(exec: ExecLike, roots: Roots): string | undefined {
    const args = record(exec.arguments);
    if ((/^(?:web_fetch|curl|wget)/i.test(exec.name) || EXTERNAL_WRITE_TOOL.test(exec.name)) && containsCredentialMaterial(exec.arguments)) {
        return 'external call contains credential or private-key material';
    }
    if ((exec.name === 'bash' || exec.name === 'pwsh') && typeof args?.command === 'string') {
        return hardDenyShellReason(args.command, exec.name, roots);
    }
    if (['write', 'edit', 'apply_patch'].includes(exec.name)
        || (exec.name === 'str_replace_editor' && args?.command !== 'view')) {
        const targets = patchTargetPaths(args, exec.name);
        // Fail-closed: a mutation tool whose target cannot be resolved (e.g.
        // apply_patch with no/misshapen patches) must not pass the fuse.
        if (targets === undefined)
            return `mutation target is missing or unreadable for ${exec.name}`;
        for (const path of targets) {
            const reason = hardDestructiveTargetReason(path, roots);
            if (reason !== undefined)
                return `mutation targets ${reason}`;
        }
    }
    if (DESTRUCTIVE_TOOL.test(exec.name)) {
        const path = pathArgument(args);
        if (path !== undefined) {
            const reason = hardDestructiveTargetReason(path, roots);
            if (reason !== undefined)
                return `destructive plugin tool targets ${reason}`;
        }
    }
    return undefined;
}
/** Deterministic first-pass classification for every normal tool call. */
export function assessTool(exec: ExecLike, roots: Roots, artifacts: unknown): ToolAssessment {
    const hard = hardDenyReason(exec, roots);
    if (hard !== undefined)
        return { decision: 'deny', reason: hard, classifierEligible: false };
    const args = record(exec.arguments);
    const owner = exec.agent?.session;
    if ((exec.name === 'bash' || exec.name === 'pwsh') && typeof args?.command === 'string') {
        const shellAssessment = assessShell(args.command, exec.name, roots, artifacts, owner);
        // The credential floor has to cover the shell vector too. The category
        // layer labels a shell read of a sensitive path `protected` from its own
        // read-target check, so without this the widest reader of all would stay
        // unlockable by `protectedAutoReview` + an explicit `protected: 'auto'`.
        // The flag is only meaningful for a protected category, so it is added
        // exactly where the shell classifier reached a non-allow verdict.
        if (shellAssessment.decision !== 'allow' && shellReadsCredentialMaterial(args.command, exec.name, roots)) {
            return { ...shellAssessment, credentialRead: true };
        }
        return shellAssessment;
    }
    if (exec.name === 'bash' || exec.name === 'pwsh') {
        return { decision: 'ask', reason: `${exec.name} command argument is missing or invalid`, classifierEligible: false };
    }
    const readTools = new Set(['read', 'read_image', 'grep', 'glob', 'lsp']);
    if (readTools.has(exec.name)) {
        const path = pathArgument(args);
        if (path === undefined)
            return { decision: 'allow', reason: 'read-only project inspection', classifierEligible: false };
        const normalized = normalizePath(path, roots.workspace, roots.home);
        if (!isEffectiveRoutine(normalized, roots))
            return { decision: 'ask', reason: `reading outside the workspace requires semantic review: ${normalized}`, classifierEligible: true };
        // Protected workspace metadata (.env, .npmrc, .git/*, …) must not be
        // silently read through the `read` tool family. The shell path is gated
        // (`readPathsAreRoutine`), so routing the read *tool* to semantic review
        // here closes the mismatch (mirror of the F1 contract).
        if (isProtectedProjectPath(normalized, roots))
            return {
                decision: 'ask',
                reason: `reading protected project metadata requires semantic review: ${normalized}`,
                classifierEligible: true,
                ...(credentialReadTarget(normalized, roots) ? { credentialRead: true } : {}),
            };
        // A relaxation that newly admits a path outside the (position) workspace
        // must still fuse sensitive basenames anywhere: trusted-dir or
        // aggressive reads of `.env`/`.ssh/...` stay gated.
        if (!isWithin(roots.workspace, normalized) && sensitiveBasenameAt(normalized, roots))
            return {
                decision: 'ask',
                reason: `reading a sensitive path outside the workspace requires semantic review: ${normalized}`,
                classifierEligible: true,
                credentialRead: true,
            };
        return { decision: 'allow', reason: 'read-only project inspection', classifierEligible: false };
    }
    if (exec.name === 'write' || exec.name === 'edit') {
        const path = pathArgument(args);
        if (path === undefined)
            return { decision: 'ask', reason: `${exec.name} target path is missing`, classifierEligible: false };
        const normalized = normalizePath(path, roots.workspace, roots.home);
        if ((roots.allowedDshSubpaths ?? []).some(root => isWithin(root, normalized))) {
            // Unconditional deny, never an 'ask': an ask lands in the risk-tiered
            // approval pipeline where timeoutAction=allow turns an unanswered
            // countdown into an allow, silently rewriting the audit trail.
            if (runtimeStateTargetInZone(normalized, roots.allowedDshSubpaths))
                return { decision: 'deny', reason: `mutation of ${runtimeStateTargetReason(normalized)} is not permitted`, classifierEligible: false };
            // Provenance is recorded here too. This branch is how a write into an
            // allowed DSH_HOME subtree is allowed, and the plugin's own
            // development zone is one — so omitting the planned create would
            // leave the session-artifact exemption unreachable for exactly the
            // workspace this plugin is developed in, turning `rm` of a file the
            // session just created into a locked countdown. `plan()` keeps only
            // not-yet-existing paths inside an artifact area, so recording the
            // target here cannot outlive the create it describes.
            return {
                decision: 'allow',
                reason: 'trusted DSH_HOME path',
                classifierEligible: false,
                ...(exec.name === 'write' ? { plannedCreates: [normalized] } : {}),
            };
        }
        if (!isEffectiveRoutine(normalized, roots) || isProtectedProjectPath(normalized, roots)
            || (!isWithin(roots.workspace, normalized) && sensitiveBasenameAt(normalized, roots))) {
            return { decision: 'ask', reason: `mutation of external or protected path requires specific user authorization: ${normalized}`, classifierEligible: true };
        }
        // A write to a not-yet-existing workspace path is a session artifact in
        // the making: recording it lets settlement-time promotion feed the
        // rm fast path and the classifier's recent-creates context. (edit
        // cannot create files, so it never plans.)
        return {
            decision: 'allow',
            reason: 'routine project-local file edit',
            classifierEligible: false,
            ...(exec.name === 'write' ? { plannedCreates: [normalized] } : {}),
        };
    }
    // apply_patch nests its targets under `patches[].file_path`; the flat path
    // lookup used by write/edit would miss them and silently classify a
    // anywhere-write as a routine unknown tool (fail-open). Require at least
    // one target and route every target through the same workspace/protected
    // gate as write/edit.
    if (exec.name === 'apply_patch') {
        const targets = patchTargetPaths(args, exec.name);
        if (targets === undefined) {
            return { decision: 'ask', reason: 'apply_patch target paths are missing or unreadable', classifierEligible: false };
        }
        const normalized = targets.map((target) => normalizePath(target, roots.workspace, roots.home));
        const patchState = normalized.find((n) => runtimeStateTargetInZone(n, roots.allowedDshSubpaths));
        if (patchState !== undefined)
            return { decision: 'deny', reason: `mutation of ${runtimeStateTargetReason(patchState)} is not permitted`, classifierEligible: false };
        if (normalized.every((n) => (roots.allowedDshSubpaths ?? []).some((root) => isWithin(root, n)))) {
            // Same provenance requirement as the write/edit branch above and for
            // the same reason: this is how a patch into an allowed DSH_HOME
            // subtree is allowed, so a session-artifact deletion of what it
            // created must still be recognisable afterwards.
            return {
                decision: 'allow',
                reason: 'trusted DSH_HOME path',
                classifierEligible: false,
                plannedCreates: [...normalized],
            };
        }
        const allRoutine = normalized.every((n) => isEffectiveRoutine(n, roots) && !isProtectedProjectPath(n, roots)
            && !(!isWithin(roots.workspace, n) && sensitiveBasenameAt(n, roots)));
        // Add-File hunks are creations; plan() keeps only the not-yet-existing
        // targets, so recording the full target list is enough.
        if (allRoutine) {
            return { decision: 'allow', reason: 'routine project-local file edit', classifierEligible: false, plannedCreates: [...normalized] };
        }
        return { decision: 'ask', reason: `apply_patch touches external or protected paths and requires specific user authorization`, classifierEligible: true, plannedCreates: [...normalized] };
    }
    if (exec.name === 'str_replace_editor') {
        const command = args?.command;
        const path = typeof args?.path === 'string' ? args.path : undefined;
        if (!['view', 'create', 'str_replace', 'insert'].includes(String(command))) {
            return { decision: 'ask', reason: 'str_replace_editor command is missing or invalid', classifierEligible: false };
        }
        if (path === undefined) {
            return { decision: 'ask', reason: 'str_replace_editor target path is missing', classifierEligible: false };
        }
        const normalized = normalizePath(path, roots.workspace, roots.home);
        if ((roots.allowedDshSubpaths ?? []).some(root => isWithin(root, normalized)) && command !== 'view') {
            // Same unconditional deny as write/edit: an ask would decay into a
            // timeout allow under timeoutAction=allow.
            if (runtimeStateTargetInZone(normalized, roots.allowedDshSubpaths))
                return { decision: 'deny', reason: `mutation of ${runtimeStateTargetReason(normalized)} is not permitted`, classifierEligible: false };
            // `create` makes a new file, so its provenance is recorded like the
            // other DSH_HOME allow branches; `str_replace`/`insert` require an
            // existing target and can create nothing.
            return {
                decision: 'allow',
                reason: 'trusted DSH_HOME path',
                classifierEligible: false,
                ...(command === 'create' ? { plannedCreates: [normalized] } : {}),
            };
        }
        if (command === 'view') {
            if (!isEffectiveRoutine(normalized, roots))
                return { decision: 'ask', reason: `reading outside the workspace requires semantic review: ${normalized}`, classifierEligible: true };
            // Mirror of the read family above: `view` is a read, so protected
            // workspace metadata (.env, .npmrc, .git/*, ...) must not be
            // silently readable through it. Without this the same path was an
            // ask through `read` and a static allow through `view`, which made
            // the reader choice the security boundary.
            if (isProtectedProjectPath(normalized, roots))
                return {
                    decision: 'ask',
                    reason: `reading protected project metadata requires semantic review: ${normalized}`,
                    classifierEligible: true,
                    ...(credentialReadTarget(normalized, roots) ? { credentialRead: true } : {}),
                };
            if (!isWithin(roots.workspace, normalized) && sensitiveBasenameAt(normalized, roots))
                return {
                    decision: 'ask',
                    reason: `reading a sensitive path outside the workspace requires semantic review: ${normalized}`,
                    classifierEligible: true,
                    credentialRead: true,
                };
            return { decision: 'allow', reason: 'read-only project inspection', classifierEligible: false };
        }
        // The create command is a file creation in progress: recording the
        // target lets settlement-time promotion feed the rm fast path and the
        // classifier's recent-creates context, same as write. The host's
        // create result is a plain string, so the plan/settle channel is the
        // only structured way to observe it (never parse the prose).
        const creates = command === 'create' ? [normalized] : undefined;
        if (!isEffectiveRoutine(normalized, roots) || isProtectedProjectPath(normalized, roots)
            || (!isWithin(roots.workspace, normalized) && sensitiveBasenameAt(normalized, roots))) {
            return {
                decision: 'ask',
                reason: `mutation of external or protected path requires specific user authorization: ${normalized}`,
                classifierEligible: true,
                ...(creates !== undefined ? { plannedCreates: creates } : {}),
            };
        }
        return {
            decision: 'allow',
            reason: 'routine project-local file edit',
            classifierEligible: false,
            ...(creates !== undefined ? { plannedCreates: creates } : {}),
        };
    }
    if (SESSION_STATE_TOOLS.has(exec.name)) {
        return { decision: 'allow', reason: 'trusted Harness session-state operation', classifierEligible: false };
    }
    if (HARNESS_READ_TOOLS.has(exec.name)) {
        return { decision: 'allow', reason: 'trusted read-only Harness operation', classifierEligible: false };
    }
    if (AGENT_TEAMS_CONTROL_TOOLS.has(exec.name)) {
        return { decision: 'allow', reason: 'trusted AgentTeams coordination operation', classifierEligible: false };
    }
    if (OWNER_CONTROL_TOOLS.has(exec.name)) {
        return { decision: 'allow', reason: 'trusted owner-scoped lifecycle control', classifierEligible: false };
    }
    // Persistent terminals retain cwd, environment, aliases, and interpreter
    // state across calls. A standalone text fragment cannot be parsed with the
    // same guarantees as one Bash/PowerShell invocation, so never fast-path it.
    if (exec.name === 'terminal_open' || exec.name === 'terminal_send') {
        return { decision: 'ask', reason: 'stateful terminal execution requires explicit approval', classifierEligible: false };
    }
    if (['web_search', 'web_fetch', 'time', 'weather'].includes(exec.name)) {
        return { decision: 'allow', reason: 'read-only external information lookup', classifierEligible: false };
    }
    if (['subagent', 'workflow', 'ralph', 'spawn_agent', 'spawn_teammate', 'send_message', 'wait_agent', 'list_agents', 'interrupt_agent', 'read_thread', 'wait_threads'].includes(exec.name)) {
        return { decision: 'allow', reason: 'orchestration call; child tool actions remain independently checked', classifierEligible: false };
    }
    if (['git_push', 'deploy', 'publish', 'send_email', 'create_issue', 'create_pull_request'].includes(exec.name)) {
        return { decision: 'ask', reason: `external write requires specific user authorization: ${exec.name}`, classifierEligible: true };
    }
    const riskyReason = riskyPluginToolReason(exec.name);
    if (riskyReason !== undefined) {
        return { decision: 'ask', reason: riskyReason, classifierEligible: true };
    }
    // The direct-human-approval tool is the agent's explicit request for a
    // human verdict on a follow-up operation: it must never reach the LLM
    // classifier (the very layer the agent is asking to bypass), so it is
    // pinned to a status-less human ask here — the same plane as the
    // classifier-ineligible terminals above. Whether the answer trains the
    // confirmation layer is decided in the answerer, not here.
    if (exec.name === DIRECT_HUMAN_TOOL) {
        return { decision: 'ask', reason: '[dsh-auto-approval-llm] direct human request', classifierEligible: false };
    }
    // Fail closed on genuinely unknown names: a plugin/MCP tool this policy
    // cannot read must be classified independently instead of silently
    // auto-allowed just because its name carries no risk token.
    return { decision: 'ask', reason: `unrecognized registered plugin tool requires independent classification: ${exec.name}`, classifierEligible: true };
}