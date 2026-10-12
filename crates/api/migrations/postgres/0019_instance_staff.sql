-- Host staff appointed by its owner: 'admin' or 'moderator'.
CREATE TABLE instance_staff (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    role    TEXT NOT NULL
);
