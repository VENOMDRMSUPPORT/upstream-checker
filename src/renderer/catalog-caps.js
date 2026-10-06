// ============================================
// Model capabilities — what a catalogue row can do, read as three states
// ============================================
// Plain top-level functions, no IIFE and no globals touched at evaluation time,
// so test/renderer/catalog-caps.test.js can read this file and evaluate it the
// way test/renderer/logs-format.test.js does with logs-format.js. Everything
// here takes a row and returns values: no DOM, no IPC, no state.
//
// A capability is `true`, `false` or `null`, and the third one is the point of
// the file. `src/catalog/row.js` opens by saying an absent fact stays null, and
// `scoring.js:fillFromCatalog` depends on it: a stored `false` is
// indistinguishable from a published refusal, so the reference can never repair
// it afterwards. Anything that reads a modality list here obeys the same rule as
// `build.js:declaresNonTextOutput` — a list that was published and left the token
// out is a "no", and a list nobody published is silence, not a refusal.
//
// Four booleans come straight off the row (tools, reasoning, structured,
// attachment). The other four are read out of the two modality lists, which
// are comma-separated strings and may be ''. Video and image generation also
// answer from `kind`, the row's own declared classification (row.js readsKind),
// because a generator that publishes no modality still declares what it is.

const CAT_CAPABILITIES = [
  {
    id: 'tools',
    label: 'Tools',
    blurb: 'Function calling & external API integration',
    tone: 'tool',
  },
  {
    id: 'reasoning',
    label: 'Reasoning',
    blurb: 'Deep thinking & chain-of-thought processing',
    tone: 'reasoning',
  },
  {
    id: 'structured',
    label: 'Structured',
    blurb: 'Strict JSON schema & grammar-constrained output',
    tone: 'structured',
  },
  {
    id: 'vision',
    label: 'Vision',
    blurb: 'Image & visual comprehension',
    tone: 'vision',
  },
  {
    id: 'imageGen',
    label: 'Image Gen',
    blurb: 'Native image creation & editing',
    tone: 'imagegen',
  },
  {
    id: 'audio',
    label: 'Audio',
    blurb: 'Voice input & speech understanding',
    tone: 'audio',
  },
  {
    id: 'video',
    label: 'Video',
    blurb: 'Video sequence processing',
    tone: 'video',
  },
  {
    id: 'files',
    label: 'Files',
    blurb: 'File & document upload support',
    tone: 'files',
  },
  {
    id: 'decision',
    label: 'Decision',
    blurb: 'Typed yes/no rating of a known state, never prose',
    tone: 'decision',
  },
];

/**
 * Does a published modality list name this token?
 *
 * Three answers, never two. `true` when the list is there and names it, `false`
 * when the list is there and does not, `null` when nobody published a list — a
 * provider that says nothing about audio has not refused audio, and reading its
 * silence as a "no" would paint a hole in the legend for most of the roster.
 */
