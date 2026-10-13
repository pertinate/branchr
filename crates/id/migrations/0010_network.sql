-- branchr's own staff (admins manage the list, moderators ban), and network-wide bans: a
-- banned account can't sign in to branchr or log in to any hub with it.
CREATE TABLE network_staff (
    account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('admin', 'moderator')),
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE network_bans (
    account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    reason     TEXT NOT NULL,
    banned_by  UUID REFERENCES accounts(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
