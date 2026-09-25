# Design Document: Settings Tabs & Toolbar Redesign

**Date:** 2026-09-25  
**Topic:** Redesign of Settings Navigation and Toolbar Header  

---

## 1. Overview & Goals
The current Settings page layout utilizes a vertical sidebar list of sections that cramps content and differs from the rest of the application (such as the Providers page, which uses a sleek top toolbar with glowing accent line, breadcrumbs, and segmented tabs).

The goal of this redesign is to:
1. Replace the legacy vertical settings sidebar with a prominent, distinctive top toolbar (`.settings-toolbar`) matching the structure and aesthetics of `.pv-toolbar`.
2. Provide interactive breadcrumbs (`Home > Settings > [Active Tab]`) that dynamically update whenever the user switches sections.
3. Render a modern, horizontal segmented tabs bar (`.settings-tabs`) containing all 9 settings sections grouped by category (Testing, Data, Application), each featuring its distinctive icon and label.
4. Allow the settings content area (`.settings-content`) to expand across the full width of the container in a clean, centered, readable card view.
5. Ensure responsive horizontal scrolling on smaller viewports and smooth theme adaptation across both Dark (`vercel`) and Light (`daylight`) themes.

---

## 2. Component Architecture

### 2.1 Top Toolbar (`.settings-toolbar`)
- Replaces `.settings-header` and `.settings-nav` (as a vertical column) with a single unified header card.
- Visual properties:
  - `border: 1px solid var(--border-1)`
  - `border-radius: var(--radius-lg)`
  - Top glowing accent line (`::before` with linear gradient of `var(--accent)`)
  - Dark mode (`[data-theme="vercel"]`): Glassmorphism gradient background, subtle inner highlight.
  - Light mode (`[data-theme="daylight"]`): Clean white card surface.
- Sub-components:
  - **Breadcrumbs (`#settings-crumbs`):** Uses the established `breadcrumbHTML()` function with clickable links: `Home` (goes to overview) `>` `Settings` (current page) `>` `[Active Section Name]`.
  - **Horizontal Tabs (`#settings-nav`):** Rendered as a horizontal flex strip with category separators (`.settings-nav-group-sep`) or grouped pills.

### 2.2 Horizontal Tabs (`.settings-tabs` / `.settings-nav`)
- Each tab (`.settings-nav-item`) contains:
  - SVG icon (15x15)
  - Text label
  - `data-section` attribute targeting the corresponding section ID (`sec-test`, `sec-schedule`, etc.)
- Active state:
  - Highlighted surface (`var(--bg-4)` or subtle accent mix)
  - Accent colored indicator or border
  - Bolded text with `var(--text-0)`
- Groups & Categories:
  - **Testing:** Test, Schedule, Speed & timeouts, Reliability
  - **Data:** History, Diagnostics, Data
  - **Application:** Appearance, About
  - Separated by thin vertical dividers (`.settings-nav-divider`).

### 2.3 Settings Content Area (`.settings-content`)
- Sits below the toolbar with proper top margin (`margin-top: 18px`).
- Centered layout with maximum width constraint for ergonomic reading and form entry (`max-width: 860px`, centered).
- Existing sections (`sec-test`, `sec-schedule`, etc.) and all existing input controls/event listeners remain 100% functional.

### 2.4 Dynamic Breadcrumb & Tab Synchronisation
- In `src/renderer/app.js`:
  - When switching tabs (via click or programmatic navigation):
    - Update `.active` on the clicked button.
    - Set `sec.hidden` on all sections except the active one.
    - Call `renderCostEstimate()`.
    - Update `#settings-crumbs` with the current section name.

---

## 3. Visual & Theme Verification
- **Dark Theme (`vercel`):** Cohesive glassmorphism, accent glow, and dark tab pills.
- **Light Theme (`daylight`):** Clean white cards, crisp icons, and high contrast active tabs.
- Full verification via screenshot testing under real Electron runtime.
