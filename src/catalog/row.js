// src/catalog/row.js
'use strict';

// One adapter's model object → the shared provider row the reference merge
// expects (ref §8.1). The readers move here from src/renderer/catalog.js
// (readPricing 151-167, readsTools 169-176, summarizeModel 178-194) and change in
// one respect: an absent fact stays null. Today's `!!m.hasVision` turns "nobody
// said" into "it cannot", and that then gets stored, sorted and routed on.
//
// This runs in main over whatever the renderer's adapter produced, so it assumes
// a set of field names rather than a shape — the same names the last several
// years of OpenAI-compatible gateways have put prices under.

const {
  asNumber, perMillion, uniqueJoin, unixToDate, boolOrNull, hasParam, listHas, providerOf,
} = require('./util');

const ROW_FIELDS = ['id', 'name', 'description', 'family', 'context_tokens', 'output_tokens',
  'input_modalities', 'output_modalities', 'tools', 'reasoning', 'structured', 'attachment',
  'cost_in_per_m', 'cost_out_per_m', 'cost_kind', 'release_date', 'status'];

// The lab tokens that mean a family when they front a slash — the same set the
// reference recognises (providers/nexum-router.js LAB_PREFIX_RE). A segment in
// front of a slash that is NOT one of these is a routing HOST, not a family:
// `nexum/deepseek` is served by nexum, deepseek is the model.
const LAB_FAMILY = new Set(['qwen', 'xiaomi', 'meta', 'deepseek', 'google', 'openai', 'anthropic',
  'z-ai', 'zai', 'moonshotai', 'moonshot', 'minimax', 'nvidia', 'mistral']);

const firstNumber = (...values) => {
  for (const value of values) {
    const n = asNumber(value);
    if (n !== null) return n;
  }
  return null;
};

// A published negative is OpenRouter's -1 sentinel, not a price (ref §16.4).
const positive = (value) => {
  const n = asNumber(value);
  return n == null || n < 0 ? null : n;
};

const pick = (obj, name) => (obj && obj[name] != null ? obj[name] : null);

// The family is the id's provider segment only when that segment is a lab;
// otherwise a routed id (`nexum/deepseek-v4`) would claim nexum as its family.
const familyFromId = (id) => {
  const p = providerOf(id);
  return p && LAB_FAMILY.has(p) ? p : '';
};

function costKind({ inCost, outCost }) {
  if (inCost == null && outCost == null) return 'unknown';
  if (inCost === 0 && (outCost === 0 || outCost == null)) return 'free';
  return 'token';
}

/** The eight shapes src/renderer/catalog.js readPricing already accepted. */
function readPricing(m) {
  const pr = m.pricing || {};
  let input = firstNumber(m.input_price_per_1m, m.price_input,
    pick(pr, 'input_usd_per_1m'), pick(pr, 'input_per_1m'));
  let output = firstNumber(m.output_price_per_1m, m.price_output,
    pick(pr, 'output_usd_per_1m'), pick(pr, 'output_per_1m'));
  const perTokenIn = firstNumber(pick(pr, 'prompt'), m.input_cost_per_token);
  const perTokenOut = firstNumber(pick(pr, 'completion'), m.output_cost_per_token);
  if (input === null && perTokenIn !== null) input = perMillion(perTokenIn);
  if (output === null && perTokenOut !== null) output = perMillion(perTokenOut);
  if (input === null) input = asNumber(pick(pr, 'input'));
  if (output === null) output = asNumber(pick(pr, 'output'));
  if (input === null && output === null) {
    if (m.isFree) return { input: 0, output: 0 };
    return { input: null, output: null };
  }
  return { input: positive(input), output: positive(output) };
}

function readsTools(m) {
  const direct = boolOrNull(m.supports_tools != null ? m.supports_tools
    : m.supports_function_calling != null ? m.supports_function_calling : m.tool_call);
  if (direct !== null) return direct;
  if (Array.isArray(m.capabilities)
    && (m.capabilities.includes('tools') || m.capabilities.includes('function_calling'))) return true;
  if (hasParam(m.supported_parameters, 'tools')) return true;
  return null;
}

function readsReasoning(m) {
  const direct = boolOrNull(m.hasReasoning != null ? m.hasReasoning : m.reasoning);
  if (direct !== null) return direct;
  if (hasParam(m.supported_parameters, 'include_reasoning')
    || hasParam(m.supported_parameters, 'reasoning')) return true;
  // A route that calls itself a thinking route thinks. Reading it as unknown
  // would rank the provider's own claim below its silence.
  return /(?:^|-)thinking$|reasoner/i.test(String(m.id || '')) ? true : null;
}

