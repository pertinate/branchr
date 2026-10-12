-- Usernames are unique regardless of case (SQLite's column is COLLATE NOCASE).
CREATE UNIQUE INDEX users_username_lower ON users (lower(username));
