"use strict";

// Model-name normalization. The same model shows up under different names in
// every source ("anthropic/claude-fable-5.1-20260831" in benchmarks,
// "claude-fable-5.1-max" in LMArena, "~anthropic/claude-fable-5.1:free" on a
// host). Everything that matches models across sources goes through the keys
// defined here. When a model "shows no score", this is the file to debug.
//
// The one rule every key follows: a key names exactly one model identity.
// Tokens that only change the price of the same weights are dropped; tokens
// that change what runs (effort tier, thinking mode, preview build) or which
// build an alias points to are kept, so "gpt-5-low" and "gpt-5-high" never
// share a key while "mimo-v2.5-free" and "mimo-v2.5" always do.

const MATCH_AMBIGUOUS = Symbol("ambiguous");

// Labs whose listings win when duplicate listings are collapsed (order = priority).
const LAB_PROVIDERS = [
  "openai", "anthropic", "google", "google-vertex", "google-ai-studio",
  "meta", "x-ai", "xai", "deepseek", "mistral", "mistralai", "moonshotai",
  "z-ai", "alibaba", "qwen", "cohere",
];

// Tokens a host appends that change the price of the same weights, never the
// model itself (":free", "-contributor", "-batch"). Dropped from every key.
const PRICING_MODIFIERS = new Set(["free", "contributor", "contributors", "batch", "hosted"]);

// Tokens that change what actually runs (inference effort, thinking mode, a
// preview build) or which build an alias points to ("latest"). Kept in every
// key — merging these was the bug the old matcher had. Exported so tests can
// assert the two sets stay disjoint and that keys really retain them.
const QUALITY_MODIFIERS = new Set([
  "latest", "max", "high", "xhigh", "medium", "low", "thinking", "reasoning", "instant", "preview",
]);

// A trailing build stamp: "-20260803", "-20260803" style dates and the shorter
// "-2512" (YYMM) mistral/qwen use. Two builds of one model are two identities —
// they can differ by more than ten points — so the tag is read, not discarded.
const BUILD_SUFFIX_RE = /-(20\d{6}|\d{8}|\d{4})$/;

// Parameter sizes and quantization tags found in LMArena names ("550b", "a55b", "nvfp4").
const PARAM_SIZE_RE = /^(?:\d+(?:\.\d+)?[bt]|a\d+b|\d+x\d+b)$/;
const QUANT_TOKENS = new Set(["nvfp4", "fp4", "fp8", "bf16", "fp16", "int4", "int8", "awq", "gptq"]);

/** Strip `~`, drop `:variant`, lowercase. The canonical id cleanup. */
function cleanModelId(id) {
  return String(id || "")
    .replace(/^~/, "")
    .split(":")[0]
    .toLowerCase();
}

/** "provider/model-slug" → "model-slug". */
function modelSlug(id) {
  const cleaned = cleanModelId(id);
  const slash = cleaned.indexOf("/");
  return slash === -1 ? cleaned : cleaned.slice(slash + 1);
}

/** Slug with a leading lab prefix and dots/underscores normalized to hyphens. */
function identityKey(id) {
  let slug = modelSlug(id);
  slug = slug.replace(/^(google|anthropic|openai|meta|amazon|mistralai|mistral|qwen|alibaba)\./, "");
  slug = slug.replace(/[._]+/g, "-");
  slug = slug.replace(/-+/g, "-");
  return slug;
}

/** Display name → lowercase words only ("OpenAI: GPT-5 (max)" → "gpt 5 max"). */
function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/^[^:]+:\s*/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Split any id or name into lowercase tokens; parentheses and spaces separate too. */
function slugTokens(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[()[\]]/g, " ")
    .replace(/[\s._:/]+/g, "-")
    .split("-")
    .filter(Boolean);
}

function stripBuildSuffix(slug) {
  return String(slug || "").replace(BUILD_SUFFIX_RE, "");
}

/** The build stamp a slug carries, or null when it names no particular build. */
function buildTag(slug) {
  const match = String(slug || "").match(BUILD_SUFFIX_RE);
  return match ? match[1] : null;
}

/**
 * Order two build stamps for the same model. This must be a *total* order:
 * leaving any pair unordered would hand the decision back to the feed's row
 * order, which is the bug this whole file exists to prevent.
 *
 *   - An undated entry outranks every build: it is the model's own key rather
 *     than one build's stripped alias.
 *   - Stamps of different lengths come from different conventions ("2512" is
 *     YYMM, "20260803" is YYYYMMDD) and cannot be read as one calendar, so the
 *     more specific one is preferred. Two builds of one model realistically
 *     share a convention, so this arm decides pathological data, not real data.
 *   - Same length: later string, later build.
 *
 * @returns {number} >0 when `a` is the more authoritative, <0 when `b` is, 0 only when equal
 */
