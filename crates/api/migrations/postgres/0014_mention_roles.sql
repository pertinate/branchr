-- Roles a message pinged (JSON array of ids), for unread badges on clients.
ALTER TABLE messages ADD COLUMN mention_roles TEXT;
