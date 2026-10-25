// ============================================
// Providers and their API keys
// ============================================
// A key row holds only ciphertext (enc:v1:…). The plaintext exists in main
// memory, decrypted once per session into the shared cache, and leaves main
// only as a masked hint. A key whose ciphertext this machine can't open is
// "locked": kept untouched and reported as such, never overwritten.
const { ENC_PREFIX, revealCached } = require('../cipher');
const { ulid } = require('../ulid');

const KEY_PLACEHOLDER = 'venomkey:';
// The second secret of a signed-in account: the access token the OAuth flow
// produced. It lives in its own column and never crosses the wire — the
// renderer only ever sees this placeholder, and the resolver swaps in the
// real token for the provider's own origin.
const OAUTH_PLACEHOLDER = 'venomoauth:';
const ANY_PLACEHOLDER = /^venom(?:key|secret|oauth):/;

// The one place a key id's shape is defined. It must stay resolvable as a
// venomkey:<id> placeholder (src/db/keys.js's TOKEN caps a run at the same 64
// chars) and importable as a JSON property; src/db/import-json.js reuses this
// constant for ids read from a legacy config.json instead of duplicating it.
const KEY_ID = /^[A-Za-z0-9_.-]{1,64}$/;

// Router tiers for the multi-account waterfall (migration v6). Unknown or
// legacy values read as 'paid', so a v5 database behaves like one paid pool.
const KEY_TIERS = new Set(['subscription', 'free', 'cheap', 'paid']);

