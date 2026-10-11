-- Whether any member may ping @everyone / @here (on by default). Off means only the owner
-- may. Becomes a role permission once roles exist.
ALTER TABLE guilds ADD COLUMN everyone_mentions INTEGER NOT NULL DEFAULT 1;
