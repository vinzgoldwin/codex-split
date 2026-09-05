ALTER TABLE quota_window_members ADD COLUMN estimated_cost_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quota_window_members ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quota_window_members ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quota_window_members ADD COLUMN unknown_entries INTEGER NOT NULL DEFAULT 0;

CREATE TABLE member_usage_days (
    member_id INTEGER NOT NULL,
    day_start INTEGER NOT NULL,
    estimated_cost_micros INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    unknown_entries INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (member_id, day_start),
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

INSERT INTO member_usage_days
    (member_id, day_start, estimated_cost_micros, input_tokens, output_tokens, unknown_entries)
SELECT member_id,
       CAST(reported_at / 86400000 AS INTEGER) * 86400000,
       SUM(estimated_cost_micros),
       SUM(input_tokens),
       SUM(output_tokens),
       SUM(CASE WHEN estimated_cost_micros = 0 THEN 1 ELSE 0 END)
FROM usage_entries
GROUP BY member_id, CAST(reported_at / 86400000 AS INTEGER);

INSERT INTO quota_window_members
    (quota_window_id, member_id, allocation_percent, estimated_cost_micros, input_tokens, output_tokens, unknown_entries)
SELECT window.id,
       usage.member_id,
       0,
       SUM(usage.estimated_cost_micros),
       SUM(usage.input_tokens),
       SUM(usage.output_tokens),
       SUM(CASE WHEN usage.estimated_cost_micros = 0 THEN 1 ELSE 0 END)
FROM quota_windows AS window
JOIN usage_entries AS usage
  ON usage.reported_at BETWEEN window.reset_at - window.duration_minutes * 60000 AND window.sampled_at
WHERE 1
GROUP BY window.id, usage.member_id
ON CONFLICT(quota_window_id, member_id) DO UPDATE SET
    estimated_cost_micros = excluded.estimated_cost_micros,
    input_tokens = excluded.input_tokens,
    output_tokens = excluded.output_tokens,
    unknown_entries = excluded.unknown_entries;
