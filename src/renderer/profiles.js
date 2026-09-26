// ============================================
// Venom profiles — three exits in front of the whole catalogue
// ============================================
// venom-lite, venom-pro and venom-max are virtual models. Each has a policy:
// hard requirements a model must meet to serve it, and weights that order the
// models that do. The engine below reads only facts the catalogue measured on
// the user's own providers — never a leaderboard number — and turns them into
// a ranked, weighted roster per profile, with a reason for every exclusion.
//
// Design rules, each the fix for a way routers commonly go wrong:
//   - quality is measured here, not copied from a public board;
//   - every profile has an intelligence floor, so "cheapest" never means dumb;
//   - eligibility is about capability and evidence, never about billing tier;
//   - a model with one run is a candidate, not a fact — confidence is explicit;
//   - the same model on several providers is one family with several sources,
//     and a source without its own benchmark inherits the family's intelligence;
//   - traffic is spread across the top sources with a cap per provider, so no
//     single upstream takes everything and rate limits stay out of the way.
//
// Loaded after catalog.js.

(function () {
  'use strict';

  const B = window.BENCHMARK;
  const C = window.CATALOG;

  const PROFILE_IDS = ['lite', 'pro', 'max'];

  const DEFAULT_POLICY = {
    version: 1,
    // Evidence a source needs before it carries traffic. Below this it is a
    // candidate: ranked and shown, but given no share.
    minRuns: 1,          // own benchmark runs (inherited intelligence counts as 0)
    minVerdicts: 5,      // request verdicts in the reliability window
    // Circuit breaker: this many failures in a row, and the source rests.
    cooldownStreak: 3,
    cooldownMinutes: 10,
    // Distribution.
    topN: 5,
    maxProviderShare: 0.5,
    sharpness: 3,        // share ∝ score^sharpness; higher = more winner-takes-most
    priceRef: 15,        // $/1M blended at which the cost component reaches 0
    profiles: {
      lite: {
        label: 'Venom Lite', tag: 'Fast · cheap · good enough',
        desc: 'Simple, frequent, latency-sensitive requests: chat, autocomplete, classification, short answers.',
        minIQ: 40, maxTtftMs: 1000, minTps: 60, minReliability: 0.95, minContext: 32000, maxPrice: 1.0,
        requireTools: false, requireJson: false, requireLong: false, preferFree: true,
        weights: { iq: 0.10, speed: 0.45, reliability: 0.25, cost: 0.20 },
      },
      pro: {
        label: 'Venom Pro', tag: 'Balanced',
        desc: 'Everyday professional work where quality and speed both matter: coding help, analysis, agents with tools.',
        minIQ: 65, maxTtftMs: 3000, minTps: 30, minReliability: 0.97, minContext: 128000, maxPrice: null,
        requireTools: true, requireJson: false, requireLong: false, preferFree: false,
        weights: { iq: 0.40, speed: 0.25, reliability: 0.25, cost: 0.10 },
      },
      max: {
        label: 'Venom Max', tag: 'Best available',
        desc: 'Complex, multi-step work where the strongest verified model wins regardless of price.',
        minIQ: 85, maxTtftMs: 8000, minTps: 0, minReliability: 0.97, minContext: 200000, maxPrice: null,
        requireTools: false, requireJson: false, requireLong: true, preferFree: false,
        weights: { iq: 0.75, speed: 0.05, reliability: 0.20, cost: 0 },
      },
    },
  };

  const state = { policy: null, result: null, expanded: new Set(), showExcluded: {}, editing: {}, shell: false };

  // ---- policy persistence --------------------------------------------------

  function policy() {
    if (state.policy) return state.policy;
    const saved = C.state.data && C.state.data.profiles && C.state.data.profiles.policy;
    state.policy = mergePolicy(DEFAULT_POLICY, saved);
    return state.policy;
  }

  function mergePolicy(base, over) {
    const out = JSON.parse(JSON.stringify(base));
    if (!over || typeof over !== 'object') return out;
    Object.keys(out).forEach((k) => {
      if (k === 'profiles') return;
      if (typeof over[k] === typeof out[k]) out[k] = over[k];
    });
    PROFILE_IDS.forEach((id) => {
      const o = over.profiles && over.profiles[id];
      if (!o) return;
      Object.keys(out.profiles[id]).forEach((k) => {
        if (k === 'weights') return;
        const def = out.profiles[id][k];
        // Nullable numbers (maxPrice) default to null, so a saved number must
        // be accepted even though typeof null is 'object'.
        if (o[k] === null || typeof o[k] === typeof def || (def == null && typeof o[k] === 'number')) out.profiles[id][k] = o[k];
      });
      if (o.weights) Object.keys(out.profiles[id].weights).forEach((w) => { if (typeof o.weights[w] === 'number') out.profiles[id].weights[w] = o.weights[w]; });
    });
    return out;
  }

  function savePolicy() {
    if (!C.state.data) return;
    C.state.data.profiles = { ...(C.state.data.profiles || {}), policy: state.policy };
    C.save();
    state.result = null;
  }

  function resetPolicy() {
    state.policy = JSON.parse(JSON.stringify(DEFAULT_POLICY));
    savePolicy();
  }

  // ---- facts ---------------------------------------------------------------

  function blendedPrice(e) {
    if (!e.pricing) return null;
    return Math.round(((e.pricing.input * 3 + e.pricing.output) / 4) * 1000) / 1000;
  }

  // Everything the policy reads about one source, computed once per run.
  function factsOf(e, familyIQ) {
    const b = e.bench && e.bench.composite != null ? e.bench : null;
    const ownIQ = b ? b.quality : null;
    const iq = ownIQ != null ? ownIQ : familyIQ != null ? familyIQ.iq : null;
    const rel = C.reliability(e);
    const stab = C.stability(e);
    const c = e.caps || null;
    return {
      key: e.key, id: e.id, name: e.name || e.id, providerId: e.providerId, provider: PROVIDERS[e.providerId]?.name || e.providerId,
      family: C.familyKey(e),
      iq, ownIQ, inheritedFrom: ownIQ == null && familyIQ ? familyIQ.from : null,
      tier: iq == null ? null : B.tierOf(iq).id,
      ttftMs: b ? b.ttftMs : null,
      tps: b ? b.tps : null,
      latencyMs: b ? b.latencyMs : null,
      speedScore: b ? b.speed : null,
      reliability: rel.rate, verdicts: rel.n, streak: rel.streak, lastFail: rel.lastFail,
      runs: (e.history || []).filter((h) => h.composite != null).length,
      spread: stab.spread,
      context: e.contextWindow || null,
      tools: c ? c.tools.supported : (e.declaresTools === true ? true : null),
      json: c ? c.json.supported : null,
      longContext: c ? c.longContext.supported : null,
      longLatencyMs: c ? c.longLatencyMs : null,
      price: blendedPrice(e), isFree: !!e.isFree, pricing: e.pricing,
      hasVision: !!e.hasVision, hasReasoning: !!e.hasReasoning, kind: e.kind || 'chat',
      benchAt: b ? b.at : null, suite: b ? b.suite : null,
    };
  }

  // Intelligence is a property of the model, not of the gateway. Sources of
  // the same family that were benchmarked lend their median to the ones that
  // were not, marked as inherited so the roster can say so.
  function familyIntelligence(entries) {
    const byFam = new Map();
    entries.forEach((e) => {
      if (!(e.bench && e.bench.composite != null)) return;
      const f = C.familyKey(e);
      if (!byFam.has(f)) byFam.set(f, []);
      byFam.get(f).push({ iq: e.bench.quality, from: `${PROVIDERS[e.providerId]?.name || e.providerId}` });
    });
    const out = new Map();
    byFam.forEach((list, f) => {
      const sorted = list.slice().sort((a, b) => a.iq - b.iq);
      const mid = Math.floor(sorted.length / 2);
      const iq = sorted.length % 2 ? sorted[mid].iq : Math.round((sorted[mid - 1].iq + sorted[mid].iq) / 2);
      out.set(f, { iq, from: sorted.map((s) => s.from).join(', '), n: sorted.length });
    });
    return out;
  }

  // ---- eligibility ---------------------------------------------------------

  function evaluate(f, prof, pol) {
    const hard = [];
    const soft = [];
    if (f.kind !== 'chat') hard.push(`${f.kind} model — profiles serve chat`);
    if (f.iq == null) hard.push('not benchmarked (no intelligence measured, none to inherit)');
    else if (f.iq < prof.minIQ) hard.push(`intelligence ${f.iq} < ${prof.minIQ}`);
    if (f.ttftMs != null && prof.maxTtftMs && f.ttftMs > prof.maxTtftMs) hard.push(`first token ${fmtMs(f.ttftMs)} > ${fmtMs(prof.maxTtftMs)}`);
    if (f.tps != null && prof.minTps && f.tps < prof.minTps) hard.push(`${f.tps} tok/s < ${prof.minTps}`);
    if (f.reliability != null && f.reliability < prof.minReliability) hard.push(`reliability ${Math.round(f.reliability * 100)}% < ${Math.round(prof.minReliability * 100)}%`);
    if (f.context != null && prof.minContext && f.context < prof.minContext) hard.push(`context ${fmtK(f.context)} < ${fmtK(prof.minContext)}`);
    else if (f.context == null && prof.minContext) soft.push('context window unknown');
    if (prof.maxPrice != null && f.price != null && f.price > prof.maxPrice) hard.push(`$${f.price}/1M > $${prof.maxPrice}`);
    if (prof.requireTools) { if (f.tools === false) hard.push('tool calling failed the probe'); else if (f.tools == null) soft.push('tool calling not probed'); }
    if (prof.requireJson) { if (f.json === false) hard.push('JSON mode failed the probe'); else if (f.json == null) soft.push('JSON mode not probed'); }
    if (prof.requireLong) { if (f.longContext === false) hard.push('long-context needle missed'); else if (f.longContext == null) soft.push('long context not probed'); }
    if (f.spread != null && f.spread > 15) hard.push(`unstable: ±${f.spread} between runs`);
    if (f.suite != null && f.suite !== B.SUITE_VERSION) soft.push(`scored with suite v${f.suite}`);

    // State.
    let stateId = 'active';
    if (hard.length) stateId = 'ineligible';
    else if (f.streak >= pol.cooldownStreak && f.lastFail && Date.now() - f.lastFail < pol.cooldownMinutes * 60000) stateId = 'cooldown';
    else if (f.runs < pol.minRuns || f.verdicts < pol.minVerdicts) stateId = 'candidate';

    const confidence = f.runs >= 4 && f.verdicts >= 40 ? 'high' : f.runs >= 2 && f.verdicts >= 15 ? 'medium' : 'low';
    return { hard, soft, state: stateId, confidence };
  }

  // ---- scoring -------------------------------------------------------------

  function componentScores(f, prof, pol) {
    const iq = f.iq == null ? 0 : f.iq / 100;
    const speed = f.speedScore == null ? 0.5 : f.speedScore / 100;
    // Reliability shrinks towards 0.9 when there is little evidence, so a
    // single lucky run cannot out-rank a proven source.
    const relRaw = f.reliability == null ? 0.9 : f.reliability;
    const n = f.verdicts || 0;
    const reliability = (relRaw * n + 0.9 * 5) / (n + 5);
    let cost;
    if (f.price == null) cost = f.isFree ? 1 : 0.5;
    else cost = Math.max(0, 1 - f.price / pol.priceRef);
    if (prof.preferFree && !f.isFree && f.price !== 0) cost *= 0.6;
    const w = prof.weights;
    const total = iq * w.iq + speed * w.speed + reliability * w.reliability + cost * w.cost;
    const wsum = w.iq + w.speed + w.reliability + w.cost || 1;
    return { iq, speed, reliability, cost, score: Math.round((total / wsum) * 1000) / 10 };
  }

  // Weighted shares over the top N active sources, capped per provider. The
  // cap is enforced by clipping a provider's total and handing the excess to
  // the others, repeated until nothing is over the line.
  function distribute(active, pol) {
    const top = active.slice(0, pol.topN);
    if (!top.length) return;
    let weights = top.map((t) => Math.pow(Math.max(t.score, 1) / 100, pol.sharpness));
    let sum = weights.reduce((s, v) => s + v, 0);
    let shares = weights.map((v) => v / sum);
    const providers = [...new Set(top.map((t) => t.providerId))];
    if (providers.length > 1) {
      // A cap below an even split cannot be honoured; use the even split.
      const cap = Math.max(pol.maxProviderShare, 1 / providers.length);
      for (let iter = 0; iter < 10; iter++) {
        let moved = false;
        providers.forEach((pid) => {
          const idx = top.map((t, i) => (t.providerId === pid ? i : -1)).filter((i) => i >= 0);
          const total = idx.reduce((s, i) => s + shares[i], 0);
          if (total > cap + 1e-9) {
            const scale = cap / total;
            const excess = total - cap;
            idx.forEach((i) => { shares[i] *= scale; });
            const others = top.map((t, i) => (t.providerId !== pid ? i : -1)).filter((i) => i >= 0);
            const otherSum = others.reduce((s, i) => s + shares[i], 0) || 1;
            others.forEach((i) => { shares[i] += excess * (shares[i] / otherSum); });
            moved = true;
          }
        });
        if (!moved) break;
      }
    }
    top.forEach((t, i) => { t.share = Math.round(shares[i] * 1000) / 10; });
    active.slice(pol.topN).forEach((t) => { t.share = 0; });
  }

  // ---- compute -------------------------------------------------------------

  function compute() {
    const pol = policy();
    const entries = C.visibleEntries().filter((e) => !e.removedAt);
    const famIQ = familyIntelligence(entries);
    const facts = entries.map((e) => factsOf(e, famIQ.get(C.familyKey(e))));
    const result = { at: Date.now(), profiles: {}, families: new Set(facts.map((f) => f.family)).size, sources: facts.length, benchmarked: facts.filter((f) => f.ownIQ != null).length };
    PROFILE_IDS.forEach((id) => {
      const prof = pol.profiles[id];
      const rows = facts.map((f) => {
        const ev = evaluate(f, prof, pol);
        const sc = componentScores(f, prof, pol);
        return { ...f, ...ev, components: sc, score: sc.score, share: 0 };
      });
      const eligible = rows.filter((r) => r.state !== 'ineligible').sort((a, b) => b.score - a.score || (b.iq ?? 0) - (a.iq ?? 0));
      const active = eligible.filter((r) => r.state === 'active');
      distribute(active, pol);
      active.forEach((r, i) => { r.rank = i + 1; });
      const candidates = eligible.filter((r) => r.state === 'candidate');
      const cooldown = eligible.filter((r) => r.state === 'cooldown');
      const excluded = rows.filter((r) => r.state === 'ineligible');
      // Why models miss this profile, counted, so the owner sees what to fix.
      const reasonCounts = {};
      excluded.forEach((r) => { const k = r.hard[0].replace(/[\d.]+.*$/, '').trim(); reasonCounts[k] = (reasonCounts[k] || 0) + 1; });
      result.profiles[id] = { id, ...prof, active, candidates, cooldown, excluded, eligible: eligible.length,
        reasons: Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]),
        providersInPlay: new Set(active.filter((r) => r.share > 0).map((r) => r.providerId)).size };
    });
    state.result = result;
    return result;
  }

  // The cached result goes stale by time too: cooldowns expire and Upstream
  // Check runs add verdicts without touching the catalogue file.
  const RESULT_TTL_MS = 30000;
  function current() {
    if (state.result && Date.now() - state.result.at < RESULT_TTL_MS) return state.result;
    return compute();
  }

  function membershipOf(e) {
    const r = current();
    const out = [];
    PROFILE_IDS.forEach((id) => {
      const hit = r.profiles[id].active.find((row) => row.key === e.key);
      if (hit) out.push({ profile: id, rank: hit.rank, share: hit.share });
    });
    return out;
  }

  // ---- export --------------------------------------------------------------

  function exportObject() {
    const r = current();
    const pol = policy();
    const row = (t) => ({
      rank: t.rank || null, state: t.state, share: t.share || 0, score: t.score, confidence: t.confidence,
      family: t.family, model: t.id, name: t.name, provider: t.providerId, providerName: t.provider,
      baseUrl: PROVIDERS[t.providerId]?.baseUrl || null,
      intelligence: t.iq, intelligenceSource: t.ownIQ != null ? 'measured' : `inherited from ${t.inheritedFrom}`, tier: t.tier,
      ttftMs: t.ttftMs, tokensPerSecond: t.tps, latencyMs: t.latencyMs, reliability: t.reliability, verdicts: t.verdicts,
      context: t.context, capabilities: { tools: t.tools, json: t.json, longContext: t.longContext, vision: t.hasVision, reasoning: t.hasReasoning },
      pricePer1M: t.pricing ? { input: t.pricing.input, output: t.pricing.output, blended: t.price } : null,
      warnings: t.soft, reasons: t.hard,
    });
    const profiles = {};
    PROFILE_IDS.forEach((id) => {
      const p = r.profiles[id];
      profiles[`venom-${id}`] = {
        label: p.label, description: p.desc, policy: pol.profiles[id],
        targets: p.active.map(row), candidates: p.candidates.map(row), cooldown: p.cooldown.map(row), excluded: p.excluded.map(row),
      };
    });
    return { generatedAt: new Date(r.at).toISOString(), generator: 'VENOM Router', suite: B.SUITE_VERSION,
      global: { minRuns: pol.minRuns, minVerdicts: pol.minVerdicts, topN: pol.topN, maxProviderShare: pol.maxProviderShare, cooldownStreak: pol.cooldownStreak, cooldownMinutes: pol.cooldownMinutes },
      profiles };
  }

  // ---- rendering -----------------------------------------------------------

  function fmtMs(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  }
  function fmtK(n) {
    if (n == null) return '—';
    if (n >= 1000000) return `${(n / 1000000).toFixed(n % 1000000 ? 1 : 0)}M`;
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(n);
  }

  const ICON = {
    bolt: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    scale: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 7h18"/><path d="M5 7 2 14a4 4 0 0 0 6 0L5 7zM19 7l-3 7a4 4 0 0 0 6 0l-3-7z"/></svg>',
    crown: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18h18M4 18 2 7l5.5 4L12 4l4.5 7L22 7l-2 11"/></svg>',
    layers: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg>',
    users: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="9" r="3"/><circle cx="17" cy="9" r="3"/><path d="M2 20c0-3 3-5 6-5s6 2 6 5"/><path d="M14 20c0-2 2-4 5-4s5 2 5 4"/></svg>',
    download: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M6 11l6 6 6-6"/><path d="M4 21h16"/></svg>',
    copy: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    refresh: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
    sliders: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3"/><path d="M1 14h6M9 8h6M17 16h6"/></svg>',
    chevron: '<svg class="kx-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    empty: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/></svg>',
  };
  const PROFILE_ICON = { lite: ICON.bolt, pro: ICON.scale, max: ICON.crown };

  function confBadge(c) {
    return `<span class="pf-conf pf-conf-${c}" title="Confidence: ${c} (from the number of benchmark runs and request verdicts)">${c}</span>`;
  }

  function tierBadge(tier) {
    if (!tier) return '<span class="mc-tier mc-tier-none">—</span>';
    return `<span class="mc-tier mc-tier-${tier}">${tier}</span>`;
  }

  function policySummary(p, pol) {
    const bits = [];
    bits.push(`Intelligence ≥ ${p.minIQ}`);
    if (p.maxTtftMs) bits.push(`first token ≤ ${fmtMs(p.maxTtftMs)}`);
    if (p.minTps) bits.push(`≥ ${p.minTps} tok/s`);
    bits.push(`reliability ≥ ${Math.round(p.minReliability * 100)}%`);
    if (p.minContext) bits.push(`context ≥ ${fmtK(p.minContext)}`);
    if (p.maxPrice != null) bits.push(`≤ $${p.maxPrice}/1M`);
    if (p.requireTools) bits.push('tool calling');
    if (p.requireJson) bits.push('JSON mode');
    if (p.requireLong) bits.push('long context');
    const w = p.weights;
    const order = Object.entries(w).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${Math.round(v * 100)}% ${({ iq: 'intelligence', speed: 'speed', reliability: 'reliability', cost: 'cost' })[k]}`);
    return { gate: bits, order, spread: `top ${pol.topN} share traffic ∝ score³ · no provider above ${Math.round(pol.maxProviderShare * 100)}%` };
  }

  function rowHTML(t, pid, showShare) {
    const open = state.expanded.has(`${pid}:${t.key}`);
    const p = PROVIDERS[t.providerId];
    return `<tr class="dt-row pf-row ${open ? 'open' : ''}" data-pf-toggle="${escapeHtml(`${pid}:${t.key}`)}" tabindex="0" aria-expanded="${open}">
      <td class="dt-num col-rank">${t.rank ? `<span class="mc-rank ${t.rank <= 3 ? 'top' : ''}">#${t.rank}</span>` : '<span class="dt-muted">—</span>'}</td>
      <td><div class="dt-provider">${ICON.chevron}<span class="pv-logo">${providerMark(p)}</span>
        <div><div class="dt-provider-name">${escapeHtml(t.name)}${t.ownIQ == null ? '<span class="pv-tag t-amber" title="Intelligence inherited from the same model on another provider">inherited</span>' : ''}${t.soft.length ? `<span class="pv-tag t-muted" title="${escapeHtml(t.soft.join(' · '))}">${t.soft.length} note${t.soft.length > 1 ? 's' : ''}</span>` : ''}</div>
        <div class="dt-provider-host">${healthDotHTML(p)}${escapeHtml(t.provider)} · <code>${escapeHtml(t.id)}</code></div></div></div></td>
      ${showShare ? `<td class="col-share">${t.share ? `<div class="pf-share"><span style="width:${Math.min(100, t.share)}%"></span></div><b>${t.share}%</b>` : '<span class="dt-muted">0%</span>'}</td>` : ''}
      <td class="dt-num col-score"><b>${t.score}</b></td>
      <td class="col-tier">${tierBadge(t.tier)} <span class="dt-num">${t.iq ?? '—'}</span></td>
      <td class="dt-num">${fmtMs(t.ttftMs)}</td>
      <td class="dt-num">${t.tps ?? '—'}</td>
      <td class="dt-num">${t.reliability == null ? '<span class="dt-muted">—</span>' : `${Math.round(t.reliability * 100)}%`}</td>
      <td>${confBadge(t.confidence)}</td>
    </tr>${open ? `<tr class="dt-detail pf-detail"><td colspan="${showShare ? 9 : 8}">${explainHTML(t)}</td></tr>` : ''}`;
  }

  function explainHTML(t) {
    const c = t.components;
    const bar = (label, v, w) => `<div class="pf-comp"><span class="pf-comp-label">${label} <small>×${Math.round(w * 100)}%</small></span><span class="pf-comp-bar"><span style="width:${Math.round(v * 100)}%"></span></span><span class="pf-comp-val">${Math.round(v * 100)}</span></div>`;
    return `<div class="pf-explain">
      <div class="pf-explain-col">
        <div class="mc-panel-head">Score ${t.score} <span class="mc-muted">${t.state}${t.share ? ` · ${t.share}% of traffic` : ''}</span></div>
        ${bar('Intelligence', c.iq, t._w?.iq ?? 0)}
        ${bar('Speed', c.speed, t._w?.speed ?? 0)}
        ${bar('Reliability', c.reliability, t._w?.reliability ?? 0)}
        ${bar('Cost', c.cost, t._w?.cost ?? 0)}
        <p class="mc-source">Reliability is shrunk towards 90% while evidence is thin (${t.verdicts} verdicts, ${t.runs} run${t.runs === 1 ? '' : 's'}); cost is 1 for free, 0 at $${policy().priceRef}/1M blended.</p>
      </div>
      <div class="pf-explain-col">
        <div class="mc-panel-head">Facts</div>
        <div class="mc-compare">
          <div class="mc-compare-row"><span>Intelligence</span><span>${t.iq ?? '—'} ${tierBadge(t.tier)}</span><span class="mc-note">${t.ownIQ != null ? 'measured here' : `inherited from ${escapeHtml(t.inheritedFrom || '')}`}</span></div>
          <div class="mc-compare-row"><span>Latency / TTFT</span><span>${fmtMs(t.latencyMs)} / ${fmtMs(t.ttftMs)}</span><span class="mc-note">${t.tps ?? '—'} tok/s</span></div>
          <div class="mc-compare-row"><span>Reliability</span><span>${t.reliability == null ? '—' : `${Math.round(t.reliability * 100)}%`}</span><span class="mc-note">${t.verdicts} verdicts${t.streak ? ` · ${t.streak} failing` : ''}</span></div>
          <div class="mc-compare-row"><span>Context</span><span>${fmtK(t.context)}</span><span class="mc-note">${t.longContext === true ? 'long probe ok' : t.longContext === false ? 'long probe failed' : 'long probe pending'}</span></div>
          <div class="mc-compare-row"><span>Capabilities</span><span>${['tools', 'json'].map((k) => `<span class="mc-cap mc-cap-${t[k] === true ? 'yes' : t[k] === false ? 'no' : 'unknown'}">${k === 'tools' ? 'T' : 'J'}</span>`).join('')}<span class="mc-cap mc-cap-${t.longContext === true ? 'yes' : t.longContext === false ? 'no' : 'unknown'}">L</span></span><span class="mc-note">${t.hasVision ? 'vision · ' : ''}${t.hasReasoning ? 'reasoning' : ''}</span></div>
          <div class="mc-compare-row"><span>Price</span><span>${t.price == null ? (t.isFree ? 'free' : '—') : `$${t.price}/1M`}</span><span class="mc-note">${t.pricing ? escapeHtml(t.pricing.source) : 'unknown'}</span></div>
        </div>
        ${t.hard.length ? `<div class="pf-reasons"><b>Not eligible:</b> ${t.hard.map((h) => `<span class="pf-reason">${escapeHtml(h)}</span>`).join('')}</div>` : ''}
        ${t.soft.length ? `<div class="pf-reasons soft"><b>Notes:</b> ${t.soft.map((h) => `<span class="pf-reason">${escapeHtml(h)}</span>`).join('')}</div>` : ''}
      </div>
    </div>`;
  }

  function policyEditorHTML(id, p) {
    const num = (k, label, step, min, max, hint) => `<label class="pf-field"><span>${label}</span><input type="number" data-pf-num="${id}.${k}" value="${p[k] == null ? '' : p[k]}" step="${step}" min="${min}" max="${max}" placeholder="—"><small>${hint || ''}</small></label>`;
    const chk = (k, label) => `<label class="pf-check"><input type="checkbox" data-pf-chk="${id}.${k}" ${p[k] ? 'checked' : ''}><span>${label}</span></label>`;
    const w = (k, label) => `<label class="pf-field"><span>${label}</span><input type="number" data-pf-w="${id}.${k}" value="${Math.round(p.weights[k] * 100)}" step="5" min="0" max="100"><small>%</small></label>`;
    return `<div class="pf-editor">
      <div class="pf-editor-grid">
        ${num('minIQ', 'Min intelligence', 1, 0, 100)}
        ${num('maxTtftMs', 'Max first token (ms)', 100, 0, 60000)}
        ${num('minTps', 'Min tok/s', 5, 0, 2000)}
        ${num('minReliability', 'Min reliability', 0.01, 0, 1, '0–1')}
        ${num('minContext', 'Min context', 1000, 0, 10000000, 'tokens')}
        ${num('maxPrice', 'Max $/1M blended', 0.1, 0, 1000, 'blank = any')}
      </div>
      <div class="pf-editor-checks">${chk('requireTools', 'Require tool calling')}${chk('requireJson', 'Require JSON mode')}${chk('requireLong', 'Require long context')}${chk('preferFree', 'Prefer free')}</div>
      <div class="pf-editor-grid weights">${w('iq', 'Intelligence')}${w('speed', 'Speed')}${w('reliability', 'Reliability')}${w('cost', 'Cost')}</div>
    </div>`;
  }

  function profileCardHTML(pf, pol) {
    const id = pf.id;
    const sum = policySummary(pf, pol);
    const showExcluded = !!state.showExcluded[id];
    const editing = !!state.editing[id];
    const total = pf.active.length + pf.candidates.length + pf.cooldown.length + pf.excluded.length;
    const cols = '<th class="col-rank">#</th><th>Model</th><th class="col-share">Share</th><th class="col-score">Score</th><th class="col-tier">IQ</th><th>TTFT</th><th>Tok/s</th><th>Rel.</th><th>Conf.</th>';
    const colsNoShare = cols.replace('<th class="col-share">Share</th>', '');
    const table = (rows, showShare, empty) => rows.length
      ? `<div class="dt-table-wrap"><table class="dt-table pf-table"><thead><tr>${showShare ? cols : colsNoShare}</tr></thead><tbody>${rows.map((t) => rowHTML({ ...t, _w: pf.weights }, id, showShare)).join('')}</tbody></table></div>`
      : `<div class="pf-empty">${empty}</div>`;
    return `<section class="pf-card pf-${id}" data-pf="${id}">
      <header class="pf-head">
        <span class="pf-icon">${PROFILE_ICON[id]}</span>
        <div class="pf-title"><h3>${escapeHtml(pf.label)} <code>venom-${id}</code></h3><p>${escapeHtml(pf.desc)}</p></div>
        <span class="pf-tag">${escapeHtml(pf.tag)}</span>
      </header>
      <div class="pf-stats">
        <div class="pf-stat"><span class="pf-stat-value">${pf.active.length}</span><span class="pf-stat-label">active</span></div>
        <div class="pf-stat"><span class="pf-stat-value">${pf.candidates.length}</span><span class="pf-stat-label">candidates</span></div>
        <div class="pf-stat"><span class="pf-stat-value">${pf.cooldown.length}</span><span class="pf-stat-label">cooling</span></div>
        <div class="pf-stat"><span class="pf-stat-value">${pf.excluded.length}</span><span class="pf-stat-label">excluded</span></div>
        <div class="pf-stat"><span class="pf-stat-value">${pf.providersInPlay}</span><span class="pf-stat-label">providers</span></div>
      </div>
      <div class="pf-meter"><span style="width:${total ? Math.round((pf.active.length / total) * 100) : 0}%"></span></div>
      <div class="pf-policy">
        <div class="pf-policy-row"><b>Gate</b><span>${sum.gate.map((g) => `<span class="pf-gate">${escapeHtml(g)}</span>`).join('')}</span></div>
        <div class="pf-policy-row"><b>Order</b><span>${sum.order.map((o, i) => `<span class="pf-order"><i>${i + 1}</i>${escapeHtml(o)}</span>`).join('')}</span></div>
        <div class="pf-policy-row"><b>Spread</b><span class="mc-muted" style="margin:0">${escapeHtml(sum.spread)}</span></div>
        <div class="pf-policy-actions"><button class="btn btn-ghost btn-mini" type="button" data-pf-edit="${id}">${ICON.sliders} ${editing ? 'Close policy' : 'Edit policy'}</button></div>
      </div>
      ${editing ? policyEditorHTML(id, pol.profiles[id]) : ''}
      <div class="pf-section-head">Roster <span class="mc-muted">ranked · shares over the top ${pol.topN}</span></div>
      ${table(pf.active, true, pf.excluded.length || pf.candidates.length ? 'Nothing active yet — see candidates and exclusions below.' : 'No models in the pool.')}
      ${pf.candidates.length ? `<div class="pf-section-head">Candidates <span class="mc-muted">eligible, but not enough evidence to carry traffic (${pol.minRuns}+ runs, ${pol.minVerdicts}+ verdicts)</span></div>${table(pf.candidates, false, '')}` : ''}
      ${pf.cooldown.length ? `<div class="pf-section-head">Cooling down <span class="mc-muted">${pol.cooldownStreak}+ failures in a row; back after ${pol.cooldownMinutes} min</span></div>${table(pf.cooldown, false, '')}` : ''}
      <div class="pf-section-head pf-toggle" data-pf-excluded="${id}">${ICON.chevron} Excluded <span class="mc-muted">${pf.excluded.length} · ${pf.reasons.slice(0, 3).map(([r, n]) => `${escapeHtml(r)} (${n})`).join(' · ')}</span></div>
      ${showExcluded ? table(pf.excluded, false, 'Nothing excluded.') : ''}
    </section>`;
  }

  function kpisHTML(r, pol) {
    const items = [
      { label: 'Sources', value: r.sources, icon: ICON.layers, foot: `${r.families} model families across connected providers` },
      { label: 'Benchmarked', value: r.benchmarked, sub: `/ ${r.sources}`, icon: ICON.users, meter: r.sources ? r.benchmarked / r.sources : 0, foot: 'measured here; the rest inherit or wait' },
    ];
    PROFILE_IDS.forEach((id) => {
      const p = r.profiles[id];
      items.push({ label: p.label, value: p.active.length, sub: p.candidates.length ? `+${p.candidates.length} cand.` : '', icon: PROFILE_ICON[id],
        meter: r.sources ? p.active.length / r.sources : 0, foot: p.active.length ? `${p.active[0].name} leads · ${p.providersInPlay} provider${p.providersInPlay === 1 ? '' : 's'} in play` : 'no active source yet' });
    });
    return statCardsHTML(items);
  }

  function render() {
    const body = $('#pf-body');
    if (!body) return;
    if (!C.state.loaded) { C.load().then(render); return; }
    $('#pf-crumbs').innerHTML = breadcrumbHTML([{ label: 'Overview', page: 'overview' }, { label: 'Routing Profiles', icon: 'profiles' }]);
    const connected = Object.values(PROVIDERS).filter(isConnected);
    if (!connected.length) {
      body.innerHTML = `<div class="pv-empty"><div class="pv-empty-icon">${ICON.empty}</div><h3>No providers connected</h3><p>Profiles route through the Model Pool, which is empty until a provider has a key.</p><button class="btn btn-primary" type="button" data-go="providers">Open Providers</button></div>`;
      return;
    }
    const pol = policy();
    const r = compute();
    body.innerHTML = `<div id="pf-kpis">${kpisHTML(r, pol)}</div>
      <div class="pf-toolbar">
        <div class="pf-global">
          <label class="pf-field inline"><span>Top N</span><input type="number" data-pf-g="topN" value="${pol.topN}" min="1" max="20" step="1"></label>
          <label class="pf-field inline"><span>Max provider share</span><input type="number" data-pf-g="maxProviderShare" value="${Math.round(pol.maxProviderShare * 100)}" min="10" max="100" step="5"><small>%</small></label>
          <label class="pf-field inline"><span>Min runs</span><input type="number" data-pf-g="minRuns" value="${pol.minRuns}" min="0" max="10" step="1"></label>
          <label class="pf-field inline"><span>Min verdicts</span><input type="number" data-pf-g="minVerdicts" value="${pol.minVerdicts}" min="0" max="200" step="1"></label>
        </div>
        <div class="pf-actions">
          <button class="btn btn-ghost btn-mini" type="button" data-pf-reset title="Restore the default policy">${ICON.refresh} Defaults</button>
          <button class="btn btn-ghost btn-mini" type="button" data-pf-copy>${ICON.copy} Copy JSON</button>
          <button class="btn btn-primary btn-mini" type="button" data-pf-export>${ICON.download} Export profiles.json</button>
        </div>
      </div>
      <div class="pf-grid">${PROFILE_IDS.map((id) => profileCardHTML(r.profiles[id], pol)).join('')}</div>
      <p class="mc-source pf-foot">Every number here was measured against your own keys by the Model Pool benchmark. Intelligence marked <em>inherited</em> comes from the same model on another of your providers. Nothing is copied from a public leaderboard.</p>`;
  }

  // The page is rebuilt whole, so a background update would drop a half-typed
  // policy value; it waits until the field is left instead.
  function renderIfShown() {
    if (currentPage !== 'profiles') return;
    const a = document.activeElement;
    if (a && a.matches('input, select, textarea') && a.closest('#pf-body')) {
      state.renderOnBlur = true;
      return;
    }
    render();
  }

  // ---- events --------------------------------------------------------------

  function setPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    cur[parts[parts.length - 1]] = value;
  }

  function bind() {
    const page = $('.page-profiles');
    if (!page) return;
    page.addEventListener('click', (ev) => {
      const go = ev.target.closest('[data-go]');
      if (go) { showPage(go.dataset.go); return; }
      if (ev.target.closest('[data-pf-export]')) {
        downloadFile(JSON.stringify(exportObject(), null, 2), `venom-profiles-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
        setStatus('done', 'profiles.json exported');
        return;
      }
      if (ev.target.closest('[data-pf-copy]')) {
        navigator.clipboard.writeText(JSON.stringify(exportObject(), null, 2)).then(() => setStatus('done', 'Profiles JSON copied')).catch(() => setStatus('error', 'Clipboard unavailable'));
        return;
      }
      if (ev.target.closest('[data-pf-reset]')) { resetPolicy(); render(); return; }
      const edit = ev.target.closest('[data-pf-edit]');
      if (edit) { state.editing[edit.dataset.pfEdit] = !state.editing[edit.dataset.pfEdit]; render(); return; }
      const exc = ev.target.closest('[data-pf-excluded]');
      if (exc) { state.showExcluded[exc.dataset.pfExcluded] = !state.showExcluded[exc.dataset.pfExcluded]; render(); return; }
      const tog = ev.target.closest('[data-pf-toggle]');
      if (tog && !ev.target.closest('input, button')) {
        const k = tog.dataset.pfToggle;
        if (state.expanded.has(k)) state.expanded.delete(k); else state.expanded.add(k);
        render();
      }
    });
    page.addEventListener('change', (ev) => {
      const pol = policy();
      const num = ev.target.closest('[data-pf-num]');
      const chk = ev.target.closest('[data-pf-chk]');
      const w = ev.target.closest('[data-pf-w]');
      const g = ev.target.closest('[data-pf-g]');
      if (num) {
        const v = num.value === '' ? null : Number(num.value);
        setPath(pol.profiles, num.dataset.pfNum, v == null || Number.isNaN(v) ? null : v);
      } else if (chk) {
        setPath(pol.profiles, chk.dataset.pfChk, chk.checked);
      } else if (w) {
        const [id, k] = w.dataset.pfW.split('.');
        pol.profiles[id].weights[k] = Math.max(0, Number(w.value) || 0) / 100;
      } else if (g) {
        const k = g.dataset.pfG;
        let v = Number(g.value);
        if (k === 'maxProviderShare') v = Math.min(1, Math.max(0.1, v / 100));
        else v = Math.max(0, Math.round(v));
        pol[k] = v;
      } else return;
      savePolicy();
      render();
    });
    page.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      const row = ev.target.closest('tr.pf-row');
      if (!row || ev.target !== row) return;
      ev.preventDefault();
      const k = row.dataset.pfToggle;
      if (state.expanded.has(k)) state.expanded.delete(k); else state.expanded.add(k);
      render();
    });
    page.addEventListener('focusout', () => {
      if (!state.renderOnBlur) return;
      state.renderOnBlur = false;
      // After the field's own change handler, which may render first.
      setTimeout(renderIfShown, 0);
    });
    // Catalogue changes (sync, benchmark done) invalidate the computed result.
    window.addEventListener('catalog-changed', () => { state.result = null; renderIfShown(); });
  }

  function init() {
    bind();
  }

  window.PROFILES = { init, render, renderIfShown, compute, membershipOf, exportObject, policy, DEFAULT_POLICY, state };
})();
