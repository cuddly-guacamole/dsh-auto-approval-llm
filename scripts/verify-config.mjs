// Capture current plugin config (GET /settings) and print as JSON for revert.
import http from 'node:http';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: 3080, path: '/_dsh/auto-approval-llm/settings', method, headers: { host: '127.0.0.1:3080', 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const res = await req('GET');
console.log('STATUS', res.status);
console.log(res.body);
