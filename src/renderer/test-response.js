// Test response parsing, asset lookup and result classification — pure helpers.
// Closure-scoped classic script: no shared lexical globals.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.responses = (() => {
  'use strict';
  function usageTokens(u = {}) {
    if (Number.isFinite(u.total_tokens)) return u.total_tokens;
    return (u.prompt_tokens || u.input_tokens || 0) + (u.completion_tokens || u.output_tokens || 0);
  }

  function parseRetryAfter(headers) {
    const raw = headers?.['retry-after'];
    if (!raw) return 0;
    const secs = parseInt(raw, 10);
    if (Number.isFinite(secs)) return Math.max(0, secs);
    const at = Date.parse(raw);
    return Number.isNaN(at) ? 0 : Math.max(0, Math.round((at - Date.now()) / 1000));
  }

  function failFromResponse(result, keyId) {
    let errMsg = `HTTP ${result.status}`;
    let errorCode = null; // machine-readable error.code (or .type), when the body has one
    try {
      const d = JSON.parse(result.body);
      errMsg = (typeof d.error === 'string' ? d.error : d.error?.message) || d.message || errMsg;
      if (d.error && typeof d.error === 'object') errorCode = d.error.code || d.error.type || null;
    } catch (_) {}
    return { status: 'fail', response: errMsg, time: result.elapsed, tokens: 0, statusCode: result.status,
             retryAfter: parseRetryAfter(result.headers), keyId, errorCode };
  }

  function transportFailure(result, keyId) {
    if (result.cancelled) return { status: 'fail', response: 'cancelled', time: result.elapsed || 0, tokens: 0, cancelled: true, keyId };
    if (result.networkError) {
      return { status: 'fail', response: result.error || 'Request failed', time: result.elapsed || 0,
               tokens: 0, networkError: true, timedOut: !!result.timedOut, keyId };
    }
    return null;
  }

  function authHeaders(apiKey) {
    return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  }

  function isMissingRoute(result, errMsg) {
    const routeWords = /endpoint|route|path|url|not supported|unsupported|not implemented/i;
    if (result.status === 405 || result.status === 501) return true;
    if (result.status === 404) return !/model/i.test(errMsg) || routeWords.test(errMsg);
    return result.status === 400 && routeWords.test(errMsg);
  }

  function findAssetUrl(node, depth = 0) {
    if (node == null || depth > 5) return null;
    if (typeof node === 'string') return /^(https?:\/\/|data:(image|video)\/)/i.test(node) ? node : null;
    if (Array.isArray(node)) {
      for (const v of node) {
        const u = findAssetUrl(v, depth + 1);
        if (u) return u;
      }
      return null;
    }
    if (typeof node === 'object') {
      const entries = Object.entries(node).sort(([a], [b]) => /url/i.test(b) - /url/i.test(a));
      for (const [, v] of entries) {
        const u = findAssetUrl(v, depth + 1);
        if (u) return u;
      }
    }
    return null;
  }

  function extractMediaUrl(text) {
    const m = /(https?:\/\/[^\s)"'<>\]]+|data:(?:image|video)\/[^\s)"'<>]+)/i.exec(text || '');
    return m ? m[1] : null;
  }

  function parseChatCompletion(body) {
    const data = JSON.parse(body);
    const choice = data.choices?.[0];
    let content = choice?.message?.content?.trim() || '';
    if (!content && choice?.message?.reasoning_content) {
      content = choice.message.reasoning_content.trim();
    }
    return { content, usage: data.usage || {} };
  }

  function parseStreamedCompletion(body) {
    let content = '';
    let usage = null;
    for (const line of (body || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch (_) {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) content += delta.content;
      if (chunk.usage) usage = chunk.usage;
    }
    return { content: content.trim(), usage: usage || {} };
  }

  function buildEmptyResult(usage, elapsed) {
    return {
      status: 'pass',
      response: 'No content returned by provider',
      isEmpty: true,
      time: elapsed,
      tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
    };
  }

  function resultRank(r) {
    if (r.status === 'pass' && !r.isEmpty) return 3;
    if (r.status === 'pass' && r.isEmpty) return 2;
    return 1;
  }

  return {
     usageTokens, parseRetryAfter, failFromResponse, transportFailure, authHeaders, isMissingRoute,
     findAssetUrl, extractMediaUrl, parseChatCompletion, parseStreamedCompletion, buildEmptyResult,
     resultRank,

  };
})();
