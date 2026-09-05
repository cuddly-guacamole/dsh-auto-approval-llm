// @ts-nocheck
// Ported from @nanmicoder/dsh-auto-mode (artifacts.js).
// MIT License, Copyright (c) 2026 程序员阿江-Relakkes (https://github.com/NanmiCoder/dsh-auto-mode).
// Retained per the MIT License: this is a substantial portion of the original.
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { sanitizeClassifierText } from './classifier.js';
import { isArtifactArea, isWithin, normalizePath } from './paths.js';
/** How many workspace-relative recent creates the parallel index keeps per owner. */
const RECENT_CREATES_CAP = 8;
/** In-memory provenance for exact paths created successfully during the live session. */
export class ArtifactRegistry {
    created = new WeakMap();
    pending = new Map();
    /** Parallel insertion-ordered recent-creates index (workspace-only, per owner). */
    createdRecent = new WeakMap();
    /** Whether a path was observed as created in this exact live session. */
    has(owner, path, roots) {
        if (owner === undefined)
            return false;
        const normalized = normalizePath(path, roots.workspace, roots.home);
        return isArtifactArea(normalized, roots) && this.created.get(owner)?.has(normalized) === true;
    }
    /** Record planned exact creations for settlement-time promotion. */
    plan(exec, paths, roots) {
        const owner = exec.agent?.session;
        if (owner === undefined)
            return;
        const eligible = paths
            .map(path => normalizePath(path, roots.workspace, roots.home))
            .filter(path => isArtifactArea(path, roots) && !existsSync(path));
        if (eligible.length > 0)
            this.pending.set(exec.token, { owner, paths: eligible });
    }
    /** Promote successful creates and forget every pending execution. */
    settle(exec, result, roots) {
        const owner = exec.agent?.session;
        const pending = this.pending.get(exec.token);
        this.pending.delete(exec.token);
        if (owner === undefined || result.isError)
            return;
        const value = result.value;
        // Shell results carry an exit code and only a zero exit actually
        // produced the planned paths. Structured write-family results have no
        // exit code; their non-error envelope is the success signal (the
        // host's create command even fails on an existing target, so a
        // non-error result of a planned create is the creation itself).
        const shellValue = typeof value === 'object' && value !== null
            && 'exitCode' in value;
        const succeeded = !shellValue || value.exitCode === 0;
        if (pending !== undefined && pending.owner === owner && succeeded) {
            for (const path of pending.paths)
                this.add(owner, path, roots);
        }
        if (exec.name === 'write' && typeof value === 'object' && value !== null
            && 'operation' in value && value.operation === 'create'
            && 'path' in value && typeof value.path === 'string') {
            const path = normalizePath(value.path, roots.workspace, roots.home);
            if (isArtifactArea(path, roots))
                this.add(owner, path, roots);
        }
    }
    add(owner, path, roots) {
        const paths = this.created.get(owner) ?? new Set();
        paths.add(path);
        this.created.set(owner, paths);
        this.indexRecent(owner, path, roots);
    }
    /** Workspace-only recent-creates slot: relative-to-workspace, tempRoots rejected. */
    indexRecent(owner, path, roots) {
        if (owner === undefined || path === undefined || roots === undefined)
            return;
        const workspace = normalizePath(roots.workspace, roots.workspace, roots.home);
        if (!isWithin(workspace, path)
            || (roots.tempRoots ?? []).some(root => isWithin(normalizePath(root, workspace, roots.home), path)))
            return;
        const arr = this.createdRecent.get(owner) ?? [];
        const at = arr.indexOf(path);
        if (at !== -1)
            arr.splice(at, 1);
        arr.push(path);
        while (arr.length > RECENT_CREATES_CAP)
            arr.shift();
        this.createdRecent.set(owner, arr);
    }
    /** Most recent N workspace-relative created paths, sanitized, newest first. */
    list(owner, roots, limit = RECENT_CREATES_CAP) {
        if (owner === undefined || roots === undefined)
            return [];
        const arr = this.createdRecent.get(owner);
        if (arr === undefined || arr.length === 0)
            return [];
        const workspace = normalizePath(roots.workspace, roots.workspace, roots.home);
        const api = /^[A-Za-z]:[\\/]/.test(workspace) || /^\\\\/.test(workspace) ? win32 : posix;
        const relative = path => api.relative(workspace, path);
        const out = [];
        for (let i = arr.length - 1; i >= 0 && out.length < limit; i -= 1) {
            const path = arr[i];
            if (!isWithin(workspace, path))
                continue;
            out.push(sanitizeClassifierText(relative(path)));
        }
        return out;
    }
}