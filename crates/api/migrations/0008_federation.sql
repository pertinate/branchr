-- branchr accounts on this server: users signed in through branchr ID carry its account id.
ALTER TABLE users ADD COLUMN global_id TEXT;
CREATE UNIQUE INDEX users_global_id ON users (global_id) WHERE global_id IS NOT NULL;

-- This server's registration with branchr ID (one row).
CREATE TABLE federation (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    branchr_id_url  TEXT NOT NULL,
    instance_id     TEXT NOT NULL,
    secret          TEXT NOT NULL,
    owner_global_id TEXT
);
