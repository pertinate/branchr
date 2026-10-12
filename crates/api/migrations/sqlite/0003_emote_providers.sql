-- Emotes can come from several providers; existing rows are 7TV.
ALTER TABLE emotes ADD COLUMN provider TEXT NOT NULL DEFAULT '7tv';
