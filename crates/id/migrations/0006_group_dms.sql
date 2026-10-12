-- Group DMs: a name (optional) and an owner who can add and remove people.
ALTER TABLE dm_channels ADD COLUMN name TEXT;
ALTER TABLE dm_channels ADD COLUMN owner_id UUID REFERENCES accounts(id) ON DELETE SET NULL;
