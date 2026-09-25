# Handoff: Upstream Checker — Sidebar Variations

## Overview
This handoff covers **four dark-mode sidebar design directions** for the **Upstream Checker** enterprise dashboard (v1.2.1). All four variants share the same information architecture and navigation structure — the difference is entirely in the background treatment, active-state language, and accent usage. All variants use a **single violet accent** and are built for an enterprise context (LLM provider / model observability tool).

The four directions are:

| # | Name | Feel |
|---|---|---|
| 01 | **Glassmorphic Neon** | Bold, glowing, futuristic — glass with a violet halo |
| 02 | **Angular Professional** | Structured, corporate, geometric — diagonal accent shapes + chevrons |
| 03 | **Minimal Icon Rail** | Clean utility — thin icon rail on the left, close button in header |
| 04 | **Premium Abstract** | Elegant, editorial — soft organic blur shapes, subdued glass active state |

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, **not production code to copy directly**. The task is to **recreate these designs in the target codebase's existing environment** (React, Vue, SwiftUI, Flutter, native, etc.) using its established components, tokens, and patterns. If no codebase exists yet, pick the framework most appropriate for the project (React + Tailwind is a natural fit for this Upstream Checker context) and implement there.

## Fidelity
**High-fidelity (hifi).** Final colors, typography, spacing, border-radius, shadows, and active/hover states are pinned down. The developer should recreate the UI pixel-perfectly using the codebase's existing libraries and design tokens. Only one direction should be chosen for production — the four are exploratory alternatives, not four separate features.

---

## Screens / Views

There is one primary view: the **collapsed application sidebar** (~240px wide, full-viewport-height in production). Each variant renders the same content:

- **Header**: Brand mark (icon + wordmark) + version badge (or close × on variant 03)
- **Primary nav** (7 items): Overview, Providers, Model Catalog, Upstream Check, Test History, Monitoring, Settings
- **Quick Stats card**: Providers count, Models count, Last Check timestamp
- **Footer strip**: "All Systems Operational" (variants 01, 03) OR brand footer with tagline (variants 02, 04)

### Layout (all variants)

- Sidebar width: **240px**
- Border radius (sidebar container): **20px** (design mock only — in production, a fixed left sidebar should be full-height with `border-radius: 0`)
- Container padding: **20px 16px 16px**
- Vertical flex column: header → nav → (mt-auto) stats → footer strip / brand footer
- Header padding-bottom: **14px** with 1px bottom divider `rgba(255,255,255,.06)`
- Nav item gap: **1px** (borders provide separation)
- Stats card border-radius: **12px**, padding: **12px 12px 6px**

### Nav item spec (shared)

- Padding: `10px 12px`
- Border-radius: `9px`
- Font: `13px / 500` (active: `13px / 600`)
- Icon size: `16 × 16`, `stroke-width: 2`
- Idle text color: `#8b91a8`
- Hover text color: `#e6edf3`
- Chevron (variant 02 only): `14 × 14` on right, `opacity: .35` idle / `.9` active

### Quick Stats card spec (shared)

- Background: `linear-gradient(180deg, rgba(255,255,255,.04) 0%, rgba(255,255,255,.015) 100%)`
- Border: `1px solid rgba(255,255,255,.07)`
- Backdrop-filter: `blur(6px)`
- Head row: bar-chart icon + "Quick Stats" (13px / 600) on left, `···` kebab on right, 1px bottom divider
- Stat row: `padding: 7px 2px`, `font: 12px / 500`, value in JetBrains Mono `12px / 600`
- Row divider: `1px solid rgba(255,255,255,.04)` between rows

### Bottom strip / Brand footer

- **Status strip** (variants 01, 03): `12px 4px 4px` padding, 1px top divider, pulse dot (9px, accent glow) + label + optional right chevron
- **Brand footer** (variants 02, 04): 1px top divider, wordmark (10.5px / 700, `.22em` tracking) + tagline (9.5px, `#8b91a8`)

---

## Variant-specific specs

### 01 · Glassmorphic Neon
- **Background**:
  - `radial-gradient(320px 260px at 20% 8%, rgba(168,85,247,.22), transparent 60%)`
  - `radial-gradient(280px 240px at 90% 95%, rgba(168,85,247,.18), transparent 65%)`
  - Base: `linear-gradient(180deg, #0d0a18 0%, #06040e 100%)`
- **Border**: `1px solid rgba(168,85,247,.35)` + outer glow `0 0 40px -10px rgba(168,85,247,.4)`
- **Corner glows** (`::before`, blur 6px, opacity .7):
  - `radial-gradient(180px 180px at 0% 100%, rgba(168,85,247,.5), transparent 65%)`
  - `radial-gradient(150px 150px at 100% 0%, rgba(192,132,252,.35), transparent 65%)`
- **Active nav item**: `linear-gradient(180deg, rgba(168,85,247,.55), rgba(124,58,237,.35))`, border `1px solid rgba(216,180,254,.5)`, inner white sheen + `0 8px 24px -8px rgba(168,85,247,.7)`, text `#fff`
- **Footer**: status strip with pulse dot + right chevron

