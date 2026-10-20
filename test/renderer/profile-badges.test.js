// Profile badges: the pure classifier behind the fixed model color identity.
// No DOM, no bridge for classification; warm() alone touches the bridge.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererModules } = require('./module-loader');

function load(bridge) {
  const win = { electronAPI: bridge || {} };
  loadRendererModules(['profile-badges'], { window: win, document: {} });
  return win.PROFILE_BADGES;
}

const PROFILES = {
  lite: { eligible: [{ providerId: 'groq', modelId: 'flash', upstreamId: 'groq::flash' }] },
  pro: { eligible: [{ providerId: 'anthropic', modelId: 'sonnet', upstreamId: 'anthropic::sonnet' }] },
  max: { eligible: [{ providerId: 'openai', modelId: 'giant', upstreamId: 'openai::giant' }] },
};

test('classification hits provider/model, bare id and upstream id, case-insensitively', () => {
  const badges = load();
  const index = badges.indexProfiles(PROFILES);
  assert.equal(badges.classify(['groq/flash'], index), 'lite');
  assert.equal(badges.classify(['SONNET'], index), 'pro');
  assert.equal(badges.classify(['openai::giant'], index), 'max');
  assert.equal(badges.classify(['unknown/model'], index), null);
});

test('badge markup wears the fixed profile tone and nothing else', () => {
  const badges = load();
  assert.match(badges.badgeHTML('lite'), /vp-badge--lite/);
  assert.match(badges.badgeHTML('pro'), /vp-badge--pro/);
  assert.match(badges.badgeHTML('max'), /vp-badge--max/);
  assert.equal(badges.badgeHTML(null), '');
  assert.equal(badges.badgeHTML('unknown'), '');
});

test('badgeFor stays empty until warm resolves, then classifies without the bridge', async () => {
  const badges = load({ routerProfiles: async () => ({ ok: true, profiles: PROFILES }) });
  assert.equal(badges.badgeFor('groq', 'flash'), '');
  await badges.warm();
  assert.match(badges.badgeFor('groq', 'flash'), /vp-badge--lite/);
  assert.match(badges.badgeFor('anthropic', 'sonnet'), /vp-badge--pro/);
  assert.equal(badges.badgeFor('nobody', 'nothing'), '');
});

test('a missing bridge warms to empty instead of throwing', async () => {
  const badges = load(null);
  assert.equal(await badges.warm(), null);
  assert.equal(badges.badgeFor('groq', 'flash'), '');
});
