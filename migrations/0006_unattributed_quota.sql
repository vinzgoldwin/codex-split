-- The collectors do not report per-device quota consumption. Clear the current
-- window's unsupported percentages without changing recorded token or cost totals.
UPDATE quota_window_members
SET used_percent = 0
WHERE quota_window_id = (SELECT id FROM quota_windows ORDER BY sampled_at DESC LIMIT 1);

-- Retire pending estimates. Keep the old tables and columns for deployment compatibility.
UPDATE quota_intervals SET finalized_at = unixepoch() * 1000 WHERE finalized_at IS NULL;
