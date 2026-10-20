// Shipped settings defaults and appearance choices — no DOM or I/O.
// Closure-scoped classic script: no shared lexical globals.
window.VENOM_RENDERER = window.VENOM_RENDERER || {};
window.VENOM_RENDERER.defaults = (() => {
  'use strict';
  const DEFAULT_SETTINGS = {
    // Latency bands for the TIME column. Calibrated to what a chat completion
    // actually costs: under 5s flagged most of a healthy run amber, which left
    // the colour saying nothing.
    timeGoodMs: 10000,
    timeOkMs: 15000,

    // How long one model may take before it is called hung. A generator needs
    // minutes; a chat model that takes minutes is broken.
    deadlineChatMs: 75000,
    deadlineImageMs: 240000,
    deadlineVideoMs: 600000,
    deadlineDecisionMs: 60000,

    // The wall clock a single model may consume across ALL of its attempts —
    // retries, rate-limit windows and empty recovery multiply (3 windows × 60s +
    // 2 retries × a 75s deadline can hold one model for ~7 minutes). A deadline
    // bounds one attempt; this bounds the whole model. 0 turns it off.
    perModelBudgetMs: 90000,

    // Retry policy for transient failures and for provider rate limits.
    maxTestRetries: 2,
    maxRateLimitWaits: 3,

    // Hedging rescues a model that is merely slow by racing extra attempts. It is
    // also the single biggest multiplier on how many requests a run costs.
    hedgeEnabled: true,
    hedgeMax: 6,
    hedgeStepMs: 2000,

    // A reasoning model can spend its whole budget thinking and return no content
    // at all, which the app then reports as an empty response. Raising this fixes
    // that case.
    maxOutputTokens: 512,
    matchMode: 'boundary',

    // Generators. Each is sent to its dedicated endpoint first (/images/generations,
    // /videos) and falls back to chat on a provider that has no such route. A
    // returned link proves little on its own — verifyAssets fetches its headers and
    // passes the model only when the link really serves an image or a video.
    imagePrompt: 'A single red circle centred on a plain white background.',
    videoPrompt: 'A single red circle slowly moving across a plain white background.',
    videoPollMs: 5000,
    verifyAssets: true,

    // Decision models answer a typed question with a probability. The probe is a
    // statement whose truth is not in doubt, so a healthy model scores it high and
    // anything under the threshold is a wrong answer — the decision twin of 2+2.
    decisionState: 'The statement under review: 2 + 2 = 4.',
    decisionQuestion: 'Is the statement under review mathematically correct?',
    decisionThreshold: 0.7,

    historyMaxRuns: 300,
    sparkRuns: 12,

    notifyRegression: true,
    notifyRunComplete: false,

    // Generators are unselected by default, but once selected they would join
    // every scheduled run — generating images on a timer, unattended.
    scheduleSkipMedia: true,

    // Live background cycle. One pass per provider covers status, keys, roster
    // and diff (see adoptProbeResults); the cadence is the catalog sync minutes.
    // liveUpdates pauses the whole cycle (the breadcrumb toggle); a manual
    // re-check still works.
    liveUpdates: true,

    // Appearance. Every colour in the stylesheet comes from a custom property, so
    // a theme is a block of overrides rather than a second stylesheet.
    // 'vercel' (Dark) or 'daylight' (Light). followSystem overrides it with the
    // OS setting. accent is one of ACCENTS' ids.
    theme: 'vercel',
    followSystem: false,
    accent: 'emerald',
    density: 'normal',

    // The app lock. Minutes of inactivity before the window asks for the password
    // again; it always asks on launch. main reads this row for its own copy of the
    // limit (src/main.js idleLimitMs), so a change here is re-read on every save.
    lockIdleMin: 60,

    // Turns off transitions and animated flourishes. The stylesheet honours it on
    // the lock screen through html[data-motion="reduced"]; the OS's own
    // prefers-reduced-motion is honoured as well and is not overridable from here.
    reduceMotion: false,

    // Diagnostics button in the top bar (header).
    debugHeader: true,

    // Request bodies in the request log: off | errors (Failed only) | all. The
    // metadata of every request is recorded whatever this says. Main reads it
    // from the saved settings row: a row without it (a new install) means
    // Failed only, and a value already saved is never changed.
    logLevel: 'errors',
    // Mirrors LOG_DEFAULTS in src/logs/settings.js, which main reads back from
    // the same row. Without them here the retention inputs open empty.
    logRetentionDays: 90,
    bodyRetentionDays: 7,
    statsRetentionMonths: 12,

    // Models Catalog. The pool re-reads every connected provider's model
    // list on this cadence. openRouterApiKey is optional and unlocks the fourth
    // upstream document (the Artificial Analysis indices); without it fewer
    // models are measured and more are estimated, and nothing breaks.
    catalogSyncMinutes: 5,
    openRouterApiKey: '',
    // Days a removed model is retained before the purge deletes it. Read by main
    // from the saved row on every ingest; bounds enforced there too.
    purgeWindowDays: 30,

    // Local multi-account gateway (venom-lite/pro/max on 127.0.0.1). Read by
    // main at boot (src/main.js gatewayPort); out-of-range values fall back
    // to the default there too. A change applies after restart. Move it when
    // a sibling router on this machine (9Router, OmniRoute) owns 20128.
    routerGatewayPort: 28228,

    // Models tested at the same time. 1 is the original behaviour. Raising it is
    // the only thing that actually shortens a run — widening the hedge spends more
    // requests on one model without lowering that model's own latency.
    concurrency: 1,
  };

  const THEMES = [
    { id: 'daylight', name: 'Light' },
    { id: 'vercel', name: 'Dark' },
  ];

  // The brand pack's five, each with an emblem drawn in its colour (see
  // scripts/generate-icons.js). hex is the swatch; the stylesheet's [data-accent]
  // rules carry the same colour and the shades derived from it.
  const ACCENTS = [
    { id: 'emerald', name: 'Emerald', hex: '#10b981', desc: 'Crisp vibrant green · Calm & balanced' },
    { id: 'cyan', name: 'Cyan', hex: '#06b6d4', desc: 'Electric neon cyan · Sharp tech contrast' },
    { id: 'violet', name: 'Violet', hex: '#8b5cf6', desc: 'Deep royal purple · Creative & refined' },
    { id: 'crimson', name: 'Crimson', hex: '#f43f5e', desc: 'Bold vivid rose · Dynamic highlights' },
    { id: 'amber', name: 'Amber', hex: '#f59e0b', desc: 'Warm golden honey · Cozy sunset glow' },
  ];

  // Accents saved before the brand pack, and the one they became. 'blue' had no
  // counterpart: cyan is the nearest hue.
  const LEGACY_ACCENTS = { green: 'emerald', rose: 'crimson', blue: 'cyan' };

  return { DEFAULT_SETTINGS, THEMES, ACCENTS, LEGACY_ACCENTS };
})();
