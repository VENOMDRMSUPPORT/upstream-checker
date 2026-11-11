'use strict';

// ---------------------------------------------------------------------------
// Gateway context diet (tier design §2.8, step 6)
// ---------------------------------------------------------------------------
// Agent loops resend the whole conversation on every step, and on lanes
// without prompt caching (ApiNex verified: none) every resent token is
// billed again, weighted. The diet shrinks what is resent without ever
// rewriting what the cache — or the conversation — depends on:
//
//   1. The static prefix is pinned byte-for-byte: leading system
//      messages and the first user message are never modified, so an
//      upstream automatic cache always sees the same opening bytes.
//   2. Tool results diet by recency: the newest keeps the full cap,
//      each older one halves toward a floor — old tool output is the
//      bulk of a loop's resend and the least likely to be re-read.
//      Trimming is head+tail with an honest marker, content only, so
//      tool-call pairing is never broken.
//   3. A window cap (estimated tokens) elides whole middle turns —
//      an assistant tool-call block together with its tool results,
//      never an orphan half — replaced by one marker message that
//      says what was removed and why. The most recent messages are
//      never elided.
//
// Token counts are estimates (chars / 4, the same yardstick the older
// tool trim used) and the report says so; the diet runs once per
// client request at the engine's door, on the exact array that is
// dispatched — including body.messages, which is what reaches the
// wire. (Before this step the gateway trimmed a copy the wire never
// read; the dispatched body carried the full history.)

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 120000;
const TOOL_CAPS_CHARS = [16000, 8000, 4000, 2000];
const TOOL_FLOOR_CHARS = 1000;
const DEFAULT_KEEP_RECENT = 6;

function estimateTextTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}

function messageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (message.content == null) return '';
  try { return JSON.stringify(message.content); } catch (_) { return ''; }
}

function estimateMessageTokens(message) {
  let tokens = estimateTextTokens(messageText(message));
  if (message && Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const args = call && call.function ? call.function.arguments : '';
      tokens += estimateTextTokens(typeof args === 'string' ? args : JSON.stringify(args || ''));
    }
  }
  return tokens;
}

function trimText(text, maxChars) {
  if (text.length <= maxChars) return { text, trimmed: 0 };
  const head = text.slice(0, Math.floor(maxChars * 0.7));
  const tail = text.slice(-Math.floor(maxChars * 0.2));
  const removed = text.length - head.length - tail.length;
  return { text: `${head}\n…[venom-router: trimmed ${removed} chars]…\n${tail}`, trimmed: removed };
}

// The indices that never change: leading system messages, plus the
// first user message after them.
function pinnedIndices(messages) {
  const pinned = new Set();
  let i = 0;
  while (i < messages.length && messages[i] && messages[i].role === 'system') {
    pinned.add(i); i += 1;
  }
  if (i < messages.length && messages[i] && messages[i].role === 'user') pinned.add(i);
  return pinned;
}

// Group messages into elision units: an assistant message carrying
// tool_calls owns the tool messages that follow it; everything else
// is a unit of one. Eliding whole units keeps the transcript valid.
function toUnits(messages) {
  const units = [];
  let current = null;
  messages.forEach((message, index) => {
    if (message && message.role === 'tool' && current && current.toolBlock) {
      current.indices.push(index);
      return;
    }
    current = { indices: [index], toolBlock: Boolean(message && message.role === 'assistant'
      && Array.isArray(message.tool_calls) && message.tool_calls.length) };
    units.push(current);
  });
  return units;
}

function applyContextDiet(messages, opts = {}) {
  const report = { beforeTokens: 0, afterTokens: 0, trimmedTools: 0, trimmedChars: 0, elidedUnits: 0, elidedMessages: 0, elidedTokens: 0 };
  if (!Array.isArray(messages)) return { messages, report };
  report.beforeTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const maxTokens = Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : DEFAULT_MAX_TOKENS;
  const keepRecent = Number.isInteger(opts.keepRecent) && opts.keepRecent >= 0
    ? opts.keepRecent : DEFAULT_KEEP_RECENT;
  const pinned = pinnedIndices(messages);

  // (2) Tool diet by recency — newest first keeps the largest cap.
  const out = messages.slice();
  const toolIndices = [];
  out.forEach((m, i) => { if (m && m.role === 'tool' && typeof m.content === 'string') toolIndices.push(i); });
  toolIndices.reverse().forEach((msgIndex, age) => {
    const cap = age < TOOL_CAPS_CHARS.length ? TOOL_CAPS_CHARS[age] : TOOL_FLOOR_CHARS;
    const original = out[msgIndex];
    const { text, trimmed } = trimText(original.content, cap);
    if (trimmed > 0) {
      out[msgIndex] = { ...original, content: text };
      report.trimmedTools += 1;
      report.trimmedChars += trimmed;
    }
  });

  // (3) Window cap — elide whole elidable units, oldest first.
  let tokens = out.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  if (tokens > maxTokens) {
    const units = toUnits(out);
    const recentBoundary = out.length - keepRecent;
    const elided = new Set();
    for (const unit of units) {
      if (tokens <= maxTokens) break;
      const first = unit.indices[0];
      if (unit.indices.some((i) => pinned.has(i))) continue;
      if (first >= recentBoundary) continue;
      const unitTokens = unit.indices.reduce((sum, i) => sum + estimateMessageTokens(out[i]), 0);
      unit.indices.forEach((i) => elided.add(i));
      tokens -= unitTokens;
      report.elidedTokens += unitTokens;
      report.elidedUnits += 1;
      report.elidedMessages += unit.indices.length;
    }
    if (elided.size) {
      const kept = [];
      let markerPlaced = false;
      out.forEach((m, i) => {
        if (elided.has(i)) {
          if (!markerPlaced) {
            kept.push({ role: 'system', content: `[venom-router: ${report.elidedMessages} earlier message(s) (~${report.elidedTokens} tokens, estimated) were elided by the context diet to fit the window cap. The conversation continues from the most recent context.]` });
            markerPlaced = true;
          }
          return;
        }
        kept.push(m);
      });
      report.afterTokens = kept.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
      return { messages: kept, report };
    }
  }
  report.afterTokens = out.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  return { messages: out, report };
}

module.exports = {
  applyContextDiet, estimateTextTokens, estimateMessageTokens,
  DEFAULT_MAX_TOKENS, TOOL_CAPS_CHARS, TOOL_FLOOR_CHARS,
};
