# Provider Integrations

Reference material for provider integrations used by, or investigated for,
VENOM Router.

## Important distinction

A document in this directory is **not** proof that the provider is currently
available in the application. A provider is built in only when all of these are
true:

1. `src/renderer/providers/<id>.js` exists and registers in
   `window.INTEGRATED_PROVIDERS`.
2. `src/renderer/index.html` loads that module before `app.js`.
3. Its logo and live fixture/count updates are present where required.
4. The provider count and relevant tests/live checks pass.

The current application has **nine** built-in provider modules. Check the source
and [README.md](../../README.md) for the authoritative current list. The table
below may also contain research references for providers not yet loaded by the
app.

## Reference index

| Provider | Doc | Status / description |
|---|---|---|
| Apinex | [APINEX.md](./APINEX.md) | Research reference; no current built-in adapter is present. |
| KiosAPI | [KIOSAPI.md](./KIOSAPI.md) | Research reference; no current built-in adapter is present. |
| DarkAPI | [DARKAPI.md](./DARKAPI.md) | Built-in adapter reference. |
| Nara | [NARA.md](./NARA.md) | Built-in adapter reference: per-key allowlist and account quota. |
| Nexum | [NEXUM.md](./NEXUM.md) | Built-in adapter reference: router/subscription behavior. |
| Mirai | — | Built-in adapter; no separate reference file is currently present. |
| Experiential | [EXPERIENTIAL.md](./EXPERIENTIAL.md) | Built-in adapter reference: gateway catalogue and free-only rules. |
| Inception | [INCEPTION.md](./INCEPTION.md) | Built-in adapter reference: catalogue and chat/error behavior. |
| Jerouter | [JEROUTER.md](./JEROUTER.md) | Built-in adapter reference: public roster and subscription behavior. |
| Devora | [DEVORA.md](./DEVORA.md) | Built-in adapter reference: event/unlimited subscription behavior. |
| Token Harbor | [TOKENHARBOR.md](./TOKENHARBOR.md) | Built-in adapter reference: `:free` routes and quota headers. |

## Evidence rules

Provider docs must label whether a statement is source-code, documentation,
screenshot, keyless live-probe or with-key verified evidence. Never put a real key
value in a document. Unverified with-key behavior must remain explicitly marked
as unverified, and a provider's documented model roster must not be treated as a
successful chat probe.
