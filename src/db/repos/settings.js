// ============================================
// Settings rows — settings, test, window
// ============================================
// One JSON value per row. JSON keeps number, string and boolean apart, so a
// value reads back with the type it was saved with (loadSettings ignores a
// value whose type differs from the default).
function createSettingsRepo(db) {
  const q = {
    get: db.prepare('SELECT value_json FROM settings WHERE key = ?'),
    set: db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`),
  };

  function get(key) {
    const row = q.get.get(key);
    return row ? JSON.parse(row.value_json) : null;
  }

  function set(key, value) {
    if (value === undefined) throw new TypeError(`Setting "${key}" has no value`);
    q.set.run(key, JSON.stringify(value), Date.now());
  }

  // save-settings. Merged into the stored row, so fields this build doesn't
  // know (legacy mediaPrompt, fields a newer build added) survive the first
  // save. aaApiKey is a secret (secrets table) and never lands here.
  const saveSettings = db.transaction((incoming) => {
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new TypeError('Settings must be an object');
    const merged = { ...(get('settings') || {}), ...incoming };
    delete merged.aaApiKey;
    set('settings', merged);
    return merged;
  });

  // save-test-definition: { prompt, expected, autoMinutes }.
  function saveTest(test) {
    if (!test || typeof test !== 'object' || Array.isArray(test)) throw new TypeError('The test definition must be an object');
    set('test', test);
  }

  return { get, set, saveSettings, saveTest };
}

module.exports = { createSettingsRepo };
