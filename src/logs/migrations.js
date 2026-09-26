// ============================================
// Request log schema migrations (venom-logs.db)
// ============================================
// Ordered and forward only, like src/db/migrations.js, with its own
// user_version. SQL lives in a JS module so electron-builder's
// `files: ["src/**/*"]` ships it. An entry that has shipped is never edited.
//
// No foreign keys: a row outlives the provider and the key it names.
module.exports = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        -- One row per request, inserted when it finishes; created_at is its start.
        CREATE TABLE request_logs (
          id INTEGER PRIMARY KEY,
          request_uid TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          source TEXT NOT NULL,
          run_id TEXT,
          attempt INTEGER NOT NULL DEFAULT 1,
          is_hedge INTEGER NOT NULL DEFAULT 0,
          provider_id TEXT,
          provider_name TEXT,
          key_id TEXT,
          method TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          model_requested TEXT,
          model_returned TEXT,
          is_stream INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          http_status INTEGER,
          error_class TEXT,
          error_code TEXT,
          error_message TEXT,
          latency_ms INTEGER,
          ttft_ms INTEGER,
          first_byte_ms INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cached_tokens INTEGER,
          cache_write_tokens INTEGER,
          reasoning_tokens INTEGER,
          usage_source TEXT,
          cost_micros INTEGER,
          price_json TEXT,
          has_body INTEGER NOT NULL DEFAULT 0,
          meta_json TEXT,
          user_id TEXT,
          token_id TEXT,
          subscription_id TEXT,
          client_ip TEXT
        );
        CREATE INDEX request_logs_by_time ON request_logs(created_at);
        CREATE INDEX request_logs_by_provider ON request_logs(provider_id, created_at);
        CREATE INDEX request_logs_by_model ON request_logs(model_requested, created_at);
        CREATE INDEX request_logs_by_source ON request_logs(source, created_at);
        CREATE INDEX request_logs_by_run ON request_logs(run_id);

        CREATE TABLE request_bodies (
          log_id INTEGER PRIMARY KEY,
          created_at INTEGER NOT NULL,
          request_headers_json TEXT,
          request_body TEXT,
          response_body TEXT,
          truncated INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX request_bodies_by_time ON request_bodies(created_at);

        -- Hourly roll-ups the charts read. Every counter is added to on upsert.
        CREATE TABLE usage_hourly (
          hour_start INTEGER NOT NULL,
          provider_id TEXT NOT NULL,
          model_id TEXT NOT NULL,
          source TEXT NOT NULL,
          requests INTEGER NOT NULL,
          ok INTEGER NOT NULL,
          cancelled INTEGER NOT NULL,
          blocked INTEGER NOT NULL,
          timeouts INTEGER NOT NULL,
          e_auth INTEGER NOT NULL,
          e_rate_limit INTEGER NOT NULL,
          e_quota INTEGER NOT NULL,
          e_bad_request INTEGER NOT NULL,
          e_server INTEGER NOT NULL,
          e_network INTEGER NOT NULL,
          e_other INTEGER NOT NULL,
          latency_sum_ms INTEGER NOT NULL,
          latency_count INTEGER NOT NULL,
          lb0 INTEGER NOT NULL, lb1 INTEGER NOT NULL, lb2 INTEGER NOT NULL, lb3 INTEGER NOT NULL,
          lb4 INTEGER NOT NULL, lb5 INTEGER NOT NULL, lb6 INTEGER NOT NULL, lb7 INTEGER NOT NULL,
          lb8 INTEGER NOT NULL, lb9 INTEGER NOT NULL, lb10 INTEGER NOT NULL, lb11 INTEGER NOT NULL,
          lb12 INTEGER NOT NULL, lb13 INTEGER NOT NULL,
          ttft_sum_ms INTEGER NOT NULL,
          ttft_count INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cached_tokens INTEGER NOT NULL,
          cost_micros INTEGER NOT NULL,
          PRIMARY KEY (hour_start, provider_id, model_id, source)
        );
      `);
    },
  },
];
