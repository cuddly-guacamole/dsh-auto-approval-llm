// @ts-nocheck
// Ported from @nanmicoder/dsh-auto-mode (shell.js).
// MIT License, Copyright (c) 2026 程序员阿江-Relakkes (https://github.com/NanmiCoder/dsh-auto-mode).
// Retained per the MIT License: this is a substantial portion of the original.
import { basename } from 'node:path';
import { globRootOf, hardDestructiveTargetReason, isArtifactArea, isCriticalPath, isProtectedProjectPath, isProtectedReadMetadata, isWithin, normalizePath, runtimeStateBasename, runtimeStateTargetInZone, runtimeStateTargetReason, } from './paths.js';
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
    /**
     * Operator that will precede the next segment pushed. Kept so consumers can
     * tell a `&&` chain (where reaching a later segment proves the earlier one
     * succeeded) from `;`/`|`/`&` (where it proves nothing).
     */
    let nextPrecededBy = '';
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
            segments.push({ words, writeTargets, readTargets, precededBy: nextPrecededBy });
        }
        words = [];
        writeTargets = [];
        readTargets = [];
        pending = undefined;
        nextPrecededBy = '';
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
            nextPrecededBy = '\n';
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
                nextPrecededBy = '&&';
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
            nextPrecededBy = '&';
            continue;
        }
        if (char === '|') {
            if (input[index + 1] === '|')
                index += 1;
            flushSegment();
            nextPrecededBy = '|';
            continue;
        }
        if (char === ';') {
            flushSegment();
            nextPrecededBy = ';';
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
    // `.env.example*` is a documentation template (same carve-out as the
    // read paths / protected-project fuses); a real `.env` or `.env.<env>`
    // (e.g. `.env.production`) stays a sensitive marker.
    return /(?:\.ssh[\\/]|\.gnupg[\\/]|\.aws[\\/]|\.kube[\\/]|\.credentials\.yaml|\.env(?!\.example)(?:$|[.\/\s])|id_(?:rsa|ed25519)|(?:API|AUTH|ACCESS|SECRET)[_-]?KEY|TOKEN|PASSWORD)/i.test(source);
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
    return globRootOf(target);
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
            const inlineValue = /^-(?:path|literalpath):(.+)$/i.exec(word.text);
            if (inlineValue !== null) {
                targets.push({ text: inlineValue[1], dynamic: word.dynamic, glob: word.glob, quoted: true });
            }
            else if (/^-(?:path|literalpath)$/i.test(word.text)) {
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
const WRAPPERS = new Set(['env', 'nohup', 'setsid', 'stdbuf', 'command', 'time', 'timeout', 'xargs', 'nice', 'ionice', 'busybox', 'toybox', 'watch', 'unbuffer']);
/** Privilege-escalation commands: hard-denied at the whole-line fuse AND per segment. */
const PRIVILEGE_COMMANDS = new Set(['sudo', 'doas', 'su', 'pkexec', 'runuser', 'runas', 'gsudo']);
/**
 * A Windows command name without its executable suffix.
 *
 * `sudo.exe`, `runas.exe` and `gsudo.exe` are the same programs as their bare
 * spellings, and Windows ships `sudo.exe` and `runas.exe` in System32, so a
 * privilege name set that only matched the bare spelling degraded an elevation
 * attempt into "unrecognized command → independent classification". Only the
 * privilege lookup normalizes this way: everywhere else the suffix is part of
 * the name the caller actually invoked.
 */
function commandNameWithoutExe(name) {
    return name.endsWith('.exe') ? name.slice(0, -4) : name;
}
/**
 * The whole-line privilege fuse. It is built from the same set the per-segment
 * check uses so the two spellings can never drift: the hand-written copy is
 * how `pkexec`, `runuser` and `runas` kept only an LLM-answerable ask while
 * `sudo` was hard-denied. The optional suffix keeps the `.exe` spelling of the
 * same program inside the fuse.
 */
const PRIVILEGE_COMMAND_PATTERN = new RegExp(`(?:^|[;&|({\`])\\s*(?:${[...PRIVILEGE_COMMANDS].join('|')})(?:\\.exe)?(?:\\s|$)`, 'i');
/** Interpreters whose inline source runs as shell code on this plane. */
const SHELL_CODE_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'fish', 'ksh', 'dash', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'eval', 'iex', 'invoke-expression']);
/** The plane a nested interpreter's own source belongs to. */
function shellPlaneOf(name) {
    return /^(?:cmd|cmd\.exe|powershell|powershell\.exe|pwsh|pwsh\.exe|iex|invoke-expression)$/.test(name) ? 'powershell' : 'bash';
}
/**
 * `env -S/--split-string VALUE` runs VALUE as a command line (the shebang
 * spelling), so VALUE is the real argv rather than an opaque flag value.
 * Consuming it as a value made `env` itself the effective command, which left
 * `env -S "rm -rf /"` a classifier-answerable ask while `rm -rf /` and
 * `sh -c "rm -rf /"` are hard-denied. Returns the words VALUE expands to plus
 * the words that follow it, or undefined when this is not the split spelling.
 */
export function envSplitStringWords(words) {
    for (let index = 1; index < words.length; index += 1) {
        const token = typeof words[index]?.text === 'string' ? words[index].text : '';
        const following = typeof words[index + 1]?.text === 'string' ? words[index + 1].text : '';
        // `--split-string`, any unambiguous abbreviation of it, and its `=`
        // value; GNU getopt accepts `--s`, `--sp`, … exactly like the full
        // spelling.
        const eq = token.indexOf('=');
        if (eq > 2 && SPLIT_STRING_LONG.test(token.slice(0, eq)))
            return { words: inlineCommandWords(token.slice(eq + 1)), rest: words.slice(index + 1) };
        if (SPLIT_STRING_LONG.test(token)) {
            if (words[index + 1] === undefined)
                return undefined;
            return { words: inlineCommandWords(following), rest: words.slice(index + 2) };
        }
        if (token.startsWith('--')) {
            if (token === '--unset' || token === '--chdir' || token === '--argv0')
                index += 1;
            continue;
        }
        if (!token.startsWith('-')) {
            if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token))
                continue;
            return undefined;
        }
        // A short-option cluster: `-S VALUE`, `-Svalue`, `-iS VALUE`, `-iSvalue`
        // and the other env flags. A value-taking letter swallows the rest of
        // the cluster, so only an `S` reached first names the split string.
        const cluster = token.slice(1);
        for (let at = 0; at < cluster.length; at += 1) {
            const letter = cluster[at];
            if (letter === 'S')
                return cluster.length > at + 1
                    ? { words: inlineCommandWords(cluster.slice(at + 1)), rest: words.slice(index + 1) }
                    : { words: inlineCommandWords(following), rest: words.slice(index + 2) };
            if (letter === 'u' || letter === 'C')
                break;
        }
        if (/^-[A-Za-z0-9]*[uC]$/.test(token))
            index += 1;
    }
    return undefined;
}
/** The `--split-string` long option, including its GNU abbreviations. */
const SPLIT_STRING_LONG = /^--(?:s|sp|spl|spli|split|split-|split-s|split-st|split-str|split-stri|split-strin|split-string)$/;
/** Split a split-string value the way `env -S` does: on whitespace, quotes kept. */
function inlineCommandWords(value) {
    return splitOpaqueWords(String(value));
}
/** Wrapper flags that consume the following word as their value. */
const WRAPPER_VALUE_FLAGS = {
    xargs: /^-(?:n|I|i|P|L|s|d|E|a)$|^--(?:max-args|replace|max-procs|max-lines|max-chars|delimiter|eof|arg-file|process-slot-var)$/,
    stdbuf: /^-(?:i|o|e)$|^--(?:input|output|error)$/,
    nice: /^-(?:n)$|^--adjustment$/,
    ionice: /^-(?:c|n|p|P|u)$|^--(?:class|classdata|pid|pgid|uid)$/,
    // env: `-u/--unset NAME`, `-C/--chdir DIR` and `--argv0 NAME` consume the
    // following word; `-S/--split-string` is spliced as a command line before
    // this table is consulted, and an empty split string falls back to
    // consuming the value. Without these entries the effective command became
    // the flag's VALUE (`env -u FOO rm -rf /` unwrapped to `FOO`), so the
    // privilege, delete, write-operand and find fuses all skipped for the
    // separated spelling while `--unset=FOO` stayed covered.
    env: /^-(?:u|S|C)$|^--(?:unset|split-string|chdir|argv0)$/,
    // timeout: `-s/--signal <SIG>` and `-k/--kill-after <DUR>` take a value;
    // without them `timeout -s KILL 5 sudo …` unwraps to `KILL` as the
    // "effective command" and skips the privilege/delete fuses entirely.
    timeout: /^-(?:s|k)$|^--(?:signal|kill-after)$/,
    time: /^-(?:o|f)$|^--(?:output|format)$/,
    watch: /^-(?:n)$/,
};
/**
 * Long options whose value is the following word, per wrapper. GNU getopt
 * accepts any unambiguous abbreviation, and that abbreviation is an equivalent
 * spelling: `env --uns FOO rm -rf /` unwrapped to the flag's value `FOO`, so
 * the privilege, delete, write-operand and find fuses all skipped while
 * `env --unset FOO rm -rf /` was hard-denied. The long spellings live here
 * (shared by both planes) instead of being copied into each table.
 */