function normaliseTier(value) {
  return KEY_TIERS.has(value) ? value : 'paid';
}

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
  const oauthCacheKey = (id) => `oauth:${id}`;
  const warnedLocked = new Set();

  // The OAuth columns arrive in a late migration (v7), so they are prepared
  // only once the database is known to have them. A file without them behaves
  // like one that has no signed-in accounts.
  let oauthColumns = null;
  let oauthStmts = null;
  function hasOAuthColumns() {
    if (oauthColumns !== null) return oauthColumns;
    try {
      const cols = db.prepare('PRAGMA table_info(provider_keys)').all();
      oauthColumns = cols.some((c) => c.name === 'oauth_cipher') && cols.some((c) => c.name === 'oauth_meta_json');
    } catch (_) {
      oauthColumns = false;
    }
    return oauthColumns;
  }
  function oauthStatements() {
    if (oauthStmts) return oauthStmts;
    oauthStmts = {
      set: db.prepare(`UPDATE provider_keys SET oauth_cipher = @cipher, oauth_meta_json = @meta,
        updated_at = @now WHERE id = @id`),
      nextPosition: db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM provider_keys WHERE provider_id = ?'),
    };
    return oauthStmts;
  }
  function readMeta(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }
  // Migration v6 columns (tier, quota_pool_id) do not exist on older files
  // opened in tests against a truncated migration list. Probe once; writes
  // fall back to the v5 shape when they are absent.
  let tierColumns = null;
  function hasTierColumns() {
    if (tierColumns !== null) return tierColumns;
    try {
      const cols = db.prepare('PRAGMA table_info(provider_keys)').all();
      tierColumns = cols.some((c) => c.name === 'tier') && cols.some((c) => c.name === 'quota_pool_id');
    } catch (_) {
      tierColumns = false;
    }
    return tierColumns;
  }

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
      tier: normaliseTier(row.tier),
      quotaPoolId: row.quota_pool_id != null ? String(row.quota_pool_id) : null,
    };
    if (row.quota_spent_json) out.quotaSpent = JSON.parse(row.quota_spent_json);
    // A signed-in account: the renderer gets the access token's placeholder
    // (never the token) and the account's public facts.
    const accountMeta = readMeta(row.oauth_meta_json);
    if (row.oauth_cipher) {
      out.oauth = true;
      out.oauthKey = OAUTH_PLACEHOLDER + row.id;
      out.account = accountMeta;
    } else if (accountMeta && accountMeta.oauthKind) {
      // A web-session account: its credential IS the session, so there is no
      // second secret to hand out — only the account's public facts.
      out.oauth = true;
      out.account = accountMeta;
    }
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
      // A placeholder can point at a different key's id (copying its secret onto
      // k.id). Drop any cached plaintext for k.id, or a stale reveal would still
      // answer with the old secret under the new cipher.
      cache.delete(cacheKey(k.id));
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
    if (!Array.isArray(p.keys)) throw new TypeError('save-provider needs a keys array');
    const keys = p.keys;
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
      if (!KEY_ID.test(k.id)) throw new TypeError(`Key id "${k.id}" of "${p.id}" is not a usable id`);
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
      // Router tier metadata (migration v6). Kept out of the base upsert so
      // v5 files without the columns keep working; a missing column is a
      // no-op, never a failed save.
      if (hasTierColumns()) {
        try {
          db.prepare('UPDATE provider_keys SET tier = ?, quota_pool_id = ? WHERE id = ?')
            .run(normaliseTier(k.tier), k.quotaPoolId != null ? String(k.quotaPoolId) : null, k.id);
        } catch (_) {
          tierColumns = false;
        }
      }
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

  // The account's access token, decrypted once per session like every other
  // secret. null when the row has none or this machine cannot open it.
  function revealOauth(id) {
    const row = q.key.get(id);
    if (!row || !row.oauth_cipher) return null;
    return revealCached(cipher, cache, oauthCacheKey(id), row.oauth_cipher);
  }

  // A signed-in account becomes a provider key: one row, the credential the
  // API is called with in `cipher`, the access token in `oauth_cipher`, and
  // the account's public facts beside them. Signing the same account in twice
  // replaces its row instead of adding a second one.
  const saveOAuthTx = db.transaction((account) => {
    const providerId = account && account.providerId;
    if (!providerId) throw new TypeError('An account needs a provider');
    const provider = q.provider.get(providerId);
    if (!provider) throw new Error('That provider is not saved');
    if (!hasOAuthColumns()) throw new Error('This database has no room for signed-in accounts — update the app and reopen it');
    const meta = account.meta && typeof account.meta === 'object' ? account.meta : {};
    const rows = q.keysOf.all(providerId);
    let existing = null;
    if (meta.email) {
      existing = rows.find((r) => {
        const m = readMeta(r.oauth_meta_json);
        return !!(m && m.email && m.email === meta.email);
      }) || null;
    }
    const id = existing ? existing.id : `acct_${ulid()}`;
    const now = Date.now();
    const position = existing ? existing.position : oauthStatements().nextPosition.get(providerId).p;
    const cipherValue = cipher.encrypt(String(account.secret || ''));
    if (existing) {
      q.updateKey.run({
        id,
        provider_id: providerId,
        name: account.name || existing.name,
        cipher: cipherValue,
        active: 1,
        position,
        quota_spent_json: existing.quota_spent_json || null,
        now,
      });
    } else {
      q.insertKey.run({
        id,
        provider_id: providerId,
        name: account.name || id,
        cipher: cipherValue,
        active: 1,
        position,
        quota_spent_json: null,
        now,
      });
    }
    oauthStatements().set.run({
      id,
      // A web-session account has one secret: the session itself. There is no
      // access token beside it, so the column stays empty.
      cipher: account.oauthSecret ? cipher.encrypt(String(account.oauthSecret)) : null,
      meta: JSON.stringify(meta),
      now,
    });
    cache.delete(cacheKey(id));
    cache.delete(oauthCacheKey(id));
    return id;
  });

  function saveOAuthAccount(account) {
    const id = saveOAuthTx(account);
    return { id, provider: get(account.providerId) };
  }

  // A signed-in account renews itself: the access token is replaced and the
  // renewal token beside it may be too. Only the two secret columns and the
  // account's own facts move — the row's name, position and enabled state
  // belong to the person, not to the provider, so a renewal never switches a
  // key back on that the person turned off.
  const updateOAuthTx = db.transaction((account) => {
    const row = q.key.get(account && account.id);
    if (!row) throw new Error('That account is not in the database');
    if (!hasOAuthColumns()) throw new Error('This database has no room for signed-in accounts — update the app and reopen it');
    const now = Date.now();
    const meta = account.meta && typeof account.meta === 'object' ? account.meta : (readMeta(row.oauth_meta_json) || {});
    const cipherValue = account.secret ? cipher.encrypt(String(account.secret)) : row.cipher;
    q.updateKey.run({
      id: row.id,
      provider_id: row.provider_id,
      name: row.name,
      cipher: cipherValue,
      active: row.active,
      position: row.position,
      quota_spent_json: row.quota_spent_json || null,
      now,
    });
    oauthStatements().set.run({
      id: row.id,
      cipher: account.oauthSecret ? cipher.encrypt(String(account.oauthSecret)) : row.oauth_cipher,
      meta: JSON.stringify(meta),
      now,
    });
    cache.delete(cacheKey(row.id));
    cache.delete(oauthCacheKey(row.id));
    return row.id;
  });

  function updateOAuthAccount(account) {
    const id = updateOAuthTx(account);
    return { id, provider: get(q.key.get(id).provider_id) };
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

  // Router plane: every active key with its provider origin. Placeholders
  // stay out of here — dispatch resolves venomkey:<id> through revealKey.
  function listAllActiveKeys() {
    const rows = db.prepare(`SELECT k.*, p.base_url AS base_url FROM provider_keys k
      JOIN providers p ON p.id = k.provider_id WHERE k.active = 1 ORDER BY k.position, k.id`).all();
    return rows.map((row) => {
      // A signed-in account carries the project its requests are billed to.
      // The gateway needs it: a provider that does not speak OpenAI names
      // the project in the request itself.
      let meta = null;
      try { meta = readMeta(row.oauth_meta_json); } catch (_) { meta = null; }
      return {
        id: row.id,
        name: row.name,
        providerId: row.provider_id,
        baseUrl: row.base_url,
        tier: normaliseTier(row.tier),
        quotaPoolId: row.quota_pool_id != null ? String(row.quota_pool_id) : null,
        project: meta && meta.project ? String(meta.project) : null,
      };
    });
  }

  function setKeyTier(id, tier, quotaPoolId = null) {
    if (!hasTierColumns()) return false;
    db.prepare('UPDATE provider_keys SET tier = ?, quota_pool_id = ?, updated_at = ? WHERE id = ?')
      .run(normaliseTier(tier), quotaPoolId != null ? String(quotaPoolId) : null, Date.now(), id);
    return true;
  }

  return { list, get, save, merge, remove, keyRecord, revealKey, revealOauth,
    saveOAuthAccount, updateOAuthAccount, listAllActiveKeys, setKeyTier, importProvider };
}

module.exports = { createProvidersRepo, maskKey, KEY_PLACEHOLDER, OAUTH_PLACEHOLDER, KEY_ID, KEY_TIERS, normaliseTier };
