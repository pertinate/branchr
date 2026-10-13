-- Scheduled events in a community, and who's interested.
CREATE TABLE guild_events (
    id          INTEGER PRIMARY KEY,
    guild_id    INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
    creator_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    start_at    INTEGER NOT NULL,
    end_at      INTEGER,
    channel_id  INTEGER REFERENCES channels(id) ON DELETE SET NULL,
    location    TEXT,
    created_at  INTEGER NOT NULL
);
CREATE INDEX guild_events_guild ON guild_events (guild_id, start_at);
CREATE TABLE event_interest (
    event_id INTEGER NOT NULL REFERENCES guild_events(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, user_id)
);
