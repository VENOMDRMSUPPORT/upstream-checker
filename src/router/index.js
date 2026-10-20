'use strict';

// Venom router plane: multi-account smart routing behind one local endpoint.
//
// Lives in main (src/main.js wires it after the databases open) and never
// requires electron, so the whole module loads under plain Node in tests.
// Secrets never pass through here as values: dispatch resolves
// venomkey:<keyId> through repos.providers.revealKey at the request path
// (src/db/keys.js + src/api-request.js), exactly like the renderer flow.

const http = require('http');

const ROUTER_PORT = 28228;
const ROUTER_HOST = '127.0.0.1';

// A fixed port collides with sibling routers on this machine (9Router,
// OmniRoute). The port is read from settings (routerGatewayPort) so the owner
// can move it; anything unusable falls back to the default with a warning.
function normalizeGatewayPort(value) {
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1024 && n <= 65535) return n;
  return ROUTER_PORT;
}

const TIER_DRAIN_ORDER = ['subscription', 'free', 'cheap', 'paid'];
const TIER_RANK = new Map(TIER_DRAIN_ORDER.map((tier, index) => [tier, index]));

// ---------------------------------------------------------------------------
// Identity: the raw upstream id vs the canonical match key
// ---------------------------------------------------------------------------
// build.js may merge listings across hosts (canonicalSlug) while model_keys
// and the upstream API still need the raw provider+model pair. The router
// keeps both: upstreamModelId is the dispatch address, canonicalSlug is only
// the scoring/benchmark lookup key.
function canonicalSlug(providerId, modelId) {
  return `${String(providerId || '').trim().toLowerCase()}`
    + `/${String(modelId || '').trim().toLowerCase()
      .replace(/:(free|hosted|floor|nitro)$/, '')
      .replace(/-(free|hosted|latest)$/, '')}`;
}

function upstreamModelId(providerId, modelId) {
  return `${String(providerId)}::${String(modelId)}`;
}

// Router-internal capability read. This never invents a catalog score: when
// the reference has no measurement the row carries an explicit heuristic
// estimate (score_source 'est-heuristic') so it ranks last instead of staying
// outside every tier. The Models page still shows measured vs estimated from
// the catalog's own score_source; this value only orders router pools.
function evaluateModelCapabilities(row) {
  const source = row && row.score_source;
  if (row && row.score != null && (source === 'aa' || source === 'est' || source === 'proxy' || source === 'local')) {
    return { score: row.score, scoreSource: source, estimated: source !== 'aa' };
  }
  let score = 8;
  if (row && row.tools === true) score += 4;
  if (row && row.reasoning === true) score += 4;
  const context = Number(row && row.context_tokens);
  if (Number.isFinite(context) && context >= 128000) score += 3;
  else if (Number.isFinite(context) && context >= 32000) score += 1;
  const cost = Number(row && row.cost_in_per_m);
  if (Number.isFinite(cost) && cost > 0 && cost <= 0.5) score += 1;
  return { score: Math.round(score * 10) / 10, scoreSource: 'est-heuristic', estimated: true };
}

// ---------------------------------------------------------------------------
// Tool-output compression (RTK-style, lossless trimming)
// ---------------------------------------------------------------------------
function compressToolMessages(messages, maxTokens = 4000) {
  if (!Array.isArray(messages)) return messages;
  const maxChars = Math.max(500, maxTokens * 4);
  return messages.map((message) => {
    if (!message || message.role !== 'tool' || typeof message.content !== 'string') return message;
    if (message.content.length <= maxChars) return message;
    const head = message.content.slice(0, Math.floor(maxChars * 0.7));
    const tail = message.content.slice(-Math.floor(maxChars * 0.2));
    return { ...message, content: `${head}\n…[venom-router: trimmed ${message.content.length - head.length - tail.length} chars]…\n${tail}` };
  });
}

// A light model that emits a tool call as prose instead of tool_calls still
// carries the intent; rescue it into the OpenAI shape before replying.
function rescuePlainTextToolCalls(content) {
  if (typeof content !== 'string' || !content.includes('{')) return null;
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const candidates = [content.slice(start, end + 1), content.match(/\{[^{}]*"(name|function)"[^{}]*\}/)];
  for (const candidate of candidates) {
    const text = typeof candidate === 'string' ? candidate : (candidate && candidate[0]);
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      const name = parsed.name || (parsed.function && parsed.function.name);
      if (!name) continue;
      return [{ id: `call_${Date.now().toString(36)}`, type: 'function',
        function: { name, arguments: JSON.stringify(parsed.arguments || parsed.parameters || {}) } }];
    } catch (_) {
      // Try the next candidate shape.
    }
  }
  return null;
}

// Stage scoring for the pro cascade (Switchyard-style): read tool results
// directly, no judge model per step.
function analyzeCascadeStage(messages) {
  const tools = (Array.isArray(messages) ? messages : []).filter((m) => m && m.role === 'tool');
  let consecutiveErrors = 0;
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const text = typeof tools[i].content === 'string' ? tools[i].content : JSON.stringify(tools[i].content || '');
    if (/error|exception|fail|traceback/i.test(text)) consecutiveErrors += 1;
    else break;
  }
  return { consecutiveErrors, shouldEscalate: consecutiveErrors >= 1, toolTurns: tools.length };
}

