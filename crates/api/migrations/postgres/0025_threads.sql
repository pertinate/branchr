-- Threads are channels (kind 'thread') under a text channel (parent_id), optionally started
-- from one of its messages; they take their parent's permissions.
ALTER TABLE channels ADD COLUMN starter_message_id BIGINT;
ALTER TABLE channels ADD COLUMN owner_id BIGINT;
CREATE UNIQUE INDEX channels_thread_starter ON channels (starter_message_id) WHERE starter_message_id IS NOT NULL;
