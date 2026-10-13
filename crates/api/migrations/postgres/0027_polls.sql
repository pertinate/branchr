-- Polls: a message's question and answers (a JSON array of strings), and who voted for what.
CREATE TABLE polls (
    message_id BIGINT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    question   TEXT NOT NULL,
    answers    TEXT NOT NULL,
    multi      BIGINT NOT NULL DEFAULT 0,
    ends_at    BIGINT NOT NULL
);
CREATE TABLE poll_votes (
    message_id BIGINT NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
    answer     BIGINT NOT NULL,
    user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, answer, user_id)
);