// ---------------------------------------------------------------------------
// Smart catalog: one scored list in, three venom tiers out
// ---------------------------------------------------------------------------
// Tier boundaries live on the catalog's real VQ scale (Artificial Analysis
// intelligence index, top ~57.6 here), so the three policy cards never show
// the same number:
//   venom-lite  free or near-free text rows at score >= 20 (zero marginal
//               cost priority), including rows served under free/subscription
//               keys, ordered free-first then cheapest then highest VQ.
//   venom-pro   hybrid cascade rung: tool-capable rows (tools !== false) at
//               score >= 30, split into efficient (30..45, starts fast) and
//               capable (>= 45, escalation target on tool errors).
//   venom-max   frontier only: documented scores (never the router's own
//               est-heuristic) at score >= 45, ordered by VQ then key depth.
const PRO_MIN_SCORE = 30;
const PRO_EFFICIENT_MAX = 45;
const PRO_CAPABLE_MIN = 45;
const MAX_MIN_SCORE = 45;
const LITE_MIN_SCORE = 20;
const LITE_NOMINAL_COST = 0.5;
const POOL_CAP = 50;

function rowCost(row) {
  const cost = Number(row && row.cost_in_per_m);
  return Number.isFinite(cost) ? cost : null;
}

function rowCostKind(row) {
  const kind = row && (row.cost_kind || row.costKind);
  return typeof kind === 'string' ? kind.toLowerCase() : null;
}

function isFreeRow(row) {
  if (rowCost(row) === 0) return true;
  if (rowCostKind(row) === 'free') return true;
  const id = String((row && (row.modelId || row.model_id)) || '');
  return /:(free|hosted|floor)$/i.test(id) || /-(free|latest)$/i.test(id);
}

function firstNonEmpty(...pools) {
  for (const pool of pools) {
    if (Array.isArray(pool) && pool.length) return pool;
  }
  return [];
}

function tiersByProvider(keys = []) {
  const map = new Map();
  for (const key of keys) {
    if (!key || !key.providerId) continue;
    if (!map.has(key.providerId)) map.set(key.providerId, new Set());
    map.get(key.providerId).add(key.tier || 'paid');
  }
  return map;
}

function scoredCopy(row, heuristic) {
  return { ...row, score: heuristic.score, score_source: 'est-heuristic' };
}

function targetEntry(row, keyCount) {
  return {
    providerId: row.providerId,
    modelId: row.modelId,
    displayName: formatModelDisplayName(row.modelId, row.name || row.display_name),
    upstreamId: row.upstream_id,
    score: row.score,
    scoreSource: row.score_source || null,
    tools: row.tools === true,
    costInPerM: rowCost(row),
    activeKeys: Number.isInteger(keyCount) ? keyCount : 0,
  };
}

// ---------------------------------------------------------------------------
// Routability + display naming
// ---------------------------------------------------------------------------
// A roster row PROVES it cannot answer in text when it publishes a non-text
// output modality, or when its kind names a generator (image/audio/video/
// embeddings). Silence is not proof: a row that publishes nothing stays,
// exactly like src/catalog/snapshot.js declaresNonTextOutput/dropNonText.
function declaresNonTextOutput(row) {
  const raw = (row && (row.output_modalities || row.outputModalities)) || '';
  const out = String(raw).toLowerCase().split(/[,\s]+/).filter(Boolean);
  return out.length > 0 && !out.includes('text');
}

function isRoutableTextRow(row) {
  if (!row) return false;
  if (declaresNonTextOutput(row)) return false;
  const kind = row.kind != null ? String(row.kind).trim().toLowerCase() : '';
  if (kind && kind !== 'chat' && kind !== 'text') return false;
  return true;
}

// Display-only cleanup: routing prefixes say who served the listing, not what
// the model is called. The raw id is never rewritten here — upstreamModelId
// still carries providerId::modelId untouched for dispatch.
function formatModelDisplayName(rawId, name) {
  const clean = String(name == null ? '' : name).trim();
  if (clean && !clean.includes('/') && !clean.includes('::')) return clean;
  const id = String(rawId == null ? '' : rawId);
  const afterSlash = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  const afterNs = afterSlash.includes('::') ? afterSlash.slice(afterSlash.lastIndexOf('::') + 1) : afterSlash;
  const display = afterNs
    .replace(/:(free|hosted|floor|nitro)$/i, '')
    .replace(/-(free|hosted|latest)$/i, '')
    .trim();
  return display || id.trim() || 'unknown';
}

