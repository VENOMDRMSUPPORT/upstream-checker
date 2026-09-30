// One adapter's model object → the shared provider row the reference merge
// expects (ref §8.1). The readers move here from src/renderer/catalog.js
// (readPricing 151-167, readsTools 169-176, summarizeModel 178-194) and change in
// one respect: an absent fact stays null. Today's `!!m.hasVision` turns "nobody
// said" into "it cannot", and that then gets stored, sorted and routed on — the
// same trap waits behind every field this app already coerces with `!!`.
//
// This runs in main over whatever the renderer's adapter produced, so it assumes
// a set of field names rather than a shape — the same names the last several
// years of OpenAI-compatible gateways have put prices under.
//
// src/catalog/row.js
'use strict';

const {
  asNumber, perMillion, uniqueJoin, unixToDate, boolOrNull, hasParam, listHas, providerOf,
} = require('./util');
const { LAB_PROVIDERS } = require('./keys');

const ROW_FIELDS = ['id', 'name', 'description', 'family', 'context_tokens', 'output_tokens',
  'input_modalities', 'output_modalities', 'tools', 'reasoning', 'structured', 'attachment',
  'cost_in_per_m', 'cost_out_per_m', 'cost_kind', 'release_date', 'status'];

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

const dedupe = (values) => [...new Set(values)].filter(Boolean);

// Lab tokens that may front a model id: the reference's set
// (providers/nexum-router.js:70 LAB_PREFIX_RE) unioned with the labs this repo
// already enumerates (src/catalog/keys.js LAB_PROVIDERS — imported, not copied),
// longest first so `z-ai` and `mistralai` win where an unordered scan would find
// `z`- or `mistral`-sized fragments. Only used to split an id, never to decide what
// may be a family: see the provider-relative rule in `familyOf`.
const LAB_TOKENS = [...new Set([
  'qwen', 'xiaomi', 'meta', 'deepseek', 'google', 'openai', 'anthropic', 'z-ai', 'zai',
  'moonshotai', 'moonshot', 'minimax', 'nvidia', 'mistral',
  ...LAB_PROVIDERS,
])]
  .sort((a, b) => b.length - a.length);

/** The known lab token fronting this id, or '' when the id leads with its name. */
function labTokenOf(modelId) {
  return LAB_TOKENS.find((token) => modelId.startsWith(`${token}-`)) || '';
}

/**
 * The family is the id's own provider segment — except when that segment IS the
 * host serving the row, which is a routing fact and not a lineage: `nara/deepseek-v4`
 * served by nara publishes no family, while `deepseek-ai/deepseek-v3.2` served by
 * nara does. Relative to the serving provider because a whitelist of "known labs"
 * silently loses every lab it has never met — `mistralai/*` (92 rows), `deepseek-ai/*`
 * (109), `xai/*` + `x-ai/*` (104), `zai-org/*` (105), `cohere/*` (28) all read
 * family-less under the list this replaces. `providerId` is what this parameter was
 * meant for; before it, the argument existed only inside the no-id error string.
 */
const familyOf = (id, providerId) => {
  const segment = providerOf(id);
  return !segment || segment === String(providerId || '') ? '' : segment;
};

function costKind({ inCost, outCost }) {
  if (inCost == null && outCost == null) return 'unknown';
  if (inCost === 0 && (outCost === 0 || outCost == null)) return 'free';
  return 'token';
}

/**
 * The eight shapes src/renderer/catalog.js readPricing already accepted — in the
 * order it accepts them (catalog.js:154-155 tries `pricing.*` BEFORE the top-level
 * fields). The order is not cosmetic: an adapter that normalises onto `pricing`
 * while carrying a raw `0` default at the top level reads as free when top-level
 * fields lead, and `cost_kind: 'free'` is a claim the catalog cannot walk back.
 */
function readPricing(m) {
  const pr = m.pricing || {};
  let input = firstNumber(pick(pr, 'input_usd_per_1m'), pick(pr, 'input_per_1m'),
    m.input_price_per_1m, m.price_input);
  let output = firstNumber(pick(pr, 'output_usd_per_1m'), pick(pr, 'output_per_1m'),
    m.output_price_per_1m, m.price_output);
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

// Reasoning, in the order the raw spellings answer. `hasReasoning` is last and is
// only believed when it claims true, because in this app it is never a provider
// field: every adapter produces it through `!!` (src/renderer/app.js:1483-1487,
// providers/nara.js:87, providers/experiential.js:89) or hardcodes `false`
// (providers/tokenharbor.js:98). A coerced `false` stored as a published refusal
// is worse than a gap — scoring.js `fillFromCatalog` treats a non-empty false as
// an answer, so the catalog can never repair it. The rule is about silence, not
// about contradicting a provider: a raw field that says false stays an answer.
function readsReasoning(m) {
  for (const value of [m.reasoning, m.supports_reasoning]) {
    const raw = boolOrNull(value);
    if (raw !== null) return raw;
  }
  if (hasParam(m.supported_parameters, 'include_reasoning')
    || hasParam(m.supported_parameters, 'reasoning')) return true;
  if (Array.isArray(m.capabilities) && m.capabilities.includes('reasoning')) return true;
  // A route that calls itself a thinking route thinks. Reading it as unknown
  // would rank the provider's own claim below its silence.
  if (/(?:^|-)thinking$|reasoner/i.test(String(m.id || ''))) return true;
  return boolOrNull(m.hasReasoning === true ? true : null);
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
 * stripped before the lab/name split. The split then happens at the LONGEST KNOWN
 * lab token, not at the first hyphen — `x-ai-grok-4` is lab `x-ai` plus `grok-4`
 * (the spelling with catalog rows), not lab `x` plus `ai-grok-4` (a key that names
 * nothing). What comes out, most likely first: for a version that leads with a
 * digit the collapsed `lab<version>` form, then the lab host form and the id
 * itself; otherwise the host form, the id, and the reference's own three variants
 * (`rest`, the `-v`-repaired rest, `lab/rest`).
 *
 * Order is load-bearing. scoring.js lookupCatalogRow returns the FIRST exact-alias
 * hit and bestCandidate prefers the highest-SCORING hit, so a loose variant in
 * front attaches another model's score — and MATCH_AMBIGUOUS does not catch it: it
 * fires when two catalog rows collide under one key, not when two provider rows
 * reach the same alias. So a bare numeric rest (`5`, `4.6`, `3.8-max`) is never
 * emitted: the reference's digit branch (providers/nexum-router.js:79) returns only
 * the collapsed form, because a one-token version numbers nobody's model.
 */
function matchIds(id) {
  const cleaned = String(id || '').toLowerCase();
  if (!cleaned) return [];
  const slash = cleaned.indexOf('/');
  // Drop the routing host; keep everything after the first slash as the model id.
  const modelId = slash === -1 ? cleaned : cleaned.slice(slash + 1);
  if (!modelId) return [];
  const lab = labTokenOf(modelId);
  // No known lab fronts this id (`gpt-5`, `kimi-k3-thinking`), so there is nothing
  // to collapse and no lab to double into a host form the reference never emits.
  if (!lab) return [modelId];
  const rest = modelId.slice(lab.length + 1);
  if (!rest) return [modelId];
  if (/^\d/.test(rest)) {
    return dedupe([`${lab}${rest}`, `${lab}/${modelId}`, modelId]);
  }
  return dedupe([`${lab}/${modelId}`, modelId, rest,
    rest.replace(/-(\d+(?:\.\d+)?)/, '-v$1'), `${lab}/${rest}`]);
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
    family: m.owned_by || m.ownedBy || familyOf(id, providerId),
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
