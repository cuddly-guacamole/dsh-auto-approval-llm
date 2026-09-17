// Capture current plugin config (GET /settings) and print as JSON for revert.
//
// The web carrier authenticates /api before the plugin handler runs, so a
// session is required. Pass the launch URL from the operator's own shell, or an
// exported cookie file:
//
//   node scripts/verify-config.mjs --url '<startup-url>'
//   node scripts/verify-config.mjs --cookie-file <path>
import http from 'node:http';
import { parseAuthArgs, exchangeToken, readCookieFile } from './verify-auth.mjs';

const HOST = '127.0.0.1';
const PORT = 3080;
const args = parseAuthArgs(process.argv.slice(2));

let cookie = null;
let authority = `${HOST}:${PORT}`;
if (args.url !== undefined) {
  const session = await exchangeToken(args.url);
  cookie = session.cookie;
  authority = session.authority;
} else if (args.cookieFile !== undefined) {
  cookie = readCookieFile(args.cookieFile);
  if (args.host !== undefined) authority = `${args.host}:${args.port ?? PORT}`;
}
if (cookie === null) {
  console.error('verify-config: the web carrier requires a session; pass --url <startup-url> or --cookie-file <file>');
  process.exit(2);
}

function req(method) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: HOST, port: PORT, path: '/api/auto-approval-llm/settings', method, headers: { host: authority, cookie, 'content-type': 'application/json' } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    r.on('error', reject);
    r.end();
  });
}

const res = await req('GET');
console.log('STATUS', res.status);
console.log(res.body);
process.exit(res.status === 200 ? 0 : 1);