function hasModality(list, ...tokens) {
  const parts = String(list || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (!parts.length) return null;
  const wanted = tokens.map((t) => String(t).toLowerCase());
  return parts.some((p) => wanted.includes(p));
}

// A published boolean, or silence. Anything that is not literally true or false
// — a missing field, the string "yes", 1 — is unknown, because a capability that
// counts rows must not count a non-answer.
function publishedBool(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

// `attachment` is the row's own answer when the provider published one; the
// modality list is the fallback. `row.js:readsAttachment` prefers the field over
// the list for exactly this reason, and the two never contradict in practice —
// but the order is the point, not the detail.
function filesState(row) {
  const direct = publishedBool(row.attachment);
  if (direct !== null) return direct;
  return hasModality(row.input_modalities, 'file', 'pdf', 'document');
}

// A provider may declare a generator and publish no modality for it at all —
// `kind` is the provider's declared classification (row.js readsKind of its
// explicit supports_* flags) and answers that case on its own. Declared wins
// over the list, for the same reason `filesState` reads the field first.
function outputState(row, token, kind) {
  if (row.kind === kind) return true;
  return hasModality(row.output_modalities, token);
}

/**
 * One capability of one row, or `null` when the provider said nothing about it.
 *
 * `decision` is answered by the row's own kind: row.js readsKind keeps the
 * provider's explicit supports_decisions flag, and app.js classifyModel falls
 * back to name matching only when no verdict was stored. A declared generator
 * answers the same way through `outputState`, and this is the row's equivalent
 * for decision models.
 *
 * @param {object} row  a catalogue row, as catalog:read serves it
 * @param {string} id   one of CAT_CAPABILITIES[].id
 * @returns {boolean|null}
 */
function capabilityState(row, id) {
  const r = row || {};
  switch (id) {
    case 'tools': return publishedBool(r.tools);
    case 'reasoning': return publishedBool(r.reasoning);
    case 'structured': return publishedBool(r.structured);
    case 'vision': return hasModality(r.input_modalities, 'image');
    case 'audio': return hasModality(r.input_modalities, 'audio');
    case 'files': return filesState(r);
    case 'imageGen': return outputState(r, 'image', 'image');
    case 'video': return outputState(r, 'video', 'video');
    case 'decision': return r.kind === 'decision' ? true
      : r.kind != null ? false : hasModality(r.output_modalities, 'decision');
    default: return null;
  }
}

// Where the answer came from, so the tile and the row's detail drawer can both
// say it. A flag the provider published and a token found in its modality list
// are not the same claim, and neither is either of them a declared kind.
const BOOLEAN_CAPS = new Set(['tools', 'reasoning', 'structured']);

/**
 * Where a capability's answer was read from — the legend tile and the row's
 * detail drawer both show this, so a borrowed modality never reads as a
 * published flag.
 *
 * @returns {{ value: boolean|null, from: 'published'|'modalities'|'kind'|'silent' }}
 */
function capabilityOrigin(row, id) {
  const r = row || {};
  const value = capabilityState(r, id);
  if (value === null) return { value, from: 'silent' };
  // `decision` is answered by the row's own kind, exactly
  // like the generators above it: a declared decision model says so by being
  // one, not by publishing a flag.
  if ((id === 'imageGen' && r.kind === 'image') || (id === 'video' && r.kind === 'video')
    || (id === 'decision' && r.kind === 'decision')) {
    return { value, from: 'kind' };
  }
  // `files` is a published flag only when the provider wrote the field; when the
  // answer came from the modality list it is a modality answer like any other.
  if (BOOLEAN_CAPS.has(id) || (id === 'files' && publishedBool(r.attachment) !== null)) {
    return { value, from: 'published' };
  }
  return { value, from: 'modalities' };
}

/** All eight answers for one row, keyed by capability id. */
function capabilitySet(row) {
  const out = {};
  for (const cap of CAT_CAPABILITIES) out[cap.id] = capabilityState(row, cap.id);
  return out;
}

/**
 * How many of `rows` carry each capability. Only `true` counts: a capability
 * nobody published is a gap in the sources, and counting it would make the
 * legend claim a model can do something the catalog has never seen said.
 *
 * One pass, so a page with a few thousand rows costs one walk rather than eight.
 *
 * @param {object[]} rows
 * @returns {Object<string, number>} every capability id is present, 0 included
 */
function capabilityCounts(rows) {
  const counts = {};
  for (const cap of CAT_CAPABILITIES) counts[cap.id] = 0;
  for (const row of rows || []) {
    for (const cap of CAT_CAPABILITIES) {
      if (capabilityState(row, cap.id) === true) counts[cap.id] += 1;
    }
  }
  return counts;
}

if (typeof window !== 'undefined') {
  window.CAT_CAPABILITIES = CAT_CAPABILITIES;
  window.capabilityCounts = capabilityCounts;
  window.capabilityState = capabilityState;
}
