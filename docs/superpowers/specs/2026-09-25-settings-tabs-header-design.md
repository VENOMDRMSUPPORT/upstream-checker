# Design Document: Settings Toolbar & Two-Card Layout

**Date:** 2026-09-25 (revised 2026-09-26 to match the shipped implementation)
**Status:** Implemented
**Topic:** Settings page navigation and header

---

## 1. Overview

The original proposal replaced the vertical settings list with horizontal
segmented tabs. That direction was dropped. What shipped keeps a vertical
category list, but moves it into a card and puts a breadcrumb toolbar above
the page, so Settings uses the same card language as Overview and Providers.

Goals (as built):
1. A top toolbar (`.settings-toolbar`) styled like `.pv-toolbar`, holding the
   breadcrumb `Overview > Settings > [Active section]`.
2. A two-column grid: a sticky **Categories** card on the left and a **main**
   card on the right that shows the active section.
3. The main card's header shows the active section's icon, title and a
   one-line description, all kept in sync with the selected category.
4. Works in both Dark (`vercel`) and Light (`daylight`) themes and collapses
   to one column on narrow windows.

---

## 2. Structure (`src/renderer/index.html`)

```
section.page-settings
  div.settings-toolbar
    nav.crumbs#settings-crumbs
  div.settings-layout-grid
    aside.settings-panel-card.settings-categories-panel
      div.settings-panel-head        (icon, "Categories", "Settings & configuration")
      div.settings-panel-body
        nav.settings-side-nav#settings-nav[role=tablist]
          button.settings-nav-item[data-section=sec-…]  x10
    main.settings-panel-card.settings-main-panel
      div.settings-panel-head
        span#settings-main-head-icon
        span#settings-main-head-title
        span#settings-main-head-desc
      div.settings-panel-body
        div#settings-estimate
        section.settings-section#sec-…  x10
```

### Sections (in nav order)

| id               | Label              | Description                                           |
| ---------------- | ------------------ | ----------------------------------------------------- |
| sec-appearance   | Appearance         | Theme, accent colour and how dense the results table is |
| sec-test         | Test & Prompts     | The prompt and the pass rule for each kind of model   |
| sec-schedule     | Schedule           | Automatic re-tests, health checks and alerts          |
| sec-speed        | Speed & Timeouts   | Latency colours, and how long a model may take        |
| sec-reliability  | Reliability        | Hedging, models tested at once, and retries           |
| sec-catalog      | Model Catalog      | How the catalogue syncs, benchmarks and ranks models  |
| sec-history      | History            | How many runs are kept, and exporting them            |
| sec-logs         | Diagnostics & Logs | What is logged about each request, and where          |
| sec-data         | Data Directory     | Where your settings, keys and history are stored      |
| sec-about        | About Upstream     | Version, providers and updates                        |

Labels and descriptions live in `SETTINGS_SECTIONS_META` in `app.js`.

---

## 3. Styles (`src/renderer/styles.css`)

- `.settings-toolbar`: bordered card, `var(--radius-lg)`, 1px accent gradient
  line via `::before`. Glass gradient in `vercel`, plain surface with a light
  shadow in `daylight`.
- `.settings-layout-grid`: `grid-template-columns: 240px minmax(0, 1fr)`,
  18px gap.
- `.settings-panel-card`: same card as `.ov-panel`; `.settings-panel-head`
  has an icon tile, title, meta line and the accent line.
- `.settings-categories-panel`: `position: sticky; top: 0`, with a
  `max-height` so a short window can still reach every category (the list
  scrolls inside).
- The page scrolls as a whole, not the main card.
- `@media (max-width: 960px)`: the grid becomes one column and the categories
  card is no longer sticky. `@media (max-width: 760px)`: tighter page padding.

---

## 4. Behaviour (`src/renderer/app.js`)

- `renderSettingsCrumbs(label)` renders the breadcrumb with `breadcrumbHTML()`.
- `switchSettingsSection(id)`:
  - sets `.active` / `aria-selected` on the matching nav item;
  - hides every `.settings-section` except the target;
  - if the page is scrolled past the grid, scrolls back so the new section
    opens at its top;
  - updates the main card's title, description and icon (cloned from the nav
    item's own icon, so the two can't drift apart);
  - re-renders the breadcrumb, calls `renderCostEstimate()` and `syncRoute()`
    (the section is part of the `#/settings/<section>` route).
- `prepareSettingsPage()` refills the form, then re-selects the active
  section (default `sec-appearance`).
- A click on `#settings-nav` switches section; a click on `[data-go]` inside
  the page navigates to that page.

---

## 5. Cleanup

The rules left over from the old layout (`.settings-panel`, `.settings-page …`,
`.settings-header`, `.settings-body`, `.settings-nav`, `.settings-nav-group`,
`.settings-content`) matched nothing in `index.html` or the scripts and were
removed on 2026-09-26. The base `.settings-nav-item` and `.settings-nav-icon`
rules stay, since the current nav uses them.
