-- Snapshot (JSON array of Emote) of emotes from other servers referenced as <:name:id>
-- in the message, so everyone can render them even if not in that server, or if the
-- emote is later removed.
ALTER TABLE messages ADD COLUMN emotes TEXT;
