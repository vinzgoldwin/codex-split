ALTER TABLE quota_window_members ADD COLUMN used_percent REAL NOT NULL DEFAULT 0;
ALTER TABLE quota_windows ADD COLUMN attribution_sampled_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quota_windows ADD COLUMN attribution_used_percent REAL NOT NULL DEFAULT 0;

-- Preserve the existing estimate once. Historical quota samples were not retained.
UPDATE quota_window_members AS member
SET used_percent = (
    SELECT MAX(0, window.used_percent - window.baseline_used_percent) *
        CASE WHEN totals.unknown_entries = 0 AND totals.weight > 0
             THEN member.usage_weight * 1.0 / totals.weight
             WHEN totals.tokens > 0
             THEN (member.input_tokens + member.output_tokens) * 1.0 / totals.tokens
             ELSE 0 END
    FROM quota_windows AS window
    JOIN (
        SELECT quota_window_id, SUM(usage_weight) AS weight,
               SUM(input_tokens + output_tokens) AS tokens, SUM(unknown_entries) AS unknown_entries
        FROM quota_window_members GROUP BY quota_window_id
    ) AS totals ON totals.quota_window_id = window.id
    WHERE window.id = member.quota_window_id
);

UPDATE quota_windows
SET attribution_sampled_at = MAX(sampled_at, unixepoch() * 1000),
    attribution_used_percent = used_percent;

CREATE TABLE quota_intervals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quota_window_id INTEGER NOT NULL REFERENCES quota_windows(id) ON DELETE CASCADE,
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    used_percent REAL NOT NULL,
    settle_after INTEGER NOT NULL,
    finalized_at INTEGER,
    UNIQUE (quota_window_id, ends_at)
);
CREATE INDEX quota_intervals_pending ON quota_intervals(finalized_at, settle_after);
