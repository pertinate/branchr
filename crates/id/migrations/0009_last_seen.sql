-- When a server last talked to us (status checks, tokens, Explore), so its owner can tell a
-- live claim from a stale one.
ALTER TABLE instances ADD COLUMN last_seen_at TIMESTAMPTZ;
