-- ============================================================================
-- 0126_business_encryption_keys_rls.sql — Phase 24 Wave 3 follow-up.
--
-- `business_encryption_keys` (migration 0072) shipped with a policy that does
-- not match any other tenant table in the schema:
--
--     USING (business_id = nullif(current_setting('app.business_id', TRUE), '')::uuid)
--
-- Every policy in 0021 is `app_rls_bypass() OR business_id = app_current_business()`.
-- The missing half is not cosmetic. `app.rls_bypass` is how the platform realm,
-- the migration runner and every background job that legitimately works across
-- tenants get their access (see the catalogue of reasons on
-- `withoutTenantScope` in src/lib/db.ts), and a table that ignores it is
-- invisible to all of them.
--
-- Nothing noticed until Wave 3 gave the table its first reader, because nothing
-- had ever read it. What it breaks, on any install where the app connects as
-- the unprivileged `pos_app` role — which is to say every correctly configured
-- install, and NOT the docker-compose default where `pos` is a superuser and
-- RLS is silently a no-op:
--
--   * `provisionBusiness` mints the business's DEK inside its transaction,
--     which runs under the platform bypass. The INSERT fails the policy's
--     WITH CHECK, so creating a business fails outright once a master key is
--     configured.
--   * `getBusinessDek` reads and mints under the same bypass, so every
--     encrypted read and write fails.
--   * `scripts/encrypt-fields.ts` enumerates businesses under the bypass and
--     can never load a key.
--
-- The fix is to make it an ordinary tenant table: the same predicate as
-- everything else, a matching WITH CHECK, and FORCE so the table owner is
-- bound by it too.
--
-- This does NOT weaken the isolation the original policy intended. A tenant
-- session still sees only its own row. And the row is inert either way: the
-- wrapped DEK is ciphertext under a KEK that lives in the process environment,
-- never in the database — the RLS here is defence-in-depth, not the thing
-- keeping the key secret.
-- ============================================================================

DROP POLICY IF EXISTS "business_encryption_keys_tenant_isolation" ON business_encryption_keys;

CREATE POLICY "business_encryption_keys_tenant_isolation" ON business_encryption_keys
    FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE business_encryption_keys FORCE ROW LEVEL SECURITY;
