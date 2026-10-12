-- Social: handles to find people by, friends and blocks, and direct messages.

-- A unique, lowercase handle per account (from the Discord username, made unique).
ALTER TABLE accounts ADD COLUMN handle TEXT;
UPDATE accounts a SET handle = sub.h
FROM (
    SELECT account_id, base || CASE WHEN rn > 1 THEN rn::text ELSE '' END AS h
    FROM (SELECT account_id, base, row_number() OVER (PARTITION BY base ORDER BY account_id) AS rn
          FROM (SELECT account_id, regexp_replace(lower(username), '[^a-z0-9_.]', '', 'g') AS base
                FROM identities WHERE provider = 'discord') y
          WHERE length(base) >= 2) x
) sub
WHERE a.id = sub.account_id;
-- Anyone left (no usable username) gets one from their id, which is unique.
UPDATE accounts SET handle = 'user' || replace(id::text, '-', '') WHERE handle IS NULL;
ALTER TABLE accounts ALTER COLUMN handle SET NOT NULL;
CREATE UNIQUE INDEX accounts_handle ON accounts (handle);

-- Each side's view of the other: friend, outgoing / incoming (a request), or blocked.
CREATE TABLE relationships (
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    other_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, other_id)
);
CREATE INDEX relationships_other ON relationships (other_id);

-- Direct message channels (one-to-one for now; `kind` leaves room for groups).
CREATE TABLE dm_channels (
    id              BIGINT PRIMARY KEY,
    kind            TEXT NOT NULL DEFAULT 'dm',
    last_message_id BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE dm_members (
    channel_id   BIGINT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    last_read_id BIGINT,
    PRIMARY KEY (channel_id, account_id)
);
CREATE INDEX dm_members_account ON dm_members (account_id);
-- At most one one-to-one channel per pair (low < high).
CREATE TABLE dm_pairs (
    low        UUID NOT NULL,
    high       UUID NOT NULL,
    channel_id BIGINT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    PRIMARY KEY (low, high)
);
CREATE TABLE dm_messages (
    id         BIGINT PRIMARY KEY,
    channel_id BIGINT NOT NULL REFERENCES dm_channels(id) ON DELETE CASCADE,
    author_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    reply_to   BIGINT,
    edited_at  BIGINT
);
CREATE INDEX dm_messages_channel ON dm_messages (channel_id, id);
