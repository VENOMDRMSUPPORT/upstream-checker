// Provider model discovery, roster ownership and catalog ingestion.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.providerModels = {
  create(deps) {
    'use strict';
    const {
      $, $$, electronAPI, getProviders, getActiveProvider, integratedProviders,
      usableKeys, setStatus, updateTestAllButton, updateStats, renderCostEstimate,
      classifyModel, isMedia, escapeHtml, kindLabels, refreshActivity, wire,
    } = deps;

    function getModels(providerId = getActiveProvider()) {
      return getProviders()[providerId]?.models || [];
    }

    let modelFilter = '';
    function visibleModels() {
      const models = getModels();
      if (!modelFilter) return models;
      return models.filter((m) => m.id.toLowerCase().includes(modelFilter));
    }

    function buildModelItem(m) {
      const id = escapeHtml(m.id);
      const selected = getProviders()[getActiveProvider()]?.selected.has(m.id);
      const gate = m.isFree || !m.isFreeForPaid ? ''
        : m.freeMinBalance != null
          ? ` · needs ${escapeHtml(String(m.freeMinBalance))} balance`
          : ' · needs balance';
      const tip = `${id}${gate}${m.contextLabel ? ` · ${escapeHtml(m.contextLabel)}` : ''}`;
      return `
    <div class="model-item ${selected ? 'selected' : ''}" data-model-id="${id}">
      <div class="model-checkbox"></div>
      <div class="model-info">
        <span class="model-name" title="${tip}">${id}</span>
        ${kindLabels[m.kind] ? `<span class="model-kind">${kindLabels[m.kind]}</span>` : ''}
        ${m.contextLabel ? `<span class="model-context">${m.contextLabel}</span>` : ''}
      </div>
    </div>`;
    }

    function renderModelsList() {
      const container = $('#models-list');
      const countEl = $('#model-count');
      const models = getModels();
      const shown = visibleModels();
      countEl.textContent = shown.length === models.length ? String(models.length) : `${shown.length}/${models.length}`;
      if (!models.length) {
        container.innerHTML = `<div class="models-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
          <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
        </svg><span>No models loaded</span>
        <span class="models-empty-hint">${getProviders()[getActiveProvider()].keys.length ? 'Fetch models to list what this provider offers.' : 'Add an API key, then fetch models.'}</span>
      </div>`;
        updateTestAllButton();
        return;
      }
      if (!shown.length) {
        container.innerHTML = `<div class="models-empty"><span>No model matches "${escapeHtml(modelFilter)}"</span></div>`;
        updateTestAllButton();
        return;
      }
      let html = '';
      if (shown[0].noPlans) html += shown.map(buildModelItem).join('');
      else {
        const free = shown.filter((m) => m.isFree);
        const freeForPaid = shown.filter((m) => m.isFreeForPaid);
        if (free.length) html += `<div class="model-group-label">FREE (${free.length})</div>${free.map(buildModelItem).join('')}`;
        if (freeForPaid.length) html += `<div class="model-group-label">FREE FOR PAID (${freeForPaid.length})</div>${freeForPaid.map(buildModelItem).join('')}`;
        // A roster with no free row at all (a fully quota-based provider, e.g.
        // Apinex on a subscription key) would otherwise render an empty list
        // while the count badge still read the full roster.
        if (!free.length && !freeForPaid.length) html += shown.map(buildModelItem).join('');
      }
      container.innerHTML = html;
      $$('.model-item').forEach((item) => item.addEventListener('click', () => toggleModelSelection(item.dataset.modelId, item)));
      updateTestAllButton();
      updateStats();
      renderCostEstimate();
    }

    function toggleModelSelection(id, item) {
      const selected = getProviders()[getActiveProvider()].selected;
      if (selected.has(id)) { selected.delete(id); item.classList.remove('selected'); }
      else { selected.add(id); item.classList.add('selected'); }
      updateTestAllButton();
      updateStats();
    }

    function setSelectionForVisible(on) {
      const selected = getProviders()[getActiveProvider()].selected;
      visibleModels().forEach((m) => (on ? selected.add(m.id) : selected.delete(m.id)));
      renderModelsList();
    }

    function getSelectedModels() {
      const selected = getProviders()[getActiveProvider()]?.selected;
      if (!selected) return [];
      return getModels().filter((m) => selected.has(m.id));
    }

    $('#models-search').addEventListener('input', (e) => {
      modelFilter = e.target.value.trim().toLowerCase();
      renderModelsList();
    });
    $('#btn-select-all').addEventListener('click', () => setSelectionForVisible(true));
    $('#btn-select-none').addEventListener('click', () => setSelectionForVisible(false));

    function getFreeGroupName(code) {
      if (code === 'free') return 'FREE';
      if (code === 'freemium' || code === 'freemium-max') return 'FREE FOR PAID';
      return code;
    }

    function taggedApiRequest(source, p) {
      const pricingPages = [p && p.pricingUrl, p && p.plansUrl].filter(Boolean);
      return (opts) => electronAPI.apiRequest({
        ...opts,
        source: pricingPages.some((u) => String(opts.url || '').startsWith(u)) ? 'pricing' : source,
      });
    }

    function readContextWindow(m) {
      return m.context_window ?? m.context_length ?? m.max_context_tokens ?? m.max_context_length
        ?? m.top_provider?.context_length ?? m.limit?.context ?? null;
    }

    function readsVision(m) {
      if (m.vision != null) return !!m.vision;
      if (m.supports_vision != null) return !!m.supports_vision;
      const modality = m.architecture?.input_modalities ?? m.architecture?.modality;
      if (Array.isArray(modality)) return modality.includes('image');
      if (typeof modality === 'string') return modality.includes('image');
      return Array.isArray(m.capabilities) && m.capabilities.includes('vision');
    }

    function readsReasoning(m) {
      if (m.reasoning != null) return !!m.reasoning;
      if (m.supports_reasoning != null) return !!m.supports_reasoning;
      return Array.isArray(m.capabilities) && m.capabilities.includes('reasoning');
    }

    function formatContext(ctx) {
      if (!ctx) return '';
      if (ctx >= 1000000) return `${Math.round(ctx / 1000000)}M`;
      if (ctx >= 1000) return `${Math.round(ctx / 1000)}K`;
      return String(ctx);
    }

    async function discoverModels(p, apiKey) {
      const adapter = integratedProviders()[p.id];
      if (adapter && adapter.fetchModels) {
        return adapter.fetchModels({
          apiKey, baseUrl: p.baseUrl, plansUrl: p.plansUrl, pricingUrl: p.pricingUrl,
          apiRequest: taggedApiRequest('discovery', p), formatContext, getFreeGroupName,
          // A provider that does not speak OpenAI builds its own request
          // through the app's wire.
          wire,
        });
      }
      const response = await electronAPI.apiRequest({
        url: `${p.baseUrl}/models`, method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        source: 'discovery',
      });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      return (JSON.parse(response.body).data || []).map((m) => {
        const ctx = readContextWindow(m);
        return {
          ...m, isFree: false, isFreeForPaid: false, noPlans: true, groupName: 'MODELS',
          hasVision: readsVision(m), hasReasoning: readsReasoning(m),
          context_window: ctx, contextLabel: formatContext(ctx),
        };
      }).sort((a, b) => a.id.localeCompare(b.id));
    }

    async function ingestProviderRoster(providerId = getActiveProvider()) {
      const p = getProviders()[providerId];
      if (!p) throw new Error('No provider selected');
      const reply = await electronAPI.catalogIngest(p.id, p.models || []);
      if (reply && reply.ok === false) throw new Error(catalogIngestFailure(reply));
      if (reply && reply.rows && reply.rows.length) {
        const moved = (reply.changes && reply.changes.moved) || { appeared: 0, disappeared: 0 };
        const bits = [];
        if (moved.appeared) bits.push(`${moved.appeared} new`);
        if (moved.disappeared) bits.push(`${moved.disappeared} removed`);
        const scored = reply.rows.filter((r) => r.score != null).length;
        const detail = bits.length ? ` — ${bits.join(' · ')}` : '';
        setStatus('done', `Catalog updated: ${reply.rows.length} models, ${scored} scored${detail}`);
        if (reply.warning) setStatus('warn', reply.warning);
      }
      refreshActivity();
      return reply;
    }

    const INGEST_CODES = {
      INVALID_PROVIDER_PAYLOAD: 'The provider answered with a model list this app cannot read, so nothing was changed.',
      NOT_FOUND: 'That provider is no longer in the database, so nothing was fetched.',
      SUSPICIOUS_PROVIDER_DROP: 'The model count dropped sharply and is being held until it repeats — the last good list is still shown.',
      SYNC_IN_PROGRESS: 'That provider is already being re-read; try again in a moment.',
    };
    function catalogIngestFailure(reply) {
      return INGEST_CODES[reply.code]
        || `The catalog refused this roster (${reply.code || 'no code given'})${reply.message ? `: ${reply.message}` : ''}`;
    }

    function tagAliasGroups(list) {
      const bare = (id) => String(id).split('/').pop().toLowerCase();
      const counts = new Map();
      list.forEach((m) => counts.set(bare(m.id), (counts.get(bare(m.id)) || 0) + 1));
      list.forEach((m) => {
        const id = bare(m.id);
        if (counts.get(id) > 1) { m.aliasGroup = id; m.aliasCount = counts.get(id); }
      });
      return list;
    }

    function dedupeById(list) {
      const seen = new Set();
      return list.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
    }

    async function fetchModels() {
      const providerId = getActiveProvider();
      const p = getProviders()[providerId];
      const activeKeys = usableKeys(p);
      if (!activeKeys.length) {
        setStatus('error', 'No active API keys. Add and activate a key first.');
        return;
      }
      const btn = $('#btn-fetch-models');
      const originalText = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Fetching...';
      setStatus('running', `Fetching models from ${activeKeys.length} key${activeKeys.length === 1 ? '' : 's'}...`);
      const byId = new Map();
      const failures = [];
      for (const k of activeKeys) {
        try {
          const list = await discoverModels(p, k.key);
          list.forEach((m) => {
            const existing = byId.get(m.id);
            if (existing) {
              if (!existing.keyIds.includes(k.id)) existing.keyIds.push(k.id);
            } else byId.set(m.id, { ...m, keyIds: [k.id] });
          });
        } catch (err) { failures.push(`${k.name}: ${err.message || 'failed'}`); }
      }
      try {
        if (!byId.size) throw new Error(failures[0] || 'No models returned');
        let models = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
        models = tagAliasGroups(dedupeById(models));
        const adapter = integratedProviders()[p.id];
        if (adapter && typeof adapter.excludeModel === 'function') models = models.filter((m) => !adapter.excludeModel(m));
        models.forEach((m) => { m.kind = classifyModel(p.id, m); });
        p.models = models;
        p.selected = new Set(models.filter((m) => !isMedia(m)).map((m) => m.id));
        renderModelsList();
        let catalogNote = '';
        try { await ingestProviderRoster(providerId); catalogNote = ' · catalog updated'; }
        catch (err) { catalogNote = ` · catalog not updated: ${err.message}`; }
        const keyNote = activeKeys.length > 1 ? ` across ${activeKeys.length} keys` : '';
        if (p.plansUrl) {
          const free = models.filter((m) => m.isFree).length;
          const freeForPaid = models.filter((m) => m.isFreeForPaid).length;
          setStatus('done', `Fetched ${models.length} models${keyNote} (${free} free + ${freeForPaid} free for paid)${catalogNote}`);
        } else if (failures.length) setStatus('error', `Fetched ${models.length} models${keyNote} — ${failures.join('; ')}${catalogNote}`);
        else setStatus('done', `Fetched ${models.length} models${keyNote}${catalogNote}`);
        updateStats();
      } catch (err) {
        setStatus('error', err.message || 'Failed to fetch models');
        console.error(err);
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
    }

    $('#btn-fetch-models').addEventListener('click', fetchModels);
    return {
      getModels, fetchModels, ingestProviderRoster, discoverModels, taggedApiRequest,
      tagAliasGroups, dedupeById, formatContext, getFreeGroupName,
      readContextWindow, readsVision, readsReasoning,
      renderModelsList, getSelectedModels,
      setSearch: (value) => { modelFilter = ''; const search = $('#models-search'); if (search) search.value = value; },
    };
  },
};
