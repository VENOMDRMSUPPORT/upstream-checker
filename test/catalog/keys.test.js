"use strict";

// lib/keys.js is where every cross-source model match happens. These cases are
// drawn from real naming quirks documented in the module's own header comment
// and in docs/providers.md — not made-up strings.

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cleanModelId, identityKey, qualityModelKey, qualityNameKey, bareModelKey,
  nameKeyIsSafe, benchKeysFromSlug, compareBuilds, buildTag, stripBuildSuffix,
  PRICING_MODIFIERS, QUALITY_MODIFIERS, MATCH_AMBIGUOUS, looseArenaKey,
  slugTokens, pricingTokenCount,
} = require('../../src/catalog/keys');

test("cleanModelId strips ~, drops :variant, lowercases", () => {
  assert.equal(cleanModelId("~Anthropic/Claude-Fable-5.1:thinking"), "anthropic/claude-fable-5.1");
});

test("identityKey normalizes dots to hyphens after stripping the provider prefix", () => {
  // The exact example from the module header: same model, benchmark spelling.
  assert.equal(identityKey("anthropic/claude-fable-5.1-20260831"), "claude-fable-5-1-20260831");
});

test("slugTokens splits on brackets, parens and separators", () => {
  assert.deepEqual(slugTokens("GPT-5 (Max) [preview]"), ["gpt", "5", "max", "preview"]);
});

test("pricing and quality modifier sets are disjoint", () => {
  for (const token of PRICING_MODIFIERS) assert.ok(!QUALITY_MODIFIERS.has(token), token);
});

test("quality keys collapse a ':free' listing onto its paid twin", () => {
  // The point of dropping pricing tokens: a host's free-tier duplicate must
  // resolve to the same identity as the regular listing.
  const paid = qualityModelKey("anthropic/claude-fable-5.1", "Claude Fable 5.1");
  const free = qualityModelKey("~anthropic/claude-fable-5.1:free", "Claude Fable 5.1 (free)");
  assert.equal(free, paid);
  assert.equal(paid, "claude-fable-5-1");
  assert.equal(qualityModelKey("opencode/mimo-v2.5-free", "MiMo V2.5 Free"), "mimo-v2-5");
  assert.equal(qualityModelKey("meta/muse-spark-1.3-contributor", "Muse Spark 1.3 Contributor"), "muse-spark-1-3");
  assert.equal(qualityModelKey("minimax/minimax-m3:batch", "MiniMax M3 (batch)"), "minimax-m3");
  assert.equal(qualityNameKey("Nemotron 3 Ultra (free)"), "nemotron-3-ultra");
});

test("quality keys keep every effort and lifecycle token", () => {
  for (const token of QUALITY_MODIFIERS) {
    assert.equal(qualityModelKey(`lab/model-1-${token}`, ""), `model-1-${token}`);
    assert.equal(qualityNameKey(`Model 1 (${token})`), `model-1-${token}`);
  }
  assert.equal(qualityModelKey("openai/gpt-5-low", "GPT-5 Low"), "gpt-5-low");
  assert.equal(qualityModelKey("openai/gpt-5-high", "GPT-5 High"), "gpt-5-high");
  assert.equal(qualityModelKey("qwen/qwen3-thinking", "Qwen3 Thinking"), "qwen3-thinking");
  assert.equal(qualityModelKey("~anthropic/claude-fable-latest", "Claude Fable Latest"), "claude-fable-latest");
  assert.equal(qualityNameKey("OpenAI: GPT-5.1 Codex (max)"), "gpt-5-1-codex-max");
});

test("qualityModelKey falls back to the display name when the id has no tokens", () => {
  assert.equal(qualityModelKey("", "Anthropic: Claude Fable 5.1"), "claude-fable-5-1");
});

test("pricingTokenCount counts only pricing tokens", () => {
  assert.equal(pricingTokenCount("opencode/muse-spark-1.3-contributor-free"), 2);
  assert.equal(pricingTokenCount("openai/gpt-5-high"), 0);
});

test("benchKeysFromSlug dedupes a build-dated slug down to a few useful keys", () => {
  assert.deepEqual(
    benchKeysFromSlug("gpt-5-20260601", "OpenAI: GPT-5"),
    ["gpt-5-20260601", "gpt-5"],
  );
});

test("benchKeysFromSlug never produces a key that erases an effort tier", () => {
  const keys = benchKeysFromSlug("openai/gpt-5-high", "OpenAI: GPT-5 (high)");
  assert.ok(keys.every((key) => key.endsWith("high")), keys.join(", "));
});

