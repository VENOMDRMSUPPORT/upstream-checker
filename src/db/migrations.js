// ============================================
// Schema migrations
// ============================================
// Ordered and forward only. Kept as SQL strings inside a JS module (not .sql
// files) so electron-builder's `files: ["src/**/*"]` ships them with no extra
// config. A new version appends an entry; an entry that has shipped is never
// edited.
const crypto = require('crypto');

module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE secrets (
          name TEXT PRIMARY KEY,
          cipher TEXT NOT NULL CHECK (cipher GLOB 'enc:v1:?*'),
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE providers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          base_url TEXT NOT NULL,
          rpm INTEGER,
          is_custom INTEGER NOT NULL DEFAULT 0,
          position INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        -- A key row holds ciphertext only: never plaintext, never ''.
        CREATE TABLE provider_keys (
          id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          cipher TEXT NOT NULL CHECK (cipher GLOB 'enc:v1:?*'),
          active INTEGER NOT NULL DEFAULT 1,
          position INTEGER NOT NULL DEFAULT 0,
          quota_spent_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX provider_keys_by_provider ON provider_keys(provider_id, position);

        -- Catalogue and history rows keep the ids of deleted providers and
        -- keys on purpose, so they carry no foreign keys to either.
        CREATE TABLE models (
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          name TEXT,
          kind TEXT,
          first_seen INTEGER,
          last_seen INTEGER,
          removed_at INTEGER,
          is_new INTEGER NOT NULL DEFAULT 0,
          summary_json TEXT,
          bench_json TEXT,
          history_json TEXT,
          bench_error TEXT,
          caps_json TEXT,
          caps_error TEXT,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (provider_id, model_id)
        );
        CREATE INDEX models_by_provider ON models(provider_id, removed_at);

        CREATE TABLE model_keys (
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          key_id TEXT NOT NULL,
          PRIMARY KEY (provider_id, model_id, key_id),
          FOREIGN KEY (provider_id, model_id) REFERENCES models(provider_id, model_id) ON DELETE CASCADE
        );

        CREATE TABLE provider_sync (
          provider_id TEXT PRIMARY KEY,
          last_sync_at INTEGER NOT NULL
        );

        CREATE TABLE key_model_counts (
          key_id TEXT PRIMARY KEY,
          count INTEGER NOT NULL,
          at INTEGER NOT NULL
        );

        CREATE TABLE catalog_meta (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL
        );

        CREATE TABLE test_runs (
          id INTEGER PRIMARY KEY,
          run_uid TEXT NOT NULL UNIQUE,
          at INTEGER NOT NULL,
          provider_id TEXT NOT NULL,
          provider_name TEXT NOT NULL,
          prompt TEXT NOT NULL
        );
        CREATE INDEX test_runs_by_at ON test_runs(at);
        CREATE INDEX test_runs_by_provider ON test_runs(provider_id, id);

        CREATE TABLE test_results (
          id INTEGER PRIMARY KEY,
          run_id INTEGER NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
          model_id TEXT NOT NULL,
          status TEXT NOT NULL,
          time_ms INTEGER,
          tokens INTEGER,
          completion_tokens INTEGER,
          attempts INTEGER NOT NULL DEFAULT 1,
          correct INTEGER
        );
        CREATE INDEX test_results_by_run ON test_results(run_id);
        CREATE INDEX test_results_by_model ON test_results(model_id);
      `);
      // Identifies this install to a future sync server. Never changes.
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('install_id', crypto.randomUUID());
    },
  },
  {
    version: 2,
    up(db) {
      db.exec(`
        -- The roster-level fields the reference kept at file level beside the
        -- per-model history (ref §10): when the history started, when the rows
        -- were fetched, how the last attempt ended, and a quarantined mass drop.
        CREATE TABLE snapshot_meta (
          provider_id       TEXT PRIMARY KEY,
          created_at        INTEGER NOT NULL,
          fetched_at        INTEGER,
          last_sync_json    TEXT,
          pending_drop_json TEXT
        );

        -- One row per provider+model: the snapshot's "models" entry and that
        -- model's provider-published facts together, so a sync writes history and
        -- rows in one transaction. Separate from the "models" table on purpose —
        -- see the two-writers deviation at the top of this plan. summary_json
        -- carries the provider's own facts with every derived field stripped (ref
        -- §10 providerRowSnapshot); health_json holds one minimal request's
        -- verdict and its latency samples: { status, note, httpStatus, at,
        -- latencies: [{ at, ms }] }, newest sample last. The snapshot writer
        -- never touches health_json — that column belongs to catalog:health (see
        -- src/db/repos/snapshots.js, and the case that pins it).
        CREATE TABLE roster_snapshot (
          provider_id  TEXT NOT NULL,
          model_id     TEXT NOT NULL,
          name         TEXT,
          first_seen   INTEGER NOT NULL,
          last_seen    INTEGER NOT NULL,
          removed_at   INTEGER,
          summary_json TEXT,
          health_json  TEXT,
          updated_at   INTEGER NOT NULL,
          PRIMARY KEY (provider_id, model_id)
        );
        CREATE INDEX roster_by_provider ON roster_snapshot(provider_id, removed_at);
      `);
    },
  },
];
