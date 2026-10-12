-- Servers (guilds) that hosts publish for people to find. A host replaces its whole set on
-- every heartbeat; listings not refreshed for a while are hidden (the host is gone).
CREATE TABLE listings (
    instance_id UUID NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
    guild_id    TEXT NOT NULL,
    name        TEXT NOT NULL,
    description TEXT,
    icon_url    TEXT,
    tags        TEXT[] NOT NULL DEFAULT '{}',
    members     INTEGER NOT NULL,
    online      INTEGER NOT NULL,
    invite      TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (instance_id, guild_id)
);
CREATE INDEX listings_fresh ON listings (updated_at);
