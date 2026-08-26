ALTER TABLE audit_log ADD COLUMN ip_address text;
ALTER TABLE audit_log ADD COLUMN user_agent text;

ALTER TABLE platform_audit_log ADD COLUMN ip_address text;
ALTER TABLE platform_audit_log ADD COLUMN user_agent text;
