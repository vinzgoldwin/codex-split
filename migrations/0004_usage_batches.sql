ALTER TABLE devices ADD COLUMN last_batch_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN last_batch_id TEXT;

-- One bounded JSON record per upload, not one indexed row per model request.
CREATE TABLE usage_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL REFERENCES devices(id),
    member_id INTEGER NOT NULL REFERENCES members(id),
    batch_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    usage_json TEXT NOT NULL,
    contributions_json TEXT NOT NULL,
    pricing_version TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX usage_batches_created ON usage_batches(created_at);
ALTER TABLE quota_window_members ADD COLUMN usage_weight INTEGER NOT NULL DEFAULT 0;
UPDATE quota_window_members SET usage_weight = estimated_cost_micros;
ALTER TABLE member_usage_days ADD COLUMN incomplete_entries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quota_window_members ADD COLUMN incomplete_entries INTEGER NOT NULL DEFAULT 0;
UPDATE member_usage_days SET incomplete_entries = 1 WHERE input_tokens + output_tokens > 0;
UPDATE quota_window_members SET incomplete_entries = 1 WHERE input_tokens + output_tokens > 0;
