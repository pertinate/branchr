-- Usernames are matched with lower() so the same SQL works on Postgres; index that form.
CREATE INDEX users_username_lower ON users (lower(username));
