-- Full-text search over message text.
CREATE INDEX messages_search ON messages USING GIN (to_tsvector('simple', content));

-- Pinned messages: when (ms), or null.
ALTER TABLE messages ADD COLUMN pinned_at BIGINT;
CREATE INDEX messages_pins ON messages (channel_id, pinned_at) WHERE pinned_at IS NOT NULL;
