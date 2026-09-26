// ============================================
// Providers and their API keys
// ============================================
// A key row holds only ciphertext (enc:v1:…). The plaintext exists in main
// memory, decrypted once per session into the shared cache, and leaves main
// only as a masked hint. A key whose ciphertext this machine can't open is
// "locked": kept untouched and reported as such, never overwritten.
const { ENC_PREFIX, revealCached } = require('../cipher');

const KEY_PLACEHOLDER = 'venomkey:';
const ANY_PLACEHOLDER = /^venom(?:key|secret):/;

// The display mask the renderer has always shown, computed from the plaintext
// at read time. Never stored: it still holds real characters of the key.
function maskKey(key) {
  if (!key) return '';
  const head = key.length <= 12 ? 6 : 10;
  return key.slice(0, head) + '********' + key.slice(-4);
}

function createProvidersRepo(db, cipher, cache, log = console) {
  const q = {
    providers: db.prepare('SELECT * FROM providers ORDER BY position, id'),
    provider: db.prepare('SELECT * FROM providers WHERE id = ?'),
    nextProviderPosition: db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM providers'),
    insertProvider: db.prepare(`INSERT INTO providers (id, name, base_url, rpm, is_custom, position, created_at, updated_at)
      VALUES (@id, @name, @base_url, @rpm, @is_custom, @position, @now, @now)`),
    updateProvider: db.prepare(`UPDATE providers SET name = @name, base_url = @base_url, rpm = @rpm,
      is_custom = @is_custom, updated_at = @now WHERE id = @id`),
    deleteProvider: db.prepare('DELETE FROM providers WHERE id = ?'),
    keysOf: db.prepare('SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY position, id'),
    key: db.prepare('SELECT * FROM provider_keys WHERE id = ?'),
    keyWithProvider: db.prepare(`SELECT k.id, k.name, k.provider_id, p.base_url FROM provider_keys k
      JOIN providers p ON p.id = k.provider_id WHERE k.id = ?`),
    insertKey: db.prepare(`INSERT INTO provider_keys
      (id, provider_id, name, cipher, active, position, quota_spent_json, created_at, updated_at)
      VALUES (@id, @provider_id, @name, @cipher, @active, @position, @quota_spent_json, @now, @now)`),
    updateKey: db.prepare(`UPDATE provider_keys SET name = @name, cipher = @cipher, active = @active,
      position = @position, quota_spent_json = @quota_spent_json, updated_at = @now WHERE id = @id`),
    moveKey: db.prepare('UPDATE provider_keys SET provider_id = ?, position = ?, updated_at = ? WHERE id = ?'),
    deleteKey: db.prepare('DELETE FROM provider_keys WHERE id = ?'),
  };
  const cacheKey = (id) => `key:${id}`;
  const warnedLocked = new Set();

  function reveal(row) {
    const plain = revealCached(cipher, cache, cacheKey(row.id), row.cipher);
    if (plain === null && !warnedLocked.has(row.id)) {
      warnedLocked.add(row.id);
      log.warn(`Key "${row.name}" can't be decrypted here (encrypted for another machine or user); kept as is`);
    }
    return plain;
  }

  // The key as the renderer sees it: a placeholder and a hint, never the secret.
  function toKey(row) {
    const secret = reveal(row);
    const locked = secret === null;
    const out = {
      id: row.id,
      name: row.name,
      key: locked ? '' : KEY_PLACEHOLDER + row.id,
      hint: locked ? '' : maskKey(secret),
      active: row.active === 1,
      locked,
    };
    if (row.quota_spent_json) out.quotaSpent = JSON.parse(row.quota_spent_json);
    return out;
  }

  function toProvider(row) {
    const out = { name: row.name, baseUrl: row.base_url, rpm: row.rpm, keys: q.keysOf.all(row.id).map(toKey) };
    if (row.is_custom === 1) out.custom = true;
    return out;
  }

  function list() {
    const out = {};
    q.providers.all().forEach((row) => { out[row.id] = toProvider(row); });
    return out;
  }

  function get(id) {
    const row = q.provider.get(id);
    return row ? toProvider(row) : null;
  }

  // What to store for one key of a save-provider payload (spec §4, "save-provider
  // key semantics").
  function cipherFor(providerId, k, stored) {
    const label = k.name || k.id;
    const value = typeof k.key === 'string' ? k.key : '';
    if (value.startsWith(KEY_PLACEHOLDER)) {
      const ref = q.key.get(value.slice(KEY_PLACEHOLDER.length));
      if (!ref) throw new Error(`Key "${label}" points at a key that doesn't exist`);
      if (ref.provider_id !== providerId) throw new Error(`Key "${label}" belongs to another provider`);
      return ref.cipher;
    }
    if (value === '') {
      // '' is how a locked key comes back: keep what is stored, never write ''.
      if (stored) return stored.cipher;
      throw new Error(`Key "${label}" has no value`);
    }
    if (ANY_PLACEHOLDER.test(value) || value.startsWith(ENC_PREFIX)) throw new Error(`Key "${label}" is not a usable key value`);
    // The same secret sent back (while the renderer still holds plaintext):
    // keep the stored ciphertext instead of re-encrypting it on every save.
    if (stored && reveal(stored) === value) return stored.cipher;
    cache.delete(cacheKey(k.id));
    return cipher.encrypt(value);
  }

  // save-provider: upsert by id, keys as sent. One transaction, so a refused
  // key leaves the provider exactly as it was.
  const saveTx = db.transaction((p) => {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id) throw new TypeError('A provider needs an id');
    if (typeof p.name !== 'string' || typeof p.baseUrl !== 'string') throw new TypeError(`Provider "${p.id}" needs a name and a base URL`);
    const keys = Array.isArray(p.keys) ? p.keys : [];
    const now = Date.now();
    const existing = q.provider.get(p.id);
    const row = {
      id: p.id,
      name: p.name,
      base_url: p.baseUrl,
      rpm: Number.isFinite(p.rpm) ? p.rpm : null,
      is_custom: p.custom === undefined ? (existing ? existing.is_custom : 0) : (p.custom ? 1 : 0),
      now,
    };
    if (existing) q.updateProvider.run(row);
    else q.insertProvider.run({ ...row, position: q.nextProviderPosition.get().p });

    const stored = new Map(q.keysOf.all(p.id).map((r) => [r.id, r]));
    const seen = new Set();
    keys.forEach((k, position) => {
      if (!k || typeof k.id !== 'string' || !k.id) throw new TypeError(`A key of "${p.id}" has no id`);
      if (seen.has(k.id)) throw new Error(`Key ${k.id} is listed twice`);
      seen.add(k.id);
      const owner = q.key.get(k.id);
      if (owner && owner.provider_id !== p.id) throw new Error(`Key ${k.id} belongs to another provider`);
      const values = {
        id: k.id,
        provider_id: p.id,
        name: typeof k.name === 'string' && k.name ? k.name : k.id,
        cipher: cipherFor(p.id, k, stored.get(k.id)),
        active: k.active === false ? 0 : 1,
        position,
        quota_spent_json: k.quotaSpent ? JSON.stringify(k.quotaSpent) : null,
        now,
      };
      if (stored.has(k.id)) q.updateKey.run(values);
      else q.insertKey.run(values);
    });
    // A key left out of the payload was deleted by the user.
    stored.forEach((r, id) => {
      if (seen.has(id)) return;
      q.deleteKey.run(id);
      cache.delete(cacheKey(id));
    });
  });

  function save(p) {
    saveTx(p);
    return get(p.id);
  }

  // merge-provider: a legacy custom provider folded into its built-in twin.
  const mergeTx = db.transaction((fromId, intoId) => {
    if (fromId === intoId) throw new Error('A provider cannot be merged into itself');
    if (!q.provider.get(fromId)) throw new Error(`Provider "${fromId}" not found`);
    if (!q.provider.get(intoId)) throw new Error(`Provider "${intoId}" not found`);
    // Same secret = same key. A locked key has no readable value, so its
    // ciphertext stands in for it (two copies of one locked key still match).
    const identity = (row) => {
      const value = reveal(row);
      return value === null ? `cipher:${row.cipher}` : `value:${value}`;
    };
    const target = q.keysOf.all(intoId);
    const have = new Set(target.map(identity));
    let position = target.reduce((max, r) => Math.max(max, r.position), -1) + 1;
    const now = Date.now();
    q.keysOf.all(fromId).forEach((row) => {
      const id = identity(row);
      if (have.has(id)) {
        q.deleteKey.run(row.id);
        cache.delete(cacheKey(row.id));
        return;
      }
      have.add(id);
      q.moveKey.run(intoId, position, now, row.id);
      position += 1;
    });
    q.deleteProvider.run(fromId);
  });

  function merge(fromId, intoId) {
    mergeTx(fromId, intoId);
    return get(intoId);
  }

  // delete-provider: its keys go with it (ON DELETE CASCADE).
  const remove = db.transaction((id) => {
    const keys = q.keysOf.all(id);
    const { changes } = q.deleteProvider.run(id);
    keys.forEach((k) => cache.delete(cacheKey(k.id)));
    return changes > 0;
  });

  // For request signing (src/db/keys.js) and copy-key.
  function keyRecord(id) {
    const row = q.keyWithProvider.get(id);
    return row ? { id: row.id, name: row.name, providerId: row.provider_id, baseUrl: row.base_url } : null;
  }

  function revealKey(id) {
    const row = q.key.get(id);
    return row ? reveal(row) : null;
  }

  // Import only, inside the importer's transaction: rows exactly as given,
  // ciphertext included.
  function importProvider(p) {
    const now = Date.now();
    q.insertProvider.run({ id: p.id, name: p.name, base_url: p.baseUrl, rpm: p.rpm, is_custom: p.custom ? 1 : 0, position: p.position, now });
    p.keys.forEach((k, position) => q.insertKey.run({
      id: k.id,
      provider_id: p.id,
      name: k.name,
      cipher: k.cipher,
      active: k.active ? 1 : 0,
      position,
      quota_spent_json: k.quotaSpent ? JSON.stringify(k.quotaSpent) : null,
      now,
    }));
  }

  return { list, get, save, merge, remove, keyRecord, revealKey, importProvider };
}

module.exports = { createProvidersRepo, maskKey, KEY_PLACEHOLDER };
