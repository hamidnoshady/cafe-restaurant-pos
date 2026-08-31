ALTER TABLE auth_login_attempts DROP CONSTRAINT auth_login_attempts_realm_check;
ALTER TABLE auth_login_attempts ADD CONSTRAINT auth_login_attempts_realm_check 
  CHECK (realm IN ('tenant_password','platform_admin','directory','mfa_challenge'));
