PRAGMA foreign_keys = ON;

CREATE TABLE members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    deactivated_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    member_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    arch TEXT,
    agent_version TEXT,
    last_seen_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);
CREATE INDEX devices_member_active ON devices(member_id, revoked_at);

CREATE TABLE pairings (
    code TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL,
    device_name TEXT NOT NULL,
    platform TEXT NOT NULL,
    arch TEXT,
    agent_version TEXT,
    device_id TEXT,
    device_token_cipher TEXT,
    expires_at INTEGER NOT NULL,
    claimed_at INTEGER,
    delivered_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
);
CREATE INDEX pairings_expiry ON pairings(expires_at);

CREATE TABLE usage_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    member_id INTEGER NOT NULL,
    batch_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_micros INTEGER NOT NULL DEFAULT 0,
    reported_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
    UNIQUE (device_id, batch_id, model)
);
CREATE INDEX usage_entries_member_reported ON usage_entries(member_id, reported_at);

CREATE TABLE quota_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reset_at INTEGER NOT NULL UNIQUE,
    duration_minutes INTEGER NOT NULL,
    used_percent REAL NOT NULL DEFAULT 0,
    sampled_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE quota_window_members (
    quota_window_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL,
    allocation_percent REAL NOT NULL,
    PRIMARY KEY (quota_window_id, member_id),
    FOREIGN KEY (quota_window_id) REFERENCES quota_windows(id) ON DELETE CASCADE,
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

INSERT INTO members (name, active, created_at, updated_at)
VALUES
    ('Kevin', 1, unixepoch() * 1000, unixepoch() * 1000),
    ('Darius', 1, unixepoch() * 1000, unixepoch() * 1000),
    ('Albert', 1, unixepoch() * 1000, unixepoch() * 1000);
