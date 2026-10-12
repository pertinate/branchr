-- Server banner (shown above the channel list) and a short description.
ALTER TABLE guilds ADD COLUMN banner_url TEXT;
ALTER TABLE guilds ADD COLUMN description TEXT;
