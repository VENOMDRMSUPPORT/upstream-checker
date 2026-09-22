# NARA Provider Module + Reliability + Speed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the NARA integrated provider into its own module, add retry-with-backoff to model testing, and run tests through a concurrency pool.

**Architecture:** Integrated providers register themselves into `window.INTEGRATED_PROVIDERS` from their own `<script>` module (loaded before `app.js`). `app.js` builds `BUILTIN_PROVIDERS` from that registry and delegates model discovery to each provider's `fetchModels` adapter; custom providers use the existing generic path. Testing gets retry on transient failures and a fixed 5-worker concurrency pool.

**Tech Stack:** Electron 33, vanilla JS, no bundler (classic `<script>` tags), config via IPC.

**Spec:** [docs/superpowers/specs/2026-09-22-nara-module-reliability-speed-design.md](../specs/2026-09-22-nara-module-reliability-speed-design.md)

## Global Constraints

- English only on disk. 2-space indent, single quotes, semicolons.
- No automated test framework: verify with `node --check` on changed JS files + an Electron launch that does not crash the renderer; interactive flows need a human. Never leave a hanging electron process (`taskkill //F //IM electron.exe`, Git Bash double-slash).
- `makeRuntimeProvider` uses `structuredClone` — provider `meta` must be plain data (NO functions). Adapter functions live only in `window.INTEGRATED_PROVIDERS`.
- Fixed defaults: `TEST_CONCURRENCY = 5`, `MAX_TEST_RETRIES = 2`, retryable HTTP `{429,502,503,504}`, backoff `600 * 2^attempt` + jitter; 429 honors `Retry-After` (cap 10s).
- nara behavior (free/freemium filtering) must stay identical; custom-provider generic fetch must stay identical.

---

### Task 1: Extract NARA into its own integrated-provider module

**Files:**
- Create: `src/renderer/providers/nara.js`
- Modify: `src/renderer/index.html` — add the script tag before `app.js` (near line 326)
- Modify: `src/renderer/app.js` — replace `BUILTIN_PROVIDERS` literal (lines 15-26) with a registry build; delegate the fetch handler's plans-aware branch (lines 403-453) to the adapter

**Interfaces:**
- Produces: `window.INTEGRATED_PROVIDERS.nara = { meta, fetchModels(ctx) }` where `ctx = { apiKey, baseUrl, plansUrl, apiRequest, formatContext, getFreeGroupName }` and `fetchModels` resolves to an array of model objects (same shape the fetch handler previously built). `BUILTIN_PROVIDERS` becomes a map built from `window.INTEGRATED_PROVIDERS[*].meta`.

- [ ] **Step 1: Create `src/renderer/providers/nara.js`**

```javascript
// ============================================
// NARA Router — integrated provider module
// Registers into window.INTEGRATED_PROVIDERS; loaded before app.js.
// meta is plain data (structuredClone-safe); fetchModels lives only here.
// ============================================
window.INTEGRATED_PROVIDERS = window.INTEGRATED_PROVIDERS || {};

window.INTEGRATED_PROVIDERS.nara = {
  meta: {
    id: 'nara',
    name: 'NARA Router',
    baseUrl: 'https://router.bynara.id/v1',
    plansUrl: 'https://router.bynara.id/api/plans',
    color: '#00d4ff',
    modelsEndpoint: '/models',
    plansEndpoint: '/api/plans',
    chatEndpoint: '/chat/completions',
  },

  // Plan-aware discovery: keep only free / free-for-paid models.
  async fetchModels({ apiKey, baseUrl, plansUrl, apiRequest, formatContext, getFreeGroupName }) {
    const [modelsResult, plansResult] = await Promise.all([
      apiRequest({
        url: `${baseUrl}/models`,
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      }),
      apiRequest({
        url: plansUrl,
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);

    if (modelsResult.status !== 200) throw new Error(`HTTP ${modelsResult.status}`);
    const rawModels = JSON.parse(modelsResult.body).data || [];

    const planModels = {};
    if (plansResult.status === 200) {
      JSON.parse(plansResult.body).data?.forEach((plan) => {
        planModels[plan.code] = { name: plan.name, models: plan.models || [] };
      });
    }

    const freeIds = new Set(planModels['free']?.models || []);
    const freemiumIds = new Set(planModels['freemium']?.models || []);
    const allowedIds = new Set([...freeIds, ...freemiumIds]);

    return rawModels
      .filter((m) => allowedIds.has(m.id))
      .map((m) => {
        const isFree = freeIds.has(m.id);
        const isFreeForPaid = !isFree && freemiumIds.has(m.id);
        return {
          ...m,
          isFree,
          isFreeForPaid,
          noPlans: false,
          groupName: getFreeGroupName(isFree ? 'free' : 'freemium'),
          hasVision: !!m.vision,
          hasReasoning: !!m.reasoning,
          contextLabel: formatContext(m.context_window),
        };
      })
      .sort((a, b) => {
        if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
        return a.id.localeCompare(b.id);
      });
  },
};
```

- [ ] **Step 2: index.html — load the module before app.js**

