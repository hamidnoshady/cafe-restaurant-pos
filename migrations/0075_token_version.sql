ALTER TABLE users ADD COLUMN token_version integer NOT NULL DEFAULT 1;
ALTER TABLE platform_users ADD COLUMN token_version integer NOT NULL DEFAULT 1;
ALTER TABLE platform_admins ADD COLUMN token_version integer NOT NULL DEFAULT 1;
