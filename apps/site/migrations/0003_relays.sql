-- Relays people run (or, later, rent from us) that carry their hubs.
CREATE TABLE relays (
    id               UUID PRIMARY KEY,
    secret_hash      BYTEA NOT NULL,
    name             TEXT NOT NULL,
    owner_id         UUID REFERENCES accounts(id) ON DELETE SET NULL,
    claim_code_hash  BYTEA UNIQUE,
    claim_expires_at TIMESTAMPTZ,
    -- What it last reported about itself; null until its first heartbeat.
    quic             TEXT,
    fp               TEXT,
    web              TEXT,
    public_ip        TEXT,
    udp_start        INTEGER,
    udp_end          INTEGER,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at     TIMESTAMPTZ
);
CREATE INDEX relays_owner ON relays (owner_id);

-- The relay carrying a hub, and the media ports it has there.
ALTER TABLE hubs ADD COLUMN relay_id UUID REFERENCES relays(id) ON DELETE SET NULL;
ALTER TABLE hubs ADD COLUMN relay_port_base INTEGER;
ALTER TABLE hubs ADD COLUMN relay_port_count INTEGER;
CREATE INDEX hubs_relay ON hubs (relay_id);