function readsStructured(m) {
  const direct = boolOrNull(m.structured_output);
  if (direct !== null) return direct;
  if (hasParam(m.supported_parameters, 'response_format')
    || hasParam(m.supported_parameters, 'structured_outputs')) return true;
  return null;
}

function readsAttachment(m) {
  const direct = boolOrNull(m.attachment);
  if (direct !== null) return direct;
  const input = uniqueJoin([m.modalities && m.modalities.input,
    m.architecture && m.architecture.input_modalities]);
  if (listHas(input, 'file') || listHas(input, 'pdf') || listHas(input, 'document')) return true;
  return null;
}

/**
 * The aliases a thin, route-prefixed id needs to reach the reference (ref §8.2).
 * The provider that needs it most publishes nothing else about itself. Unlike the
 * reference's Nexum-only variant, this one is host-aware: a routed id carries a
 * routing prefix (`nexum/…`) that is never part of the model's identity, so it is
 * stripped before the lab/name split. It then emits, most likely first: the lab
 * host form, the lab-prefixed id, the bare name, and — for a version that leads
 * with a digit — the collapsed `lab<version>` form the catalog knows, or else the
 * `-v`-repaired and `lab/<name>` variants.
 */
function matchIds(id) {
  const cleaned = String(id || '').toLowerCase();
  if (!cleaned) return [];
  const slash = cleaned.indexOf('/');
  // Drop the routing host; keep everything after the first slash as the model id.
  const modelId = slash === -1 ? cleaned : cleaned.slice(slash + 1);
  if (!modelId) return [];
  const hyphen = modelId.indexOf('-');
  if (hyphen === -1) return [...new Set([modelId])].filter(Boolean);
  const lab = modelId.slice(0, hyphen);
  const rest = modelId.slice(hyphen + 1);
  const out = [`${lab}/${modelId}`, modelId, rest];
  if (/^\d/.test(rest)) {
    out.push(`${lab}${rest}`);                      // qwen-3.8-max -> qwen3.8-max
  } else {
    out.push(rest.replace(/-(\d+(?:\.\d+)?)/, '-v$1')); // xiaomi-mimo-2.5 -> mimo-v2.5
    out.push(`${lab}/${rest}`);                     // lab/name form used by hosts
  }
  return [...new Set(out)].filter(Boolean);
}

/** For a `-thinking` route, the base route's first match id — its quality proxy. */
function qualityProxyIds(id) {
  const cleaned = String(id || '').toLowerCase();
  if (!/-thinking$/.test(cleaned)) return [];
  const base = cleaned.replace(/-thinking$/, '');
  const first = matchIds(base)[0];
  return first ? [first] : [];
}

function providerRow(model, providerId) {
  const m = model || {};
  const id = String(m.id || '');
  const pricing = readPricing(m);
  const modalities = m.modalities || {};
  const architecture = m.architecture || {};
  const row = {
    id,
    name: String(m.name || id).replace(/^[^:]+:\s*/, '') || id,
    description: m.description || '',
    family: m.owned_by || m.ownedBy || familyFromId(id) || '',
    context_tokens: firstNumber(m.limit && m.limit.context, m.context_length, m.context_window),
    output_tokens: firstNumber(m.limit && m.limit.output, m.max_output_tokens, m.max_completion_tokens,
      m.top_provider && m.top_provider.max_completion_tokens),
    input_modalities: uniqueJoin([modalities.input, architecture.input_modalities]),
    output_modalities: uniqueJoin([modalities.output, architecture.output_modalities]),
    tools: readsTools(m),
    reasoning: readsReasoning(m),
    structured: readsStructured(m),
    attachment: readsAttachment(m),
    cost_in_per_m: pricing.input,
    cost_out_per_m: pricing.output,
    cost_kind: m.cost_kind || costKind({ inCost: pricing.input, outCost: pricing.output }),
    release_date: m.release_date || unixToDate(m.created),
    status: m.status || 'active',
  };
  // The reference drops every entry with no id; saying it here means a malformed
  // adapter row is refused at the door rather than becoming a catalog entry keyed
  // by the empty string.
  if (!row.id) throw new Error(`${providerId} listed a model with no id`);
  return row;
}

module.exports = {
  ROW_FIELDS, providerRow, readPricing, costKind,
  readsTools, readsReasoning, readsStructured, readsAttachment, matchIds, qualityProxyIds,
};
