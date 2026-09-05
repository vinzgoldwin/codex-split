ALTER TABLE quota_windows ADD COLUMN baseline_used_percent REAL NOT NULL DEFAULT 0;

UPDATE quota_windows
SET baseline_used_percent = (
    SELECT MIN(nearby.used_percent)
    FROM quota_windows AS nearby
    WHERE nearby.duration_minutes = quota_windows.duration_minutes
      AND nearby.reset_at BETWEEN quota_windows.reset_at - 300000 AND quota_windows.reset_at + 300000
);
