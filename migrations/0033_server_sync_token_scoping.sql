-- Phase 17 security review — server-sync's receiving side (push/pull) has
-- authenticated against one global REMOTE_SYNC_TOKEN env var since Phase 11:
-- fine for a single dedicated VPS, but on a server hosting more than one
-- business it means any one business's café-laptop token also authenticates
-- as every other business hosted there. This adds a dedicated per-business
-- token, mirroring rollup_locations.token_hash exactly: only the hash is
-- stored, and resolving a token to a business happens before any tenant is
-- chosen — the same bypass category as login (see src/lib/server-sync.ts's
-- resolveBusinessBySyncToken). The legacy global-token path stays available
-- for anyone who hasn't configured a per-business token yet, but even that
-- path now derives its tenant scope explicitly from the request rather than
-- relying on RLS alone (see server-sync/push and /pull route.ts).

CREATE TABLE server_sync_tokens (
    business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
    token_hash  text NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE server_sync_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE server_sync_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON server_sync_tokens FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
