-- Full-text search over message text (FTS5, kept in step with messages by triggers).
CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO messages_fts (rowid, content) VALUES (new.id, new.content);
END;

-- Pinned messages: when (ms), or null.
ALTER TABLE messages ADD COLUMN pinned_at INTEGER;
CREATE INDEX messages_pins ON messages (channel_id, pinned_at) WHERE pinned_at IS NOT NULL;
