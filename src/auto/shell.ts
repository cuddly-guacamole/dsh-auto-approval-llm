// @ts-nocheck
// Ported from @nanmicoder/dsh-auto-mode (shell.js).
// MIT License, Copyright (c) 2026 程序员阿江-Relakkes (https://github.com/NanmiCoder/dsh-auto-mode).
// Retained per the MIT License: this is a substantial portion of the original.
import { basename } from 'node:path';
import { RUNTIME_STATE_BASENAMES, hardDestructiveTargetReason, isArtifactArea, isProtectedProjectPath, isWithin, normalizePath, runtimeStateTargetInZone, runtimeStateTargetReason, } from './paths.js';
import { isEffectiveRoutine, sensitiveBasenameAt } from './category.js';
function ambiguous(reason) {
    return { decision: 'ask', reason, classifierEligible: true };
}
function manualReview(reason) {
    return { decision: 'ask', reason, classifierEligible: false };
}
function semanticReview(reason) {
    return { decision: 'ask', reason, classifierEligible: true };
}
function denied(reason) {
    return { decision: 'deny', reason, classifierEligible: false };
}
function allowed(reason, plannedCreates) {
    return {
        decision: 'allow', reason, classifierEligible: false,
        ...(plannedCreates === undefined || plannedCreates.length === 0 ? {} : { plannedCreates }),
    };
}
function opaque(reason) {
    return { kind: 'opaque', reason };
}
/** Sticky patterns matched in place, so the lexer never copies the remaining input. */
const DESCRIPTOR_DUPLICATION = /[<>]&\s*(?:[0-9]+|-)/y;
const REDIRECT_OPERATOR = /(?:>>|>\||>&|<&|>|<)/y;
const MERGED_REDIRECT = /&>>?/y;
const CMD_VARIABLE = /%[A-Za-z_][A-Za-z0-9_()]*%/y;
const BASH_EXPANSION = /\$[A-Za-z_][A-Za-z0-9_]*/y;
const PWSH_EXPANSION = /\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*/y;
function matchAt(pattern, input, index) {
    pattern.lastIndex = index;
    return pattern.exec(input)?.[0];
}
/**
 * Read one `$` expansion and return its written form, or `undefined` when the
 * construct executes a nested command instead of naming a variable.
 */
function readExpansion(input, index, shell) {
    const next = input[index + 1];
    if (next === '(' || next === "'" || next === '"')
        return undefined;
    if (next === '{') {
        const end = input.indexOf('}', index + 2);
        if (end < 0)
            return undefined;
        const body = input.slice(index + 2, end);
        if (/[($`]/.test(body))
            return undefined;
        return input.slice(index, end + 1);
    }
    return matchAt(shell === 'pwsh' ? PWSH_EXPANSION : BASH_EXPANSION, input, index) ?? '$';
}
/**
 * Split one command line into segments, redirections, and word metadata.
 *
 * Operators separate segments so that every command in a compound line is
 * assessed on its own. Constructs whose effect cannot be read statically —
 * command substitution, here-documents, grouping, unbalanced quotes — return
 * `opaque` so callers fail closed instead of guessing shell semantics.
 */
export function decomposeCommandLine(source, shell) {
    const input = source;
    const segments = [];
    let words = [];
    let writeTargets = [];
    let readTargets = [];
    let text = '';
    let started = false;
    let dynamic = false;
    let glob = false;
    let quoted = false;
    let quote;
    let pending;
    const flushWord = () => {
        if (!started)
            return;
        const word = { text, dynamic, glob, quoted };
        if (pending === 'write')
            writeTargets.push(word);
        else if (pending === 'read')
            readTargets.push(word);
        else
            words.push(word);
        pending = undefined;
        text = '';
        started = false;
        dynamic = false;
        glob = false;
        quoted = false;
    };
    const flushSegment = () => {
        flushWord();
        if (words.length > 0 || writeTargets.length > 0 || readTargets.length > 0) {
            segments.push({ words, writeTargets, readTargets });
        }
        words = [];
        writeTargets = [];
        readTargets = [];
        pending = undefined;
    };
    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        if (quote === 'single') {
            if (char === "'") {
                quote = undefined;
                continue;
            }
            text += char;
            continue;
        }
        if (quote === 'double') {
            if (shell === 'bash' && char === '\\') {
                const next = input[index + 1];
                if (next === undefined)
                    return opaque('the command line ends inside an escape');
                if ('\\"$`\n'.includes(next)) {
                    text += next;
                    index += 1;
                    continue;
                }
                text += char;
                continue;
            }
            if (char === '`') {
                return opaque(shell === 'bash'
                    ? 'command substitution cannot be read statically'
                    : 'PowerShell escape sequences cannot be read statically');
            }
            if (char === '"') {
                quote = undefined;
                continue;
            }
            if (char === '$') {
                const expansion = readExpansion(input, index, shell);
                if (expansion === undefined)
                    return opaque('command substitution cannot be read statically');
                text += expansion;
                dynamic = true;
                index += expansion.length - 1;
                continue;
            }
            text += char;
            continue;
        }
        if (char === '\n' || char === '\r') {
            flushSegment();
            continue;
        }
        if (/\s/.test(char)) {
            flushWord();
            continue;
        }
        if (char === "'") {
            quote = 'single';
            started = true;
            quoted = true;
            continue;
        }
        if (char === '"') {
            quote = 'double';
            started = true;
            quoted = true;
            continue;
        }
        if (shell === 'bash' && char === '\\') {
            const next = input[index + 1];
            if (next === undefined)
                return opaque('the command line ends inside an escape');
            index += 1;
            if (next === '\n')
                continue;
            text += next;
            started = true;
            quoted = true;
            continue;
        }
        if (char === '`') {
            return opaque(shell === 'bash'
                ? 'command substitution cannot be read statically'
                : 'PowerShell escape sequences cannot be read statically');
        }
        if (char === '$') {
            const expansion = readExpansion(input, index, shell);
            if (expansion === undefined)
                return opaque('command substitution cannot be read statically');
            text += expansion;
            started = true;
            dynamic = true;
            index += expansion.length - 1;
            continue;
        }
        if (char === '#' && !started) {
            while (index + 1 < input.length && input[index + 1] !== '\n')
                index += 1;
            continue;
        }
        if (shell === 'pwsh' && char === '%' && matchAt(CMD_VARIABLE, input, index) !== undefined) {
            return opaque('cmd-style variable expansion cannot be read statically');
        }
        if (char === '&') {
            if (input[index + 1] === '&') {
                flushSegment();
                index += 1;
                continue;
            }
            const merged = matchAt(MERGED_REDIRECT, input, index);
            if (merged !== undefined) {
                flushWord();
                pending = 'write';
                index += merged.length - 1;
                continue;
            }
            flushSegment();
            continue;
        }
        if (char === '|') {
            if (input[index + 1] === '|')
                index += 1;
            flushSegment();
            continue;
        }
        if (char === ';') {
            flushSegment();
            continue;
        }
        if (char === '>' || char === '<') {
            if (input.startsWith('<<', index))
                return opaque('here-document input cannot be read statically');
            if (started && !quoted && !dynamic && !glob && /^[0-9]+$/.test(text)) {
                text = '';
                started = false;
            }
            else {
                flushWord();
            }
            const duplication = matchAt(DESCRIPTOR_DUPLICATION, input, index);
            if (duplication !== undefined) {
                index += duplication.length - 1;
                continue;
            }
            const operator = matchAt(REDIRECT_OPERATOR, input, index);
            pending = char === '>' ? 'write' : 'read';
            index += operator.length - 1;
            continue;
        }
        if (char === '{' && input[index + 1] === '}' && !started && (input[index + 2] === undefined || /\s/.test(input[index + 2]))) {
            // `find -exec ... {} \;` uses an exact literal placeholder. It is not
            // brace expansion, and treating it as one made routine read-only
            // inspection impossible. Other braces remain opaque.
            text = '{}';
            started = true;
            index += 1;
            continue;
        }
        if ('(){}'.includes(char))
            return opaque('shell grouping or brace expansion cannot be read statically');
        if (char === '*' || char === '?') {
            glob = true;
        }
        text += char;
        started = true;
    }
    if (quote !== undefined)
        return opaque('the command line ends inside an unbalanced quote');
    if (pending !== undefined && !started)
        return opaque('a redirection has no target');
    flushSegment();
    if (segments.length === 0)
        return opaque('the command line contains no command');
    return { kind: 'segments', segments };
}
/** Parse one static shell command. Any executable shell syntax fails closed. */
export function parseSimpleCommand(source, shell) {
    const decomposition = decomposeCommandLine(source, shell);
    if (decomposition.kind === 'opaque' || decomposition.segments.length !== 1)
        return undefined;
    const segment = decomposition.segments[0];
    if (segment.writeTargets.length > 0 || segment.readTargets.length > 0)
        return undefined;
    if (segment.words.some(word => word.dynamic || word.glob))
        return undefined;
    const tokens = segment.words.map(word => word.text);
    if (tokens.length === 0 || tokens[0]?.includes('=') === true)
        return undefined;
    return { tokens };
}
function commandName(token) {
    return basename(token.replaceAll('\\', '/')).toLowerCase();
}
function dynamicHomeTarget(source) {
    return /(?:\$\{?HOME\}?|\$env:(?:USERPROFILE|HOME)|%USERPROFILE%|%HOME%)/i.test(source);
}
function sensitiveMarker(source) {
    return /(?:\.ssh[\\/]|\.gnupg[\\/]|\.aws[\\/]|\.kube[\\/]|\.credentials\.yaml|\.env(?:$|[.\/\s])|id_(?:rsa|ed25519)|(?:API|AUTH|ACCESS|SECRET)[_-]?KEY|TOKEN|PASSWORD)/i.test(source);
}
/**
 * Whether a shell exfil would ship a file living under the configured DSH_HOME
 * (or the home-relative default `.dsh`). Scoped to those roots (rather than a
 * bare unanchored `.dsh` substring) so a workspace `.dsh/` subdir or a URL with
 * `.dsh/` in its path is not mistaken for a credential exfil, while a custom,
 * non-`.dsh`-named DSH_HOME is still caught.
 *
 * The dynamic spellings of those roots match too (`$HOME`, `${HOME}`,
 * `$env:USERPROFILE`, `%USERPROFILE%`, `$DSH_HOME`, …): a compromised model
 * reaches for the variable form in practice (`curl -F file=@$HOME/.dsh/…`), and
 * the bare `.dsh[\\/]` marker that used to cover them also over-blocked
 * ordinary workspace/URL `.dsh/` paths.
 */
