-- Preserve observations for checking estimates; they never allocate member usage.
CREATE TABLE quota_samples (
    quota_window_id INTEGER NOT NULL REFERENCES quota_windows(id) ON DELETE CASCADE,
    sampled_at INTEGER NOT NULL,
    used_percent REAL NOT NULL,
    PRIMARY KEY (quota_window_id, sampled_at, used_percent)
);

INSERT INTO quota_samples (quota_window_id, sampled_at, used_percent)
SELECT id, sampled_at, used_percent FROM quota_windows;
