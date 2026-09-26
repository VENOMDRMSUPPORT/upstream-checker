// ============================================
// Scrub substituted secrets out of stored log text
// ============================================
// A provider can echo the key it was sent ("invalid key sk-…"). The request
// log stores error messages and captured replies, so every secret main swapped
// in for this request is replaced by its placeholder before storing — in each
// form it can come back in: raw, JSON-escaped, JSON-escaped with / written as
// \/ (PHP's json_encode), and URL-encoded. Longest first, so a secret that
// contains another is replaced whole. Only stored text is touched, never the
// reply the renderer gets.
function formsOf(secret) {
  const json = JSON.stringify(secret).slice(1, -1);
  const forms = [secret, json, json.replace(/\//g, '\\/')];
  try {
    forms.push(encodeURIComponent(secret));
  } catch {
    // Skip URL-encoded form if encodeURIComponent throws (e.g., lone surrogate)
  }
  return forms;
}

function scrub(text, substitutions) {
  if (typeof text !== 'string' || text === '' || !Array.isArray(substitutions) || substitutions.length === 0) return text;
  const pairs = [];
  const seen = new Set();
  substitutions.forEach((s) => {
    if (!s || typeof s.secret !== 'string' || s.secret === '' || typeof s.placeholder !== 'string') return;
    formsOf(s.secret).forEach((form) => {
      if (seen.has(form)) return;
      seen.add(form);
      pairs.push([form, s.placeholder]);
    });
  });
  pairs.sort((a, b) => b[0].length - a[0].length);
  return pairs.reduce((out, [form, placeholder]) => out.split(form).join(placeholder), text);
}

module.exports = { scrub };
