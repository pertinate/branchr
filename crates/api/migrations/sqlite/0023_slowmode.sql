-- Slow mode: seconds each member waits between messages in a channel (0 = off).
ALTER TABLE channels ADD COLUMN slowmode INTEGER NOT NULL DEFAULT 0;