function compareBuilds(a, b) {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a.length !== b.length) return a.length > b.length ? 1 : -1;
  return a < b ? -1 : 1;
}

/**
 * Model identity from an id: identity tokens minus pricing tokens, joined with
 * "-". Falls back to the display name when the id has no usable tokens.
 */
function qualityModelKey(id, name) {
  const fromId = slugTokens(identityKey(id)).filter((token) => !PRICING_MODIFIERS.has(token));
  if (fromId.length) return fromId.join("-");
  return qualityNameKey(name);
}

/** Model identity from a display name, same token rules as qualityModelKey. */
function qualityNameKey(name) {
  return slugTokens(normalizeName(name))
    .filter((token) => !PRICING_MODIFIERS.has(token))
    .join("-");
}

/**
 * Whether a row's display name may stand in for its id as a lookup key.
 *
 * It may not when the id asserts something the name drops:
 *   - an effort tier or lifecycle stage ("mistral/devstral-latest" displayed as
 *     "Devstral 2" would otherwise collect a dated build's measurement);
 *   - a build stamp. The name path bypasses build resolution entirely, so a
 *     2512 build reachable as "Devstral Small 2" would silently answer with the
 *     2507 build's number — the same leak one level down.
 */
function nameKeyIsSafe(id, name) {
  const idKey = qualityModelKey(id, name);
  const nameTokens = new Set(slugTokens(qualityNameKey(name)));
  if (!slugTokens(idKey).every((token) => !QUALITY_MODIFIERS.has(token) || nameTokens.has(token))) return false;
  const build = buildTag(idKey);
  return build == null || nameTokens.has(build);
}

// A bare key needs at least this many tokens to be used: "minimax-m3" names a
// model, "m3" on its own could be anybody's.
const MIN_BARE_KEY_TOKENS = 2;

/**
 * The model's own name with every routing segment removed:
 * "edenai/qwen/qwen3.8-max" and "nano-gpt/alibaba/qwen3.8-max" both give
 * "qwen3-8-max". `modelSlug` only cuts at the first slash, so a host that
 * re-exports under "host/lab/model" would otherwise be a different model from
 * the lab's own listing — measured in one place, estimated in another.
 *
 * Returns "" when the last segment is too generic to identify anything, which
 * is what keeps this from turning "opper/minimax/m3" into a claim on "m3".
 */
function bareModelKey(id) {
  const segments = cleanModelId(id).split("/").filter(Boolean);
  if (segments.length < 2) return "";
  const key = qualityModelKey(segments[segments.length - 1], "");
  return slugTokens(key).length >= MIN_BARE_KEY_TOKENS ? key : "";
}

/** How many pricing tokens an id carries; the plain listing is preferred among equals. */
function pricingTokenCount(id) {
  return slugTokens(identityKey(id)).filter((token) => PRICING_MODIFIERS.has(token)).length;
}

/** Every key a benchmark or Arena entry should be findable under. */
function benchKeysFromSlug(slug, displayName) {
  const keys = new Set();
  const add = (value) => {
    if (value) keys.add(String(value).toLowerCase());
  };
  const normalized = qualityModelKey(slug, displayName);
  add(cleanModelId(slug));
  add(identityKey(slug));
  add(normalized);
  add(stripBuildSuffix(normalized));
  add(bareModelKey(slug));
  // Only when the name repeats what the id says — see nameKeyIsSafe.
  if (nameKeyIsSafe(slug, displayName)) add(qualityNameKey(displayName));
  return [...keys];
}

/**
 * Loose key for LMArena names that carry the lab, parameter size and quantization:
 * "nvidia-nemotron-3-ultra-550b-a55b-nvfp4" → "nemotron-3-ultra". Used only after
 * strict keys miss; collisions between different models are marked ambiguous.
 */
function looseArenaKey(name, organization) {
  let tokens = slugTokens(identityKey(name));
  const org = slugTokens(organization || "");
  if (org.length && tokens.length > org.length && org.every((token, index) => tokens[index] === token)) {
    tokens = tokens.slice(org.length);
  }
  tokens = tokens.filter(
    (token) => !PRICING_MODIFIERS.has(token) && !QUANT_TOKENS.has(token) && !PARAM_SIZE_RE.test(token),
  );
  return tokens.join("-");
}

module.exports = {
  MATCH_AMBIGUOUS,
  LAB_PROVIDERS,
  PRICING_MODIFIERS,
  QUALITY_MODIFIERS,
  cleanModelId,
  modelSlug,
  identityKey,
  normalizeName,
  slugTokens,
  stripBuildSuffix,
  buildTag,
  compareBuilds,
  qualityModelKey,
  qualityNameKey,
  bareModelKey,
  nameKeyIsSafe,
  pricingTokenCount,
  benchKeysFromSlug,
  looseArenaKey,
};
