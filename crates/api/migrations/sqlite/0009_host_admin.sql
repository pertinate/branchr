-- Host-level moderation (the claimed owner of a federated host).
CREATE TABLE instance_bans (
    user_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reason    TEXT,
    banned_at INTEGER NOT NULL
);

-- Settings the owner changes at runtime (override the environment).
CREATE TABLE instance_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