function buildSmartCatalog(scoredRows, keys = []) {
  const rows = (Array.isArray(scoredRows) ? scoredRows : []).map((row) => {
    const providerId = row.provider_id || row.providerId || '';
    const modelId = row.model_id || row.id || '';
    return {
      ...row,
      providerId,
      modelId,
      upstream_id: upstreamModelId(providerId, modelId),
      canonical_slug: canonicalSlug(providerId, modelId),
    };
  });
  const keyList = Array.isArray(keys) ? keys.filter((k) => k && k.id) : [];
  const keySet = new Set(keyList.map((k) => k.id));
  const providerTiers = tiersByProvider(keyList);
  const keysByProvider = new Map();
  for (const k of keyList) {
    keysByProvider.set(k.providerId, (keysByProvider.get(k.providerId) || 0) + 1);
  }
  // Generators and fake listings never enter the tiers or the counts: a row
  // that cannot answer in text is not a routing candidate.
  const usable = rows.filter((row) => (row.modelId && row.providerId)
    && (keySet.size === 0 || keyList.some((k) => k.providerId === row.providerId))
    && isRoutableTextRow(row));
  // Every row gets a number: measured rows keep theirs, the rest read an
  // explicit est-heuristic so no roster row stays outside the tiers.
  const scored = usable.map((row) => {
    if (row.score != null) return row;
    return scoredCopy(row, evaluateModelCapabilities(row));
  });
  // Documented means the catalog measured or estimated it (aa/est/proxy/
  // local) — never the router's own est-heuristic fallback invented above.
  const documented = (row) => row.score != null
    && Boolean(row.score_source) && row.score_source !== 'est-heuristic';

  const hasFreeOrSubKey = (row) => {
    const tiers = providerTiers.get(row.providerId);
    return Boolean(tiers && (tiers.has('free') || tiers.has('subscription')));
  };
  const freeGate = (row) => isFreeRow(row) || hasFreeOrSubKey(row)
    || (rowCost(row) != null && rowCost(row) <= LITE_NOMINAL_COST);
  const liteCandidates = scored.filter(freeGate);
  const lite = liteCandidates.filter((row) => (row.score || 0) >= LITE_MIN_SCORE).sort((a, b) => {
    const free = Number(isFreeRow(b)) - Number(isFreeRow(a));
    if (free) return free;
    const costA = rowCost(a);
    const costB = rowCost(b);
    if (costA != null && costB != null && costA !== costB) return costA - costB;
    return (b.score || 0) - (a.score || 0);
  }).slice(0, POOL_CAP);

  const proCandidates = scored.filter((row) => row.tools !== false && (row.score || 0) >= PRO_MIN_SCORE);
  const efficient = proCandidates.filter((row) => row.score < PRO_EFFICIENT_MAX)
    .sort((a, b) => b.score - a.score).slice(0, POOL_CAP);
  const capable = proCandidates.filter((row) => row.score >= PRO_CAPABLE_MIN)
    .sort((a, b) => b.score - a.score).slice(0, POOL_CAP);

  const maxCandidates = scored.filter(documented);
  const frontier = maxCandidates.filter((row) => (row.score || 0) >= MAX_MIN_SCORE)
    .sort((a, b) => (b.score - a.score)
      || ((keysByProvider.get(b.providerId) || 0) - (keysByProvider.get(a.providerId) || 0)));
  const seenProviders = new Set();
  const max = [];
  for (const row of frontier) {
    if (max.length >= 3) break;
    if (seenProviders.has(row.providerId)) continue;
    seenProviders.add(row.providerId);
    max.push(row);
  }
  for (const row of frontier) {
    if (max.length >= 3) break;
    if (max.includes(row)) continue;
    max.push(row);
  }

  return { builtAt: new Date().toISOString(), lite, efficient, capable, max, unscored: [],
    counts: { total: usable.length, scored: scored.length, unscored: 0,
      liteCandidates: liteCandidates.length, proCandidates: proCandidates.length,
      maxCandidates: maxCandidates.length } };
}

