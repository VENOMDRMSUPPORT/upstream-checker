# Provider Name in Config + Edit From UI — Design

Date: 2026-09-22
Status: Approved

## Problem / user feedback

After the data-driven provider work landed, the user observed:
1. The built-in provider name "NARA Router" is code-only and does not appear in
   `config.json` (config stored only `keys` + `baseUrl` for built-ins). The user
   wants the JSON to be the source of truth for the provider name, and to enter
   the name when adding a provider. For nara (the first integrated provider), the
   name should be config-driven and editable.
2. The "+" add-provider button (rendered as a lone tab-shaped button floating
   after the tabs) looks bad and is poorly placed.
3. The always-visible Base URL field in the sidebar is not useful; the URL only
   needs to live in the JSON.
   The user also wants to be able to edit the provider name and URL from the UI.

## Decisions

- **Config is the source of truth for `name` and `baseUrl` (all providers,
  including nara).** `BUILTIN_PROVIDERS` in code remains the seed and the
  fallback for fields NOT edited from the UI: `plansUrl`, `color`, `endpoints`.
- On first launch, each built-in is **seeded** into `config.json` with its
  `name`, `baseUrl`, and empty `keys`, so the name is visible and editable.
- Editing a built-in's `baseUrl` does NOT change its `plansUrl` (a separate
  code-defined URL); nara's free/freemium filtering stays intact.
- **Name + baseUrl are editable from the UI** via a generalized provider modal
  (Add / Edit). Each provider tab gets an edit (pencil) action; custom providers
  also keep the delete (×). nara is editable but not deletable.
- The "+" button moves to a small icon button beside the "PROVIDER" section
  label, matching the existing sidebar affordance style.
- The sidebar **ENDPOINT / Base URL** section is removed. baseUrl is set/edited
  only through the provider modal.

## Persistence model

`config.json` (version 1). Per provider entry now always includes `name`,
`baseUrl`, `keys`; custom providers add `custom: true` and `color`:

```json
{
  "version": 1,
  "providers": {
    "nara": { "name": "NARA Router", "baseUrl": "https://router.bynara.id/v1", "keys": [] },
    "prov_...": { "custom": true, "name": "My Provider", "baseUrl": "https://api.example.com/v1", "color": "#7b2ff7", "keys": [] }
  }
}
```

On load: built-in = code template with config `name`/`baseUrl`/`keys` overlaid
(config wins). Missing built-in entries are seeded and written back.

## UI

- PROVIDER section label carries a small "+" icon button (`#btn-add-provider`)
  that opens the modal in add mode.
- Each provider tab: colored dot + name + right-aligned actions (pencil edit for
  all; × delete for custom only).
- Provider modal (`#add-provider-modal`) is reused for add and edit: title and
  submit-button label switch on mode; edit prefills name + baseUrl.
- ENDPOINT/Base URL sidebar section removed, along with the `#base-url` change
  handler and the two `$('#base-url').value = ...` assignments.

## Error handling

- Add/edit validation: non-empty name + baseUrl; baseUrl parses via `new URL`;
  duplicate name rejected (case-insensitive, excluding the provider being
  edited). Trailing slashes trimmed with `/\/+$/`.

## Testing

No automated test framework. Manual via `npm start`:
1. Fresh config → launch → `config.json` shows `providers.nara` with
   `name: "NARA Router"` and its baseUrl.
2. Edit nara's name/URL from the pencil → persists; JSON updates; plans/free
   filtering still works after a baseUrl edit.
3. Add a custom provider (name entered) → appears, persists.
4. Edit a custom provider; delete a custom provider (nara has no delete).
5. No Base URL field in the sidebar; "+" sits beside the PROVIDER label.

## Out of scope

- Editing `plansUrl`, `color`, or `endpoints` from the UI.
- Non-OpenAI-compatible providers.
