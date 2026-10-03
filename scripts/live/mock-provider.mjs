// A local stand-in for the fixture's providers: OpenAI-shaped /models and
// /chat/completions on 127.0.0.1, answering only fixture keys. It records
// every request, so the live check can see which key actually went out.
// Completions report usage and fixture-alpha carries a price, so the request
// log's tokens and cost can be checked; /echo-key quotes the key it was sent
// back in an error, as some gateways do, so the log's scrubbing can be too.
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
        // fixture-alpha carries a price; fixture-gamma publishes capability
        // metadata the Models page draws as icons; fixture-beta publishes
        // nothing at all, which is the case the page must render as an empty
        // Caps cell rather than as eight dim marks. The three together are the
        // whole tri-state: lit, dim, and nothing said.
        return send(200, { object: 'list', data: [
          { id: 'fixture-alpha', object: 'model', owned_by: 'fixture',
            pricing: { input_usd_per_1m: 2, output_usd_per_1m: 10 },
            // One capability published and nothing else: the row must show one
            // lit icon beside dimmed ones, never a shelf of eight and never a
            // red "no" for the seven nobody mentioned.
            tool_call: true },
          { id: 'fixture-gamma', object: 'model', owned_by: 'fixture',
            modalities: { input: ['text', 'image', 'audio'], output: ['text'] },
            supported_parameters: ['tools', 'response_format'], tool_call: true, reasoning: true },
          { id: 'fixture-beta', object: 'model', owned_by: 'fixture' },
        ] });
      }
      if (req.method === 'POST' && req.url.endsWith('/echo-key')) {
        return send(400, { error: { message: `fixture: rejected ${authorization}`, code: 'fixture_echo' } });
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
