-- Slow mode: seconds each member waits between messages in a channel (0 = off).
ALTER TABLE channels ADD COLUMN slowmode BIGINT NOT NULL DEFAULT 0;
