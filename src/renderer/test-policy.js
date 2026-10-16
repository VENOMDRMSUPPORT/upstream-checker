// Key eligibility, quota state and per-key pacing. Maps belong to each instance.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.policy = {
  create(deps) {
    'use strict';
    const { getProviders, getActiveProvider, isAborted, getRunStatus, usableKeys,
      saveProviderConfig, refreshAfterKeyChange, setStatus, sleep, getAdapter = () => null } = deps;
    // 429 is handled by the rate-limit path below, not here: it isn't a transient
    // glitch to back off from, it's the provider telling us to wait out its window.

    // Hitting a per-minute cap is not a property of the model — it's a property of
    // how fast we were going. Waiting the window out and continuing gives the model
    // a real verdict instead of recording our own pacing as its failure.
    const RATE_LIMIT_WAIT_MS = 60000; // a full window, when the provider doesn't say
    const RATE_LIMIT_PATTERN =
      /rate.?limit|too many requests|per[- ]minute|requests? per (minute|min)|\brpm\b|concurrency limit/i;


    // Checked before the rate limit, because a provider will happily return 429 for
    // a billing problem: NaraRouter answers "Insufficient credits. Please top up your
    // balance" with a 429, and treating that as throttling means waiting out three
    // full windows for something no amount of waiting fixes.
    function isRateLimit(r) {
      if (isEntitlementDenial(r)) return false;
      if (r.statusCode === 429) return true;
      return typeof r.response === 'string' && RATE_LIMIT_PATTERN.test(r.response);
    }

    // A key can be refused a model it simply isn't entitled to — an unfunded account
    // asked for a paid-tier model, a plan that doesn't include it. That is a fact
    // about the key, not about the model, and it is permanent until the account
    // changes, so unlike a rate limit there is nothing to wait for.
    // Matched on the message, not the status code. Real examples this has to catch:
    //   403 "Your plan does not include the requested model."
    //   429 "Insufficient credits. Please top up your balance and try again..."
    // The status is unreliable — the second is a billing problem wearing a rate
    // limit's code — so the wording is what decides.
    const ENTITLEMENT_PATTERN = new RegExp(
      [
        'insufficient',
        'top[\s-]?up',
        'no credit|out of credit|credits? remaining',
        'plan does not includ|not includ(?:e|ed) (?:in|on) your',
        'not (?:entitled|available on) your',
        'not granted',
        'upgrade your|requires? a paid|paid plan',
        'payment required|billing',
        'quota exceeded|subscribe',
      ].join('|'),
      'i'
    );

    function isEntitlementDenial(r) {
      if (r.statusCode === 402) return true;
      return typeof r.response === 'string' && ENTITLEMENT_PATTERN.test(r.response);
    }

    // "keyId::modelId" pairs the provider has refused this session. Discovery can't
    // always tell what a key is entitled to — NaraRouter's catalogue comes from
    // public pricing endpoints that never see a key, so every key looks like it can
    // reach everything — so entitlement is learned the only way it can be: by being
    // told no, once, and not asking that key again.
    const deniedPairs = new Set();
    const denialKey = (keyId, modelId) => `${keyId}::${modelId}`;

    // A key whose allowance is used up — a free tier's weekly allowance, a prepaid
    // quota. A models-endpoint check can't see it (it keeps answering 200), so it
    // is learned from the provider's error — the module's readQuotaError, else the
    // standard codes below — and kept on the key as `quotaSpent` (so it survives a
    // restart) until the reset time the error named.
    //
    // It is recorded per model, not for the whole key: one key can draw on more
    // than one allowance. Token Harbor's free models share the free-tier allowance,
    // but a campaign model carries its own, so with the free tier spent
    // qwen3.8-flash:free still answers 200. `quotaSpent.models` lists the models
    // that were refused; only those sit the key out, every other model is still
    // tried on it (once), and one that is refused joins the list.
    const QUOTA_ERROR_CODES = new Set(['insufficient_quota', 'quota_exceeded']);

    function readQuotaError(provider, r) {
      const adapter = getAdapter(provider.id);
      const info = { status: r.statusCode, code: r.errorCode, message: r.response };
      const own = adapter && adapter.readQuotaError ? adapter.readQuotaError(info) : null;
      if (own) return own;
      return QUOTA_ERROR_CODES.has(r.errorCode) ? { until: null, message: r.response } : null;
    }

    // A refusal that named no reset time is one model's answer on one day, not a
    // fact about the key. Without an expiry it would sit on the key forever —
    // Dark API's generic path (readQuotaError) never sets `until`, so a single
    // exhausted route would read as a dead key for every restart after it.
    const QUOTA_SPENT_TTL_MS = 24 * 60 * 60 * 1000;

    function quotaSpentExpired(s) {
      return !s.until && s.at != null && Date.now() - s.at > QUOTA_SPENT_TTL_MS;
    }

    // The key has a spent allowance that has not reset yet (for some models).
    function isKeySpent(k) {
      const s = k && k.quotaSpent;
      if (!s || quotaSpentExpired(s)) return false;
      return !s.until || s.until > Date.now();
    }

    // The whole key is spent: no model list, so every model sits it out.
    function isKeyFullySpent(k) {
      return isKeySpent(k) && !(Array.isArray(k.quotaSpent.models) && k.quotaSpent.models.length > 0);
    }

    // Only the listed models were refused; the key still serves everything else.
    // This is what the run already does (keysFor filters just these out) — the
    // badge used to claim otherwise.
    function isKeyPartiallySpent(k) {
      return isKeySpent(k) && !isKeyFullySpent(k);
    }

    // The key was refused this model for a spent allowance, and it hasn't reset.
    function isKeySpentFor(k, modelId) {
      return isKeySpent(k) && Array.isArray(k.quotaSpent.models) && k.quotaSpent.models.includes(modelId);
    }

    // "5h 12m", "2d 3h", "40m" — time left until a future moment.
    function formatIn(ts) {
      const m = Math.max(1, Math.round((ts - Date.now()) / 60000));
      if (m < 60) return `${m}m`;
      const h = Math.floor(m / 60);
      if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
      const d = Math.floor(h / 24);
      return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
    }

    function spentHint(k) {
      const s = k.quotaSpent;
      const reset = s.until ? `resets ${new Date(s.until).toLocaleString()} (in ${formatIn(s.until)})` : 'no reset time given (cleared after 24h)';
      const models = Array.isArray(s.models) && s.models.length ? s.models : null;
      return models
        ? `Quota used up for ${models.length} model${models.length === 1 ? '' : 's'} — ${reset}. Those are skipped on this key until then; other models are still tried.\n\n${models.join('\n')}`
        : `Quota used up — ${reset}.`;
    }

    // Records that the key was refused `modelId` for a spent allowance. Models
    // refused earlier in the same period stay listed.
    async function markKeySpent(pid, kid, quota, modelId) {
      const k = getProviders()[pid] && getProviders()[pid].keys.find((x) => x.id === kid);
      if (!k) return;
      const models = isKeySpent(k) && Array.isArray(k.quotaSpent.models) ? [...k.quotaSpent.models] : [];
      if (modelId && !models.includes(modelId)) models.push(modelId);
      k.quotaSpent = { until: quota.until || null, status: quota.status || null, message: quota.message || '', at: Date.now(), models };
      await saveProviderConfig(pid);
      refreshAfterKeyChange(pid);
    }

    async function clearKeySpent(pid, kid) {
      const k = getProviders()[pid] && getProviders()[pid].keys.find((x) => x.id === kid);
      if (!k || !k.quotaSpent) return;
      delete k.quotaSpent;
      await saveProviderConfig(pid);
      refreshAfterKeyChange(pid);
    }

    // ============================================
    // Keys and pacing
    // ============================================
    // The per-minute cap belongs to the key, not to the app: it is a property of the
    // plan that key is on. Both the budget and the cooldown are therefore tracked per
    // key, which is also what makes a second key worth having — the run moves onto it
    // instead of sitting out a whole minute.
    const keyCooldownUntil = new Map(); // keyId -> timestamp
    const keyRequestTimes = new Map();  // keyId -> recent request timestamps
    let keyCursor = 0;

    function keyNameById(keyId) {
      const p = getProviders()[getActiveProvider()];
      const k = p && p.keys.find((x) => x.id === keyId);
      return k ? k.name : '';
    }

    function rpmOf(provider) {
      const n = Number(provider.rpm);
      return Number.isFinite(n) && n > 0 ? n : 0; // 0 = unknown, so don't pace
    }

    // The keys that can actually serve this model. Discovery records which keys
    // returned each model, so a provider whose keys unlock different catalogues gets
    // each request sent to a key that has the model — otherwise a working model is
    // recorded as broken because the wrong key was used to ask for it.
    function keysFor(provider, model) {
      let keys = usableKeys(provider);
      if (model && Array.isArray(model.keyIds) && model.keyIds.length > 0) {
        const listed = keys.filter((k) => model.keyIds.includes(k.id));
        if (listed.length > 0) keys = listed;
      }
      if (!model) return keys;
      // A key already refused this model for a spent quota sits out while another
      // can serve it. When every key is, the full list comes back and testModel
      // reports that.
      const unspent = keys.filter((k) => !isKeySpentFor(k, model.id));
      if (unspent.length > 0) keys = unspent;
      const permitted = keys.filter((k) => !deniedPairs.has(denialKey(k.id, model.id)));
      // If every key has been refused, hand back the full list so the caller still
      // gets a real error to report rather than "no key available".
      return permitted.length > 0 ? permitted : keys;
    }

    function slotsUsed(keyId, now) {
      return (keyRequestTimes.get(keyId) || []).filter((t) => now - t < 60000).length;
    }

    // The configured RPM is a starting guess — it comes from a provider's published
    // figure, and a particular key's plan may allow less. Being refused is the only
    // reliable measurement of what a key is really permitted, so a refusal narrows
    // the budget for that key to below what it had just spent.
    const learnedRpm = new Map(); // keyId -> the ceiling this key actually enforces

    function budgetFor(provider, keyId) {
      const configured = rpmOf(provider);
      const learned = learnedRpm.get(keyId);
      if (!configured) return learned || 0;
      return learned ? Math.min(configured, learned) : configured;
    }

    // Called when the provider says the per-minute limit was reached. Whatever we
    // managed to send in the preceding minute was over the line, so the new ceiling
    // sits below it — and never below one, or the key would be unusable.
    function learnRateLimit(keyId) {
      const sent = slotsUsed(keyId, Date.now());
      const next = Math.max(1, Math.floor((sent || 1) * 0.75));
      const prev = learnedRpm.get(keyId);
      if (!prev || next < prev) {
        learnedRpm.set(keyId, next);
        console.info(`Rate limit learned for key ${keyId}: ${next}/min (was sending ${sent})`);
      }
    }

    // Whether any key that can serve this model has a free slot in its per-minute
    // budget right now. Shared by the hedge escalator and the empty-recovery race:
    // neither should fire a parallel attempt into a cap every key is already at,
    // spending a slot the models still waiting need.
    function hasFreeKeyBudget(provider, model) {
      return keysFor(provider, model).some((k) => {
        const budget = budgetFor(provider, k.id);
        return !budget || slotsUsed(k.id, Date.now()) < budget;
      });
    }

    // Round-robin over the eligible keys, but a key with a free slot in its own
    // minute beats one that is merely not cooling off. Without that preference the
    // rotation would stop on a key that has spent its budget and wait there while a
    // second key sat idle — which is the whole reason a second key is worth having.
    function pickKey(provider, model) {  const keys = keysFor(provider, model);
      if (keys.length === 0) return null;
      const now = Date.now();

      let free = null;  // usable right now
      let ready = null; // not cooling, but at its per-minute cap

      for (let i = 0; i < keys.length; i++) {
        const k = keys[(keyCursor + i) % keys.length];
        if ((keyCooldownUntil.get(k.id) || 0) > now) continue;
        const budget = budgetFor(provider, k.id);
        if (!budget || slotsUsed(k.id, now) < budget) { free = k; break; }
        if (!ready) ready = k;
      }

      const chosen = free || ready;
      if (chosen) keyCursor = (keys.indexOf(chosen) + 1) % keys.length;
      return chosen;
    }

    function soonestKeyAvailable(provider, model) {
      const keys = keysFor(provider, model);
      if (keys.length === 0) return Infinity;
      return Math.min(...keys.map((k) => keyCooldownUntil.get(k.id) || 0));
    }

    // Holds a request back until its key has a slot in its own minute. Staying under
    // the cap costs a few seconds; going over it costs a full window — so pacing is
    // strictly cheaper than recovering from a 429.
    async function waitForSlot(provider, key) {
      const rpm = budgetFor(provider, key.id);
      if (!rpm) return;
      while (!isAborted()) {
        const now = Date.now();
        const recent = (keyRequestTimes.get(key.id) || []).filter((t) => now - t < 60000);
        if (recent.length < rpm) {
          recent.push(now);
          keyRequestTimes.set(key.id, recent);
          return;
        }
        const waitMs = 60000 - (now - recent[0]) + 100;
        keyRequestTimes.set(key.id, recent);
        setStatus('running', `Pacing ${provider.name} — next slot in ${Math.ceil(waitMs / 1000)}s`);
        await sleep(Math.min(1000, waitMs));
      }
    }

    // Every key is cooling off; wait for whichever frees up first.
    async function waitForAnyKey(provider, model) {
      let waited = false;
      while (!isAborted()) {
        const remaining = soonestKeyAvailable(provider, model) - Date.now();
        if (remaining <= 0 || !Number.isFinite(remaining)) break;
        waited = true;
        setStatus('running', `Rate limited — resuming in ${Math.ceil(remaining / 1000)}s`);
        await sleep(Math.min(1000, remaining));
      }
      if (waited && !isAborted()) setStatus('running', getRunStatus());
    }

    function coolKeyDown(keyId, result) {
      const ms = result.retryAfter > 0 ? result.retryAfter * 1000 : RATE_LIMIT_WAIT_MS;
      keyCooldownUntil.set(keyId, Math.max(keyCooldownUntil.get(keyId) || 0, Date.now() + ms));
    }


    function resetRun(reset) {
      keyCooldownUntil.clear();
      if (reset) { learnedRpm.clear(); deniedPairs.clear(); }
    }
    function cooldownUntil(keyId) { return keyCooldownUntil.get(keyId) || 0; }
    function deny(keyId, modelId) { deniedPairs.add(denialKey(keyId, modelId)); }
    function isDenied(keyId, modelId) { return deniedPairs.has(denialKey(keyId, modelId)); }
    return {
      isRateLimit, isEntitlementDenial, readQuotaError, QUOTA_SPENT_TTL_MS, quotaSpentExpired,
      isKeySpent, isKeyFullySpent, isKeyPartiallySpent, isKeySpentFor, formatIn, spentHint,
      markKeySpent, clearKeySpent, keyNameById, rpmOf, keysFor, slotsUsed, budgetFor,
      learnRateLimit, hasFreeKeyBudget, pickKey, soonestKeyAvailable, waitForSlot, waitForAnyKey,
      coolKeyDown, resetRun, cooldownUntil, deny, isDenied,
    };
  },
};
