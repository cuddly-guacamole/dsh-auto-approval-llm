/**
 * Canonical static-risk tokens shared by the host classifier and policy layer.
 *
 * These two patterns are the single source of truth for "does this tool name /
 * reason spell a HIGH-risk operation". They were previously inlined in
 * index.ts's `classifyStaticRisk` (duplicated from policy.ts's name regexes),
 * which invited silent drift. Keep both consumers pointed here.
 *
 * Behavior note: this file is verbatim the prior index.ts patterns, so adopting
 * it changes no classification outcome.
 */
export const RISK_NAME_PATTERN = /(?:^|[_-])(?:delete|destroy|remove|erase|purge|drop|truncate|wipe|unlink|rmdir|reset|revoke|deploy|publish|push|upload|send|post|release|merge|submit|chmod|chown|permission|permissions|policy|grant|revoke|credential|credentials|secret|secrets|auth)(?:$|[_-])/i
export const RISK_REASON_PATTERN = /(?:external write|security-boundary|destructive|protected path|credential|private-key|stateful terminal)/i