// Detailed per-profile payload for the Venom Profiles page and the
// router:profiles channel. Pure data: copy strings live in the renderer.
function buildProfilesPayload(smartCatalog, { keys = [], poolStatus = null, gateway = null, fleet = null } = {}) {
  const catalog = smartCatalog || {};
  const keyList = Array.isArray(keys) ? keys : [];
  const keysByProvider = new Map();
  for (const key of keyList) {
    if (!key || !key.providerId) continue;
    keysByProvider.set(key.providerId, (keysByProvider.get(key.providerId) || 0) + 1);
  }
  const toTargets = (rows) => (rows || []).map((row) => targetEntry(row, keysByProvider.get(row.providerId) || 0));
  const lite = toTargets(catalog.lite);
  const efficient = toTargets(catalog.efficient);
  const capable = toTargets(catalog.capable);
  const max = toTargets(catalog.max);
  const seen = new Set();
  const proEligible = [...efficient, ...capable].filter((t) => {
    const id = `${t.providerId}/${t.modelId}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).sort((a, b) => b.score - a.score);
  const pool = poolStatus || { keys: keyList.length, cooldowns: [] };
  const cooldowns = Array.isArray(pool.cooldowns) ? pool.cooldowns : [];
  return {
    ok: true,
    gateway: { listening: Boolean(gateway && gateway.listening), port: (gateway && gateway.port) || ROUTER_PORT },
    fleet: {
      active: (fleet && fleet.active) != null ? fleet.active : keyList.length,
      total: (fleet && fleet.total) != null ? fleet.total : keyList.length,
      disabled: (fleet && fleet.disabled) != null ? fleet.disabled : 0,
      liveKeys: pool.keys != null ? pool.keys : keyList.length,
      cooldowns: cooldowns.length,
    },
    pools: catalog.counts || { total: 0, scored: 0, unscored: 0 },
    pool,
    profiles: {
      lite: { name: 'venom-lite', count: lite.length, eligible: lite,
        candidates: (catalog.counts && catalog.counts.liteCandidates) != null
          ? catalog.counts.liteCandidates : lite.length },
      pro: { name: 'venom-pro', count: proEligible.length, eligible: proEligible, efficient, capable,
        candidates: (catalog.counts && catalog.counts.proCandidates) != null
          ? catalog.counts.proCandidates : proEligible.length },
      max: { name: 'venom-max', count: max.length, eligible: max,
        candidates: (catalog.counts && catalog.counts.maxCandidates) != null
          ? catalog.counts.maxCandidates : max.length },
    },
  };
}

// ---------------------------------------------------------------------------
// Key pool: three-level isolation (model-on-key < key < provider)
// ---------------------------------------------------------------------------
function cooldownKey(scope, key) {
  return `${scope}::${key}`;
}

class KeyPoolManager {
  constructor({ keys = [], now = Date.now } = {}) {
    this.keys = new Map(keys.map((k) => [k.id, { ...k }]));
    this.cooldowns = new Map();
    this.providerFailures = new Map();
    this.now = now;
  }

  refresh(keys = []) {
    for (const key of keys) {
      if (!key || !key.id) continue;
      this.keys.set(key.id, { ...(this.keys.get(key.id) || {}), ...key });
    }
    for (const id of [...this.keys.keys()]) {
      if (!keys.some((k) => k && k.id === id)) this.keys.delete(id);
    }
  }

  isCool(scope, key) {
    const until = this.cooldowns.get(cooldownKey(scope, key));
    return !until || until <= this.now();
  }

  coolDown(scope, key, ms, persist) {
    const until = this.now() + Math.max(0, ms);
    this.cooldowns.set(cooldownKey(scope, key), until);
    if (typeof persist === 'function') {
      try { persist(scope, key, until); } catch (_) { /* memory state is authoritative */ }
    }
  }

  // Waterfall: subscription, then free, then cheap, then paid. Within a tier,
  // power-of-two-choices over the least-recently-failed keys; keys sharing a
  // quota_pool_id count once so a shared bucket is not read as spare room.
  pickKey(candidates = []) {
    const live = (Array.isArray(candidates) ? candidates : [])
      .map((c) => (typeof c === 'string' ? { keyId: c } : c))
      .filter((c) => c && this.keys.has(c.keyId) && this.isCool('key', c.keyId)
        && (!c.modelId || this.isCool(`model:${c.modelId}`, c.keyId))
        && (!c.providerId || this.isCool('provider', c.providerId || this.keys.get(c.keyId).providerId)));
    if (!live.length) return null;
    const byTier = new Map();
    for (const candidate of live) {
      const tier = this.keys.get(candidate.keyId).tier || 'paid';
      if (!byTier.has(tier)) byTier.set(tier, []);
      byTier.get(tier).push(candidate);
    }
    for (const tier of TIER_DRAIN_ORDER) {
      const pool = (byTier.get(tier) || []).filter((c) => {
        const key = this.keys.get(c.keyId);
        return !key.quotaPoolId || this.isCool('pool', key.quotaPoolId);
      });
      const usable = pool.length ? pool : (byTier.get(tier) || []);
      if (!usable.length) continue;
      if (usable.length === 1) return usable[0];
      const a = usable[Math.floor(Math.random() * usable.length)];
      let b = usable[Math.floor(Math.random() * usable.length)];
      if (b === a) b = usable[(usable.indexOf(a) + 1) % usable.length];
      const failures = (c) => this.providerFailures.get(c.keyId) || 0;
      return failures(a) <= failures(b) ? a : b;
    }
    return null;
  }

  reportResult({ keyId, modelId = null, providerId = null, outcome = 'ok', retryAfterMs = 0, persist } = {}) {
    if (!keyId) return;
    const key = this.keys.get(keyId);
    const provider = providerId || (key && key.providerId);
    if (outcome === 'ok') {
      if (modelId) this.cooldowns.delete(cooldownKey(`model:${modelId}`, keyId));
      return;
    }
    if (outcome === 'rate_limit') {
      if (modelId) this.coolDown(`model:${modelId}`, keyId, retryAfterMs || 60 * 1000, persist);
      else this.coolDown('key', keyId, retryAfterMs || 60 * 1000, persist);
      return;
    }
    if (outcome === 'payment' || outcome === 'auth') {
      this.coolDown('key', keyId, 10 * 60 * 1000, persist);
      if (key && key.quotaPoolId) this.coolDown('pool', key.quotaPoolId, 60 * 1000, persist);
      return;
    }
    if (outcome === 'server' && provider) {
      const count = (this.providerFailures.get(provider) || 0) + 1;
      this.providerFailures.set(provider, count);
      if (count >= 3) {
        this.coolDown('provider', provider, 2 * 60 * 1000, persist);
        this.providerFailures.set(provider, 0);
      }
    }
  }

  status() {
    const now = this.now();
    return {
      keys: this.keys.size,
      cooldowns: [...this.cooldowns.entries()]
        .filter(([, until]) => until > now)
        .map(([scopeKey, until]) => ({ scopeKey, untilInMs: until - now })),
    };
  }
}

// ---------------------------------------------------------------------------
// Catalog score persistence: 0ms values at boot, refreshed after each sync
// ---------------------------------------------------------------------------
function persistCatalogScores(db, scoredRows) {
  if (!db || !Array.isArray(scoredRows)) return { written: 0 };
  let write;
  try {
    write = db.prepare(`INSERT INTO catalog_scores
      (model_key, score, score_source, score_basis_json, catalog_rank, updated_at)
      VALUES (@model_key, @score, @score_source, @score_basis_json, @catalog_rank, @updated_at)
      ON CONFLICT(model_key) DO UPDATE SET score = excluded.score,
        score_source = excluded.score_source, score_basis_json = excluded.score_basis_json,
        catalog_rank = excluded.catalog_rank, updated_at = excluded.updated_at`);
  } catch (_) {
    return { written: 0, skipped: true };
  }
  const now = Date.now();
  const run = db.transaction((rows) => {
    let written = 0;
    for (const row of rows) {
      if (!row || row.score == null) continue;
      // Heuristic estimates order router pools but are never stored as
      // measurements: a guess in catalog_scores would read as evidence.
      if (row.score_source === 'est-heuristic') continue;
      const key = String(row.matched_id || row.canonical_slug || row.id || '');
      if (!key) continue;
      write.run({ model_key: key, score: row.score, score_source: row.score_source || null,
        score_basis_json: row.score_basis ? JSON.stringify(row.score_basis) : null,
        catalog_rank: row.catalog_rank != null ? row.catalog_rank : null, updated_at: now });
      written += 1;
    }
    return written;
  });
  return { written: run(scoredRows) };
}

function readCatalogScores(db) {
  try {
    return db.prepare('SELECT * FROM catalog_scores').all();
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Cascade engine: venom-lite / venom-pro / venom-max over our own accounts
// ---------------------------------------------------------------------------
class VenomCascadeEngine {
  constructor({ smartCatalog = null, keyPool = null, dispatchUpstream = null, streamUpstream = null, now = Date.now } = {}) {
    this.smartCatalog = smartCatalog;
    this.keyPool = keyPool;
    this.dispatchUpstream = dispatchUpstream;
    this.streamUpstream = streamUpstream;
    this.sessions = new Map();
    this.now = now;
  }

  refresh({ smartCatalog = null, keyPool = null } = {}) {
    if (smartCatalog) this.smartCatalog = smartCatalog;
    if (keyPool) this.keyPool = keyPool;
  }

  sessionOf(sessionId) {
    if (!sessionId) return null;
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, { tier: null, escalationLevel: 0, consecutiveToolErrors: 0 });
    }
    return this.sessions.get(sessionId);
  }

  candidateRoutes(pool, limit = 5) {
    if (!this.keyPool) return [];
    const routes = [];
    for (const row of (pool || []).slice(0, limit)) {
      for (const key of this.keyPool.keys.values()) {
        if (key.providerId !== row.providerId) continue;
        routes.push({ keyId: key.id, providerId: row.providerId, modelId: row.modelId, row });
      }
    }
    return routes;
  }

  async routeLite(payload) {
    const pool = (this.smartCatalog && this.smartCatalog.lite) || [];
    const picked = this.keyPool ? this.keyPool.pickKey(this.candidateRoutes(pool, 6)) : null;
    if (!picked) throw Object.assign(new Error('no venom-lite route has a live key'), { code: 'NO_ROUTE' });
    return this.dispatch(picked, { ...payload, reasoningEffort: 'low' });
  }

  async routePro(payload) {
    const catalog = this.smartCatalog || {};
    const session = this.sessionOf(payload.sessionId);
    const stage = analyzeCascadeStage(payload.messages);
    const escalated = session ? session.escalationLevel > 0 : false;
    // An empty rung never owns the request: fall down to the next live pool
    // instead of throwing NO_ROUTE on a strict-but-empty tier.
    const pool = (escalated || stage.shouldEscalate)
      ? firstNonEmpty(catalog.capable, catalog.efficient, catalog.lite)
      : firstNonEmpty(catalog.efficient, catalog.lite);
    const picked = this.keyPool ? this.keyPool.pickKey(this.candidateRoutes(pool, 6)) : null;
    if (!picked) throw Object.assign(new Error('no venom-pro route has a live key'), { code: 'NO_ROUTE' });
    if (session && stage.shouldEscalate) {
      session.escalationLevel += 1;
      session.consecutiveToolErrors = stage.consecutiveErrors;
    }
    const handoff = (session && session.escalationLevel > 0)
      ? `\n\n[VENOM CASCADE HANDOFF: escalated to flagship tier after ${stage.consecutiveErrors} tool error(s). Continue the task, do not restart it.]`
      : '';
    return this.dispatch(picked, { ...payload,
      reasoningEffort: (escalated || stage.shouldEscalate) ? 'high' : 'medium', handoff });
  }

  async routeMax(payload) {
    const panel = ((this.smartCatalog && this.smartCatalog.max) || []).slice(0, 3);
    const routes = this.keyPool ? panel.map((row, index) => {
      const keys = [...this.keyPool.keys.values()].filter((k) => k.providerId === row.providerId);
      const key = keys[index % Math.max(1, keys.length)] || keys[0];
      return key ? { keyId: key.id, providerId: row.providerId, modelId: row.modelId, row } : null;
    }).filter(Boolean) : [];
    if (!routes.length) throw Object.assign(new Error('no venom-max route has a live key'), { code: 'NO_ROUTE' });
    if (routes.length === 1) return this.dispatch(routes[0], { ...payload, reasoningEffort: 'high' });
    const drafts = await Promise.allSettled(routes.map((route) => this.dispatch(route, { ...payload, reasoningEffort: 'high' })));
    const fulfilled = drafts.filter((d) => d.status === 'fulfilled').map((d) => d.value);
    if (!fulfilled.length) throw drafts.find((d) => d.status === 'rejected').reason;
    if (fulfilled.length < 2) return { ...fulfilled[0], panelSize: 1, model: 'venom-max' };
    // Lead Analyst synthesis: the first route merges the parallel drafts
    // into one answer (consensus kept, contradictions resolved). A bare
    // longest-draft pick is the fallback, never the plan.
    const leadRoute = routes[0];
    const brief = fulfilled.map((draft, index) =>
      `--- Draft ${index + 1} (via ${draft.routedVia || 'unknown route'}) ---\n${String(draft.text || '').slice(0, 6000)}`)
      .join('\n\n');
    const mergeMessages = [...(Array.isArray(payload.messages) ? payload.messages : []),
      { role: 'user', content: `You are the Lead Analyst. Merge the ${fulfilled.length} panel drafts below into one final answer: keep every point the drafts agree on, resolve contradictions by choosing the best-supported claim, and drop filler. Answer directly, no meta-commentary.\n\n${brief}` }];
    try {
      const merged = await this.dispatch(leadRoute, { ...payload,
        messages: mergeMessages, reasoningEffort: 'high', synthesis: true });
      return { ...merged, panelSize: fulfilled.length, model: 'venom-max', synthesis: 'lead-analyst' };
    } catch (_) {
      fulfilled.sort((a, b) => String(b.text || '').length - String(a.text || '').length);
      return { ...fulfilled[0], panelSize: fulfilled.length, model: 'venom-max', synthesis: 'longest-draft-fallback' };
    }
  }

  // Ordered failover chain for streaming: tier rank first, then the
  // least-recently-failed key, so the first live route wins.
  orderedRoutes(candidates = []) {
    const rank = (route) => {
      const key = this.keyPool ? this.keyPool.keys.get(route.keyId) : null;
      const tier = (key && key.tier) || 'paid';
      return TIER_RANK.has(tier) ? TIER_RANK.get(tier) : TIER_RANK.size;
    };
    const failures = (route) => (this.keyPool ? this.keyPool.providerFailures.get(route.keyId) || 0 : 0);
    return [...candidates].sort((a, b) => (rank(a) - rank(b)) || (failures(a) - failures(b)));
  }

  streamPool(tier) {
    const catalog = this.smartCatalog || {};
    if (tier === 'venom-lite') return catalog.lite || [];
    if (tier === 'venom-max') return (catalog.max || []).slice(0, 3);
    return firstNonEmpty(catalog.efficient, catalog.lite);
  }

  // True SSE passthrough: the first route answering 200 OK owns the client
  // connection and its bytes are piped chunk by chunk. Failover across routes
  // happens only before the first chunk; afterwards the connection is pinned.
  async routeStream(tier, payload = {}, { clientRes = null, pipe = null, onFirstUpstream = null } = {}) {
    if (typeof this.streamUpstream !== 'function') {
      throw Object.assign(new Error('no streaming dispatcher wired'), { code: 'NO_STREAM' });
    }
    if (typeof pipe !== 'function') {
      throw Object.assign(new Error('no stream pipe wired'), { code: 'NO_STREAM' });
    }
    const pool = this.streamPool(tier);
    const routes = this.orderedRoutes(this.candidateRoutes(pool, 6));
    if (!routes.length) throw Object.assign(new Error(`no ${tier} route has a live key`), { code: 'NO_ROUTE' });
    let failovers = 0;
    let lastError = null;
    for (const route of routes) {
      let upstream;
      try {
        upstream = await this.streamUpstream(route, payload);
      } catch (err) {
        lastError = err;
        failovers += 1;
        continue;
      }
      if (!upstream || upstream.status !== 200 || !upstream.stream) {
        lastError = new Error(`upstream answered ${upstream ? upstream.status : 'empty'}`);
        lastError.status = upstream ? upstream.status : 502;
        failovers += 1;
        continue;
      }
      if (this.keyPool) {
        this.keyPool.reportResult({ keyId: route.keyId, modelId: route.modelId,
          providerId: route.providerId, outcome: 'ok' });
      }
      // The gateway writes the 200 head here, after the upstream status is
      // known and before the first byte moves — never speculatively.
      if (typeof onFirstUpstream === 'function') await onFirstUpstream(route, upstream);
      const piped = await pipe(upstream.stream, clientRes, upstream.headers || {});
      return { ok: true, routedVia: `${route.providerId}/${route.modelId}`, tier,
        failovers, chunks: piped.chunks, bytes: piped.bytes, partial: piped.partial };
    }
    const err = lastError || new Error(`no ${tier} route answered`);
    err.code = (err && err.code) || 'NO_ROUTE';
    throw err;
  }

  async dispatch(route, payload) {
    if (typeof this.dispatchUpstream !== 'function') {
      throw Object.assign(new Error('no upstream dispatcher wired'), { code: 'NO_DISPATCH' });
    }
    const body = { ...(payload.body || {}), model: route.modelId };
    const started = this.now();
    try {
      const result = await this.dispatchUpstream(route, { ...payload, body });
      if (this.keyPool) this.keyPool.reportResult({ keyId: route.keyId, modelId: route.modelId, providerId: route.providerId, outcome: 'ok' });
      return { ...result, routedVia: `${route.providerId}/${route.modelId}`,
        cascadeReason: payload.handoff ? 'escalated' : 'direct', elapsedMs: this.now() - started };
    } catch (err) {
      if (this.keyPool) {
        const status = err && err.status;
        this.keyPool.reportResult({ keyId: route.keyId, modelId: route.modelId, providerId: route.providerId,
          outcome: status === 429 ? 'rate_limit' : status === 402 ? 'payment' : status === 401 || status === 403 ? 'auth' : 'server',
          retryAfterMs: err && err.retryAfterMs });
      }
      throw err;
    }
  }

  route(tier, payload = {}) {
    if (tier === 'venom-lite') return this.routeLite(payload);
    if (tier === 'venom-max') return this.routeMax(payload);
    return this.routePro(payload);
  }
}

// ---------------------------------------------------------------------------
// Local HTTP gateway: OpenAI + Anthropic shapes on 127.0.0.1 only
// ---------------------------------------------------------------------------
// Chunk-by-chunk pipe for a live upstream byte stream. The caller owns the
// response head: this only moves bytes, ends the client exactly once, and
// reports whether the stream broke mid-flight (partial) so the gateway can
// label it. Failover decisions belong to routeStream, before the first chunk.
async function pipeUpstreamStream(upstreamStream, clientRes, _upstreamHeaders = {}) {
  let chunks = 0;
  let bytes = 0;
  let partial = false;
  const write = (chunk) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    chunks += 1;
    bytes += text.length;
    if (clientRes && typeof clientRes.write === 'function') clientRes.write(text);
  };
  try {
    for await (const chunk of upstreamStream) write(chunk);
  } catch (_) {
    partial = true;
  }
  try {
    if (clientRes && typeof clientRes.end === 'function') clientRes.end();
  } catch (_) {
    partial = true;
  }
  return { chunks, bytes, partial };
}

function sendVenomHeaders(res, status, contentType, extra = {}) {
  res.writeHead(status, { 'content-type': contentType,
    'x-venom-routed-via': String(extra.routedVia || 'venom-router'),
    'x-venom-cascade-reason': String(extra.cascadeReason || 'direct') });
}

function sendJson(res, status, value, extraHeaders = {}) {
  sendVenomHeaders(res, status, 'application/json; charset=utf-8', extraHeaders);
  res.end(JSON.stringify(value));
}

// Slice a finished reply into word-safe SSE payloads. Upstream itself is
// fetched whole (api-request buffers today), so this is gateway-level framing:
// clients that demand event streams get valid frames with an early first
// chunk, not a held-open socket waiting on the provider.
function sliceForStream(text, size = 120) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > size) {
    let cut = rest.lastIndexOf(' ', size);
    if (cut < size / 3) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

function writeOpenAiStream(res, tier, text, extra = {}) {
  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);
  sendVenomHeaders(res, 200, 'text/event-stream; charset=utf-8', extra);
  const frame = (delta, finish) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk',
    created, model: tier, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.write(frame({ role: 'assistant' }, null));
  for (const slice of sliceForStream(text)) res.write(frame({ content: slice }, null));
  res.write(frame({}, 'stop'));
  res.end('data: [DONE]\n\n');
}

function writeAnthropicStream(res, tier, text, extra = {}) {
  const id = `msg_${Date.now().toString(36)}`;
  sendVenomHeaders(res, 200, 'text/event-stream; charset=utf-8', extra);
  const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  res.write(event('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: tier } }));
  res.write(event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
  for (const slice of sliceForStream(text)) {
    res.write(event('content_block_delta', { type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: slice } }));
  }
  res.write(event('content_block_stop', { type: 'content_block_stop', index: 0 }));
  res.write(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: text.length } }));
  res.end(event('message_stop', { type: 'message_stop' }));
}

function createVenomHttpGateway({ cascadeEngine = null, port = ROUTER_PORT, host = ROUTER_HOST, log = console } = {}) {
  let server = null;
  let boundPort = null;
  const routes = [];

  function record(method, path) {
    routes.push({ method, path, at: Date.now() });
    if (routes.length > 200) routes.splice(0, routes.length - 200);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => {
        chunks.push(chunk);
        if (Buffer.concat(chunks).length > 8 * 1024 * 1024) reject(new Error('body too large'));
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text) return resolve({});
        try { resolve(JSON.parse(text)); } catch (err) { reject(err); }
      });
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', `http://${host}`);
    const path = url.pathname;
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      record('GET', path);
      const catalog = (cascadeEngine && cascadeEngine.smartCatalog) || {};
      const seen = new Set();
      const data = [...(catalog.lite || []), ...(catalog.efficient || []), ...(catalog.capable || []), ...(catalog.max || [])]
        .filter((row) => {
          const id = `${row.providerId}/${row.modelId}`;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        })
        .slice(0, 50).map((row) => ({ id: `${row.providerId}/${row.modelId}`, object: 'model', owned_by: row.providerId }));
      data.unshift({ id: 'venom-lite', object: 'model', owned_by: 'venom' },
        { id: 'venom-pro', object: 'model', owned_by: 'venom' },
        { id: 'venom-max', object: 'model', owned_by: 'venom' });
      return sendJson(res, 200, { object: 'list', data });
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/messages')) {
      record('POST', path);
      let body;
      try { body = await readBody(req); } catch (_) { return sendJson(res, 400, { error: 'unparsable JSON body' }); }
      const requested = String(body.model || 'venom-pro');
      const tier = requested.startsWith('venom-') ? requested : 'venom-pro';
      const messages = compressToolMessages(body.messages || [{ role: 'user', content: body.input || '' }]);
      // True SSE passthrough when a streaming dispatcher is wired (main):
      // the provider's bytes move chunk by chunk after its 200 OK, with
      // automatic failover to the next route only before the first chunk.
      // Without a streamer (tests, legacy) the finished reply is framed
      // into valid SSE below instead — same contract, buffered source.
      if (body.stream === true && typeof cascadeEngine.routeStream === 'function'
        && typeof cascadeEngine.streamUpstream === 'function') {
        try {
          let headed = false;
          const outcome = await cascadeEngine.routeStream(tier,
            { messages, body, sessionId: body.session_id || body.sessionId || null },
            { clientRes: res,
              pipe: (stream, client, headers) => pipeUpstreamStream(stream, client, headers),
              onFirstUpstream: (route, upstream) => {
                const media = String((upstream.headers || {})['content-type'] || '');
                const contentType = /event-stream/.test(media) ? media : 'text/event-stream; charset=utf-8';
                sendVenomHeaders(res, 200, contentType,
                  { routedVia: `${route.providerId}/${route.modelId}`, cascadeReason: 'direct' });
                headed = true;
              } });
          if (!headed) {
            return sendJson(res, 502, { error: 'upstream opened no stream' });
          }
          record('STREAM', `${path} -> ${outcome.routedVia} (${outcome.chunks} chunks, ${outcome.failovers} failovers)`);
          return;
        } catch (err) {
          const code = err && err.code === 'NO_ROUTE' ? 503 : 502;
          return sendJson(res, code, { error: (err && err.message) || 'upstream failed' });
        }
      }
      try {
        const result = await cascadeEngine.route(tier, { messages, body, sessionId: body.session_id || body.sessionId || null });
        if (body.stream === true) {
          if (path === '/v1/messages') return writeAnthropicStream(res, tier, result.text || '', result);
          return writeOpenAiStream(res, tier, result.text || '', result);
        }
        if (path === '/v1/messages') {
          return sendJson(res, 200, { id: `msg_${Date.now().toString(36)}`, type: 'message', role: 'assistant',
            content: [{ type: 'text', text: result.text || '' }], model: tier }, result);
        }
        const text = result.text || '';
        const rescued = rescuePlainTextToolCalls(text);
        return sendJson(res, 200, { id: `chatcmpl-${Date.now().toString(36)}`, object: 'chat.completion',
          created: Math.floor(Date.now() / 1000), model: tier,
          choices: [{ index: 0, message: { role: 'assistant', content: text, ...(rescued ? { tool_calls: rescued } : {}) }, finish_reason: rescued ? 'tool_calls' : 'stop' }] }, result);
      } catch (err) {
        const code = err && err.code === 'NO_ROUTE' ? 503 : 502;
        return sendJson(res, code, { error: (err && err.message) || 'upstream failed' });
      }
    }
    record(req.method, path);
    return sendJson(res, 404, { error: 'unknown venom-router path' });
  }

  return {
    isListening() { return server !== null; },
    port() { return boundPort || port; },
    start() {
      return new Promise((resolve, reject) => {
        if (server) return resolve({ host, port, already: true });
        server = http.createServer(handle);
        server.on('error', (err) => {
          // A busy port never blocks the app: the desktop works without the
          // local gateway, so this stays a warning, not a boot failure.
          (log.warn || log.info || console.warn).call(log, `venom-router gateway not started on ${host}:${port}:`, err.message);
          server = null;
          reject(err);
        });
        server.listen(port, host, () => {
          const bound = server && server.address() && server.address().port;
          boundPort = bound || port;
          resolve({ host, port: boundPort });
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (!server) return resolve(false);
        boundPort = null;
        server.close(() => resolve(true));
        server = null;
      });
    },
    routes: () => [...routes],
  };
}

module.exports = { ROUTER_PORT, ROUTER_HOST, normalizeGatewayPort, canonicalSlug, upstreamModelId,
  evaluateModelCapabilities, compressToolMessages, rescuePlainTextToolCalls,
  analyzeCascadeStage, rowCost, formatModelDisplayName, isRoutableTextRow,
  buildSmartCatalog, buildProfilesPayload,
  KeyPoolManager, persistCatalogScores,
  readCatalogScores, VenomCascadeEngine, pipeUpstreamStream, createVenomHttpGateway };
