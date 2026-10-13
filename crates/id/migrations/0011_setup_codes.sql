-- One-time codes a signed-in person gets for a new hub: the hub trades it for its key and
-- secret on first start, already owned by that person (no claim code).
CREATE TABLE setup_codes (
    code_hash   BYTEA PRIMARY KEY,
    account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    -- Set once a hub has used it.
    instance_id UUID REFERENCES instances(id) ON DELETE SET NULL
);
CREATE INDEX setup_codes_account ON setup_codes (account_id);