Find the line `  <script src="app.js"></script>` (near line 326) and insert immediately ABOVE it:

```html
  <script src="providers/nara.js"></script>
```

- [ ] **Step 3: app.js — build `BUILTIN_PROVIDERS` from the registry**

Replace lines 15-26 (the whole `const BUILTIN_PROVIDERS = { nara: {...} };` literal) with:

```javascript
// Built-in providers register their metadata into window.INTEGRATED_PROVIDERS
// (see src/renderer/providers/*.js, loaded before this file).
const BUILTIN_PROVIDERS = {};
Object.values(window.INTEGRATED_PROVIDERS || {}).forEach((entry) => {
  BUILTIN_PROVIDERS[entry.meta.id] = { ...entry.meta };
});
```

- [ ] **Step 4: app.js — delegate the fetch handler to the adapter**

In the `#btn-fetch-models` handler, replace the `if (p.plansUrl) { ... } else { ... }` block (lines 403-478) with a version that uses the adapter when present and keeps the generic path otherwise:

```javascript
    const adapter = (window.INTEGRATED_PROVIDERS || {})[p.id];
    if (adapter && adapter.fetchModels) {
      // Integrated provider: delegate discovery to its module
      models = await adapter.fetchModels({
        apiKey,
        baseUrl: p.baseUrl,
        plansUrl: p.plansUrl,
        apiRequest: window.electronAPI.apiRequest,
        formatContext,
        getFreeGroupName,
      });
    } else {
      // Plain OpenAI-compatible provider: show all models, no plan filtering
      const modelsResult = await window.electronAPI.apiRequest({
        url: `${p.baseUrl}/models`,
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      });
      if (modelsResult.status !== 200) throw new Error(`HTTP ${modelsResult.status}`);
      const rawModels = JSON.parse(modelsResult.body).data || [];

      models = rawModels
        .map((m) => ({
          ...m,
          isFree: false,
          isFreeForPaid: false,
          noPlans: true,
          groupName: 'MODELS',
          hasVision: !!m.vision,
          hasReasoning: !!m.reasoning,
          contextLabel: formatContext(m.context_window),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
```

(The line `p.models = [...models];` immediately after this block, and the status-message block that follows using `if (p.plansUrl)`, stay UNCHANGED. `p.plansUrl` is still present on the runtime provider for nara via its `meta`, so the free-count status still shows for nara and the plain message for custom providers.)

- [ ] **Step 5: Verify**

`node --check src/renderer/providers/nara.js` and `node --check src/renderer/app.js` (both must pass — note: `nara.js` references `window`, which `node --check` only parses, not runs, so this is fine). Launch: `rm -f "$APPDATA/upstream-checker/config.json"`, `npm start &`, `sleep 8`, check stdout/stderr for renderer exceptions (a load-order bug would throw "Cannot read properties of undefined (reading 'meta')" or leave nara tab missing), then `taskkill //F //IM electron.exe`; confirm none remain. Statically confirm: `providers/nara.js` script tag precedes `app.js` in index.html; `BUILTIN_PROVIDERS` is built from the registry; the fetch handler delegates to `adapter.fetchModels`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/providers/nara.js src/renderer/index.html src/renderer/app.js
git commit -m "refactor: extract NARA into its own integrated-provider module"
```

---

### Task 2: Retry with backoff + concurrency pool

**Files:**
- Modify: `src/renderer/app.js` — add `sleep`/`retryDelay` + retry loop in `testModel` (lines 591-650); rewrite the Test-All handler loop (lines 678-691) as a concurrency pool; add constants

**Interfaces:**
- Consumes: `testModel(model, apiKey, baseUrl)` (now retrying), `abortTesting`, `addResultRow`, `updateResultRow`, `updateStats`, `showProgress`, `getSelectedModels`.
- Produces: module constants `TEST_CONCURRENCY = 5`, `MAX_TEST_RETRIES = 2`, `RETRYABLE_STATUS`; helpers `sleep(ms)`, `retryDelay(attempt, result)`.

- [ ] **Step 1: Add constants + helpers above `testModel`**

Directly above the `// Test a single model` comment block (line 588), insert:

```javascript
// ============================================
// Test reliability + concurrency settings
// ============================================
const TEST_CONCURRENCY = 5;
const MAX_TEST_RETRIES = 2;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Backoff between retries; honors Retry-After (seconds) for 429, capped at 10s.
function retryDelay(attempt, result) {
  if (result && result.status === 429 && result.headers) {
    const ra = parseInt(result.headers['retry-after'], 10);
    if (!isNaN(ra) && ra > 0) return Math.min(ra * 1000, 10000);
  }
  return 600 * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
}
```

- [ ] **Step 2: Rewrite `testModel` with a retry loop**

Replace the whole `testModel` function (lines 591-650) with:

