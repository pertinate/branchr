-- A channel's last message comes from the messages index now. Updating it on every
-- send made one row every sender in a channel queued on (one commit each).
ALTER TABLE channels DROP COLUMN last_message_id;
