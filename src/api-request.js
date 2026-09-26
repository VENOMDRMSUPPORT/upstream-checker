// ============================================
// api-request — every outbound request the renderer asks for
// ============================================
// Main sends it (the page has connect-src 'none'), so key placeholders are
// swapped for secrets here and nowhere else (src/db/keys.js).
//
// Each request ends exactly once, through finish(): the response ending, the
// body being cut off (a cancel, or the server dropping the connection), the
// socket timing out, a transport error, or the resolver refusing a key.
// finish() resolves the renderer's promise first and only then, in
// setImmediate, hands the request to the log (onFinish), so logging adds
// nothing to the reply path and a logging fault can never reach the reply.
//
// Failures resolve rather than reject. A rejected ipcMain.handle reaches the
// renderer as "Error invoking remote method 'api-request': ..." with the real
// message buried and every other field — notably the elapsed time — gone.
const https = require('https');
const http = require('http');

// A chunk that carries model text: a non-empty content/text/reasoning field.
// Matches both a streamed delta and a whole non-streamed body.
const CONTENT_TOKEN = /"(?:content|text|reasoning_content|reasoning)"\s*:\s*"[^"\\]/;
const CANCEL_REASONS = new Set(['hedge_lost', 'stop', 'deadline']);
const CUT_OFF = 'The connection closed before the response ended';