```javascript
async function testModel(model, apiKey, baseUrl) {
  // Reasoning models need higher max_tokens + reasoning_effort
  const isReasoning = model.hasReasoning;
  const maxTokens = isReasoning ? 256 : DEFAULT_MAX_TOKENS;

  const payload = {
    model: model.id,
    messages: [{ role: 'user', content: DEFAULT_TEST_PROMPT }],
    max_tokens: maxTokens,
    stream: false,
  };
  if (isReasoning) {
    payload.reasoning_effort = 'low';
  }

  let lastResult = { status: 'fail', response: 'Request failed', time: 0, tokens: 0 };

  for (let attempt = 0; attempt <= MAX_TEST_RETRIES; attempt++) {
    if (abortTesting) return lastResult;
    try {
      const result = await window.electronAPI.apiRequest({
        url: `${baseUrl}/chat/completions`,
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (result.status === 200) {
        const data = JSON.parse(result.body);
        const choice = data.choices?.[0];
        const usage = data.usage || {};

        let content = choice?.message?.content?.trim() || '';
        if (!content && choice?.message?.reasoning_content) {
          content = choice.message.reasoning_content.trim();
        }

        const isEmpty = !content;
        return {
          status: 'pass',
          response: isEmpty ? '(reasoning only — no visible output)' : content,
          isEmpty,
          time: result.elapsed,
          tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
        };
      }

      // Non-200
      let errMsg = `HTTP ${result.status}`;
      try {
        const errData = JSON.parse(result.body);
        errMsg = errData.error?.message || errMsg;
      } catch (_) {}
      lastResult = { status: 'fail', response: errMsg, time: result.elapsed, tokens: 0, statusCode: result.status };

      if (RETRYABLE_STATUS.has(result.status) && attempt < MAX_TEST_RETRIES && !abortTesting) {
        await sleep(retryDelay(attempt, result));
        continue;
      }
      return lastResult;
    } catch (err) {
      // Network error / timeout — retryable
      lastResult = { status: 'fail', response: err.error || err.message || 'Request failed', time: err.elapsed || 0, tokens: 0 };
      if (attempt < MAX_TEST_RETRIES && !abortTesting) {
        await sleep(retryDelay(attempt, null));
        continue;
      }
      return lastResult;
    }
  }

  return lastResult;
}
```

- [ ] **Step 3: Rewrite the Test-All loop as a concurrency pool**

In the `#btn-test-all` handler, replace the sequential `for` loop (lines 678-691) with:

```javascript
  // Pre-create rows in selection order so the table stays stable while
  // workers complete out of order.
  selected.forEach((model) =>
    addResultRow(model, { status: 'running', time: 0, response: 'Testing...', tokens: '-' })
  );

  let cursor = 0;
  let completed = 0;

  async function worker() {
    while (!abortTesting) {
      const i = cursor++;
      if (i >= selected.length) return;
      const model = selected[i];
      const result = await testModel(model, apiKey, baseUrl);
      if (abortTesting) return;
      testResults.push({ model: model.id, ...result, provider: p.name, group: model.groupName || '' });
      updateResultRow(model, result);
      updateStats();
      completed++;
      showProgress(completed, selected.length);
    }
  }

  const poolSize = Math.min(TEST_CONCURRENCY, selected.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));
```

(The lines before it — `initResultsTable();` and the button spinner — and the lines after it — `hideProgress(); isTesting = false; ...` summary — stay UNCHANGED.)

- [ ] **Step 4: Verify**

`node --check src/renderer/app.js` (must pass). Launch: `npm start &`, `sleep 8`, check stdout/stderr for renderer exceptions, `taskkill //F //IM electron.exe`, confirm none remain. Statically confirm: `testModel` loops up to `MAX_TEST_RETRIES`, returns 200 immediately, retries only `RETRYABLE_STATUS`/transport errors, honors `Retry-After`; the Test-All handler pre-creates rows then runs `poolSize` workers off a shared `cursor`, progress uses `completed`, and `abortTesting` stops workers.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app.js
git commit -m "feat: retry transient test failures and run tests with a concurrency pool"
```

---

## Self-Review

**Spec coverage:**
- NARA extracted to its own module + registry + adapter delegation → Task 1. ✓
- Generic custom-provider path preserved → Task 1 Step 4 (else branch). ✓
- `structuredClone`-safe meta (adapter kept out of meta) → Task 1 Step 1/3. ✓
- Retry with backoff, retryable set, Retry-After, abort → Task 2 Steps 1-2. ✓
- Concurrency pool of 5, stable row order, progress by completed, abort → Task 2 Step 3. ✓
- Fixed defaults, no new UI → constants in Task 2 Step 1. ✓

**Placeholder scan:** No TBD/TODO; all code steps concrete. ✓

**Type consistency:** `window.INTEGRATED_PROVIDERS.nara.meta` fields match `makeRuntimeProvider` expectations (plain data). `fetchModels` ctx keys (`apiKey/baseUrl/plansUrl/apiRequest/formatContext/getFreeGroupName`) match the call site in Task 1 Step 4. `TEST_CONCURRENCY`/`MAX_TEST_RETRIES`/`RETRYABLE_STATUS`/`sleep`/`retryDelay` defined in Task 2 Step 1, used in Steps 2-3. `testModel(model, apiKey, baseUrl)` signature unchanged. Result object shape (`status/response/time/tokens/isEmpty/statusCode`) unchanged, so `updateResultRow`/`updateStats`/CSV keep working. ✓