### 02 · Angular Professional
- **Background**: `linear-gradient(180deg, #14121c 0%, #0a0812 100%)`
- **Angular shapes** (`::before`) — three diagonal stripes at bottom-left using `linear-gradient(135deg, ...)` with violet accents at bands 60–70%, 74–82%, 86–94%
- **Top-right glow** (`::after`): `radial-gradient(220px 160px at 100% 0%, rgba(168,85,247,.15), transparent 65%)`
- **Active nav item**: `linear-gradient(90deg, rgba(168,85,247,.22) 0%, rgba(168,85,247,.06) 100%)`, border `1px solid rgba(168,85,247,.35)`, text `#fff`
- **Chevrons**: every nav item has a right-side `>` chevron (except Settings)
- **Footer**: brand footer, right-aligned, tagline "Built for a more connected tomorrow."

### 03 · Minimal Icon Rail
- **Background**: `linear-gradient(180deg, #0d0d15 0%, #07070d 100%)`
- **Icon rail** (`::before`): 44px-wide left column with subtle violet wash `rgba(168,85,247,.06)` and 1px right divider `rgba(168,85,247,.18)`
- **Header close button**: 22px circle, `background: rgba(255,255,255,.04)`, `border: 1px solid rgba(255,255,255,.08)`, contains 11px × icon
- **Nav item icons**: wrapped in 22px rounded (6px radius) tiles with `background: rgba(255,255,255,.03)` and `border: 1px solid rgba(255,255,255,.06)`
- **Active nav item**: horizontal violet wash `linear-gradient(90deg, rgba(168,85,247,.14) 0%, transparent 100%)`, icon tile lit up with `linear-gradient(135deg, rgba(168,85,247,.35), rgba(168,85,247,.15))` and `border: 1px solid rgba(216,180,254,.4)`
- **Nav border-radius**: `0 9px 9px 0` (open on the rail side)
- **Footer**: status strip with concentric-dot pulse (outer 18px neutral, inner 6px accent)

### 04 · Premium Abstract
- **Background**:
  - `radial-gradient(260px 320px at 100% 40%, rgba(168,85,247,.28), transparent 60%)`
  - `radial-gradient(200px 240px at 100% 90%, rgba(124,58,237,.22), transparent 65%)`
  - `radial-gradient(180px 220px at 0% 60%, rgba(168,85,247,.10), transparent 65%)`
  - Base: `linear-gradient(180deg, #0e0a18 0%, #06040e 100%)`
- **Organic overlay** (`::before`, blur 8px, opacity .9): two more radial gradients from the right edge
- **Highlight arc** (`::after`): large offset radial ring `radial-gradient(600px 600px at 130% 50%, transparent 40%, rgba(216,180,254,.14) 41%, transparent 43%)`
- **Active nav item**: `linear-gradient(180deg, rgba(255,255,255,.10) 0%, rgba(255,255,255,.03) 100%)`, border `1px solid rgba(255,255,255,.18)`, `backdrop-filter: blur(4px)`, text `#fff` — restrained white glass rather than colored fill
- **Footer**: brand footer, **center-aligned**, tagline "Monitor. Analyze. Stay Ahead."

---

## Interactions & Behavior

- **Nav click**: navigates and moves the `.active` class to the clicked item
- **Hover on nav item (idle)**: text color transitions `#8b91a8 → #e6edf3` over `200ms ease`
- **Active state**: applied via `.active` class; use the variant-specific background/border spec above
- **Version badge**: static — no interaction
- **Close × (variant 03 only)**: collapses the sidebar into rail-only mode (icons visible, labels hidden). In production, animate width `240px → 68px` over `240ms cubic-bezier(0.4, 0, 0.2, 1)`; labels fade out at 0-120ms, icon rail column persists.
- **Quick Stats kebab (`···`)**: opens a small menu (Refresh, Configure, Hide). Placeholder in the mock.
- **All Systems Operational chevron**: opens a status detail popover (out of scope for this handoff).
- **Reduced motion**: honor `prefers-reduced-motion: reduce` — disable glow pulses and backdrop-filter blurs.

## State Management
Minimal for the sidebar itself:
- `activeRoute: string` — which nav item is highlighted (drive from router state)
- `collapsed: boolean` — whether the sidebar is in rail mode (variant 03 close button)
- `stats: { providers: number; models: number; lastCheckAt: Date }` — fed from a monitoring API; format `lastCheckAt` as relative time (`34m ago`)
- `systemStatus: 'operational' | 'degraded' | 'down'` — drives the pulse dot color in the footer strip

---

## Design Tokens

### Colors

