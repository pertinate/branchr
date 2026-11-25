-- Self-hosted hubs that accept branchr accounts. A hub registers itself (getting an id and
-- a secret), shows its owner a claim code, and the owner claims it while signed in.
CREATE TABLE hubs (
    id               UUID PRIMARY KEY,
    secret_hash      BYTEA NOT NULL,
    name             TEXT NOT NULL,
    public_url       TEXT NOT NULL,
    owner_id         UUID REFERENCES accounts(id) ON DELETE SET NULL,
    claim_code_hash  BYTEA UNIQUE,
    claim_expires_at TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at     TIMESTAMPTZ
);
CREATE INDEX hubs_owner ON hubs (owner_id);

-- Hubs an account uses, so a new device can reconnect to all of them.
CREATE TABLE account_hubs (
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    url        TEXT NOT NULL,
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, url)
);

-- One-time codes a signed-in person gets for a new hub: the hub trades it for its key and
-- secret on first start, already owned by that person.
CREATE TABLE setup_codes (
    code_hash  BYTEA PRIMARY KEY,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    -- Set once a hub has used it.
    hub_id     UUID REFERENCES hubs(id) ON DELETE SET NULL
);
CREATE INDEX setup_codes_account ON setup_codes (account_id);