function createApiRequester({ getResolver = () => null, onFinish = () => {}, log = console, now = Date.now } = {}) {
  // In flight by the renderer's requestId, so it can cancel hedge losers,
  // Stop a run, or give up at a deadline.
  const active = new Map();
  let inFlight = 0;

  function request(args) {
    const a = args && typeof args === 'object' ? args : {};
    const { url, method, headers, body, requestId, timeoutMs } = a;
    const startedAt = now();
    const resolver = getResolver();
    const outgoing = resolver ? resolver.resolve({ url, headers, body }) : { url, headers, body };
    // substitutions holds secrets: it goes to onFinish (the log scrubs with
    // it) and never into a reply.
    const refs = Array.isArray(outgoing.refs) ? outgoing.refs : [];
    const substitutions = Array.isArray(outgoing.substitutions) ? outgoing.substitutions : [];

    const report = (fields) => {
      const done = {
        args: a, startedAt, refs, substitutions,
        cancelReason: null, httpStatus: null, contentType: null, responseText: '',
        error: null, elapsed: now() - startedAt, firstByteMs: null, firstTokenMs: null,
        ...fields,
      };
      setImmediate(() => {
        try {
          onFinish(done);
        } catch (err) {
          log.warn('Request log: could not record a request:', err && err.message);
        }
      });
    };

    if (outgoing.blocked) {
      log.warn(outgoing.error);
      report({ outcome: 'blocked', error: outgoing.error, elapsed: 0 });
      return Promise.resolve({ status: 0, body: '', elapsed: 0, headers: {}, blocked: true, error: outgoing.error });
    }

    return new Promise((resolve) => {
      inFlight += 1;
      const entry = { req: null, cancelReason: null };
      let settled = false;
      // The response once its headers arrived: what it delivered so far.
      let response = null;
      const elapsed = () => now() - startedAt;

      const finish = (reply, fields) => {
        if (settled) return;
        settled = true;
        inFlight -= 1;
        if (requestId && active.get(requestId) === entry) active.delete(requestId);
        resolve(reply);
        report(fields);
      };

      const seen = () => (response ? {
        httpStatus: response.res.statusCode,
        contentType: String(response.res.headers['content-type'] || '') || null,
        responseText: Buffer.concat(response.chunks).toString('utf8'),
        firstByteMs: response.firstByteMs,
        firstTokenMs: response.firstTokenMs,
      } : {});

      const failNetwork = (error, outcome = 'error') => {
        const e = elapsed();
        finish({ status: 0, body: '', elapsed: e, headers: {}, networkError: true, error }, { outcome, error, elapsed: e, ...seen() });
      };
      const finishCancelled = () => {
        const e = elapsed();
        finish({ status: 0, body: '', elapsed: e, headers: {}, cancelled: true },
          { outcome: 'cancelled', cancelReason: entry.cancelReason, elapsed: e, ...seen() });
      };

      let urlObj;
      try {
        urlObj = new URL(outgoing.url);
      } catch (err) {
        failNetwork(err.message);
        return;
      }
      const isHttps = urlObj.protocol === 'https:';
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: method || 'GET',
        headers: outgoing.headers || {},
        // Socket inactivity timeout. A video generator sends nothing for minutes
        // while it works, so a fixed 60s here would kill it regardless of the
        // deadline the caller set for that kind of model.
        timeout: Number(timeoutMs) > 0 ? Number(timeoutMs) : 60000,
      };

      const onResponse = (res) => {
        // Collected as Buffers and decoded once at the end. `data += chunk`
        // decodes each chunk on its own, so a UTF-8 character split across a
        // chunk boundary comes out mangled — "Bốn" renders as "Bón".
        // firstByteMs: time to the first byte of the body (for a stream, the
        // first token as far as the wire can tell). firstTokenMs: time to the
        // first chunk carrying model text; a proxy can answer with headers, a
        // keep-alive comment or an empty role delta long before the model does.
        response = { res, chunks: [], firstByteMs: null, firstTokenMs: null };
        res.on('data', (chunk) => {
          const t = elapsed();
          if (response.firstByteMs === null) response.firstByteMs = t;
          if (response.firstTokenMs === null && CONTENT_TOKEN.test(chunk.toString('utf8'))) response.firstTokenMs = t;
          response.chunks.push(chunk);
        });
        res.on('end', () => {
          const s = seen();
          const e = elapsed();
          finish(
            { status: res.statusCode, body: s.responseText, elapsed: e, firstByteMs: s.firstByteMs, firstTokenMs: s.firstTokenMs, headers: res.headers },
            { outcome: 'end', elapsed: e, ...s },
          );
        });
        // The body stopped before 'end'. Node emits 'aborted', then 'error'
        // (ECONNRESET), then 'close'. Either a cancel (hedge loser, Stop,
        // deadline) or the server dropping the connection mid-stream; before
        // finish-once, neither ever resolved the renderer's promise.
        const cut = () => (entry.cancelReason ? finishCancelled() : failNetwork(CUT_OFF, 'aborted'));
        res.on('aborted', cut);
        res.on('error', cut);
        res.on('close', () => {
          if (!res.complete) cut();
        });
      };

      let req;
      try {
        req = (isHttps ? https : http).request(options, onResponse);
      } catch (err) {
        // Node refuses to build it (a header value with a newline, say).
        failNetwork(err.message);
        return;
      }
      entry.req = req;
      if (requestId) active.set(requestId, entry);

      req.on('error', (err) => {
        if (entry.cancelReason) finishCancelled();
        // A reset after the headers arrived is the body being cut off, the
        // same as res 'aborted', whichever event Node delivers first.
        else if (response) failNetwork(CUT_OFF, 'aborted');
        else failNetwork(err.message);
      });
      req.on('timeout', () => {
        const error = `No response for ${Math.round(options.timeout / 1000)}s`;
        const e = elapsed();
        finish({ status: 0, body: '', elapsed: e, headers: {}, networkError: true, timedOut: true, error },
          { outcome: 'timeout', error, elapsed: e, ...seen() });
        // Destroying fires 'error' (and 'aborted' mid-body); finish() ignores both.
        req.destroy();
      });

      try {
        if (outgoing.body) req.write(typeof outgoing.body === 'string' ? outgoing.body : JSON.stringify(outgoing.body));
        req.end();
      } catch (err) {
        req.destroy();
        failNetwork(err.message);
      }
    });
  }

  // reason: hedge_lost | stop | deadline; anything else is recorded as stop.
  // An id that already finished (or never existed) is a no-op.
  function cancel(requestId, reason) {
    const entry = active.get(requestId);
    if (!entry) return false;
    active.delete(requestId);
    entry.cancelReason = CANCEL_REASONS.has(reason) ? reason : 'stop';
    entry.req.destroy();
    return true;
  }

  return { request, cancel, inFlight: () => inFlight };
}

module.exports = { createApiRequester, CONTENT_TOKEN };
