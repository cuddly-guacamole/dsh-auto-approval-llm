// Mock LLM reviewer for runtime verification. Listens on 127.0.0.1:18777 and
// answers OpenAI-style /chat/completions with a deterministic ALLOW (MEDIUM).
// Honors MOCK_DELAY_MS to simulate reviewer latency.
import http from 'node:http';

const DELAY = Number(process.env.MOCK_DELAY_MS ?? '200');
const REVIEW = JSON.stringify({ decision: 'ALLOW', risk_level: 'MEDIUM', reason: 'mock approved (runtime verification)' });

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: REVIEW, role: 'assistant' } }] }));
      }, DELAY);
    });
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});
server.listen(18777, '127.0.0.1', () => console.log('mock reviewer on 127.0.0.1:18777'));
