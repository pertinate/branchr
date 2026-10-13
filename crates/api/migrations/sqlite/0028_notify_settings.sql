-- Each user's muted communities and channels and notification levels here (JSON), so they
-- follow them across devices.
CREATE TABLE notify_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data    TEXT NOT NULL
);
