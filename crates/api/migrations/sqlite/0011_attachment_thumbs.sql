-- Content type of the attachment's preview (stored at thumb/<id>), when it has one.
ALTER TABLE attachments ADD COLUMN thumb_type TEXT;