const WRAPPER_VALUE_LONG_OPTIONS = {
    xargs: ['max-args', 'replace', 'max-procs', 'max-lines', 'max-chars', 'delimiter', 'eof', 'arg-file', 'process-slot-var'],
    stdbuf: ['input', 'output', 'error'],
    nice: ['adjustment'],
    ionice: ['class', 'classdata', 'pid', 'pgid', 'uid'],
    env: ['unset', 'split-string', 'chdir', 'argv0'],
    timeout: ['signal', 'kill-after'],
    time: ['output', 'format'],
    watch: ['interval'],
};
/** Whether a wrapper flag consumes the following word, abbreviations included. */
export function wrapperValueFlag(name, token) {
    if (WRAPPER_VALUE_FLAGS[name]?.test(token) === true)
        return true;
    if (typeof token !== 'string' || !token.startsWith('--') || token.includes('='))
        return false;
    const option = token.slice(2);
    if (option === '')
        return false;
    const names = WRAPPER_VALUE_LONG_OPTIONS[name];
    return names !== undefined && names.some(full => full.startsWith(option));
}
/** Strip prefix wrappers so the effective command is judged, not the wrapper. */
function unwrapCommand(words) {
    let current = words;
    let dynamicInput = false;
    // Strip leading `NAME=value` environment prefixes (`VAR=val cmd`), which
    // are legal in both shells. Without this, `words[0]` being `VAR=val` made
    // the effective command name `var=val` and skipped the privilege / hard
    // destructive fuses entirely (`BLAH=0 sudo ls`, `BLAH=0 rm -rf /`). The
    // value may be EMPTY (`FOO= sudo ls` clears the variable for one command),
    // which is why the value part is optional: requiring `.+` left `FOO=` as
    // the effective command name and lost both fuses for that spelling.
    while (current.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(current[0]?.text ?? '')) {
        current = current.slice(1);
    }
    for (let depth = 0; depth < 4; depth += 1) {
        const name = commandName(current[0]?.text ?? '');
        if (!WRAPPERS.has(name))
            break;
        if (name === 'xargs')
            dynamicInput = true;
        // `env -S/--split-string VALUE` carries a whole command line, so its
        // value is spliced in as the effective command instead of being
        // consumed as an opaque flag value.
        const split = name === 'env' ? envSplitStringWords(current) : undefined;
        if (split !== undefined && split.words.length > 0) {
            current = [...split.words, ...split.rest];
            continue;
        }
        let index = 1;
        while (index < current.length) {
            const token = current[index].text;
            if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
                index += 1;
                continue;
            }
            if (!token.startsWith('-'))
                break;
            if (wrapperValueFlag(name, token))
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
/**
 * git `rev:path` object-read operands (`git show HEAD:.env`, `HEAD:src/x`, or
 * the index form `:./file`) bypass the bare-word path gate: `HEAD:.env` is not
 * an explicit-path spelling, so `explicitPaths` never sees the `.env` part and
 * an empty `.every()` over the extracted paths short-circuits to a static
 * allow. Extract colon operands and judge the path portion with the same
 * routine / protected / sensitive gates as a bare path. Returns the offending
 * operand text or undefined.
 */
function gitObjectReadProtected(words, roots) {
    for (const word of words) {
        const text = word?.text ?? word;
        if (typeof text !== 'string' || text === '' || text.startsWith('-'))
            continue;
        const colon = text.indexOf(':');
        if (colon < 0)
            continue;
        // `:./file` is the index form; `rev:path` splits on the first colon
        // (a rev can be `HEAD`, `HEAD~3`, `abc123`, `v1.0.0`).
        const pathPart = colon === 0 ? text.slice(1) : text.slice(colon + 1);
        if (pathPart === '' || pathPart.startsWith(':'))
            continue;
        const normalized = normalizePath(pathPart, roots.workspace, roots.home);
        if (isProtectedProjectPath(normalized, roots)
            || !isEffectiveRoutine(normalized, roots)
            || sensitiveBasenameAt(normalized, roots)) {
            return text;
        }
    }
    return undefined;
}
/** Deletion hidden behind an interpreter stays outside classifier authority. */
function destructiveNestedSource(source) {
    // A backtick substitution is a segment boundary like `$(`, so it belongs in
    // the anchor set: `` `rm -rf /` `` starts the nested source right after the
    // backtick and used to miss every anchor here.
    return /(?:^|[\s;&|()`])(?:rm|rmdir|unlink|shred|remove-item|del|erase)(?:\s|$)|\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir|removedirs)|file\.(?:delete|unlink)|directory\.delete)\s*\(|\.(?:rm|rmsync|unlink|unlinksync|rmdir|rmdirsync|delete)\s*\(|\b(?:delete\s+from|drop\s+(?:table|database)|truncate\s+table)\b/i.test(source);
}
/**
 * Whether a visible nested-execution source combines a file-write function
 * call with a DSH_HOME path literal. Static heuristic: catches the common
 * `node -e "fs.writeFileSync('~/.dsh/…')"` shape while leaving dynamic path
 * construction to the LLM classifier. Closes the node -e / python -c write
 * vectors to DSH_HOME.
 */
export function nestedSourceWritesToDshHome(source, roots) {
    if (typeof source !== 'string' || source.length === 0)
        return false;
    const WRITE_FN = /(?:writefilesync|writefile|createwritestream|appendfilesync|appendfile|copyfilesync|cpsync|copy\s*\(|open\s*\([^)]*['"][wa]['"]|io\.open|\.write\s*\(|os\.write|path\s*\(\s*['"]|file\s*\(\s*['"]\s*[,]\s*['"]w)|(?:shutil\.copy|shutil\.move|open\s*\([^)]*['"]w['"])/i;
    return WRITE_FN.test(source) && dshHomeExfil(source, roots) === true;
}
/** Redirect targets written inside a nested source: `>`, `>>`, `2>`, `&>`. */
const NESTED_REDIRECT_TARGET = /(?:^|[\s;&|(`])(?:\d*&?>{1,2})\s*([^\s;&|()<>`]+)/g;
/**
 * Whether any redirect target inside a nested inline source is a hard-deny
 * target (DSH_HOME / runtime-state / critical paths). Same static heuristic
 * contract as nestedSourceWritesToDshHome: ordinary workspace targets stay
 * with the classifier, denied targets never reach it.
 */
function nestedRedirectTargetsDenied(source, roots) {
    if (typeof source !== 'string' || source.length === 0)
        return false;
    for (const match of source.matchAll(NESTED_REDIRECT_TARGET)) {
        if (hardDestructiveTargetReason(match[1], roots) !== undefined)
            return true;
    }
    return false;
}
/**
 * Hard-deny reason when a find -exec body writes through a nested interpreter
 * into a denied target (`find . -exec bash -c 'echo x >> ~/.dsh/…' \;`). The
 * quoted `-c` source is one opaque word, so the per-segment redirect fuse never
 * sees it and the body used to fall through to semantic review — an LLM
 * answerable DSH_HOME write. The deletion counterpart lives in
 * findHasDestructiveAction.
 */
function findNestedWriteDenyReason(words, roots) {
    for (let index = 1; index < words.length; index += 1) {
        const token = words[index].text.toLowerCase();
        if (!FIND_NESTED_ACTION.test(token))
            continue;
        const terminator = words.findIndex((word, nestedIndex) => nestedIndex > index && (word.text === ';' || word.text === '+'));
        if (terminator < 0)
            return undefined;
        const nested = words.slice(index + 1, terminator);
        const nestedExec = nestedExecution(commandName(nested[0]?.text ?? ''), nested);
        const source = typeof nestedExec?.source === 'string' ? nestedExec.source : undefined;
        if (source !== undefined && (nestedSourceWritesToDshHome(source, roots) || nestedRedirectTargetsDenied(source, roots)))
            return 'find executes a nested command writing to a protected location';
        if (source === undefined) {
            // A nested body without an interpreter boundary is an ordinary
            // command judged on its own operands (`find . -exec cp a b \;`,
            // `-exec rm ~/.dsh/x \;`, `-exec sed -i …`): hand it to the same
            // segment fuses so a direct DSH_HOME / runtime-state / critical
            // / deletion target cannot hide behind find -exec and decay into
            // an LLM-answerable ask. Interpreter bodies keep the source scan
            // above; `{}` placeholders are not explicit paths and stay with
            // the caller's routine/semantic judgment.
            const reason = segmentHardDenyReason({ words: nested, writeTargets: [], readTargets: [] }, 'bash', roots);
            if (reason !== undefined)
                return `find -exec nested command: ${reason}`;
        }
        index = terminator;
    }
    return undefined;
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
    // An interior `..` segment is explicit for the same reason: a token that
    // only *starts* with a plain name (`b/../../../../Users/…`) climbs out of
    // the workspace exactly like a leading `../`, and dropping it left the
    // routine gate with an empty path list and a `true` answer.
    return token.startsWith('/') || token.startsWith('.')
        || token.startsWith('~') || /^[A-Za-z]:[\\/]/.test(token) || /^\\\\/.test(token)
        || token.split(/[\\/]/).includes('..');
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
    return explicitPaths(words, roots).every(path => (isEffectiveRoutine(path, roots) && !isProtectedReadMetadata(path, roots)
        && !(!isWithin(roots.workspace, path) && sensitiveBasenameAt(path, roots)))
        || roots.tempRoots.some(root => isWithin(root, path)));
}
/**
 * Whether a shell command line READS credential material (a sensitive basename
 * or tree, or a critical path). Same question the policy layer answers with its
 * `credentialRead` field for the structured readers, asked here for the shell
 * vector so one floor covers both.
 *
 * A shell `cat`/`grep` of a token store is labeled `protected` by the category
 * layer through its own read-target check, so a floor wired only to the
 * structured readers would leave the widest reader of all unlockable by
 * `protectedAutoReview` + an explicit `protected: 'auto'`.
 *
 * Deliberately reuses `decomposeCommandLine` + `explicitPaths` and the same two
 * predicates the category and policy layers use — not a second lexer and not a
 * second sensitivity table. A command that cannot be read statically (opaque)
 * is judged conservative: an opaque line's read operands are unknown, so any
 * such line counts as potentially-credential only when it also carries the
 * literal markers `explicitPaths` can lift; otherwise the category layer will
 * not have labeled it `protected` either, and the clamp has nothing to bite on.
 */
export function shellReadsCredentialMaterial(source, shell, roots) {
    if (typeof source !== 'string' || source.length === 0)
        return false;
    const decomposition = decomposeCommandLine(source, shell);
    if (decomposition.kind !== 'segments')
        return false;
    for (const segment of decomposition.segments) {
        const unwrapped = unwrapCommand(segment.words);
        const name = commandName(unwrapped.words[0]?.text ?? '');
        // A reader's operands are all sources. A file-manipulating command has
        // SOURCES too, and those decide whether credential material is exposed:
        // `cp secret out`, `tee out < secret` and `dd if=secret of=out` all make
        // the bytes reachable through the tool result, so they count as
        // credential reads for this flag even though the head writes. The write
        // DESTINATION is the write fuse's business — but a destination that is
        // itself a sensitive name stays flagged too, since a credential store
        // being overwritten is no less sensitive.
        const judgesSources = readOnlyCommand(name, unwrapped.words, shell)
            || writesThroughOperands(name, unwrapped.words)
            // cp/mv are not in writesThroughOperands (their destinations come
            // from the operand list instead), but their sources are just as
            // readable as tee's stdin.
            || name === 'cp' || name === 'mv';
        if (!judgesSources)
            continue;
        const operands = [...unwrapped.words.slice(1), ...segment.readTargets];
        if (name === 'dd')
            operands.push(...ddInputTargets(unwrapped.words));
        for (const path of explicitPaths(operands, roots)) {
            if (sensitiveBasenameAt(path, roots) || isCriticalPath(path, roots))
                return true;
        }
    }
    return false;
}
/**
 * Path operands a shell command line hands to a command, as NORMALIZED absolute
 * paths, for the host symlink/escape guard.
 *
 * The guard's whole premise is "whoever is missing from the target list has no
 * realpath re-check", and `bash` / `pwsh` were missing from `symlinkGuardTargets`
 * — so `cat ext/id_rsa`, with `ext` a workspace junction onto a credential tree,
 * was statically allowed with no panel, no classifier and no countdown, while
 * the same path through the `read` tool was hard-denied.
 *
 * Deliberately reuses the single lexer (`decomposeCommandLine`), the single path
 * normalizer (`normalizePath`) and the single changer-base owner
 * (`effectiveCwdAfter`) instead of growing a second command parser or a second
 * notion of "which directory does this segment see". It differs from
 * `explicitPaths` in ONE respect: a bare relative operand (`ext/id_rsa`,
 * `history.jsonl`) counts as a candidate too. Filtering those out is what made
 * the guard miss the very shape it exists to catch, and a token that is not a
 * path at all resolves to the deepest existing ancestor of the workspace and
 * triggers nothing — the resolution, not a spelling heuristic, decides.
 *
 * The changer base follows the `&&`-only rule the hard-deny fuse already uses,
 * and it is here for a second reason: it makes `cd ~/.ssh && cat id_rsa` a hit
 * (the relative operand resolves against the directory the segment really sees)
 * rather than a miss against the workspace.
 *
 * Absolute spellings are ALSO recovered straight from the raw line, and that
 * recovery is load-bearing rather than belt-and-braces: the bash lexer treats
 * `\` as an escape, so an unquoted `cat C:\Users\u\.ssh\id_rsa` reaches the
 * operand list as `C:Usersu.sshid_rsa` — the drive-letter form of exactly the
 * read this guard exists to stop. Every other spelling of the same read
 * (quoted, forward-slash, pwsh) survives the lexer. This is still not a second
 * lexer: it scans only for literal drive-letter / UNC spellings, adds them as
 * candidates, and lets the same resolution decide.
 *
 * Returns `undefined` when no candidate at all was found, including a command
 * line that cannot be decomposed statically (opaque: `$(...)`, `(...)`,
 * heredocs, unbalanced quotes) and carries no literal absolute spelling. An
 * opaque line's operands are unknown, and guessing them would turn the guard
 * into a source of false denials; such a line keeps exactly today's behaviour.
 */
const RAW_ABSOLUTE_PATH = /(?:^|[^A-Za-z0-9_])((?:[A-Za-z]:[\\/]|\\\\[^\s"'|&;<>()]+)[^\s"'|&;<>()]*)/g;

/**
 * The path spelling inside one operand token, or '' when the token is not one.
 *
 * Three shapes carry a path in a non-leading position and used to be dropped:
 *   - a flag value (`--file=ext/id_rsa`, pwsh `-Path:ext\id_rsa`);
 *   - a command-specific key value (`dd if=ext/id_rsa`);
 *   - a curl-style form field (`-F file=@ext/id_rsa`, where `@` marks a file).
 *
 * A bare `NAME=value` is NOT skipped wholesale any more: `unwrapCommand` already
 * strips the environment prefixes that precede a command, so the blanket filter
 * only ever removed real operands — `dd if=<junction>/id_rsa` and
 * `curl -F file=@<junction>/id_rsa` were both invisible to the guard because of
 * it. A token that is genuinely an assignment with no path-looking value (for
 * example `--pretty=format:%h`) normalizes to a workspace-relative pseudo-path
 * and triggers nothing.
 */
function operandPathSpelling(text) {
    if (text === '')
        return '';
    if (text.startsWith('-')) {
        // `-Flag:value`, `-Flag=value`, `--flag=value` and `--flag:value`. The
        // inline colon is a real gap (pwsh carries no separated operand), and the
        // long forms put the value after `=`.
        const colon = /^-{1,2}[A-Za-z][A-Za-z0-9-]*(?::|=)(.+)$/.exec(text);
        if (colon !== null)
            return colon[1];
        return '';
    }
    const keyed = /^[A-Za-z_][A-Za-z0-9_-]*=(.+)$/.exec(text);
    if (keyed !== null) {
        const value = keyed[1];
        return value.startsWith('@') ? value.slice(1) : value;
    }
    return text;
}

export function shellGuardTargets(source, shell, roots) {
    if (typeof source !== 'string' || source.length === 0)
        return undefined;
    const out = [];
    const decomposition = decomposeCommandLine(source, shell);
    if (decomposition.kind === 'segments') {
        let changerBase;
        for (const segment of decomposition.segments) {
            if (segment.precededBy !== '' && segment.precededBy !== '&&')
                changerBase = undefined;
            const segmentRoots = changerBase !== undefined ? { ...roots, workspace: changerBase } : roots;
            const unwrapped = unwrapCommand(segment.words);
            // Leading `VAR=value cmd` prefixes and any wrapper words consumed by
            // unwrapCommand are dropped; the effective command name heads what is
            // left and is not an operand.
            const stripped = segment.words.slice(0, segment.words.length - unwrapped.words.length);
            const operands = [...unwrapped.words.slice(1), ...segment.readTargets, ...segment.writeTargets];
            for (const word of operands) {
                if (word === undefined || stripped.includes(word))
                    continue;
                const text = typeof word.text === 'string' ? word.text : '';
                const spelled = operandPathSpelling(text);
                if (spelled === '')
                    continue;
                out.push(normalizePath(spelled, segmentRoots.workspace, segmentRoots.home));
            }
            const next = effectiveCwdAfter(segment, shell, segmentRoots);
            if (next !== undefined)
                changerBase = next;
        }
    }
    for (const match of source.matchAll(RAW_ABSOLUTE_PATH)) {
        const raw = match[1];
        if (raw !== undefined && raw !== '')
            out.push(normalizePath(raw, roots.workspace, roots.home));
    }
    const unique = [...new Set(out)];
    return unique.length === 0 ? undefined : unique;
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
const FIND_MUTATING_ACTION = /^-(?:delete|fprint|fprint0|fprintf|fls)$/;
const FIND_NESTED_ACTION = /^-(?:exec|execdir|ok|okdir)$/;
/** find actions whose next word is an output FILE (`-fprint F`, `-fprint0 F`, `-fls F`). */
const FIND_WRITE_ACTION = /^-(?:fprint|fprint0|fprintf|fls)$/;
/**
 * cp/mv/install flags whose value is a SEPARATE word. Without this the value
 * (`-m 755`, `-S orig`) became the last positional and the real destination
 * (`lib/index.js`) fell out of both the fuse and the static-allow judgement.
 */
const COPY_DEST_VALUE_FLAGS = new Set(['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group', '--strip-program']);
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
/**
 * Output/write flags of whitelisted read-only commands, keyed per command:
 * `-o` means "only matching" for `rg`/`grep` and must never be treated as a
 * write, so a shared short-flag list would over-block. `git` only writes
 * through the long form (`--output`), not through `--output-indicator-*`.
 */
const READ_ONLY_OUTPUT_FLAGS = {
    sort: /^(?:-[a-zA-Z]*o.*|--o(?:u(?:t(?:p(?:u(?:t)?)?)?)?)?(?:=.*)?)$/,
    tree: /^(?:-[a-zA-Z]*o.*|--o(?:u(?:t(?:p(?:u(?:t)?)?)?)?)?(?:=.*)?)$/,
    git: /^--output(?:=.*)?$/,
};
/**
 * Mutating `date` flags in every GNU spelling: the long form may carry its
 * value with `=` and may be abbreviated (`--s`, `--se`), and a short option
 * cluster may fuse its value (`-s2020-01-01`, `-us2020-01-01`). A cluster is a
 * clock write only when `s`
 * is the first value-taking letter: `-I[FMT]`, `-d`, `-f` and `-r` swallow the
 * rest of their cluster as a READ-ONLY value, so `date -Iseconds` and
 * `date -Ins` are format spellings rather than `--set`.
 */
function isDateClockWriteFlag(token) {
    if (/^--s(?:e(?:t)?)?(?:=.*)?$/.test(token))
        return true;
    if (!/^-[^-]/.test(token))
        return false;
    const cluster = token.slice(1);
    const valueOption = cluster.search(/[dIfrs]/);
    return valueOption >= 0 && cluster[valueOption] === 's';
}
/**
 * Whether a `date` invocation sets the system clock. Setting the clock is
 * neither a task for an agent session nor recoverable by the session: it moves
 * the timeline every other recorded event is dated against, it can expire or
 * resurrect credentials and sessions, and no static rule can bound its effect.
 * A clock write is therefore refused outright rather than handed to an
 * independent classifier — one classifier mistake used to be enough to let an
 * auto session move the machine clock, since such a call is otherwise an
 * ordinary `ask` and the unattended countdown settles it.
 */
function dateClockWriteReason(name, tokens) {
    if (name !== 'date')
        return undefined;
    return tokens.slice(1).some(token => isDateClockWriteFlag(token))
        ? 'the system clock is not settable from agent sessions'
        : undefined;
}
/** The write targets a read-only command carries inside its own output flag. */
function readOnlyOutputFlagTargets(name, words, shell) {
    if (shell !== 'bash')
        return [];
    const pattern = READ_ONLY_OUTPUT_FLAGS[name];
    if (pattern === undefined)
        return [];
    const targets = [];
    for (let index = 1; index < words.length; index += 1) {
        const word = words[index];
        const text = word.text;
        if (!pattern.test(text))
            continue;
        const eq = text.indexOf('=');
        if (eq > 1) {
            targets.push({ text: text.slice(eq + 1), dynamic: word.dynamic, glob: word.glob, quoted: word.quoted });
            continue;
        }
        // The long form carries its value either with `=` (handled above) or as
        // the NEXT word (`sort --output FILE`). Slicing after the first `o` of
        // the flag name produced the literal target `utput`, so the real
        // destination reached no fence at all: `sort --output <protected>`
        // degraded from hard deny to a classifier-answerable ask.
        if (text.startsWith('--')) {
            const value = words[index + 1];
            if (value !== undefined)
                targets.push(value);
            continue;
        }
        const at = text.indexOf('o', 1);
        if (at === text.length - 1) {
            const value = words[index + 1];
            if (value !== undefined)
                targets.push(value);
            continue;
        }
        targets.push({ text: text.slice(at + 1), dynamic: word.dynamic, glob: word.glob, quoted: word.quoted });
    }
    return targets.filter(target => target.text !== '');
}
function readOnlyCommand(name, words, shell) {
    const tokens = words.map(word => word.text);
    if (shell === 'bash') {
        // Whitelist members with mutating or executing spellings keep only
        // their read-only forms; every other spelling falls through to
        // independent classification instead of the static allow.
        if (name === 'rg' && tokens.slice(1).some(token => /^--pre(?:=.*)?$/.test(token)))
            return false;
        // A whitelisted read-only command can still hand work to a program the
        // caller never wrote on the line: `sort --compress-program=PROG` runs
        // PROG over the sort temporaries and `-T` names a directory to write
        // them into, so those spellings leave the static allow exactly like
        // `rg --pre` above.
        if (name === 'sort' && tokens.slice(1).some(token => /^(?:--co|--te|-T)/.test(token)))
            return false;
        if (name === 'date')
            return !tokens.slice(1).some(token => isDateClockWriteFlag(token));
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
/** Values of dd's `of=` operands — the only dd spelling that names an output file. */
function ddOutputTargets(words) {
    const targets = [];
    for (let index = 1; index < words.length; index += 1) {
        const match = /^of=(.+)$/i.exec(words[index].text);
        if (match !== null)
            targets.push({ text: match[1], dynamic: words[index].dynamic, glob: words[index].glob, quoted: true });
    }
    return targets;
}
/** `dd if=…` sources: the operand the command reads its bytes from. */
function ddInputTargets(words) {
    const targets = [];
    for (let index = 1; index < words.length; index += 1) {
        const match = /^if=(.+)$/i.exec(words[index].text);
        if (match !== null)
            targets.push({ text: match[1], dynamic: words[index].dynamic, glob: words[index].glob, quoted: true });
    }
    return targets;
}
/** Whether a sed invocation edits files in place (`-i`, `-i.suffix`, `--in-place[=suffix]`). */
function sedEditsInPlace(words) {
    return words.slice(1).some((word) => /^-i/.test(word.text) || /^--in-place(?:=|$)/.test(word.text));
}
/**
 * Whether the flags supply sed's script explicitly (`-e`/`-f` in separate,
 * fused, or long form), so every remaining bare operand is an edited file.
 * Without them the first bare operand is the script text; it can name
 * path-like strings, so counting it as a write target would hard-deny
 * ordinary edits whose expression merely mentions a state-file basename.
 */
function sedScriptFlagPresent(words) {
    return words.slice(1).some((word) => /^--(?:expression|file)(?:=.+)?$/.test(word.text)
        || word.text === '-e' || word.text === '-f'
        || /^-[ef]./.test(word.text));
}
function sedInPlaceTargets(words) {
    const bare = words.slice(1).filter((word) => !word.text.startsWith('-'));
    return sedScriptFlagPresent(words) ? bare : bare.slice(1);
}
/**
 * Bash heads beyond copy/move and creation whose own operands mutate files:
 * `tee` writes its operands outright, `dd` writes through `of=`, `sed -i`
 * rewrites its inputs in place, `truncate` resizes them, coreutils `install`
 * copies onto the destination. Read-mode spellings (`sed` without `-i`, `dd`
 * without `of=`) stay outside the family so their original handling is kept.
 */
function writesThroughOperands(name, words) {
    if (name === 'tee' || name === 'truncate' || name === 'install')
        return true;
    if (name === 'dd')
        return ddOutputTargets(words).length > 0;
    if (name === 'sed')
        return sedEditsInPlace(words);
    return false;
}
/**
 * Write-target operands of a command word list. cp/install: the destination is
 * the LAST POSITIONAL operand and the earlier ones are sources (reads) that
 * must not be denied as writes; `mv` removes its sources, so every positional
 * is judged. `-t DEST` / `--target-directory=DEST` invert the operand order:
 * their value IS the destination no matter where it sits. Dynamic/glob
 * operands are KEPT in the result: callers must judge them (a dynamic target
 * cannot be statically proven inside the routine roots, and `$HOME` spellings
 * are hard-denied exactly like the redirection and deletion branches do).
 */
function writeOperandCandidates(words, name) {
    if (!words || words.length === 0)
        return [];
    const positionals = [];
    for (let index = 1; index < words.length; index += 1) {
        if (words[index].text.startsWith('-') || COPY_DEST_VALUE_FLAGS.has(words[index - 1]?.text ?? ''))
            continue;
        positionals.push(words[index]);
    }
    const candidates = [];
    if (name === 'mv') {
        candidates.push(...positionals);
    }
    else {
        // The destination is the last POSITIONAL, not the last word: GNU
        // getopt permutes trailing flags (`cp a b -v`), which used to hide the
        // destination from every operand fuse below.
        let targetDirectory = false;
        for (let index = 1; index < words.length; index += 1) {
            const text = words[index].text;
            if (text === '-t' || text === '--target-directory' || text.startsWith('--target-directory=') || /^-t[^-]/.test(text))
                targetDirectory = true;
        }
        if (!targetDirectory && positionals.length > 0)
            candidates.push(positionals[positionals.length - 1]);
    }
    for (let index = 1; index < words.length; index += 1) {
        const text = words[index].text;
        if (text === '-t' || text === '--target-directory') {
            const value = words[index + 1];
            if (value !== undefined)
                candidates.push(value);
        }
        else if (text.startsWith('--target-directory=')) {
            const value = text.slice('--target-directory='.length);
            if (value !== '')
                // The fused spelling derives a new operand from one word; the
                // derived operand must inherit that word's dynamic/glob flags
                // (the lexer marks a `$VAR`/`*` spelling dynamic/glob on the
                // word itself). Dropping them let a `$HOME` target dodge the
                // dynamic-home hard-deny and a `*`/`?` target dodge the glob
                // gate; `-t DEST` (separate word above) already preserves the
                // flags, so this branch must not diverge from it.
                candidates.push({ text: value, dynamic: words[index].dynamic, glob: words[index].glob, quoted: true });
        }
        else if (/^-t[^-]/.test(text)) {
            // GNU getopt fuses a flag with its value: `-t./lib` IS
            // `-t ./lib`. Only the separated and `--long=` spellings used to
            // be read, so the destination never entered the operand list and
            // every write-target fuse judged the SOURCE instead — a fused
            // `-t` was a silent, statically allowed write to the plugin's own
            // execution code. Same inherited flags as the `--long=` branch.
            const value = text.slice(2);
            candidates.push({ text: value, dynamic: words[index].dynamic, glob: words[index].glob, quoted: true });
        }
    }
    return candidates;
}
// Unconditional DSH_HOME write fuse for shell vectors. Structured tools
// (edit/write/apply_patch/…) honor trustedDshSubpaths openings; shell write
// targets are extracted by a shallow lexer that cannot verify shell
// semantics (nested execution, here-docs, process substitution), so shell
// writes to DSH_HOME stay hard-denied even inside an opening.
function shellWriteToDshHomeDenied(normalizedPath, roots) {
    if (isWithin(roots.dshHome, normalizedPath))
        return 'shell write to DSH_HOME is not permitted by auto mode — use the write or edit tool instead';
    return undefined;
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
        const dshReason = shellWriteToDshHomeDenied(normalizePath(target.text, roots.workspace, roots.home), roots);
        if (dshReason !== undefined)
            return `redirection targets ${dshReason}`;
    }
    const unwrapped = unwrapCommand(segment.words);
    const name = commandName(unwrapped.words[0]?.text ?? '');
    // The per-segment privilege check in `hardDenyShellReason` only runs on
    // decomposable lines, so the opaque recovery and `find -exec` lost the
    // fuse: `(env sudo ls)`, `(/usr/bin/sudo ls)`, `(timeout 5 sudo ls)` and
    // `(A=1 sudo ls)` were classifier-answerable asks while the same text
    // without the grouping is hard-denied. Judging the effective name here
    // gives every caller the same owner.
    if (PRIVILEGE_COMMANDS.has(commandNameWithoutExe(name)))
        return 'privilege escalation is not permitted by auto mode';
    // Commands whose non-flag operands are write destinations (copy/move,
    // creation, pwsh output cmdlets): a runtime-state target inside the zone is
    // an unconditional hard deny, and the same normalization the allow path
    // uses must not weaken when the workspace IS the zone.
    let writeOperands = null;
    if (shell === 'bash' && ['cp', 'mv'].includes(name)) {
        writeOperands = writeOperandCandidates(unwrapped.words, name);
    }
    else if (shell === 'bash' && ['mkdir', 'touch'].includes(name)) {
        writeOperands = unwrapped.words.slice(1).filter(word => !word.text.startsWith('-'));
    }
    else if (shell === 'bash' && writesThroughOperands(name, unwrapped.words)) {
        // Destination extraction mirrors how each head really writes: install
        // behaves exactly like copy/move (last bare operand, or every bare
        // operand once -t/--target-directory supplies the destination); dd
        // names its output only through of=; in-place sed edits its file
        // operands; tee and truncate write their bare operands directly.
        if (name === 'install')
            writeOperands = writeOperandCandidates(unwrapped.words, name);
        else if (name === 'dd')
            writeOperands = ddOutputTargets(unwrapped.words);
        else if (name === 'sed')
            writeOperands = sedInPlaceTargets(unwrapped.words);
        else
            writeOperands = unwrapped.words.slice(1).filter(word => !word.text.startsWith('-'));
    }
    else if (shell === 'pwsh' && ['set-content', 'add-content', 'out-file', 'copy-item', 'move-item', 'new-item'].includes(name)) {
        writeOperands = [];
        for (let index = 1; index < unwrapped.words.length; index += 1) {
            const word = unwrapped.words[index];
            // Inline colon spellings (`-Path:VALUE`) fuse the flag and its
            // value into one word. Without lifting the value the write-target
            // fuses below never see a destination that the separated spelling
            // (`-Path VALUE`) flags, so `set-content -Path:$HOME/.dsh/…` used
            // to decay into an LLM-answerable ask. Mirror the separated path:
            // carry the source word's dynamic/glob markers so `$HOME` keeps
            // the unconditional hard deny. `-Destination` belongs here too
            // (its separated value is caught as a positional below; the fused
            // form would otherwise hide it behind a leading `-`).
            const inlineValue = /^-(?:path|literalpath|filepath|destination):(.+)$/i.exec(word.text);
            if (inlineValue !== null) {
                if (inlineValue[1] !== '')
                    writeOperands.push({ text: inlineValue[1], dynamic: word.dynamic, glob: word.glob, quoted: true });
                continue;
            }
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
        // Runtime-state files keep their precise reason in every spelling, so
        // they are judged over ALL operands first: `mv` contributes its source
        // before its destination, and the broad DSH_HOME refusal below would
        // otherwise answer for the source and mask the destination's precise
        // "runtime state file" reason.
        for (const operand of writeOperands) {
            if (operand.dynamic || operand.glob)
                continue;
            const stateReason = runtimeStateWriteReason(normalizePath(operand.text, roots.workspace, roots.home), roots);
            if (stateReason !== undefined)
                return `${name} targets ${stateReason}`;
        }
        for (const operand of writeOperands) {
            if (operand.dynamic) {
                // Mirror the redirection / deletion branches: a dynamic write
                // target spelling the user home is an unconditional hard deny
                // (a compromised model reaches for `$HOME/.ssh/…` in practice).
                if (dynamicHomeTarget(operand.text))
                    return `dynamic ${name} targeting the user home is not permitted`;
                continue;
            }
            if (operand.glob) {
                // A globbed write target cannot be proven inside the routine
                // roots; judge its deepest statically-readable prefix.
                const reason = hardDestructiveTargetReason(globRoot(operand.text), roots);
                if (reason !== undefined)
                    return `${name} targets ${reason}`;
                continue;
            }
            const normalized = normalizePath(operand.text, roots.workspace, roots.home);
            // Runtime-state files keep their precise reason (zone basename
            // match), then the destructive-target predicate covers the rest.
            // That predicate is applied to EVERY operand: gating it on
            // `looksLikeExplicitPath` let a bare relative destination
            // (`cp ./src/index.ts lib/index.js`) rewrite the plugin's own
            // execution code with no fuse at all. The spelling check stays
            // only around the broad DSH_HOME refusal, which would otherwise
            // read a bare flag value (`truncate -s 0`'s `0`) as a path.
            const stateReason = runtimeStateWriteReason(normalized, roots);
            if (stateReason !== undefined)
                return `${name} targets ${stateReason}`;
            if (looksLikeExplicitPath(operand.text)) {
                const dshReason = shellWriteToDshHomeDenied(normalized, roots);
                if (dshReason !== undefined)
                    return `${name} targets ${dshReason}`;
            }
            // Same destructive fuse the redirection and deletion branches
            // apply: an operand spelling a credential-critical or system path
            // must hard-deny, not decay into an answerable ask.
            const reason = hardDestructiveTargetReason(normalized, roots);
            if (reason !== undefined)
                return `${name} targets ${reason}`;
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
    if (name === 'find') {
        // find's own writing actions name a file operand (`-fprint FILE`,
        // `-fprintf FILE FMT`, `-fls FILE`). The module already classes them as
        // mutating, but only the `-delete` / `-exec` shapes reached a target
        // fuse, and the category plane labels the segment readOnly (not
        // LOCKED) — so `find . -fprint ~/.ssh/authorized_keys` was an
        // answerable countdown that timeoutAction=allow can settle while every
        // other write vector hard-denies the same target.
        for (let index = 1; index < unwrapped.words.length; index += 1) {
            if (!FIND_WRITE_ACTION.test(unwrapped.words[index].text))
                continue;
            const target = unwrapped.words[index + 1];
            if (target === undefined)
                continue;
            if (target.dynamic) {
                if (dynamicHomeTarget(target.text))
                    return 'find output targeting the user home is not permitted';
                continue;
            }
            const reason = hardDestructiveTargetReason(globRoot(target.text), roots);
            if (reason !== undefined)
                return `find output targets ${reason}`;
            const stateReason = runtimeStateWriteReason(normalizePath(globRoot(target.text), roots.workspace, roots.home), roots);
            if (stateReason !== undefined)
                return `find output targets ${stateReason}`;
        }
    }
    if (name === 'find') {
        const nestedWriteReason = findNestedWriteDenyReason(unwrapped.words, roots);
        if (nestedWriteReason !== undefined)
            return nestedWriteReason;
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
/**
 * Commands that rewrite the working directory for every later segment of the
 * same line. Deliberately narrow: `pushd`/`popd` are paired and `cd -` is a
 * history lookup, so their net effect cannot be read one segment at a time, and
 * `chdir` is not a bash builtin.
 */
const DIRECTORY_CHANGER_COMMANDS = new Set(['cd', 'set-location', 'sl']);

/** The spelling family of a normalized path ('win32' for drive/UNC, 'posix' for '/…'). */
function pathSpellingFamily(path) {
    if (/^[a-z]:/i.test(path) || path.startsWith('\\\\') || path.startsWith('//'))
        return 'win32';
    if (path.startsWith('/'))
        return 'posix';
    return undefined;
}

/**
 * The working directory a directory-changer segment establishes, or undefined
 * when that cannot be read statically.
 *
 * A hard-deny fuse resolves a relative target against `roots.workspace`, the
 * session's directory — right for a plain command, wrong for a line that moves
 * elsewhere first. Returning the changer's target here lets the caller use it as
 * the resolution base for the segments that follow.
 *
 * Two conditions make the substitution sound, and both are enforced here or by
 * the caller:
 *
 * - The caller only carries a base across `&&`. Reaching a later segment in an
 *   `&&` chain proves the changer succeeded, so the shell really is standing
 *   there. Across `;`/`|`/`&` it proves nothing — `cd /nodir; printf x >
 *   package.json` fails its `cd` and still writes into the workspace, so the
 *   base must not move. (A `cd` shadowed by an alias is the residual
 *   assumption.)
 * - The base must be comparable with the workspace. A posix-spelled target on a
 *   win32 workspace (or the reverse) cannot be compared against the plugin zone,
 *   DSH_HOME or the credential trees, so every fuse would silently miss —
 *   `cd /c/Users/.../dsh-auto-approval-llm` names the plugin repo itself.
 *   Refusing the substitution keeps the workspace reading, which is the
 *   fail-closed answer.
 *
 * A dynamic, globbed or missing target returns undefined for the same reason:
 * an unreadable changer must never move the base on a guess.
 */
function effectiveCwdAfter(segment, shell, roots) {
    const unwrapped = unwrapCommand(segment.words);
    const name = commandName(unwrapped.words[0]?.text ?? '');
    if (!DIRECTORY_CHANGER_COMMANDS.has(name))
        return undefined;
    const target = unwrapped.words.slice(1).find(word => !word.text.startsWith('-'));
    if (target === undefined || target.dynamic || target.glob)
        return undefined;
    const resolved = normalizePath(target.text, roots.workspace, roots.home);
    if (pathSpellingFamily(resolved) !== pathSpellingFamily(roots.workspace))
        return undefined;
    return resolved;
}

/**
 * Redirect targets found by scanning a raw command line for `>` / `>>`
 * spellings, used only where the lexer cannot read the line at all.
 *
 * The guard target class excludes the shell metacharacters that can end a
 * redirect target, so a match is a plausible target rather than a parsed one:
 * this is a best-effort recovery, not a second lexer. The clobber form (`>|`)
 * is included because the lexer's operator table accepts it everywhere else.
 *
 * The leading class is deliberately "any single character that cannot itself be
 * part of a redirect operator" rather than a whitespace/separator list. Shell
 * allows a redirect to be attached directly to the preceding word
 * (`printf x>file`, `printf x2>file`, `printf "a">file`), which is the idiomatic
 * spelling; requiring a separator made the whole recovery bypassable by
 * removing one space.
 *
 * `>&file` / `N>&file` are writes (the lexer's own operator table sends them to
 * `pending = 'write'`), so they are matched too — hence the second operator
 * alternative. Its `(?=\D)` lookahead keeps a descriptor dup (`>&2`, `2>&1`)
 * out: those name a file descriptor, not a path, and must stay unfused.
 */
const OPAQUE_REDIRECT_TARGET = /(?:^|[^;&|()<>])(?:\d*&?>{1,2}\|?|\d*>{1,2}&(?=\D))\s*("[^"]*"|'[^']*'|[^\s;&|()<>]+)/g;

/**
 * The redirect-target fuse applied to a command line `decomposeCommandLine`
 * reports as opaque (grouping, brace expansion, command substitution, a
 * here-document, an unbalanced quote, or a target-less redirect).
 *
 * Why this exists: the whole-line fuses above only cover privilege escalation,
 * OS policy changes, credential exfiltration and `$HOME` deletion. Everything
 * they miss used to reach an early `return undefined` at the opaque branch,
 * which made every per-target fuse unreachable for the whole line — so
 * `printf x > package.json; (:)` lost its `redirection overwrites the plugin's
 * own contract/build file` hard deny and decayed into a classifier-eligible
 * MEDIUM ask. Under `timeoutAction=allow` (or an unattended review mode) that
 * ask is answered by the countdown, so the strongest verdict class in the
 * plugin became the weakest one. The fuses below are the SAME predicates the
 * decomposed path uses (`hardDestructiveTargetReason`, `runtimeStateWriteReason`,
 * `shellWriteToDshHomeDenied`), deliberately not a private re-derivation: the
 * DSH_HOME `allowedDshSubpaths` openings and maintenance paths live in those
 * single owners, and a second copy would drift from them.
 *
 * Scope discipline — the two halves of the trade:
 * - Only targets that another vector would already hard-deny are reported, so
 *   an opaque line whose writes are ordinary workspace/temp paths keeps its
 *   existing `ask` and the classifier still sees it. This is why the scan is
 *   not "deny every opaque line".
 * - Quoted text that merely spells a redirect to such a target is treated as a
 *   real one (`echo "see > package.json for config"; (true)` hard-denies), and
 *   the here-document body is exempted by scanning the command line only. A
 *   here-document body is data handed to the command's stdin, so a `>` inside
 *   it is literal text — but the redirect in `cat <<'EOF' > package.json` sits
 *   on the first line and is still judged. The residual false positive is
 *   accepted: a needless human-visible refusal is the failure mode this plugin
 *   prefers over a silent allowance.
 */
/**
 * Drop here-document BODIES from a raw command line, keeping the lines that are
 * actually shell syntax.
 *
 * A here-document body is data handed to a command's stdin: a `>` inside it is
 * literal text, so judging it as a redirect is a false positive (`git commit -m
 * "$(cat <<'EOF' … > package.json …)"` is the shape that bites this repo, whose
 * commit messages name fuse targets).
 *
 * The bodies are removed by walking the lines and matching each introducer
 * (`<<` / `<<-`, an optional `-`, a delimiter that may be quoted) against the
 * line that closes it — NOT by testing the lexer's message for the word
 * `here-document`. That string coupling was wrong twice over: rewording the
 * lexer message silently flipped bodies back into the scanned region, and
 * because the lexer reports only the FIRST reason it hit, a command that is
 * opaque for another reason (a command substitution wrapping a heredoc) kept
 * its body in the scan.
 *
 * Best effort by construction: an unterminated body consumes the rest of the
 * input, which is the conservative reading (those lines are body, not syntax).
 */
function stripHeredocBodies(source) {
    const lines = source.split(/\r?\n/);
    const out = [];
    let pending = [];
    for (const line of lines) {
        if (pending.length > 0) {
            const stripped = line.replace(/^\t+/, '');
            if (pending[0].stripTabs ? stripped === pending[0].delimiter : line === pending[0].delimiter) {
                pending.shift();
            }
            continue;
        }
        out.push(line);
        // Only a `<<` that is live syntax opens a here-document. Position-blind
        // matching read `<<` inside quotes and comments too: one line such as
        // `echo "a << b"` pushed a pending delimiter, and every following line —
        // real syntax included — was then consumed as body, which silently
        // disarmed every target fuse for the rest of the input (`rm -rf X; (:)`
        // after such a line degraded from hard deny to ask).
        const view = shellSyntaxView(line);
        for (const introducer of view.matchAll(/<<(-?)/g)) {
            // The delimiter is read from the ORIGINAL text at the matched
            // offset (the view blanks quoted spans but keeps offsets), so the
            // quoted spelling `<<"EOF"` still names its delimiter. Only the
            // operator is matched in the view: a trailing `\s*` there would
            // swallow the original delimiter along with the blanked span.
            const rest = line.slice(introducer.index + introducer[0].length).replace(/^[ \t]*/, '');
            const delimiter = /^(?:"([^"]*)"|'([^']*)'|\\([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/.exec(rest);
            const value = delimiter?.[1] ?? delimiter?.[2] ?? delimiter?.[3] ?? delimiter?.[4];
            if (value !== undefined && value !== '') {
                pending.push({ delimiter: value, stripTabs: introducer[1] === '-' });
            }
        }
    }
    return out.join('\n');
}

/**
 * A same-length view of one shell line with quoted spans, comments and escape
 * pairs blanked out, so a `<<` that is plain text cannot be read as a
 * here-document introducer.
 *
 * Double-quoted command substitutions stay live syntax — `"$(cat <<'EOF' …)"`
 * really does open a here-document — so `$(`/`)` nesting is tracked instead of
 * treating the whole double-quoted span as inert; single-quoted spans are fully
 * inert by shell rules. Making the fence too eager here would only scan a body
 * (over-blocking), which is why the introducer is READ from the view but the
 * delimiter is taken from the original line.
 */
function shellSyntaxView(line) {
    const out = [];
    const stack = [];
    const top = () => stack[stack.length - 1];
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (top() === 'single') {
            if (char === "'")
                stack.pop();
            out.push(' ');
            continue;
        }
        if (top() === 'double') {
            if (char === '\\') {
                out.push('  ');
                index += 1;
                continue;
            }
            if (char === '"') {
                stack.pop();
                out.push(' ');
                continue;
            }
            if (char === '$' && line[index + 1] === '(') {
                stack.push('subst');
                out.push('  ');
                index += 1;
                continue;
            }
            out.push(' ');
            continue;
        }
        // Live syntax, at top level or inside a command substitution.
        if (char === '\\') {
            out.push('  ');
            index += 1;
            continue;
        }
        if (char === '#' && (index === 0 || /[\s;|&(]/.test(line[index - 1]))) {
            out.push(' '.repeat(line.length - index));
            break;
        }
        if (char === '"') {
            stack.push('double');
            out.push(' ');
            continue;
        }
        if (char === "'") {
            stack.push('single');
            out.push(' ');
            continue;
        }
        if (char === '$' && line[index + 1] === '(') {
            stack.push('subst');
            out.push('  ');
            index += 1;
            continue;
        }
        if (char === ')' && top() === 'subst') {
            stack.pop();
            out.push(' ');
            continue;
        }
        out.push(char);
    }
    return out.join('');
}

/**
 * Best-effort word split of an opaque line, one chunk per shell segment.
 *
 * Used by the opaque recovery to reach the fuses that are NOT about redirect
 * targets: deletion targets (`rm -rf /etc; (:)`) and write operands (`tee
 * history.jsonl < /dev/null; (:)`) are hard-denied when written plainly, and
 * skipping them for opaque lines left the same degradation the redirect
 * recovery exists to remove.
 *
 * This is a deliberately coarse split, not a second lexer: separators and
 * grouping characters split the line, whitespace splits the words, surrounding
 * quotes are stripped, and `$`/`%VAR%`/glob markers are carried so the
 * downstream fuses fail closed on dynamic or globbed targets. A quoted string
 * that merely spells a command is therefore judged as one — the same accepted
 * false positive as a quoted redirect target, in the same fail-closed
 * direction.
 */
/** Separators that end an opaque chunk when they are not inside quotes. */
function splitOpaqueChunks(source) {
    const chunks = [];
    let current = '';
    let quote = '';
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (quote !== '') {
            if (char === quote)
                quote = '';
            current += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            current += char;
            continue;
        }
        if (/[\n;&|(){}`]/.test(char)) {
            chunks.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    chunks.push(current);
    return chunks;
}
/**
 * Words of an opaque chunk, with quoted runs kept as one word: an interpreter
 * source is written as a single quoted argument (`bash -c "cp a ~/.dsh/x"`),
 * and splitting it on whitespace hid the boundary from every caller.
 */
function splitOpaqueWords(chunk) {
    const words = [];
    let index = 0;
    while (index < chunk.length) {
        if (/\s/.test(chunk[index])) {
            index += 1;
            continue;
        }
        let text = '';
        let quoted = false;
        while (index < chunk.length && !/\s/.test(chunk[index])) {
            const quote = chunk[index];
            if (quote === '"' || quote === "'") {
                const end = chunk.indexOf(quote, index + 1);
                text += end < 0 ? chunk.slice(index + 1) : chunk.slice(index + 1, end);
                index = end < 0 ? chunk.length : end + 1;
                quoted = true;
                continue;
            }
            text += chunk[index];
            index += 1;
        }
        if (text !== '')
            words.push({ text, dynamic: /[$]|%[A-Za-z_]+%/.test(text), glob: /[*?]/.test(text), quoted });
    }
    return words;
}
function opaqueSegmentWords(source) {
    const segments = [];
    for (const chunk of splitOpaqueChunks(stripHeredocBodies(source))) {
        const words = splitOpaqueWords(chunk);
        if (words.length > 0)
            segments.push({ words, writeTargets: [], readTargets: [] });
    }
    return segments;
}

function opaqueHardDenyReason(source, shell, roots) {
    const scan = stripHeredocBodies(source);
    // Non-redirect fuses first: they cover deletion and write operands, which
    // the redirect scan below cannot see.
    for (const segment of opaqueSegmentWords(source)) {
        const reason = segmentHardDenyReason(segment, shell, roots);
        if (reason !== undefined)
            return reason;
    }
    // A read-only command that writes through its own output flag carries no
    // redirection token, so the redirect scan below never sees it: on an opaque
    // line (`sort -o <protected> in.txt; (:)`) the whole-line fuse lost the
    // verdict every decomposable spelling still reaches.
    const outputFlag = opaqueOutputFlagReason(source, shell, roots);
    if (outputFlag !== undefined)
        return outputFlag;
    for (const match of scan.matchAll(OPAQUE_REDIRECT_TARGET)) {
        const raw = match[1];
        const target = raw.length > 1 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
            ? raw.slice(1, -1)
            : raw;
        if (target === '' || isNullSink({ text: target }, shell))
            continue;
        if (dynamicHomeTarget(target))
            return 'dynamic redirection targeting the user home is not permitted';
        const destructive = hardDestructiveTargetReason(globRoot(target), roots);
        if (destructive !== undefined)
            return `redirection overwrites ${destructive}`;
        const stateReason = runtimeStateWriteReason(normalizePath(target, roots.workspace, roots.home), roots);
        if (stateReason !== undefined)
            return `redirection targets ${stateReason}`;
        const dshReason = shellWriteToDshHomeDenied(normalizePath(target, roots.workspace, roots.home), roots);
        if (dshReason !== undefined)
            return `redirection targets ${dshReason}`;
    }
    return undefined;
}

/**
 * Hard-deny reason for a shell write target, using the same three predicates
 * the redirection fuse uses. A read-only command's own output flag
 * (`sort -o out`) is a write like any other: judging it with only the
 * destructive-target predicate left `sort -o history.jsonl in.txt` a
 * classifier-answerable ask while `printf x > history.jsonl` is hard-denied.
 */
function writeTargetHardDenyReason(target, roots) {
    const destructive = hardDestructiveTargetReason(globRoot(target), roots);
    if (destructive !== undefined)
        return destructive;
    const normalized = normalizePath(target, roots.workspace, roots.home);
    const stateReason = runtimeStateWriteReason(normalized, roots);
    if (stateReason !== undefined)
        return stateReason;
    return shellWriteToDshHomeDenied(normalized, roots);
}

/** Output-flag write targets recovered from a line that cannot be decomposed. */
function opaqueOutputFlagReason(source, shell, roots) {
    if (shell !== 'bash')
        return undefined;
    for (const segment of opaqueSegmentWords(source)) {
        const name = commandName(segment.words[0]?.text ?? '');
        for (const target of readOnlyOutputFlagTargets(name, segment.words, shell)) {
            const reason = writeTargetHardDenyReason(target.text, roots);
            if (reason !== undefined)
                return `output flag writes ${reason}`;
        }
    }
    return undefined;
}

/** Clock writes recovered from a line that cannot be decomposed. */
function opaqueClockWriteReason(source, shell) {
    if (shell !== 'bash')
        return undefined;
    for (const segment of opaqueSegmentWords(source)) {
        const reason = dateClockWriteReason(commandName(segment.words[0]?.text ?? ''), segment.words.map(word => word.text));
        if (reason !== undefined)
            return reason;
    }
    return undefined;
}

/**
 * Interpreter boundaries inside a line that cannot be decomposed. The quoted
 * source is one opaque word, so the per-segment loop never saw it and the
 * plain spelling's tier was lost: `(bash -c "cp a.txt ~/.dsh/x")` stayed a
 * classifier-answerable ask while `bash -c "cp a.txt ~/.dsh/x"` now hard-denies.
 * The same owners decide here in the same order as the decomposed path.
 */
function opaqueNestedAssessment(source, shell, roots) {
    for (const segment of opaqueSegmentWords(source)) {
        const unwrapped = unwrapCommand(segment.words);
        const name = commandName(unwrapped.words[0]?.text ?? '');
        const nested = nestedExecution(name, unwrapped.words);
        if (nested === undefined)
            continue;
        if (nested.source === undefined)
            return manualReview('opaque nested execution requires manual review');
        if (destructiveNestedSource(nested.source))
            return manualReview('nested deletion requires manual review');
        if (nestedSourceWritesToDshHome(nested.source, roots))
            return denied('nested execution writes to DSH_HOME — use the write or edit tool instead');
        if (SHELL_CODE_INTERPRETERS.has(name)) {
            const nestedHard = hardDenyShellReason(nested.source, shellPlaneOf(name), roots);
            if (nestedHard !== undefined)
                return denied(nestedHard);
            // A read-only command's own output flag writes a file without any
            // redirection token, so the ladder above cannot see it
            // (`bash -c "sort -o ~/.dsh/history.jsonl in.txt"`).
            const nestedOutput = opaqueOutputFlagReason(nested.source, shellPlaneOf(name), roots);
            if (nestedOutput !== undefined)
                return denied(nestedOutput);
        }
    }
    return undefined;
}

export function hardDenyShellReason(source, shell, roots) {
    const compact = source.trim();
    // Newline-flattened copy for the whole-line fuses: `decomposeCommandLine`
    // treats `\n` as a segment separator, but an opaque grouping form such as
    // `(echo a\nsudo ls)` short-circuits before any per-segment check, and the
    // anchor class here has no `\n` — so a privilege command hidden on its own
    // line inside a group previously escaped the unconditional fuse. Flattening
    // first makes `\n` behave exactly like the `;` separator the segment loop
    // already guards against.
    const flat = compact.replace(/\r?\n/g, '; ');
    // Whole-line privilege fuse: also catches a compound line whose operator
    // separates a segment starting with sudo/doas/su (`echo hi;sudo ls`,
    // `cmd && sudo rm -rf /`), which the old `^|\s` anchor missed. Anchored on
    // a segment start (line start or after an operator) so a mere argument
    // (`echo sudo`) is not misjudged; the per-segment check below is the
    // authoritative guard for decomposed lines. `{` is included so a brace
    // group (`{ sudo ls; }`) is caught before decomposition (a `{` otherwise
    // makes the line opaque and escapes both fuses), and a backtick is a
    // segment start in the same sense (`` x=`sudo ls` ``).
    if (PRIVILEGE_COMMAND_PATTERN.test(flat))
        return 'privilege escalation is not permitted by auto mode';
    if (/(?:set-executionpolicy|disable-windowsdefender|clear-disk|format-volume|remove-partition|bcdedit)(?:\s|$)/i.test(flat)) {
        return 'operating-system security or disk policy changes are not permitted';
    }
    if (/(?:curl|wget|invoke-webrequest|invoke-restmethod)/i.test(compact) && (sensitiveMarker(compact) || dshHomeExfil(compact, roots))) {
        return 'credential or private-data exfiltration pattern is not permitted';
    }
    if (dynamicHomeTarget(compact) && /(?:rm|remove-item|rmdir)\b/i.test(compact)) {
        return 'dynamic deletion targeting the user home is not permitted';
    }
    const decomposition = decomposeCommandLine(compact, shell);
    if (decomposition.kind === 'opaque') {
        // The line cannot be decomposed, but it may still spell a redirect at a
        // target every other vector hard-denies. Recovering just that much (and
        // nothing else) keeps the strongest verdict reachable on opaque lines
        // while a line whose writes are ordinary paths keeps its `ask`.
        const opaqueClock = opaqueClockWriteReason(compact, shell);
        if (opaqueClock !== undefined)
            return opaqueClock;
        return opaqueHardDenyReason(compact, shell, roots);
    }
    // Fuses resolve relative targets against the directory the segment really
    // sees. A changer only moves that base inside an `&&` chain: there, reaching
    // this segment proves the changer ran and succeeded, so a relative name is
    // judged by the path it denotes. Across `;`/`|`/`&` the changer's outcome is
    // unknown — it may have failed and left the shell in the workspace — so the
    // base resets and the relative target is judged against the workspace, which
    // is what keeps `cd /nodir; printf x > package.json` a hard deny. The
    // changer's own segment is always judged against the base it runs in.
    //
    // The base must be RECOMPUTED per segment, not carried in a variable that
    // only advances: a previous version kept the last established base after the
    // reset, so `cd C:/tmp && printf a > f1; cd <workspace>; printf x >
    // package.json` judged the final write against C:/tmp and missed the
    // workspace contract file entirely (a fail-open on the strongest fuse).
    let changerBase;
    for (const segment of decomposition.segments) {
        if (segment.precededBy !== '' && segment.precededBy !== '&&')
            changerBase = undefined;
        const segmentRoots = changerBase !== undefined ? { ...roots, workspace: changerBase } : roots;
        // Per-segment privilege fuse: the whole-line regex above only sees the
        // raw source; a decomposed segment lets us judge the effective command
        // after wrappers, so `echo hi; sudo ls` cannot dodge the hard deny.
        const segName = commandName(unwrapCommand(segment.words).words[0]?.text ?? '');
        if (PRIVILEGE_COMMANDS.has(commandNameWithoutExe(segName)))
            return 'privilege escalation is not permitted by auto mode';
        const clockWrite = dateClockWriteReason(segName, segment.words.map(word => word.text));
        if (clockWrite !== undefined)
            return clockWrite;
        const reason = segmentHardDenyReason(segment, shell, segmentRoots);
        if (reason !== undefined)
            return reason;
        const next = effectiveCwdAfter(segment, shell, segmentRoots);
        if (next !== undefined)
            changerBase = next;
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
        if (nestedSourceWritesToDshHome(nested.source, roots))
            return denied('nested execution writes to DSH_HOME — use the write or edit tool instead');
        // A nested inline source must not step below the tier the same text
        // reaches on its own: `bash -c "cp a.txt ~/.dsh/history.jsonl"` writes
        // exactly what the top-level spelling hard-denies, and
        // `bash -c "sudo ls"` escalates exactly like `sudo ls`. Only
        // `find -exec` consulted the write-operand, redirect and privilege
        // owners, so those families had no reachable owner behind an
        // interpreter. The nested-deletion heuristic above keeps its
        // manual-review tier, so the ladder runs last.
        if (SHELL_CODE_INTERPRETERS.has(name)) {
            const nestedHard = hardDenyShellReason(nested.source, shellPlaneOf(name), roots);
            if (nestedHard !== undefined)
                return denied(nestedHard);
            // A read-only command's own output flag writes a file without any
            // redirection token, so the ladder above cannot see it
            // (`bash -c "sort -o ~/.dsh/history.jsonl in.txt"`).
            const nestedOutput = opaqueOutputFlagReason(nested.source, shellPlaneOf(name), roots);
            if (nestedOutput !== undefined)
                return denied(nestedOutput);
        }
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
            // `sessionArtifactDeletion` is a structured signal, not a hint in the
            // reason text: the category layer locks every `delete`, which would
            // otherwise intercept this call and hand it to a countdown a
            // reviewer can never answer — making the provenance exemption
            // unreachable in aggressive mode. Consumers read the flag; nothing
            // parses the message.
            return {
                ...allowed(`delete exact session-created artifact${paths.length === 1 ? '' : 's'}: ${paths.join(', ')}`),
                sessionArtifactDeletion: true,
            };
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
    // A whitelisted read-only command can still write through its own output
    // flag (`sort -o out`, `tree -o out`, `git diff --output=out`): the value
    // is a real write target even though no redirection token carries it, so
    // judge it with the same destructive fuse and keep the segment off the
    // static read-only allow.
    const outputFlagWrites = readOnlyOutputFlagTargets(name, words, shell);
    for (const target of outputFlagWrites) {
        const reason = writeTargetHardDenyReason(target.text, roots);
        if (reason !== undefined)
            return denied(`output flag writes ${reason}`);
    }
    const writesAFile = redirectedToFile || outputFlagWrites.length > 0;
    if (name === 'find' && !findActionsAreReadOnly(words)) {
        return semanticReview(findHasDestructiveAction(words)
            ? 'find deletion requires specific user authorization'
            : 'find executes or writes through a non-read-only action and requires independent classification');
    }
    if (!writesAFile && readOnlyCommand(name, words, shell)) {
        // git `rev:path` operands (`HEAD:.env`) hide a path inside a colon
        // token that `explicitPaths` never lifts; judge them with the same
        // gates so the read-only fast path cannot expose protected content.
        const objectRead = name === 'git' ? gitObjectReadProtected(words, roots) : undefined;
        if (objectRead !== undefined)
            return semanticReview(`git object read references a protected or external path: ${objectRead}`);
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
    if (shell === 'bash' && (['cp', 'mv'].includes(name) || writesThroughOperands(name, words))) {
        // Boundary note (deliberate, do not "fix"): inside the routine roots a
        // CONTENT write is routine — overwrite (tee/cp/redirect) and emptying
        // (truncate -s 0) alike — while PATH deletion is gated. Truncating a
        // pre-existing file therefore stays a static allow; gating truncate
        // alone would be a sham boundary because the same destruction rides
        // `tee file < /dev/null` or `cp /dev/null file`. Path deletion is the
        // only irreversible-by-content-means operation and keeps its ask.
        // The write destinations must be statically readable before a static
        // allow: a dynamic/globbed destination (e.g. `cp ./x "$DEST"` or
        // `tee ./a "$FOO"`) cannot be proven inside the routine roots — and a
        // `$HOME` spelling is already hard-denied in segmentHardDenyReason.
        // Only the destination operands matter here (sources are reads and
        // may be dynamic without endangering the write).
        const writeTargets = name === 'dd'
            ? ddOutputTargets(words)
            : name === 'sed'
                ? sedInPlaceTargets(words)
                : name === 'install' || name === 'cp' || name === 'mv'
                    ? writeOperandCandidates(words)
                    : words.slice(1).filter(word => !word.text.startsWith('-'));
        if (writeTargets.some(word => word.dynamic || word.glob))
            return semanticReview('file write target is dynamic or globbed and cannot be statically proven inside the routine roots');
        // A write head can also READ. `tee out < secret` echoes stdin to its
        // stdout and `dd if=secret of=out` copies it, so a credential SOURCE
        // must not ride the write fast path: only write targets used to be
        // judged here, which made a credential read through a write head a
        // static allow with no approval, no reviewer and no verdict naming the
        // read. Both the `<` redirects and dd's `if=` operand are checked.
        const readSources = [...segment.readTargets, ...(name === 'dd' ? ddInputTargets(words) : [])];
        if (readSources.some(word => word.dynamic || word.glob))
            return semanticReview('file write command reads a target that cannot be statically proven inside the routine roots');
        if (readSources.length > 0) {
            const sourcePaths = explicitPaths(readSources, roots);
            if (readSources.some(word => tildeUserTarget(word.text)) || sourcePaths.length === 0
                || !sourcePaths.every(path => isEffectiveRoutine(path, roots) && !isProtectedProjectPath(path, roots)
                    && !(!isWithin(roots.workspace, path) && sensitiveBasenameAt(path, roots))))
                return semanticReview('file write command reads an external, protected, or unclear path');
        }
        // Flags stay in the list: explicitPaths lifts embedded values out of
        // them, so `--target-directory=C:/abs` is judged like a bare operand.
        // dd hides its destination inside `of=…`, so the extracted output
        // targets join the operands for the same judgment.
        const operands = name === 'dd'
            ? [...words.slice(1), ...ddOutputTargets(words)]
            : words.slice(1);
        const paths = explicitPaths(operands, roots);
        const tildeUser = operands.some(word => tildeUserTarget(word.text));
        return !tildeUser && paths.length > 0 && paths.every(path => isEffectiveRoutine(path, roots) && !isProtectedProjectPath(path, roots)
            && !(!isWithin(roots.workspace, path) && sensitiveBasenameAt(path, roots)))
            ? allowed('static project-local file operation')
            : semanticReview('file write target is external, protected, or unclear');
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
/**
 * Whether an opaque line feeds a here-document into an interpreter that runs
 * its program from stdin (`python3 <<EOF … EOF`, `cat <<EOF | node`). The body
 * is data for most commands — `git commit -m "$(cat <<EOF … EOF)"` names a fuse
 * target in a message — but such an interpreter executes it, so stripping the
 * body must not lower the line's tier.
 */
function hereDocumentRunsAsCode(source) {
    if (typeof source !== 'string' || !/<<-?[ \t]*["']?[A-Za-z_]/.test(source))
        return false;
    for (const segment of opaqueSegmentWords(source)) {
        const name = commandName(unwrapCommand(segment.words).words[0]?.text ?? '');
        if (STDIN_SCRIPT_INTERPRETERS.has(name))
            return true;
    }
    return false;
}
/** Interpreters that read their program from stdin. */
const STDIN_SCRIPT_INTERPRETERS = new Set(['python', 'python3', 'pythonw', 'ruby', 'perl', 'node', 'nodejs', 'php', 'lua', 'bun', 'deno', 'osascript', 'sh', 'bash', 'zsh', 'fish', 'ksh', 'dash', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe']);

export function assessShell(source, shell, roots, artifacts, owner) {
    const hard = hardDenyShellReason(source, shell, roots);
    if (hard !== undefined)
        return denied(hard);
    const decomposition = decomposeCommandLine(source, shell);
    if (decomposition.kind === 'opaque') {
        // A here-document body is data, not syntax: the same stripping owner the
        // hard-deny plane uses keeps an ordinary commit message that names a
        // fuse target out of the destructiveness heuristic. It is code when the
        // line feeds it to an interpreter that reads its program from stdin, so
        // that shape keeps the manual-review tier instead of losing it.
        const stripped = stripHeredocBodies(source);
        const nested = opaqueNestedAssessment(stripped, shell, roots);
        if (nested !== undefined)
            return nested;
        return destructiveNestedSource(stripped) || hereDocumentRunsAsCode(source)
            ? manualReview(`${shell} destructive command cannot be read statically: ${decomposition.reason}`)
            : semanticReview(`${shell} command requires independent classification because it cannot be read statically: ${decomposition.reason}`);
    }
    const assessments = decomposition.segments.map(segment => assessSegment(segment, shell, roots, artifacts, owner));
    // A segment-level hard deny (e.g. the nested-execution DSH_HOME write
    // fuse) must propagate to the whole line, not degrade into a classifier
    // ask via the generic merge below.
    const deniedSegment = assessments.find(assessment => assessment.decision === 'deny');
    if (deniedSegment !== undefined)
        return deniedSegment;
    const blocked = assessments.find(assessment => assessment.decision === 'ask' && !assessment.classifierEligible);
    if (blocked !== undefined)
        return blocked;
    if (assessments.every(assessment => assessment.decision === 'allow')) {
        const creates = assessments.flatMap(assessment => assessment.plannedCreates ?? []);
        // Provenance survives the line-level rebuild. Reaching this branch at
        // all means no segment was an unproven deletion (that would have come
        // back as an ask), so one flagged segment is enough to state that every
        // deletion in the line targeted a path this session created.
        const provenArtifactDeletion = assessments.some(assessment => assessment.sessionArtifactDeletion === true);
        const merged = allowed(assessments.length === 1
            ? assessments[0].reason
            : `every command in this ${shell} line is a recognized routine operation`, creates);
        return provenArtifactDeletion ? { ...merged, sessionArtifactDeletion: true } : merged;
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
            const base = runtimeStateBasename(normalized);
            if (base !== undefined && !hits.includes(base))
                hits.push(base);
        }
    }
    return hits;
}