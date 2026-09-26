# Settings Toolbar & Two-Card Layout — Implementation Plan

**Status:** Done. Revised 2026-09-26 to record what was built; the original
plan for horizontal segmented tabs was not followed. See
[the design](../specs/2026-09-25-settings-tabs-header-design.md).

**Goal:** Give Settings a breadcrumb toolbar and the same card layout as the
rest of the app: a sticky Categories card on the left and a main card for the
active section on the right.

**Tech stack:** Vanilla JavaScript, HTML, CSS custom properties, Electron 33.

---

### Task 1: HTML (`src/renderer/index.html`)

- [x] Add `.settings-toolbar` with `#settings-crumbs` at the top of `page-settings`
- [x] Add `.settings-layout-grid` with the Categories card (`#settings-nav`, 10 items with icons)
- [x] Add the main card with `#settings-main-head-icon`, `-title`, `-desc` and all 10 sections

### Task 2: CSS (`src/renderer/styles.css`)

- [x] `.settings-toolbar` with the accent line and `vercel` / `daylight` variants
- [x] `.settings-layout-grid` (240px + fluid) and `.settings-panel-card` / `.settings-panel-head`
- [x] Sticky, internally scrolling Categories card
- [x] One-column layout under 960px, tighter padding under 760px

### Task 3: JS (`src/renderer/app.js`)

- [x] `SETTINGS_SECTIONS_META` with a label and description per section
- [x] `renderSettingsCrumbs()` using `breadcrumbHTML()`
- [x] `switchSettingsSection()` syncs nav state, visible section, main card head, breadcrumb, cost estimate and route
- [x] `prepareSettingsPage()` restores the active section

### Task 4: Cleanup

- [x] Remove the unused `.settings-panel`, `.settings-page …`, `.settings-header`, `.settings-body`, `.settings-nav`, `.settings-nav-group` and `.settings-content` rules from `styles.css` (42 rules and an empty `@media (max-width: 900px)` block, ~245 lines)
