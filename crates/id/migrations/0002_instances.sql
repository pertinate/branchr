-- Self-hosted servers federated with branchr ID. A server registers itself (getting an id
-- and a secret), shows its owner a claim code, and the owner claims it while signed in.
CREATE TABLE instances (
    id               UUID PRIMARY KEY,
    secret_hash      BYTEA NOT NULL,
    name             TEXT NOT NULL,
    public_url       TEXT NOT NULL,
    owner_id         UUID REFERENCES accounts(id) ON DELETE SET NULL,
    claim_code_hash  BYTEA UNIQUE,
    claim_expires_at TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
