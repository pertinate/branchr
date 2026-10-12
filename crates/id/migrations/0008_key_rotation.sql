-- Rotation: a new key is published (in the JWKS) before it starts signing at activates_at.
ALTER TABLE signing_keys ADD COLUMN activates_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE signing_keys SET activates_at = created_at;
