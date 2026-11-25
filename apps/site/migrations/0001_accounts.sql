-- Accounts signed in through providers (Discord first), and OAuth state.

CREATE TABLE accounts (
    id           UUID PRIMARY KEY,
    handle       TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    avatar_url   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A provider identity (e.g. a Discord user) linked to an account.
CREATE TABLE identities (
    provider   TEXT NOT NULL,
    subject    TEXT NOT NULL,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    username   TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_account ON identities (account_id);

-- A sign-in in progress: our client's PKCE challenge while the user is at the provider.
CREATE TABLE auth_requests (
    id             TEXT PRIMARY KEY,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    client_state   TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One-time codes handed back to the client, exchanged at /token with the PKCE verifier.
CREATE TABLE auth_codes (
    code_hash      BYTEA PRIMARY KEY,
    account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    expires_at     TIMESTAMPTZ NOT NULL
);

-- Refresh tokens rotate on every use. Presenting one that was rotated a while ago means it
-- leaked, so the whole family (that sign-in) is revoked.
CREATE TABLE refresh_tokens (
    token_hash BYTEA PRIMARY KEY,
    family     UUID NOT NULL,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    rotated    BOOLEAN NOT NULL DEFAULT false,
    rotated_at TIMESTAMPTZ
);
CREATE INDEX refresh_tokens_family ON refresh_tokens (family);

-- Ed25519 keys for the tokens we issue; the public halves are published as JWKS. A new key
-- is published before it starts signing at activates_at.
CREATE TABLE signing_keys (
    kid          TEXT PRIMARY KEY,
    seed         BYTEA NOT NULL,
    public_key   BYTEA NOT NULL,
    activates_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired      BOOLEAN NOT NULL DEFAULT false
);

-- Requests per client address per minute, for endpoints anyone can call.
CREATE TABLE rate_limits (
    key    TEXT NOT NULL,
    minute TIMESTAMPTZ NOT NULL,
    count  INTEGER NOT NULL,
    PRIMARY KEY (key, minute)
);
