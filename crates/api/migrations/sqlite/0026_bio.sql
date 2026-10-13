-- About me: a few lines people see on your user card.
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
