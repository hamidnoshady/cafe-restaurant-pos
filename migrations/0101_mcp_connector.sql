-- Phase 34 — the MCP connector.
--
-- Every AI surface this app has built so far points inward: the assistant, the
-- proactive digests, autopilot and the coworker all run a model *we* call, with
-- *our* prompt, inside this codebase. An owner who already pays for Claude or
-- ChatGPT and wants to ask *that* app about their café has had no way to do it —
-- and the public API (Phase 19) does not help, because a chat client cannot read
-- an OpenAPI spec and mint itself a key.
--
-- The Model Context Protocol is the missing shape: one HTTP endpoint that
-- advertises its own tools, and an OAuth 2.1 authorization server so a connector
-- can be added by pasting a URL and pressing "connect" — which is the only flow
-- the Claude mobile/desktop apps and ChatGPT's connectors offer.
--
-- Four decisions this schema encodes:
--
--   * **Read and write are separate grants.** `scopes` is a set, so an owner can
--     hand out read-only, write-only or both. A read-only connection is the
--     default and the one most owners should ever create.
--   * **Write trust is per connection.** `write_mode = 'apply'` means the model's
--     write runs immediately (the owner pressed "trust" once instead of pressing
--     Apply every time); `'approve'` means it lands in an approval list and
--     changes nothing until a human says so. Neither is a default the code picks.
--   * **Two ways to hold the credential, one row.** An OAuth grant (Claude,
--     ChatGPT) and a pasted static token (Codex, a config file, a script) both
--     produce an `mcp_connections` row; only the second stores a token hash on
--     it, and only the first has a `client_id`. Revoking is one action either way.
--   * **A token is never stored.** SHA-256 and a display prefix, the same rule
--     api_keys, pairing codes, invitations and rollup tokens all follow.
--
-- All four tables are tenant-scoped and carry the standard RLS policy. The
-- OAuth client registration is scoped too: a business is served from its own
-- origin (Phase 23), so the host the client registered against *is* the tenant,
-- and a registration made at one business's address must not be usable at
-- another's.

-- ---------------------------------------------------------------------------
-- Connections
-- ---------------------------------------------------------------------------

CREATE TABLE mcp_connections (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    -- The branch every tool call is scoped to, exactly as an API key names one.
    location_id     uuid NOT NULL,
    name            text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
    scopes          text[] NOT NULL CHECK (
                        cardinality(scopes) > 0
                        AND scopes <@ ARRAY['pos.read', 'pos.write']::text[]
                    ),
    -- Only consulted when 'pos.write' is granted; stored regardless so that
    -- widening a connection later cannot silently inherit 'apply'.
    write_mode      text NOT NULL DEFAULT 'approve' CHECK (write_mode IN ('apply', 'approve')),
    -- 'token' = an owner minted a bearer token and pasted it into a client
    -- config. 'oauth' = a client obtained it through the authorization flow.
    origin          text NOT NULL CHECK (origin IN ('token', 'oauth')),
    client_id       uuid,
    -- Static tokens only. NULL for an OAuth connection, whose credentials live
    -- in mcp_oauth_tokens and rotate.
    token_prefix    text CHECK (token_prefix IS NULL OR char_length(token_prefix) BETWEEN 10 AND 32),
    token_hash      text UNIQUE CHECK (token_hash IS NULL OR char_length(token_hash) = 64),
    status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
    -- The human whose authority a write runs under. Same rule as
    -- ai_autopilot_settings.authorized_by: an automated write is never
    -- anonymous, so a connection whose authorizer is gone can read but not write.
    authorized_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    last_used_at    timestamptz,
    expires_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz,
    CONSTRAINT mcp_connections_location_business_fk
        FOREIGN KEY (location_id, business_id)
        REFERENCES locations (id, business_id)
        ON DELETE CASCADE,
    CONSTRAINT mcp_connections_id_business_unique UNIQUE (id, business_id),
    CONSTRAINT mcp_connections_status_revocation_consistent CHECK (
        (status = 'active' AND revoked_at IS NULL)
        OR (status = 'revoked' AND revoked_at IS NOT NULL)
    ),
    CONSTRAINT mcp_connections_expiry_after_creation CHECK (
        expires_at IS NULL OR expires_at > created_at
    ),
    -- A static token is exactly the pair, present together or not at all; an
    -- OAuth connection has neither and names the client it was issued to.
    CONSTRAINT mcp_connections_credential_shape CHECK (
        (origin = 'token' AND token_hash IS NOT NULL AND token_prefix IS NOT NULL AND client_id IS NULL)
        OR (origin = 'oauth' AND token_hash IS NULL AND token_prefix IS NULL AND client_id IS NOT NULL)
    )
);

CREATE INDEX idx_mcp_connections_business_created
    ON mcp_connections (business_id, created_at DESC);
CREATE INDEX idx_mcp_connections_active
    ON mcp_connections (business_id, created_at DESC) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- OAuth 2.1 authorization server
-- ---------------------------------------------------------------------------

