# Data-Driven Multi-Provider Config — Design

Date: 2026-09-22
Status: Approved (Approach A)

## Problem

The config file (`config.json` in `app.getPath('userData')`) is only written
lazily, the first time a key is added to the `nara` provider. Until then no
config exists on disk. The app is also hardcoded to a single provider (`nara`)
even though it is meant to support many providers.

Goals:
1. The config file exists and is ready to hold multiple providers from first
   launch — not created lazily on first key add.
2. Providers are data-driven: new OpenAI-compatible providers can be added from
   the UI (stored in config) without code changes.
3. Built-in providers stay defined in code so they cannot be corrupted and so
   future app updates can ship new built-ins automatically.

Constraint confirmed with user: **all providers are OpenAI-compatible**
(`GET /models`, `POST /chat/completions`). The nara-specific free/freemium plan
filtering (`GET /api/plans`) remains a per-provider capability, active only when
a provider defines a `plansUrl`.

## Approach (A): built-in defaults registry + config merge

Built-in providers are code-defined templates. The config file stores only
user-mutable data for built-ins (keys, baseUrl override) plus full definitions
for user-added custom providers. At runtime the two are merged into the
`PROVIDERS` map the rest of the app already consumes.

## Config schema (version 1)

```json
{
  "version": 1,
  "providers": {
    "nara": {
      "keys": [{ "id": "key_...", "name": "...", "key": "...", "active": true }],
      "baseUrl": "https://router.bynara.id/v1"
    },
    "prov_1699999999": {
      "custom": true,
      "name": "My Provider",
      "baseUrl": "https://api.example.com/v1",
      "color": "#7b2ff7",
      "keys": []
    }
  }
}
```

- Built-in provider entry: only `keys` and optional `baseUrl` override are
  persisted. Endpoints, `plansUrl`, and `color` come from code.
- Custom provider entry: full definition with `custom: true`. Custom providers
  have no `plansUrl`.
- `version` supports future migrations.

## main.js changes

- Add `CONFIG_VERSION = 1` and `getDefaultConfig()` → `{ version: 1, providers: {} }`.
- `readConfig()` becomes robust: if the file is missing, write the default and
  return it; if present but missing `version`, add it; always ensure
  `providers` is an object. (Light in-place migration.)
- Call an `ensureConfig()` step inside `app.whenReady()` before `createWindow()`
  so the file exists on disk from the first launch.

## app.js changes

- Rename the hardcoded `PROVIDERS` object to `BUILTIN_PROVIDERS` (immutable
  templates; nara keeps `plansUrl`, endpoints, `color`).
- At `init()`, build the runtime `PROVIDERS` map (keep this name to minimize the
  diff across existing references):
  1. Deep-clone each built-in template.
  2. Overlay persisted `keys` and `baseUrl` from config.
  3. Add every `custom` provider found in config.
- Replace `loadProviderConfig(id)` with `loadAllProviders()` — reads config once
  and hydrates all providers.
- `saveProviderConfig(id)` persists `keys` and `baseUrl` for the provider; for a
  custom provider it also persists the definition fields (`custom`, `name`,
  `color`, `baseUrl`).
- `addProvider({ name, baseUrl })`: generate an id (`prov_<timestamp>`), pick a
  color from a small palette, set `custom: true`, `keys: []`; persist; re-render
  tabs; switch to the new provider.
- `removeProvider(id)`: only allowed for custom providers; removes from runtime
  map and config; falls back to the first remaining provider.
- `renderProviderTabs()` (already dynamic): append a "+ Add Provider" control;
  custom tabs get a small delete (×) affordance.
- `fetchModels` branches on `p.plansUrl`:
  - **has `plansUrl`** (nara): existing free/freemium filtering and grouping.
  - **no `plansUrl`** (custom): keep all models from `/models`, mark them under a
    single generic group (`groupName: 'MODELS'`), skip free/freeForPaid flags.
- `renderModelsList()` handles providers without free grouping: if the provider
  has no `plansUrl`, render all models under one "MODELS" group instead of the
  FREE / FREE FOR PAID groups.
- `buildRowHtml()` plan icon: only show a tier icon for providers that have plan
  data; otherwise omit it.

## UI

- "+ Add Provider" button beneath the provider tabs opens a small modal with two
  fields: Name and Base URL. New provider is assumed OpenAI-compatible.
- Custom provider tabs show a small × to delete.

## Error handling

- Add provider validation: non-empty name and baseUrl; baseUrl must parse as a
  valid URL; reject a name that duplicates an existing provider.
- Config read/write stays wrapped in try/catch (already present); a corrupt or
  missing file resolves to the default config rather than throwing.

## Testing

No test framework in the project (only `start`/`build` scripts). Manual
verification via `npm start`:

1. Fresh launch with no existing config → `config.json` is created with
   `{ "version": 1, "providers": {} }`.
2. Add a custom provider → appears as a tab and persists.
3. Fetch models on the custom provider → all `/models` entries are shown (no
   plan filtering).
4. Add a key, run a test → works as before.
5. Switch between provider tabs → keys and models are per-provider.
6. Delete the custom provider → removed; built-ins remain.
7. Restart the app → all changes persisted.

## Out of scope

- Non-OpenAI-compatible providers / adapter system.
- Editing built-in provider endpoints from the UI.
- Importing/exporting provider configs.
