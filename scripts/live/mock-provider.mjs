// A local stand-in for the fixture's providers: OpenAI-shaped /models and
// /chat/completions on 127.0.0.1, answering only fixture keys. It records
// every request, so the live check can see which key actually went out.
import http from 'node:http';

export function startMock(port) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const authorization = req.headers.authorization || '';
      requests.push({ method: req.method, url: req.url, authorization, body });
      const send = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (!authorization.startsWith('Bearer sk-fixture-')) return send(401, { error: { message: 'fixture: missing or unknown key' } });
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        return send(200, { object: 'list', data: [
          { id: 'fixture-alpha', object: 'model', owned_by: 'fixture' },
          { id: 'fixture-beta', object: 'model', owned_by: 'fixture' },
        ] });
      }
      if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
        return send(200, {
          id: 'fixture', object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: '4' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        });
      }
      return send(404, { error: { message: 'fixture: no such route' } });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      origin: `http://127.0.0.1:${port}`,
      requests,
      close: () => new Promise((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
    }));
  });
}