function dshHomeExfil(source, roots) {
    const flat = String(source).replace(/\\/g, '/');
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const home = typeof roots?.home === 'string' ? roots.home.replace(/\\/g, '/') : '';
    const dshHome = typeof roots?.dshHome === 'string' ? roots.dshHome.replace(/\\/g, '/') : '';
    // `.dsh` root boundary: a literal `.dsh` directory whose next char is a
    // slash (a path inside it) or a non-path boundary (end of line / word
    // edge) — so a bare `~/.dsh` or `$HOME/.dsh` used as a whole operand
    // (`tar czf - ~/.dsh | curl …`) is caught, while `~/.dshsomething` stays
    // unmatched and a workspace/URL `.dsh/…` (no home/dshHome prefix) is not
    // over-blocked. The same suffix form covers the variable spellings and the
    // resolved DSH_HOME root. Trailing `/` (the historical form) is implied by
    // the `[/\b$]` boundary.
    const DSHTAIL = '(/|\\b|$)';
    const patterns = [];
    if (/([^\\/])/.test(dshHome))
        patterns.push(esc(dshHome.replace(/\/+$/, '')) + DSHTAIL);
    if (/([^\\/])/.test(home))
        patterns.push('(?:' + esc(home) + '|~)/\\.dsh' + DSHTAIL);
    patterns.push('(?:\\$\\{?DSH_HOME\\}?|\\$env:DSH_HOME)' + DSHTAIL);
    patterns.push('(?:\\$\\{?HOME\\}?|\\$env:(?:USERPROFILE|HOME)|%USERPROFILE%|%HOME%)/\\.dsh' + DSHTAIL);
    return patterns.some((pattern) => new RegExp(pattern, 'i').test(flat));
}
/** Whether a redirection target discards output instead of writing a file. */
export function isNullSink(word, shell) {
    const text = word.text.toLowerCase();
    return text === '/dev/null' || (shell === 'pwsh' && (text === '$null' || text === 'nul'));
}
/**
 * Reduce a globbed path to the deepest directory it cannot escape, so an
 * unbounded expansion such as `/*` is judged against `/`.
 */
