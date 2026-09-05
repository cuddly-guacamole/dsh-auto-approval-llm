#!/usr/bin/env node
/**
 * Runtime smoke for the running dsh web profile (link: development shape).
 *
 * Verifies the plugin's web surface on the live process: the privileged
 * settings/history routes answer 200 on a loopback-trusted request, the
 * session-mode route speaks its header protocol, and the retired routes stay
 * absent (404). Exits non-zero on any failure — run it after a dsh restart
 * to confirm the new lib actually booted.
 *
 * The web URL (with a fresh token) is read from ~/.dsh/dsh-web-url.txt, which
 * the restart flow rewrites. Run: node scripts/smoke-runtime.mjs
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const urlFile = join(homedir(), '.dsh', 'dsh-web-url.txt')
const webUrl = readFileSync(urlFile, 'utf8').trim().split(/\r?\n/)[0]
const base = new URL(webUrl)
base.search = ''
base.hash = ''

const HEADERS = { Host: `${base.hostname}${base.port ? `:${base.port}` : ''}` }
const ROUTES = '/_dsh/auto-approval-llm'

async function probe(path, { expect, headers = {} } = {}) {
  const res = await fetch(`${base.origin}${path}`, { headers: { ...HEADERS, ...headers } })
  const ok = res.status === expect
  console.log(`${ok ? 'ok' : 'FAIL'} ${path} -> ${res.status}${expect !== undefined ? ` (want ${expect})` : ''}`)
  return ok
}

const checks = [
  probe(`${ROUTES}/settings`, { expect: 200 }),
  probe(`${ROUTES}/history`, { expect: 200 }),
  probe(`${ROUTES}/session-mode`, { expect: 400 }, true),
  probe(`${ROUTES}/models?provider=x`, { expect: 404 }, true),
  probe(`${ROUTES}/history/export`, { expect: 404 }, true),
]

const results = await Promise.all(checks)
if (results.some((ok) => !ok)) {
  console.error('runtime smoke failed: the running dsh does not match the built plugin')
  process.exit(1)
}
console.log('runtime smoke passed')