```
/* Accent (single, violet) */
--accent-500:      #a855f7   /* primary accent */
--accent-400:      #c084fc   /* accent highlight */
--accent-600:      #7c3aed   /* accent depth */
--accent-glow:     rgba(168, 85, 247, 0.55)

/* Surfaces (dark) */
--bg-page:         #05060a
--bg-sb-01:        linear-gradient(180deg, #0d0a18, #06040e)   /* Glassmorphic */
--bg-sb-02:        linear-gradient(180deg, #14121c, #0a0812)   /* Angular */
--bg-sb-03:        linear-gradient(180deg, #0d0d15, #07070d)   /* Icon Rail */
--bg-sb-04:        linear-gradient(180deg, #0e0a18, #06040e)   /* Abstract */

/* Text */
--text-primary:    #f2f6fb
--text-body:       #e6edf3
--text-muted:      #8b91a8
--text-subtle:     #9aa0b8
--text-faint:      #6a6f80

/* Hairlines / dividers */
--hairline-06:     rgba(255, 255, 255, 0.06)
--hairline-04:     rgba(255, 255, 255, 0.04)
--hairline-glow:   rgba(168, 85, 247, 0.35)

/* Glass card */
--glass-fill:      linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.015))
--glass-border:    rgba(255, 255, 255, 0.07)
```

### Typography

- **UI font**: Inter (400 / 500 / 600 / 700)
- **Mono font** (values, version badge): JetBrains Mono (500 / 600)
- **Scale**:
  - Wordmark line 1 (`UPSTREAM`): `13px / 700`, letter-spacing `.02em`
  - Wordmark line 2 (`CHECKER`): `9.5px / 700`, letter-spacing `.24em`
  - Version badge: `9px` mono, `500`
  - Nav item: `13px / 500`, active `13px / 600`
  - Stats card title: `12.5px / 600`
  - Stats row label: `12px / 500`
  - Stats row value: `12px / 600` mono
  - Footer strip label: `12px / 500`
  - Brand footer wordmark: `10.5px / 700`, letter-spacing `.22em`
  - Brand footer tagline: `9.5px / 400`

### Spacing

- Sidebar padding: `20px 16px 16px`
- Header padding-bottom: `14px`
- Nav item padding: `10px 12px`
- Nav item gap: `1px`
- Stats card padding: `12px 12px 6px`
- Stats row padding: `7px 2px`
- Divider margin: `12px` above/below

### Radii

- Sidebar container: `20px` (0 for full-height production)
- Logo mark: `8px`
- Nav item: `9px`
- Stats card: `12px`
- Rail nav item (variant 03): `0 9px 9px 0`
- Version badge: `5px`
- Pulse dot: circle

### Shadows

- Sidebar drop shadow: `0 30px 60px -20px rgba(0,0,0,.7), 0 8px 24px -12px rgba(0,0,0,.5)` + inset `0 1px 0 rgba(255,255,255,.05)`
- Logo mark: `0 6px 18px -6px var(--accent-glow), inset 0 1px 0 rgba(255,255,255,.35)`
- Glassmorphic outer glow (variant 01): `0 0 40px -10px rgba(168,85,247,.4)`
- Active nav glow (variant 01): `0 8px 24px -8px rgba(168,85,247,.7), inset 0 1px 0 rgba(255,255,255,.2)`
- Pulse dot glow: `0 0 0 3px rgba(192,132,252,.15), 0 0 12px var(--accent-glow)`

---

## Assets

All icons are inline SVG (24×24 viewBox, `stroke-width: 2`). Recommend replacing with **Lucide** in the target codebase — the SVGs used are Lucide-style equivalents:

| Nav item | Lucide icon |
|---|---|
| Overview | `home` |
| Providers | `users` (two-person variant used in mock) |
| Model Catalog | `package` |
| Upstream Check | `play` (filled) |
| Test History | `rotate-ccw` / `history` |
| Monitoring | `bar-chart-3` |
| Settings | `settings` |

Additional icons:
- Brand mark: `layers` (3-stack)
- Stats title: `bar-chart-3` (`trending-up` also acceptable)
- Stats rows: `package`, `settings`/`cog`, `clock`
- Chevron (variant 02): `chevron-right`
- Close (variant 03): `x`

No raster assets are required. No custom fonts beyond Inter + JetBrains Mono (Google Fonts).

---

## Files

Source design files in this project:

- `Sidebar Variations.html` — the current, canonical prototype (matches the reference). All four variants live in one page.
- `Sidebar Variations v1.html` — earlier iteration (emerald accent, mixed backgrounds). Kept for history.
- `Sidebar Variations v2.html` — dark enterprise iteration on emerald accent. Kept for history.

A copy of the canonical file ships in this handoff folder as `Sidebar Variations.html`.

## Implementation Notes

- **Pick ONE variant for production.** These four are alternatives, not four features to build. Recommend reviewing the four with the team, then implementing the winner as a single `<Sidebar />` component.
- Build the sidebar as a **single React/Vue component** parameterized by `variant: 'glass' | 'angular' | 'rail' | 'abstract'` if the team wants to A/B test.
- The gradient backgrounds are pure CSS — no runtime cost, no image assets.
- Backdrop-filter blur is used on the stats card and variant 04's active state. Provide a fallback opaque background for browsers without `backdrop-filter` support.
- The full-height production sidebar should NOT have the 20px outer border-radius seen in the mock (that's for the side-by-side design study). Set it to 0 when the sidebar is anchored to the viewport.
- Emerald `v2` files use a green accent — ignore them for production; violet is the current direction.
