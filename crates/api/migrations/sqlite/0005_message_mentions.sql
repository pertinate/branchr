-- Users mentioned by a message (JSON array of User, snapshotted so mentions of people who
-- later leave still render), and whether it pings everyone (@everyone / @here).
ALTER TABLE messages ADD COLUMN mentions TEXT;
ALTER TABLE messages ADD COLUMN mention_everyone INTEGER NOT NULL DEFAULT 0;
