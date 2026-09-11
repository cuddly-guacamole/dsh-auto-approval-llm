#!/usr/bin/env node
// tsc never deletes the output of a source file that has since been removed, and
// the client bundle is written next to that output. Wipe the build directory
// before a build so a stale lib/ cannot keep shipping code (and declarations)
// that no longer exists in src/.
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
rmSync(join(root, 'lib'), { recursive: true, force: true })