-- RFC 7591 dynamic client registration. Claude and ChatGPT register themselves
-- the first time an owner adds the connector; nobody types a client id.
--
-- Public clients only: there is no client secret column, because every client
-- that reaches this server is a native or browser app that cannot keep one.
-- PKCE (S256, required below) is what authenticates the token exchange instead,
-- which is what OAuth 2.1 mandates for exactly this case.
CREATE TABLE mcp_oauth_clients (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    client_name     text NOT NULL CHECK (char_length(trim(client_name)) BETWEEN 1 AND 200),
    -- Exact-match only at authorize time. No wildcards, no prefix matching:
    -- a loose redirect URI is how an authorization code leaves the building.
    redirect_uris   text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
    -- Purely informational, shown on the consent screen so the owner can see
    -- who is asking.
    client_uri      text,
    software_id     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_used_at    timestamptz,
    CONSTRAINT mcp_oauth_clients_id_business_unique UNIQUE (id, business_id)
);

CREATE INDEX idx_mcp_oauth_clients_business_created
    ON mcp_oauth_clients (business_id, created_at DESC);

ALTER TABLE mcp_connections
    ADD CONSTRAINT mcp_connections_client_fk
    FOREIGN KEY (client_id, business_id)
    REFERENCES mcp_oauth_clients (id, business_id)
    ON DELETE CASCADE;

-- An authorization code: single use, short lived, PKCE-bound.
--
-- The row is created by the *consent* POST — after a signed-in owner has looked
-- at what is being asked for — so it already carries the decision (which scopes,
-- which write mode, which branch) rather than deferring it to the token call.
CREATE TABLE mcp_oauth_codes (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    client_id       uuid NOT NULL,
    code_hash       text NOT NULL UNIQUE CHECK (char_length(code_hash) = 64),
    -- S256 only; 'plain' is not accepted anywhere in this server.
    code_challenge  text NOT NULL CHECK (char_length(code_challenge) BETWEEN 43 AND 128),
    redirect_uri    text NOT NULL,
    scopes          text[] NOT NULL CHECK (
                        cardinality(scopes) > 0
                        AND scopes <@ ARRAY['pos.read', 'pos.write']::text[]
                    ),
    write_mode      text NOT NULL DEFAULT 'approve' CHECK (write_mode IN ('apply', 'approve')),
    location_id     uuid NOT NULL,
    -- The owner who consented. Their authority is what a write later runs under.
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    connection_name text NOT NULL CHECK (char_length(trim(connection_name)) BETWEEN 1 AND 120),
    expires_at      timestamptz NOT NULL,
    consumed_at     timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT mcp_oauth_codes_client_fk
        FOREIGN KEY (client_id, business_id)
        REFERENCES mcp_oauth_clients (id, business_id)
        ON DELETE CASCADE,
    CONSTRAINT mcp_oauth_codes_location_business_fk
        FOREIGN KEY (location_id, business_id)
        REFERENCES locations (id, business_id)
        ON DELETE CASCADE
);

CREATE INDEX idx_mcp_oauth_codes_expiry ON mcp_oauth_codes (expires_at);

-- Access and refresh tokens for an OAuth connection. Hashes only, and both
-- kinds in one table because both are "a bearer string that resolves to this
-- connection" and both are revoked by the same act.
CREATE TABLE mcp_oauth_tokens (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    connection_id   uuid NOT NULL,
    kind            text NOT NULL CHECK (kind IN ('access', 'refresh')),
    token_hash      text NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
    expires_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    revoked_at      timestamptz,
    CONSTRAINT mcp_oauth_tokens_connection_fk
        FOREIGN KEY (connection_id, business_id)
        REFERENCES mcp_connections (id, business_id)
        ON DELETE CASCADE
);

CREATE INDEX idx_mcp_oauth_tokens_connection
    ON mcp_oauth_tokens (connection_id, kind, created_at DESC);
CREATE INDEX idx_mcp_oauth_tokens_expiry ON mcp_oauth_tokens (expires_at);

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

-- Every MCP tool call that changed something is an assistant action like any
-- other, so it extends the existing trail rather than forking a parallel one —
-- the same reasoning migration 0097 gives for autopilot. `mcp_connection_id`
-- answers "which connector did this", which is the one question the existing
-- columns cannot.
ALTER TABLE ai_action_audit
    DROP CONSTRAINT ai_action_audit_source_check,
    ADD CONSTRAINT ai_action_audit_source_check
        CHECK (source IN ('manual', 'autopilot', 'coworker', 'mcp')),
    ADD COLUMN mcp_connection_id uuid REFERENCES mcp_connections(id) ON DELETE SET NULL;

CREATE INDEX idx_ai_action_audit_mcp_pending
    ON ai_action_audit (business_id, created_at DESC)
    WHERE source = 'mcp' AND status = 'proposed';

-- A read is not audited (the public API's own log is bounded to mutations for
-- the same reason: an assistant asking twenty questions is not twenty events),
-- but "when did this connector last do anything" is worth knowing, so
-- mcp_connections.last_used_at is touched on every authenticated call.

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE mcp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_connections FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE mcp_oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_oauth_clients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_oauth_clients FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE mcp_oauth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_oauth_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_oauth_codes FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE mcp_oauth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_oauth_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_oauth_tokens FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