test("looseArenaKey strips lab prefix, parameter size and quantization", () => {
  // The exact example from docs/providers.md's merge-pipeline section.
  assert.equal(looseArenaKey("nvidia-nemotron-3-ultra-550b-a55b-nvfp4", "nvidia"), "nemotron-3-ultra");
});

test("looseArenaKey strips parameter sizes even with no organization given", () => {
  assert.equal(looseArenaKey("deepseek-v4-671b-a37b", ""), "deepseek-v4");
});

test("looseArenaKey keeps a thinking suffix so Arena rows do not leak across variants", () => {
  assert.equal(looseArenaKey("qwen-qwen3-max-thinking", "qwen"), "qwen3-max-thinking");
});

test("buildTag reads the build date a slug carries", () => {
  assert.equal(buildTag("qwen3-8-max-20260803"), "20260803");
  assert.equal(buildTag("qwen3-8-max-20260902"), "20260902");
  assert.equal(buildTag("devstral-2512"), "2512");
  assert.equal(buildTag("qwen3-8-max"), null);
  assert.equal(buildTag("nemotron-3-ultra-550b"), null);
});

test("nameKeyIsSafe refuses a display name that drops what the id says", () => {
  // The id calls this a moving alias; the name calls it one specific model.
  assert.equal(nameKeyIsSafe("mistral/devstral-latest", "Devstral 2"), false);
  assert.equal(nameKeyIsSafe("qwen/qwen3-max-thinking", "Qwen3 Max"), false);
  // A dated build is covered by the build rule below, not by this one.
  assert.equal(nameKeyIsSafe("mistralai/devstral-2512", "Devstral 2"), false);
  // The name repeats the tier, or the id never claimed one.
  assert.equal(nameKeyIsSafe("qwen/qwen3-max-thinking", "Qwen3 Max (thinking)"), true);
  assert.equal(nameKeyIsSafe("openai/gpt-5", "OpenAI: GPT-5"), true);
});

test("compareBuilds is a total order, so no merge can depend on arrival order", () => {
  const stamps = [null, "2512", "20260803", "20260902"];
  for (const a of stamps) {
    for (const b of stamps) {
      // Sum instead of negation: Math.sign(0) and -Math.sign(0) differ as 0 / -0.
      assert.equal(Math.sign(compareBuilds(a, b)) + Math.sign(compareBuilds(b, a)), 0, `${a} vs ${b} is not antisymmetric`);
      if (a !== b) assert.notEqual(compareBuilds(a, b), 0, `${a} and ${b} were left unordered`);
    }
  }
  assert.ok(compareBuilds(null, "20260902") > 0, "an undated entry outranks a build");
  assert.ok(compareBuilds("20260902", "20260803") > 0, "the later date wins");
  assert.ok(compareBuilds("20260803", "2512") > 0, "the more specific convention wins");
});

test("nameKeyIsSafe refuses a name that drops the id's build stamp", () => {
  // The name path skips build resolution, so a 2512 build reachable as
  // "Devstral Small 2" would answer with whatever build claimed that name.
  assert.equal(nameKeyIsSafe("mistral/labs-devstral-small-2512", "Devstral Small 2"), false);
  assert.equal(nameKeyIsSafe("anthropic/claude-fable-5.1-20260831", "Claude Fable 5.1"), false);
  // The name repeats the stamp, or the id never carried one.
  assert.equal(nameKeyIsSafe("mistral/devstral-small-2512", "Devstral Small 2512"), true);
  assert.equal(nameKeyIsSafe("anthropic/claude-fable-5.1", "Claude Fable 5.1"), true);
});

test("bareModelKey strips every routing segment, and refuses a key too generic to own", () => {
  assert.equal(bareModelKey("qwen/qwen3.8-max-0902"), "qwen3-8-max-0902");
  assert.equal(bareModelKey("edenai/qwen/qwen3.8-max-0902"), "qwen3-8-max-0902");
  assert.equal(bareModelKey("nano-gpt/alibaba/qwen3.8-max-0902"), "qwen3-8-max-0902");
  assert.equal(bareModelKey("fireworks-ai/accounts/fireworks/models/minimax-m3"), "minimax-m3");
  // One token is anybody's; a bare id with no routing segment needs no alias.
  assert.equal(bareModelKey("opper/minimax/m3"), "");
  assert.equal(bareModelKey("gpt-5"), "");
});
