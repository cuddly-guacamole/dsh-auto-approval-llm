/**
 * Canonical static-risk tokens shared by the policy layer, the decision
 * classifier, and the host wiring.
 *
 * The three component patterns are the single source of truth for "does this
 * tool name spell a destructive, external-write, or security-boundary
 * operation"; the flat name/reason unions are derived from them so every
 * consumer — the per-class reason probe and the HIGH escalator alike — reads
 * one definition. They were previously inlined twice (policy.ts and the prior
 * index.ts classifyStaticRisk), which invited silent drift: the flat union had
 * quietly dropped the `role` and `create[-_]?(?:issue|pull request)` tokens
 * that the per-class probe still enforced.
 *
 * Derived unions include every component token, so a name the policy plane
 * treats as risky escalates to HIGH on the decision plane too.
 */
export const DESTRUCTIVE_TOOL = /(?:^|[_-])(?:delete|destroy|remove|erase|purge|drop|truncate|wipe|unlink|rmdir|reset|revoke)(?:$|[_-])/i;
export const EXTERNAL_WRITE_TOOL = /(?:^|[_-])(?:deploy|publish|push|upload|send|post|release|merge|submit|create[-_]?(?:issue|pull[-_]?request))(?:$|[_-])/i;
export const SECURITY_CHANGE_TOOL = /(?:^|[_-])(?:chmod|chown|permission|permissions|policy|grant|revoke|role|credential|credentials|secret|secrets|auth)(?:$|[_-])/i;
export const RISK_NAME_PATTERN = new RegExp(
    [DESTRUCTIVE_TOOL, EXTERNAL_WRITE_TOOL, SECURITY_CHANGE_TOOL].map((r) => r.source).join('|'),
    'i',
);
export const RISK_REASON_PATTERN = /(?:external write|security-boundary|destructive|protected path|credential|private-key|stateful terminal)/i