function globRoot(target) {
    const parts = target.split(/[\\/]/);
    const index = parts.findIndex(part => /[*?]/.test(part));
    if (index < 0)
        return target;
    const kept = parts.slice(0, index);
    if (kept.length === 0)
        return '.';
    if (kept.length === 1 && kept[0] === '')
        return target.startsWith('\\') ? '\\' : '/';
    return kept.join(target.includes('\\') && !target.includes('/') ? '\\' : '/');
}
function deletionSpec(name, words, shell) {
    if (shell === 'bash' && ['rm', 'rmdir', 'unlink', 'shred'].includes(name)) {
        const rest = words.slice(1);
        const flags = rest.filter(word => word.text.startsWith('-'));
        const targets = rest.filter(word => !word.text.startsWith('-'));
        return { recursive: flags.some(flag => flag.text === '--recursive' || /^-[^-]*r/i.test(flag.text)), targets };
    }
    if (shell === 'pwsh' && ['remove-item', 'rm', 'ri', 'rd', 'del', 'erase', 'rmdir'].includes(name)) {
        const targets = [];
        for (let index = 1; index < words.length; index += 1) {
            const word = words[index];
            if (/^-(?:path|literalpath)$/i.test(word.text)) {
                const value = words[index + 1];
                if (value !== undefined)
                    targets.push(value);
                index += 1;
            }
            else if (!word.text.startsWith('-')) {
                targets.push(word);
            }
        }
        return { recursive: words.some(word => /^-(?:recurse|r)$/i.test(word.text)), targets };
    }
    return undefined;
}
/** Commands whose real work is another command this policy cannot see yet. */
const WRAPPERS = new Set(['env', 'nohup', 'setsid', 'stdbuf', 'command', 'time', 'timeout', 'xargs', 'nice', 'ionice']);
/** Privilege-escalation commands: hard-denied at the whole-line fuse AND per segment. */
const PRIVILEGE_COMMANDS = new Set(['sudo', 'doas', 'su']);
/** Wrapper flags that consume the following word as their value. */
const WRAPPER_VALUE_FLAGS = {
    xargs: /^-(?:n|I|i|P|L|s|d|E|a)$/,
    stdbuf: /^-(?:i|o|e)$/,
    nice: /^-(?:n)$/,
    ionice: /^-(?:c|n|p)$/,
};
/** Strip prefix wrappers so the effective command is judged, not the wrapper. */
function unwrapCommand(words) {
    let current = words;
    let dynamicInput = false;
    // Strip leading `NAME=value` environment prefixes (`VAR=val cmd`), which
    // are legal in both shells. Without this, `words[0]` being `VAR=val` made
    // the effective command name `var=val` and skipped the privilege / hard
    // destructive fuses entirely (`BLAH=0 sudo ls`, `BLAH=0 rm -rf /`).
    while (current.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=.+/.test(current[0]?.text ?? '')) {
        current = current.slice(1);
    }
    for (let depth = 0; depth < 4; depth += 1) {
        const name = commandName(current[0]?.text ?? '');
        if (!WRAPPERS.has(name))
            break;
        if (name === 'xargs')
            dynamicInput = true;
        const valueFlag = WRAPPER_VALUE_FLAGS[name];
        let index = 1;
        while (index < current.length) {
            const token = current[index].text;
            if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
                index += 1;
                continue;
            }
            if (!token.startsWith('-'))
                break;
            if (valueFlag?.test(token) === true)
                index += 1;
            index += 1;
        }
        if (name === 'timeout' && /^[0-9]+(?:\.[0-9]+)?[smhd]?$/.test(current[index]?.text ?? ''))
            index += 1;
        const next = current.slice(index);
        if (next.length === 0)
            return { words: current, dynamicInput };
        current = next;
    }
    return { words: current, dynamicInput };
}
/** Describe an interpreter boundary and whether its inline source is visible. */
function nestedExecution(name, words) {
    if (['node', 'deno', 'bun', 'python', 'python3', 'perl', 'ruby', 'php', 'osascript'].includes(name)) {
        const index = words.findIndex((word, wordIndex) => wordIndex > 0 && /^(?:-c|-e|-E|--eval|--exec|--command|--print)$/.test(word.text));
        if (index >= 0)
            return { ...(words[index + 1] === undefined ? {} : { source: words[index + 1].text }) };
        return undefined;
    }
    if (['sh', 'bash', 'zsh', 'fish', 'ksh', 'dash', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(name)) {
        const index = words.findIndex((word, wordIndex) => wordIndex > 0 && /^(?:-c|\/c|--command)$/.test(word.text));
        return { ...(index < 0 || words[index + 1] === undefined ? {} : { source: words[index + 1].text }) };
    }
    if (['eval', 'iex', 'invoke-expression'].includes(name)) {
        return { ...(words.length < 2 ? {} : { source: words.slice(1).map(word => word.text).join(' ') }) };
    }
    if (['exec', 'source', '.', 'invoke-command', 'start-process'].includes(name))
        return {};
    return undefined;
}
const PYTHON_IMPORT = /^(?:import\s+[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s+as\s+[A-Za-z_]\w*)?(?:\s*,\s*[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\s+as\s+[A-Za-z_]\w*)?)*|from\s+[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\s+import\s+(?:[A-Za-z_*]\w*(?:\s+as\s+[A-Za-z_]\w*)?)(?:\s*,\s*[A-Za-z_*]\w*(?:\s+as\s+[A-Za-z_]\w*)?)*)$/;
const PYTHON_PRINT_VALUE = String.raw `(?:'[^'\n]*'|"[^"\n]*"|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|[-+]?\d+(?:\.\d+)?)`;
const PYTHON_SAFE_PRINT = new RegExp(String.raw `^print\(\s*${PYTHON_PRINT_VALUE}(?:\s*,\s*${PYTHON_PRINT_VALUE})*\s*\)$`);
/** Common package/version probes are safe enough to avoid a model round trip. */
function routineInlineProbe(name, source) {
    if (source === undefined)
        return false;
    if (name === 'python' || name === 'python3') {
        const statements = source.split(/[;\n]+/).map(statement => statement.trim()).filter(Boolean);
        return statements.length > 0 && statements.every(statement => PYTHON_IMPORT.test(statement) || PYTHON_SAFE_PRINT.test(statement));
    }
    if (['node', 'bun', 'deno'].includes(name)) {
        const compact = source.trim().replace(/;$/, '');
        return /^(?:require(?:\.resolve)?\(\s*(['"])[@A-Za-z0-9_./-]+\1\s*\)|console\.log\(\s*process\.version\s*\))$/.test(compact);
    }
    return false;
}
/** Deletion hidden behind an interpreter stays outside classifier authority. */
function destructiveNestedSource(source) {
    return /(?:^|[\s;&|()])(?:rm|rmdir|unlink|shred|remove-item|del|erase)(?:\s|$)|\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir|removedirs)|file\.(?:delete|unlink)|directory\.delete)\s*\(|\.(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync|delete)\s*\(|\b(?:delete\s+from|drop\s+(?:table|database)|truncate\s+table)\b/i.test(source);
}
/**
 * Bash expands `~name/…` (and `~name`) to another user's home directory — a
 * location no configured root can statically contain. Such operands must never
 * count as routine workspace/temp paths, in reads or in writes. Plain `~`,
 * `~/…` and `~\…` stay with the existing home-expansion logic.
 */
function tildeUserTarget(text) {
    return text.length > 1 && text.startsWith('~') && !text.startsWith('~/') && !text.startsWith('~\\');
}
/** Whether a bare token spells an absolute/explicit filesystem path. */
function looksLikeExplicitPath(token) {
    // Dot-initial tokens are explicit too: without them a protected carve-out
    // like `.git/config` or `.env` would silently escape the routine gates.
    return token.startsWith('/') || token.startsWith('.')
        || token.startsWith('~') || /^[A-Za-z]:[\\/]/.test(token) || /^\\\\/.test(token);
}
/**
 * Lift a path value out of a flag token. Long options carry it after `=`
 * (`--output=C:/abs`); fused short options append it to the flag letters
 * (`-oC:/abs`, GNU sort/tree style). Only explicit-path spellings are lifted,
 * so values like `--pretty=format:%h` or `--parallel=2` are left alone.
 */
function flagEmbeddedPath(text) {
    const eq = text.indexOf('=');
    if (eq > 1) {
        const value = text.slice(eq + 1);
        return value !== '' && looksLikeExplicitPath(value) ? value : undefined;
    }
    // Fused short options (`-oC:/abs`, GNU sort/tree style): scan every tail
    // after the leading '-' for an explicit-path spelling — a greedy letter
    // match would otherwise swallow a drive letter and hide the value.
    for (let cut = 2; cut < text.length; cut += 1) {
        const tail = text.slice(cut);
        if (looksLikeExplicitPath(tail))
            return tail;
    }
    return undefined;
}
function explicitPaths(words, roots) {
    const out = [];
    for (const word of words) {
        const token = word.text;
        if (token.startsWith('-')) {
            // A flag token hides its value from the bare-token filter below;
            // extract embedded absolute paths so `sort --output=C:/abs` cannot
            // smuggle a write/read target past the routine-path checks.
            const embedded = flagEmbeddedPath(token);
            if (embedded !== undefined)
                out.push(normalizePath(embedded, roots.workspace, roots.home));
            continue;
        }
        // Bare-relative (".git/config", ".env") and dot tokens (".", "..") are
        // explicit paths too — without them a protected carve-out like
        // `./.git/config` is silently bypassed by writing `.git/config`.
        if (looksLikeExplicitPath(token))
            out.push(normalizePath(token, roots.workspace, roots.home));
    }
    return out;
}
function readPathsAreRoutine(words, roots) {
    // A variable/expansion operand cannot be statically proven to stay inside
    // the workspace (`cat $HOME/.aws/credentials`, `get-content
    // $env:USERPROFILE\.aws\credentials`, `grep ${HOME}/.gnupg/...`). Treating
    // it as "no path given" made explicitPaths() drop it and `.every()` over
    // an empty list return true, auto-allowing a credential read. Fail closed:
    // route such a read to semantic review, mirroring deletion/write whose
    // dynamic targets are never auto-allowed.
    if (words.some(word => word && word.dynamic))
        return false;
    // `~user/…` expands to another user's home — never a routine root.
    if (words.some(word => word && tildeUserTarget(word.text)))
        return false;
    return explicitPaths(words, roots).every(path => (isEffectiveRoutine(path, roots) && !isProtectedProjectPath(path, roots)
        && !(!isWithin(roots.workspace, path) && sensitiveBasenameAt(path, roots)))
        || roots.tempRoots.some(root => isWithin(root, path)));
}
/** Every redirection target must be a discard sink or ordinary project content. */
function writeTargetsAreRoutine(segment, shell, roots) {
    return segment.writeTargets.every((target) => {
        if (isNullSink(target, shell))
            return true;
        if (target.dynamic || target.glob)
            return false;
        // `> ~user/file` lands in another user's home; normalizePath cannot
        // resolve it into any root, so it must not pass as routine content.
        if (tildeUserTarget(target.text))
            return false;
        const normalized = normalizePath(target.text, roots.workspace, roots.home);
        return isEffectiveRoutine(normalized, roots) && !isProtectedProjectPath(normalized, roots)
            && !(!isWithin(roots.workspace, normalized) && sensitiveBasenameAt(normalized, roots));
    });
}
function buildOrTest(words) {
    const tokens = words.map(word => word.text);
    const name = commandName(tokens[0]);
    const first = tokens[1]?.toLowerCase();
    if (['pnpm', 'npm', 'yarn', 'bun'].includes(name)) {
        if (first === 'test')
            return true;
        if (first === 'run')
            return /^(?:build|test|typecheck|check|verify|lint)(?::[\w-]+)?$/.test(tokens[2] ?? '');
        if (name === 'pnpm' && first === 'exec')
            return ['tsc', 'vitest', 'eslint'].includes(commandName(tokens[2] ?? ''));
        return false;
    }
    if (['tsc', 'vitest', 'eslint', 'pytest'].includes(name))
        return true;
    if (['cargo', 'go'].includes(name))
        return ['build', 'test', 'check', 'vet'].includes(first ?? '');
    if (name === 'make')
        return tokens.length === 1 || tokens.slice(1).every(token => /^(?:build|test|check|verify|lint)$/.test(token));
    return false;
}
/**
 * Fast-path retention rule for build-or-test and version-probe segments that
 * carry a real-file write redirection: the static allow survives only when
 * every target is a discard sink or ordinary workspace-inside content. Any
 * other target — outside the workspace, sensitive, protected project metadata,
 * or a plugin runtime-state name inside the plugin zone — sends the whole
 * segment through the ordinary evaluation flow instead. Unlike
 * `writeTargetsAreRoutine` this predicate is deliberately not relaxed by
 * trustedDirs/aggressive mode: a build command's main effect is running it, so
 * only incidental log targets that provably stay inside the workspace may keep
 * the static allow.
 */
function redirectTargetsStayOnFastPath(segment, shell, roots) {
    return segment.writeTargets.every((target) => {
        if (isNullSink(target, shell))
            return true;
        if (target.dynamic || target.glob)
            return false;
        // `> ~user/file` lands in another user's home; normalizePath cannot
        // resolve it into the workspace.
        if (tildeUserTarget(target.text))
            return false;
        const normalized = normalizePath(target.text, roots.workspace, roots.home);
        return isWithin(roots.workspace, normalized)
            && !isProtectedProjectPath(normalized, roots)
            && !sensitiveBasenameAt(normalized, roots)
            && runtimeStateWriteReason(normalized, roots) === undefined;
    });
}
function versionProbe(words) {
    const tokens = words.map(word => word.text);
    const name = commandName(tokens[0]);
    if (['node', 'python', 'python3', 'pip', 'pip3', 'pnpm', 'npm', 'yarn', 'bun', 'git', 'cargo', 'rustc'].includes(name)) {
        return tokens.length === 2 && ['--version', '-v', 'version'].includes(tokens[1]?.toLowerCase() ?? '');
    }
    return name === 'go' && tokens.length === 2 && tokens[1]?.toLowerCase() === 'version';
}
/**
 * Directory changers stay out of both fast-path sets on purpose. `cd` rewrites
 * the working directory for every later segment of the same line, so relative
 * paths could no longer be resolved against the workspace. Leaving it
 * unrecognized keeps any line containing it out of the static allow path and
 * routes the whole line to semantic classification instead.
 */
const BASH_READ_ONLY = [
    'pwd', 'ls', 'rg', 'grep', 'egrep', 'fgrep', 'head', 'tail', 'cat', 'wc', 'od', 'du', 'df', 'stat', 'file', 'which', 'type',
    'echo', 'printf', 'true', 'false', ':', 'test', '[', 'basename', 'dirname', 'realpath', 'readlink', 'date', 'whoami', 'id',
    'hostname', 'uname', 'printenv', 'sort', 'uniq', 'cut', 'tr', 'nl', 'diff', 'cmp', 'jq', 'tree', 'column',
    'md5sum', 'shasum', 'sha1sum', 'sha256sum',
];
const PWSH_READ_ONLY = [
    'get-location', 'get-childitem', 'get-content', 'select-string', 'get-item', 'test-path',
    'write-output', 'write-host', 'measure-object', 'select-object', 'sort-object', 'get-date',
];
const FIND_MUTATING_ACTION = /^-(?:delete|fprint|fprintf|fls)$/;
const FIND_NESTED_ACTION = /^-(?:exec|execdir|ok|okdir)$/;
function findSearchRoots(words) {
    const roots = [];
    for (let index = 1; index < words.length; index += 1) {
        const word = words[index];
        if (word.text.startsWith('-') || word.text === '!' || word.text === '(')
            break;
        roots.push(word);
    }
    return roots;
}
function findHasDestructiveAction(words) {
    for (let index = 1; index < words.length; index += 1) {
        const token = words[index].text.toLowerCase();
        if (token === '-delete')
            return true;
        if (!FIND_NESTED_ACTION.test(token))
            continue;
        const terminator = words.findIndex((word, nestedIndex) => nestedIndex > index && (word.text === ';' || word.text === '+'));
        if (terminator < 0)
            return false;
        const nested = words.slice(index + 1, terminator);
        const nestedName = commandName(nested[0]?.text ?? '');
        if (deletionSpec(nestedName, nested, 'bash') !== undefined
            || destructiveNestedSource(nested.map(word => word.text).join(' ')))
            return true;
        index = terminator;
    }
    return false;
}
/** `find -exec` is read-only only when every nested command is itself read-only. */
function findActionsAreReadOnly(words) {
    for (let index = 1; index < words.length; index += 1) {
        const token = words[index].text.toLowerCase();
        if (FIND_MUTATING_ACTION.test(token) || /^(?:-execdir|-ok|-okdir)$/.test(token))
            return false;
        if (token !== '-exec')
            continue;
        const terminator = words.findIndex((word, nestedIndex) => nestedIndex > index && (word.text === ';' || word.text === '+'));
        if (terminator < 0)
            return false;
        const nested = words.slice(index + 1, terminator);
        const nestedName = commandName(nested[0]?.text ?? '');
        const nestedReadOnly = BASH_READ_ONLY.includes(nestedName)
            || (nestedName === 'git' && ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame'].includes(nested[1]?.text.toLowerCase() ?? ''))
            || versionProbe(nested);
        if (!nestedReadOnly)
            return false;
        index = terminator;
    }
    return true;
}
function readOnlyCommand(name, words, shell) {
    const tokens = words.map(word => word.text);
    if (shell === 'bash') {
        // Whitelist members with mutating or executing spellings keep only
        // their read-only forms; every other spelling falls through to
        // independent classification instead of the static allow.
        if (name === 'rg' && tokens.slice(1).some(token => /^--pre(?:=.*)?$/.test(token)))
            return false;
        if (name === 'date')
            return !tokens.slice(1).some(token => token === '-s' || token === '--set');
        if (name === 'hostname')
            return tokens.length === 1;
        if (BASH_READ_ONLY.includes(name))
            return true;
        if (name === 'find')
            return findActionsAreReadOnly(words);
        if (name === 'git')
            return ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame'].includes(tokens[1]?.toLowerCase() ?? '');
        return false;
    }
    return PWSH_READ_ONLY.includes(name);
}
function creationSpec(name, words, shell, roots) {
    let raw;
    if (shell === 'bash' && ['mkdir', 'touch'].includes(name))
        raw = words.slice(1).filter(word => !word.text.startsWith('-')).map(word => word.text);
    if (shell === 'pwsh' && name === 'new-item') {
        raw = [];
        for (let index = 1; index < words.length; index += 1) {
            const token = words[index].text;
            if (/^-(?:path|literalpath)$/i.test(token)) {
                const value = words[index + 1];
                if (value !== undefined)
                    raw.push(value.text);
                index += 1;
            }
            else if (!token.startsWith('-') && !/^(?:file|directory)$/i.test(token))
                raw.push(token);
        }
    }
    if (raw === undefined || raw.length === 0)
        return undefined;
    const paths = raw.map(path => normalizePath(path, roots.workspace, roots.home));
    return {
        paths,
        protected: raw.some(path => tildeUserTarget(path))
            || paths.some(path => !isEffectiveRoutine(path, roots) || isProtectedProjectPath(path, roots)
                || (!isWithin(roots.workspace, path) && sensitiveBasenameAt(path, roots))),
    };
}
/** Unconditional hard deny for one segment, independent of classifier behavior. */
function runtimeStateWriteReason(normalizedPath, roots) {
    // The plugin's own approval/audit state files must never be reachable
    // through a shell vector: an 'ask' for them lands in the risk-tiered
    // pipeline where timeoutAction=allow (or an LLM takeover) can answer it,
    // silently rewriting the audit trail (34251eb only covered the structured
    // write tools). Zone-scoped like the structured-tool guard: an ordinary
    // workspace file that merely shares a basename (`foo/history.jsonl`) is
    // not plugin state.
    return runtimeStateTargetInZone(normalizedPath, roots.allowedDshSubpaths)
        ? `mutation of ${runtimeStateTargetReason(normalizedPath)} is not permitted`
        : undefined;
}
/** Explicit path operands of a command word list that act as write targets. */
function writeOperandCandidates(words) {
    // cp/mv: the destination is the last non-flag operand; the earlier ones
    // are sources (reads) and must not be denied as writes.
    const candidates = [];
    for (let index = 1; index < words.length; index += 1) {
        const word = words[index];
        if (word.dynamic || word.glob || word.text.startsWith('-')) continue;
        if (index === words.length - 1) candidates.push(word);
    }
    // `-t DEST` / `--target-directory=DEST` invert the operand order: their
    // value IS the destination no matter where it sits, so a runtime-state or
    // otherwise protected target must be judged from it too.
    for (let index = 1; index < words.length; index += 1) {
        const text = words[index].text;
        if (text === '-t' || text === '--target-directory') {
            const value = words[index + 1];
            if (value !== undefined && !value.dynamic && !value.glob)
                candidates.push(value);
        }
        else if (text.startsWith('--target-directory=')) {
            const value = text.slice('--target-directory='.length);
            if (value !== '')
                candidates.push({ text: value, dynamic: false, glob: false, quoted: true });
        }
    }
    return candidates;
}
function segmentHardDenyReason(segment, shell, roots) {
    for (const target of segment.writeTargets) {
        if (isNullSink(target, shell))
            continue;
        if (target.dynamic) {
            if (dynamicHomeTarget(target.text))
                return 'dynamic redirection targeting the user home is not permitted';
            continue;
        }
        const reason = hardDestructiveTargetReason(globRoot(target.text), roots);
        if (reason !== undefined)
            return `redirection overwrites ${reason}`;
        const stateReason = runtimeStateWriteReason(normalizePath(target.text, roots.workspace, roots.home), roots);
        if (stateReason !== undefined)
            return `redirection targets ${stateReason}`;
    }
    const unwrapped = unwrapCommand(segment.words);
    const name = commandName(unwrapped.words[0]?.text ?? '');
    // Commands whose non-flag operands are write destinations (copy/move,
    // creation, pwsh output cmdlets): a runtime-state target inside the zone is
    // an unconditional hard deny, and the same normalization the allow path
    // uses must not weaken when the workspace IS the zone.
    let writeOperands = null;
    if (shell === 'bash' && ['cp', 'mv'].includes(name)) {
        writeOperands = writeOperandCandidates(unwrapped.words);
    }
    else if (shell === 'bash' && ['mkdir', 'touch'].includes(name)) {
        writeOperands = unwrapped.words.slice(1).filter(word => !word.text.startsWith('-'));
    }
    else if (shell === 'pwsh' && ['set-content', 'add-content', 'out-file', 'copy-item', 'move-item', 'new-item'].includes(name)) {
        writeOperands = [];
        for (let index = 1; index < unwrapped.words.length; index += 1) {
            const word = unwrapped.words[index];
            if (/^-(?:path|literalpath|filepath)$/i.test(word.text)) {
                const value = unwrapped.words[index + 1];
                if (value !== undefined) writeOperands.push(value);
                index += 1;
            }
            else if (!word.text.startsWith('-')) {
                writeOperands.push(word);
            }
        }
    }
    if (writeOperands !== null) {
        for (const operand of writeOperands) {
            if (operand.dynamic || operand.glob) continue;
            const stateReason = runtimeStateWriteReason(normalizePath(operand.text, roots.workspace, roots.home), roots);
            if (stateReason !== undefined)
                return `${name} targets ${stateReason}`;
        }
    }
    if (name === 'find' && findHasDestructiveAction(unwrapped.words)) {
        const rootsToCheck = findSearchRoots(unwrapped.words);
        for (const target of rootsToCheck) {
            if (target.dynamic) {
                if (dynamicHomeTarget(target.text))
                    return 'dynamic find deletion targeting the user home is not permitted';
                continue;
            }
            const reason = hardDestructiveTargetReason(globRoot(target.text), roots);
            if (reason !== undefined)
                return `destructive find operation targets ${reason}`;
            const stateReason = runtimeStateWriteReason(normalizePath(globRoot(target.text), roots.workspace, roots.home), roots);
            if (stateReason !== undefined)
                return `destructive find operation targets ${stateReason}`;
        }
    }
    const deletion = deletionSpec(name, unwrapped.words, shell);
    if (deletion === undefined)
        return undefined;
    for (const target of deletion.targets) {
        if (target.dynamic) {
            if (dynamicHomeTarget(target.text))
                return 'dynamic deletion targeting the user home is not permitted';
            continue;
        }
        const reason = hardDestructiveTargetReason(globRoot(target.text), roots);
        if (reason !== undefined)
            return `destructive operation targets ${reason}`;
        const stateReason = runtimeStateWriteReason(normalizePath(globRoot(target.text), roots.workspace, roots.home), roots);
        if (stateReason !== undefined)
            return `destructive operation targets ${stateReason}`;
    }
    return undefined;
}
/**
 * Hard-deny shell patterns independent of parsing and classifier behavior.
 *
 * The whole-line rules stay unconditional because they must also cover a
 * command line no parser can decompose. The structural rules then judge every
 * segment of a compound line, so an operator cannot smuggle a protected target
 * past the fuse.
 */
export function hardDenyShellReason(source, shell, roots) {
    const compact = source.trim();
    // Whole-line privilege fuse: also catches a compound line whose operator
    // separates a segment starting with sudo/doas/su (`echo hi;sudo ls`,
    // `cmd && sudo rm -rf /`), which the old `^|\s` anchor missed. Anchored on
    // a segment start (line start or after an operator) so a mere argument
    // (`echo sudo`) is not misjudged; the per-segment check below is the
    // authoritative guard for decomposed lines. `{` is included so a brace
    // group (`{ sudo ls; }`) is caught before decomposition (a `{` otherwise
    // makes the line opaque and escapes both fuses).
    if (/(?:^|[;&|({])\s*(?:sudo|doas|su)(?:\s|$)/i.test(compact))
        return 'privilege escalation is not permitted by auto mode';
    if (/(?:set-executionpolicy|disable-windowsdefender|clear-disk|format-volume|remove-partition|bcdedit)(?:\s|$)/i.test(compact)) {
        return 'operating-system security or disk policy changes are not permitted';
    }
    if (/(?:curl|wget|invoke-webrequest|invoke-restmethod)/i.test(compact) && (sensitiveMarker(compact) || dshHomeExfil(compact, roots))) {
        return 'credential or private-data exfiltration pattern is not permitted';
    }
    if (dynamicHomeTarget(compact) && /(?:rm|remove-item|rmdir)\b/i.test(compact)) {
        return 'dynamic deletion targeting the user home is not permitted';
    }
    const decomposition = decomposeCommandLine(compact, shell);
    if (decomposition.kind === 'opaque')
        return undefined;
    for (const segment of decomposition.segments) {
        // Per-segment privilege fuse: the whole-line regex above only sees the
        // raw source; a decomposed segment lets us judge the effective command
        // after wrappers, so `echo hi; sudo ls` cannot dodge the hard deny.
        const segName = commandName(unwrapCommand(segment.words).words[0]?.text ?? '');
        if (PRIVILEGE_COMMANDS.has(segName))
            return 'privilege escalation is not permitted by auto mode';
        const reason = segmentHardDenyReason(segment, shell, roots);
        if (reason !== undefined)
            return reason;
    }
    return undefined;
}
/** Classify one segment of an already hard-deny-cleared command line. */
function assessSegment(segment, shell, roots, artifacts, owner) {
    if (segment.words.length === 0)
        return semanticReview('redirection without a command requires semantic review');
    const first = segment.words[0];
    if (first.dynamic)
        return manualReview('the command name is produced by a dynamic expansion');
    if (first.glob)
        return manualReview('the command name is produced by a glob');
    if (first.quoted)
        return manualReview('the command name is quoted or escaped rather than written literally');
    if (segment.writeTargets.some(target => target.dynamic && !isNullSink(target, shell))) {
        return manualReview('the redirection target is produced by a dynamic expansion');
    }
    const unwrapped = unwrapCommand(segment.words);
    const words = unwrapped.words;
    const name = commandName(words[0].text);
    const nested = nestedExecution(name, words);
    if (nested !== undefined) {
        if (routineInlineProbe(name, nested.source))
            return allowed('routine inline package or version probe');
        if (nested.source === undefined)
            return manualReview('opaque nested execution requires manual review');
        if (destructiveNestedSource(nested.source))
            return manualReview('nested deletion requires manual review');
        return semanticReview('visible nested or inline-code execution requires independent classification');
    }
    const base = classifyEffectiveCommand(name, words, segment, shell, roots, artifacts, owner, unwrapped.dynamicInput);
    if (base.decision !== 'allow' || writeTargetsAreRoutine(segment, shell, roots))
        return base;
    return semanticReview(`redirection writes outside routine project content: ${segment.writeTargets.map(target => target.text).join(', ')}`);
}
function classifyEffectiveCommand(name, words, segment, shell, roots, artifacts, owner, dynamicInput) {
    const operands = [...words.slice(1), ...segment.readTargets];
    const deletion = deletionSpec(name, words, shell);
    if (deletion !== undefined) {
        if (dynamicInput)
            return manualReview('deletion operands arrive from piped input and cannot be read statically');
        if (deletion.targets.length === 0)
            return manualReview('deletion target could not be determined');
        if (deletion.targets.some(target => target.dynamic)) {
            return manualReview('deletion target is produced by a dynamic expansion');
        }
        const paths = deletion.targets.map(target => normalizePath(target.text, roots.workspace, roots.home));
        if (deletion.targets.every(target => !target.glob)
            && paths.every(path => artifacts.has(owner, path, roots) && isArtifactArea(path, roots))) {
            return allowed(`delete exact session-created artifact${paths.length === 1 ? '' : 's'}: ${paths.join(', ')}`);
        }
        return semanticReview(`deleting pre-session or unobserved data requires specific user authorization: ${paths.join(', ')}`);
    }
    if (dynamicInput)
        return ambiguous(`operands arrive from piped input and require independent classification: ${name}`);
    // A write redirection turns an otherwise read-only command into a file
    // mutation (`echo x > report.txt`), so the segment must never ride the
    // static read-only allow — even when the target is ordinary project
    // content. It falls through to the ordinary evaluation flow below, which
    // ends in an independent classification. Discard sinks (/dev/null, NUL,
    // $null) are not file writes and keep the fast path.
    const redirectedToFile = segment.writeTargets.some(target => !isNullSink(target, shell));
    if (name === 'find' && !findActionsAreReadOnly(words)) {
        return semanticReview(findHasDestructiveAction(words)
            ? 'find deletion requires specific user authorization'
            : 'find executes or writes through a non-read-only action and requires independent classification');
    }
    if (!redirectedToFile && readOnlyCommand(name, words, shell)) {
        return readPathsAreRoutine(operands, roots)
            ? allowed('static read-only command inside the workspace or temporary area')
            : semanticReview('read-only command references a protected or external path');
    }
    // Build-or-test and version-probe segments keep their static allow under a
    // write redirection only when every real-file target provably stays inside
    // the workspace; a violating target drops the whole segment into the
    // ordinary evaluation flow below instead of riding the fast path.
    const fastPathRedirect = !redirectedToFile || redirectTargetsStayOnFastPath(segment, shell, roots);
    if (versionProbe(words) && fastPathRedirect)
        return allowed('static development-tool version probe');
    if (buildOrTest(words) && fastPathRedirect) {
        return readPathsAreRoutine(operands, roots)
            ? allowed('recognized project build, test, or verification command')
            : semanticReview('build or test command references a protected or external path');
    }
    const creation = creationSpec(name, words, shell, roots);
    if (creation !== undefined) {
        if (words.some(word => word.dynamic || word.glob)) {
            return semanticReview(`creating a dynamically named path requires semantic review: ${creation.paths.join(', ')}`);
        }
        return creation.protected
            ? semanticReview(`creating outside routine project content requires specific user authorization: ${creation.paths.join(', ')}`)
            : allowed('create exact project-local artifacts', creation.paths);
    }
    if (shell === 'bash' && ['cp', 'mv'].includes(name)) {
        // Flags stay in the list: explicitPaths lifts embedded values out of
        // them, so `--target-directory=C:/abs` is judged like a bare operand.
        const operands = words.slice(1);
        const paths = explicitPaths(operands, roots);
        const tildeUser = operands.some(word => tildeUserTarget(word.text));
        return !tildeUser && paths.length > 0 && paths.every(path => isEffectiveRoutine(path, roots) && !isProtectedProjectPath(path, roots)
            && !(!isWithin(roots.workspace, path) && sensitiveBasenameAt(path, roots)))
            ? allowed('static project-local file operation')
            : semanticReview('file move/copy target is external, protected, or unclear');
    }
    const tokens = words.map(word => word.text);
    if (name === 'git' && ['reset', 'clean', 'commit', 'push', 'rebase', 'checkout', 'switch', 'branch', 'tag'].includes(tokens[1]?.toLowerCase() ?? '')) {
        return semanticReview(`Git state-changing command requires specific user authorization: ${tokens.slice(0, 3).join(' ')}`);
    }
    if (['curl', 'wget', 'invoke-webrequest', 'invoke-restmethod', 'ssh', 'scp', 'rsync'].includes(name)) {
        return semanticReview(`external network operation requires specific user authorization when it writes or transmits data: ${name}`);
    }
    if (/^(?:dropdb|createdb|psql|mysql|mongosh|redis-cli|kubectl|terraform|ansible|systemctl|launchctl)$/.test(name)) {
        return semanticReview(`database, service, or infrastructure operation requires specific user authorization: ${name}`);
    }
    return ambiguous(`unrecognized ${shell} command requires independent classification: ${name}`);
}
/**
 * Classify one Bash or PowerShell call after hard-deny evaluation.
 *
 * A compound line is assessed segment by segment. Syntax alone never blocks
 * semantic classification. Only destructive targets hidden behind dynamic or
 * opaque execution stay on the one-shot human approval path.
 */
export function assessShell(source, shell, roots, artifacts, owner) {
    const hard = hardDenyShellReason(source, shell, roots);
    if (hard !== undefined)
        return denied(hard);
    const decomposition = decomposeCommandLine(source, shell);
    if (decomposition.kind === 'opaque') {
        return destructiveNestedSource(source)
            ? manualReview(`${shell} destructive command cannot be read statically: ${decomposition.reason}`)
            : semanticReview(`${shell} command requires independent classification because it cannot be read statically: ${decomposition.reason}`);
    }
    const assessments = decomposition.segments.map(segment => assessSegment(segment, shell, roots, artifacts, owner));
    const blocked = assessments.find(assessment => assessment.decision === 'ask' && !assessment.classifierEligible);
    if (blocked !== undefined)
        return blocked;
    if (assessments.every(assessment => assessment.decision === 'allow')) {
        const creates = assessments.flatMap(assessment => assessment.plannedCreates ?? []);
        return allowed(assessments.length === 1
            ? assessments[0].reason
            : `every command in this ${shell} line is a recognized routine operation`, creates);
    }
    const reasons = assessments.filter(assessment => assessment.decision !== 'allow').map(assessment => assessment.reason);
    return semanticReview([...new Set(reasons)].join('; ').slice(0, 800));
}
/** Reader commands whose non-flag operand names a file opened for reading. */
const STATE_READ_COMMANDS = new Set(['cat', 'less', 'head', 'tail', 'more', 'type', 'get-content', 'gc']);
/**
 * Audit-only detection (pure): basenames of plugin runtime-state files this
 * command line opens for READING — through a reader-command operand, a
 * copy/move source operand, or a `<` redirection source. Callers must use the
 * result strictly for observability trails; it never feeds any verdict.
 * Dynamically expanded operands cannot be resolved statically and stay
 * unreported.
 */
export function runtimeStateReadHits(source, shell, roots) {
    const decomposition = decomposeCommandLine(String(source ?? ''), shell);
    if (decomposition.kind === 'opaque')
        return [];
    const hits = [];
    for (const segment of decomposition.segments) {
        const sources = [...segment.readTargets];
        const unwrapped = unwrapCommand(segment.words);
        const name = commandName(unwrapped.words[0]?.text ?? '');
        if (STATE_READ_COMMANDS.has(name)) {
            for (let index = 1; index < unwrapped.words.length; index += 1) {
                const word = unwrapped.words[index];
                if (!word.text.startsWith('-'))
                    sources.push(word);
            }
        }
        else if (shell === 'bash' && ['cp', 'mv'].includes(name)) {
            // Sources are every bare operand except the destination: the last
            // one conventionally, or — when `-t/--target-directory` supplies
            // the destination — every remaining bare operand.
            const bare = [];
            let destinationByFlag = false;
            for (let index = 1; index < unwrapped.words.length; index += 1) {
                const text = unwrapped.words[index].text;
                if (text === '-t' || text === '--target-directory') {
                    destinationByFlag = true;
                    index += 1;
                    continue;
                }
                if (text.startsWith('--target-directory=')) {
                    destinationByFlag = true;
                    continue;
                }
                if (!text.startsWith('-'))
                    bare.push(unwrapped.words[index]);
            }
            if (!destinationByFlag)
                bare.pop();
            sources.push(...bare);
        }
        else if (shell === 'pwsh' && ['copy-item', 'move-item', 'copy', 'move', 'cpi', 'mi', 'cp', 'mv', 'mp'].includes(name)) {
            // Sources come from -Path/-LiteralPath in either the flag-plus-value
            // or `-Path:value` spelling, plus every positional operand; an
            // explicit -Destination makes ALL positionals sources (pwsh binds
            // position 0 to -Path), otherwise the last positional is the
            // destination itself and stays unreported.
            const bare = [];
            let destinationByFlag = false;
            for (let index = 1; index < unwrapped.words.length; index += 1) {
                const text = unwrapped.words[index].text;
                const inlineValue = /^-(?:path|literalpath):([\s\S]+)$/i.exec(text);
                if (inlineValue !== null) {
                    bare.push({ text: inlineValue[1], dynamic: false, glob: false, quoted: true });
                    continue;
                }
                if (/^-(?:path|literalpath)$/i.test(text)) {
                    const value = unwrapped.words[index + 1];
                    if (value !== undefined)
                        bare.push(value);
                    index += 1;
                    continue;
                }
                if (/^-destination(?::|$)/i.test(text)) {
                    destinationByFlag = true;
                    if (!text.includes(':'))
                        index += 1;
                    continue;
                }
                // Value-taking noise flags: their values are neither sources
                // nor destinations.
                if (/^-(?:filter|include|exclude|credential)$/i.test(text)) {
                    index += 1;
                    continue;
                }
                if (!text.startsWith('-'))
                    bare.push(unwrapped.words[index]);
            }
            if (!destinationByFlag)
                bare.pop();
            sources.push(...bare);
        }
        for (const word of sources) {
            if (word.dynamic || word.glob)
                continue;
            const normalized = normalizePath(word.text, roots.workspace, roots.home);
            const base = normalized.split(/[\\/]/).pop()?.toLowerCase() ?? '';
            if (RUNTIME_STATE_BASENAMES.has(base) && !hits.includes(base))
                hits.push(base);
        }
    }
    return hits;
}