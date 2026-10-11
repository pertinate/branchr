-- Hosts (self-hosted instances) an account uses, so a new device can reconnect to all of them.
CREATE TABLE account_instances (
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    url        TEXT NOT NULL,
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, url)
);
