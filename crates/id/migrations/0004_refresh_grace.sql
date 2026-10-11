-- When a refresh token was rotated. Two tabs refreshing at once both present it within
-- moments; that's allowed for a short while instead of being treated as theft.
ALTER TABLE refresh_tokens ADD COLUMN rotated_at TIMESTAMPTZ;
