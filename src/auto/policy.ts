// Ported from @nanmicoder/dsh-auto-mode (policy.js).
// MIT License, Copyright (c) 2026 程序员阿江-Relakkes (https://github.com/NanmiCoder/dsh-auto-mode).
// Retained per the MIT License: this is a substantial portion of the original.
//
// NOTE: this file is intentionally type-checked (no `@ts-nocheck`). The
// fail-closed classifier must not escape the compiler — DSH schema drift must
// surface at build time, not at runtime. Keep the helper types below minimal so
// the logic stays the single source of truth.
import { hardDestructiveTargetReason, isProtectedProjectPath, isWithin, normalizePath, runtimeStateTargetInZone, runtimeStateTargetReason, } from './paths.js';
import { assessShell, hardDenyShellReason } from './shell.js';
import { isEffectiveRoutine, sensitiveBasenameAt } from './category.js';
import { DIRECT_HUMAN_TOOL } from './constants.js';

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
 * `read`/`read_image` file path, the `grep`/`glob` path, and the `lsp` cwd;
 * `undefined` when the tool carries no checked path operand.
 *
 * Kept pure so contract tests pin the exact per-tool spelling (grep/glob read
 * `path`, lsp reads `cwd`) and the host guard cannot silently drop a family
 * member (A-via-symlink gap).
 */
export function symlinkGuardTargets(name: string, args?: unknown): string[] | undefined {
    if (SYMLINK_GUARD_MUTATION.has(name))
        return patchTargetPaths(args, name) ?? [];
    if (name === 'str_replace_editor' && (args as JsonObject)?.command !== 'view')
        return typeof (args as JsonObject)?.path === 'string' ? [(args as JsonObject).path as string] : [];
    if (name === 'read' || name === 'read_image')
        return typeof (args as JsonObject)?.file_path === 'string' ? [(args as JsonObject).file_path as string] : [];
    if (name === 'grep' || name === 'glob')
        return typeof (args as JsonObject)?.path === 'string' ? [(args as JsonObject).path as string] : [];
    if (name === 'lsp')
        return typeof (args as JsonObject)?.cwd === 'string' ? [(args as JsonObject).cwd as string] : [];
    return undefined;
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
const DESTRUCTIVE_TOOL = /(?:^|[_-])(?:delete|destroy|remove|erase|purge|drop|truncate|wipe|unlink|rmdir|reset|revoke)(?:$|[_-])/i;
const EXTERNAL_WRITE_TOOL = /(?:^|[_-])(?:deploy|publish|push|upload|send|post|release|merge|submit|create[-_]?(?:issue|pull[-_]?request))(?:$|[_-])/i;
const SECURITY_CHANGE_TOOL = /(?:^|[_-])(?:chmod|chown|permission|permissions|policy|grant|revoke|role|credential|credentials|secret|secrets|auth)(?:$|[_-])/i;
export const RISK_NAME_PATTERN = new RegExp(
    [DESTRUCTIVE_TOOL, EXTERNAL_WRITE_TOOL, SECURITY_CHANGE_TOOL].map((r) => r.source).join('|'),
    'i',
);
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
 */
const AGENT_TEAMS_CONTROL_TOOLS = new Set([
    'agent_teams_create',
    'agent_teams_add_member',
    'agent_teams_remove_member',
    'agent_teams_create_task',
    'agent_teams_claim_task',
    'agent_teams_update_task',
    'agent_teams_send_message',
    'agent_teams_status',
    // The verified implementation archives team state instead of erasing it.
    'agent_teams_delete',
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
        return assessShell(args.command, exec.name, roots, artifacts, owner);
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
            return { decision: 'ask', reason: `reading protected project metadata requires semantic review: ${normalized}`, classifierEligible: true };
        // A relaxation that newly admits a path outside the (position) workspace
        // must still fuse sensitive basenames anywhere (G1): trusted-dir or
        // aggressive reads of `.env`/`.ssh/...` stay gated.
        if (!isWithin(roots.workspace, normalized) && sensitiveBasenameAt(normalized, roots))
            return { decision: 'ask', reason: `reading a sensitive path outside the workspace requires semantic review: ${normalized}`, classifierEligible: true };
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
            return { decision: 'allow', reason: 'trusted DSH_HOME path', classifierEligible: false };
        }
        if (!isEffectiveRoutine(normalized, roots) || isProtectedProjectPath(normalized, roots)
            || (!isWithin(roots.workspace, normalized) && sensitiveBasenameAt(normalized, roots))) {
            return { decision: 'ask', reason: `mutation of external or protected path requires specific user authorization: ${normalized}`, classifierEligible: true };
        }
        return { decision: 'allow', reason: 'routine project-local file edit', classifierEligible: false };
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
            return { decision: 'allow', reason: 'trusted DSH_HOME path', classifierEligible: false };
        }
        const allRoutine = normalized.every((n) => isEffectiveRoutine(n, roots) && !isProtectedProjectPath(n, roots)
            && !(!isWithin(roots.workspace, n) && sensitiveBasenameAt(n, roots)));
        if (allRoutine) {
            return { decision: 'allow', reason: 'routine project-local file edit', classifierEligible: false };
        }
        return { decision: 'ask', reason: `apply_patch touches external or protected paths and requires specific user authorization`, classifierEligible: true };
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
            return { decision: 'allow', reason: 'trusted DSH_HOME path', classifierEligible: false };
        }
        if (command === 'view') {
            if (!isEffectiveRoutine(normalized, roots))
                return { decision: 'ask', reason: `reading outside the workspace requires semantic review: ${normalized}`, classifierEligible: true };
            if (!isWithin(roots.workspace, normalized) && sensitiveBasenameAt(normalized, roots))
                return { decision: 'ask', reason: `reading a sensitive path outside the workspace requires semantic review: ${normalized}`, classifierEligible: true };
            return { decision: 'allow', reason: 'read-only project inspection', classifierEligible: false };
        }
        if (!isEffectiveRoutine(normalized, roots) || isProtectedProjectPath(normalized, roots)
            || (!isWithin(roots.workspace, normalized) && sensitiveBasenameAt(normalized, roots))) {
            return { decision: 'ask', reason: `mutation of external or protected path requires specific user authorization: ${normalized}`, classifierEligible: true };
        }
        return { decision: 'allow', reason: 'routine project-local file edit', classifierEligible: false };
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
    if (['subagent', 'workflow', 'ralph', 'spawn_agent', 'send_message', 'wait_agent', 'list_agents', 'interrupt_agent', 'read_thread', 'wait_threads'].includes(exec.name)) {
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
        return { decision: 'ask', reason: '[auto-mode direct human request]', classifierEligible: false };
    }
    // Fail closed on genuinely unknown names: a plugin/MCP tool this policy
    // cannot read must be classified independently instead of silently
    // auto-allowed just because its name carries no risk token.
    return { decision: 'ask', reason: `unrecognized registered plugin tool requires independent classification: ${exec.name}`, classifierEligible: true };
}