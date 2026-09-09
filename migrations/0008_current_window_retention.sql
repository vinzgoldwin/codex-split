ALTER TABLE usage_batches ADD COLUMN needs_reprice INTEGER NOT NULL DEFAULT 0;

CREATE INDEX usage_batches_reprice ON usage_batches(needs_reprice, id);
CREATE INDEX usage_batches_pricing_version ON usage_batches(pricing_version, id);

-- Anything awaiting a quota window is explicit work. Normal syncs can now skip
-- the JSON payloads instead of scanning every retained batch.
UPDATE usage_batches
SET needs_reprice = 1
WHERE EXISTS (
    SELECT 1 FROM json_each(contributions_json)
    WHERE json_extract(value, '$.window') IS NULL
);

-- Codex Split only displays the active subscription window. Drop older raw and
-- summary data now, then the scheduled Worker will maintain the same boundary.
DELETE FROM usage_batches
WHERE created_at < (
    SELECT reset_at - duration_minutes * 60000
    FROM quota_windows ORDER BY sampled_at DESC LIMIT 1
);

DELETE FROM usage_entries
WHERE reported_at < (
    SELECT reset_at - duration_minutes * 60000
    FROM quota_windows ORDER BY sampled_at DESC LIMIT 1
);

DELETE FROM member_usage_days
WHERE day_start < (
    SELECT CAST((reset_at - duration_minutes * 60000) / 86400000 AS INTEGER) * 86400000
    FROM quota_windows ORDER BY sampled_at DESC LIMIT 1
);

DELETE FROM quota_samples
WHERE quota_window_id IN (
    SELECT id FROM quota_windows
    WHERE id != (SELECT id FROM quota_windows ORDER BY sampled_at DESC LIMIT 1)
);

DELETE FROM quota_intervals
WHERE quota_window_id IN (
    SELECT id FROM quota_windows
    WHERE id != (SELECT id FROM quota_windows ORDER BY sampled_at DESC LIMIT 1)
);

DELETE FROM quota_window_members
WHERE quota_window_id IN (
    SELECT id FROM quota_windows
    WHERE id != (SELECT id FROM quota_windows ORDER BY sampled_at DESC LIMIT 1)
);

DELETE FROM quota_windows
WHERE id != (SELECT id FROM quota_windows ORDER BY sampled_at DESC LIMIT 1);
