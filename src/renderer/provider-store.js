// Runtime provider data and its persistence boundary.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.providerStore = {
  create(deps) {
    'use strict';
    const {
      builtinProviders, electronAPI, persist, quotaSpentExpired,
      getCurrentPage, renderProvidersPage, onProvidersChanged,
    } = deps;
    const providers = {};

    function makeRuntimeProvider(def) {
      // Keep model picks on the provider so re-renders do not reset them.
      return { models: [], planModels: {}, keys: [], selected: new Set(), ...structuredClone(def) };
    }

    function providerPayload(id) {
      const p = providers[id];
      if (!p) return null;
      return {
        id,
        name: p.name,
        baseUrl: p.baseUrl,
        rpm: p.rpm ?? null,
        keys: p.keys.map((k) => ({ id: k.id, name: k.name, key: k.key || '', active: k.active !== false, quotaSpent: k.quotaSpent || null })),
      };
    }

    function adoptSavedKeys(p, saved) {
      const fresh = new Map(saved.keys.map((k) => [k.id, k]));
      p.keys.forEach((k) => {
        const s = fresh.get(k.id);
        if (!s) return;
        k.key = s.key;
        k.hint = s.hint;
        k.locked = s.locked;
        // A signed-in account keeps its own fields: the placeholder of its
        // access token and the account's public facts.
        if (Object.hasOwn(s, 'oauth')) k.oauth = s.oauth;
        if (Object.hasOwn(s, 'oauthKey')) k.oauthKey = s.oauthKey;
        if (Object.hasOwn(s, 'account')) k.account = s.account;
        // Preserve live refusal state unless the save explicitly returned one.
        if (Object.hasOwn(s, 'quotaSpent')) k.quotaSpent = s.quotaSpent || null;
      });
    }

    async function save(providerId) {
      const p = providers[providerId];
      if (!p) return false;
      const saved = await persist(`save ${p.name}`, () => electronAPI.saveProvider(providerPayload(providerId)));
      if (saved) adoptSavedKeys(p, saved);
      // Any key or base URL edit invalidates discovery's verdict for this provider.
      if (window.CATALOG) window.CATALOG.syncAll({ reason: 'manual', providerId });
      if (getCurrentPage() === 'providers') renderProvidersPage();
      onProvidersChanged(providerId);
      return !!saved;
    }

    async function loadAll() {
      let stored = {};
      let readError = null;
      try {
        stored = (await electronAPI.readConfig()).providers || {};
      } catch (err) {
        readError = err;
      }
      const norm = (u) => (u || '').trim().replace(/\/+$/, '').toLowerCase();
      Object.keys(providers).forEach((id) => delete providers[id]);

      // Built-ins are code templates overlaid by saved values; the store wins.
      const missing = [];
      Object.values(builtinProviders).forEach((def) => {
        const p = makeRuntimeProvider(def);
        const s = stored[def.id];
        if (s) {
          if (s.name) p.name = s.name;
          if (s.baseUrl) p.baseUrl = s.baseUrl;
          if (s.rpm != null) p.rpm = s.rpm;
          p.keys = s.keys || [];
        } else {
          missing.push(def.id);
        }
        providers[def.id] = p;
      });

      // Expired quota refusals are renderer state with a TTL; clean them up on load.
      Object.values(providers).forEach((p) => {
        (p.keys || []).forEach((k) => {
          if (k && k.quotaSpent && quotaSpentExpired(k.quotaSpent)) {
            delete k.quotaSpent;
            electronAPI.saveProvider(providerPayload(p.id)).then(
              (saved) => { if (saved) adoptSavedKeys(p, saved); },
            ).catch(() => {});
          }
        });
      });

      // A failed read must not seed, merge, or delete anything.
      if (readError) throw readError;

      for (const id of missing) {
        await persist(`add ${providers[id].name}`, () => electronAPI.saveProvider(providerPayload(id)));
      }

      // Retire legacy custom providers only when safe; never discard saved keys.
      for (const [id, s] of Object.entries(stored)) {
        if (!s.custom || providers[id]) continue;
        const builtin = Object.values(providers).find((p) => !p.custom && norm(p.baseUrl) === norm(s.baseUrl));
        if (builtin) {
          const merged = await persist(`merge ${s.name || id} into ${builtin.name}`, () => electronAPI.mergeProvider(id, builtin.id));
          if (merged) builtin.keys = merged.keys;
        } else if (!(s.keys || []).length) {
          await persist(`remove ${s.name || id}`, () => electronAPI.deleteProvider(id));
        } else {
          console.warn(`Custom provider "${s.name || id}" still holds keys; kept in the store, not loaded.`);
        }
      }
    }

    return { providers, makeRuntimeProvider, providerPayload, adoptSavedKeys, save, loadAll };
  },
};
