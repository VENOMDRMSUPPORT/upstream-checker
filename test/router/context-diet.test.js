'use strict';

// Step 6 (§2.8): the gateway context diet. What is resent on every
// loop step is shrunk — tool results by recency, whole middle turns
// past a window cap — while the static prefix stays byte-identical
// and no tool-call pair is ever split.

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyContextDiet } = require('../../src/router/context-diet');

const toolTurn = (id, fill, size) => ([
  { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: id, content: fill.repeat(size) },
]);

test('a small conversation passes through untouched', () => {
  const messages = [
    { role: 'system', content: 'You are an agent.' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ];
  const { messages: out, report } = applyContextDiet(messages);
  assert.deepStrictEqual(out, messages);
  assert.equal(report.trimmedTools, 0);
  assert.equal(report.elidedUnits, 0);
  assert.equal(report.beforeTokens, report.afterTokens);
});

test('tool results diet by recency: the newest keeps the most', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' },
    ...toolTurn('c1', 'a', 20000),
    ...toolTurn('c2', 'b', 20000),
    ...toolTurn('c3', 'c', 20000),
  ];
  const { messages: out, report } = applyContextDiet(messages);
  const tools = out.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 3);
  assert.ok(tools[2].content.length > tools[1].content.length, 'newest tool result keeps the largest cap');
  assert.ok(tools[1].content.length > tools[0].content.length, 'older results shrink harder');
  for (const t of tools) assert.match(t.content, /venom-router: trimmed \d+ chars/);
  assert.ok(tools[2].content.startsWith('c') && tools[2].content.endsWith('c'), 'head and tail survive the trim');
  assert.equal(report.trimmedTools, 3);
  // Pairing is untouched: each tool result still follows its call.
  assert.equal(out[2].tool_calls[0].id, 'c1');
  assert.equal(out[3].tool_call_id, 'c1');
});

test('the static prefix is pinned byte-for-byte, even under elision pressure', () => {
  const system = { role: 'system', content: `STATIC PREFIX ${'p'.repeat(500)}` };
  const firstUser = { role: 'user', content: 'the original task' };
  const messages = [system, firstUser];
  for (let i = 0; i < 10; i += 1) messages.push(...toolTurn(`c${i}`, 'z', 4000));
  messages.push({ role: 'user', content: 'latest' });
  const { messages: out } = applyContextDiet(messages, { maxTokens: 2000 });
  assert.strictEqual(out[0], system, 'the system message is the same object, unmodified');
  assert.strictEqual(out[1], firstUser, 'the first user message is the same object, unmodified');
});

test('the window cap elides whole turns and says so, once', () => {
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'start' },
  ];
  for (let i = 0; i < 10; i += 1) messages.push(...toolTurn(`c${i}`, 'q', 4000));
  messages.push({ role: 'user', content: 'where are we?' });
  const { messages: out, report } = applyContextDiet(messages, { maxTokens: 3000 });
  assert.ok(report.elidedUnits > 0);
  assert.ok(report.afterTokens <= 3100, `after the diet the estimate fits the cap (saw ${report.afterTokens})`);
  const markers = out.filter((m) => typeof m.content === 'string' && m.content.includes('elided by the context diet'));
  assert.equal(markers.length, 1, 'exactly one elision marker');
  // No orphan tool results: every surviving tool message is preceded
  // in the output by an assistant message carrying tool_calls.
  out.forEach((m, i) => {
    if (m.role !== 'tool') return;
    let j = i - 1;
    while (j >= 0 && out[j].role === 'tool') j -= 1;
    assert.ok(out[j] && out[j].role === 'assistant' && Array.isArray(out[j].tool_calls),
      'a tool result never outlives its call');
  });
  assert.equal(out[out.length - 1].content, 'where are we?', 'the newest message survives');
});

test('the most recent messages are never elided, even past the cap', () => {
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'start' }];
  for (let i = 0; i < 4; i += 1) messages.push({ role: 'user', content: `recent-${i} ${'r'.repeat(3000)}` });
  const { messages: out } = applyContextDiet(messages, { maxTokens: 100, keepRecent: 4 });
  for (let i = 0; i < 4; i += 1) {
    assert.ok(out.some((m) => typeof m.content === 'string' && m.content.startsWith(`recent-${i}`)),
      `recent-${i} survives`);
  }
});

test('non-string content is counted, never mangled', () => {
  const parts = [{ type: 'text', text: 'look at this' }, { type: 'image_url', image_url: { url: 'x' } }];
  const message = { role: 'user', content: parts };
  const { messages: out } = applyContextDiet([
    { role: 'system', content: 'sys' }, message, { role: 'assistant', content: 'ok' },
  ]);
  assert.strictEqual(out[1], message);
  assert.strictEqual(out[1].content, parts);
});
