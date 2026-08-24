/**
 * Phase 34 — bearer authentication for the MCP endpoint.
 *
 * A fourth realm alongside tenant sessions, platform sessions and public API
 * keys, and it exists for the same reason Phase 19's did: the caller is a
 * machine, it holds one credential, and that credential — never a role — decides
 * what it may do. Two credential shapes resolve to the same connection row:
 *
 *   * a **static token** (`posmcp_…`) an owner pasted into a client config;
 *   * an **OAuth access token** (`posmcp_at_…`) a client obtained by walking the
 *     authorization flow, which is the only path Claude's and ChatGPT's
 *     connector UIs offer.
 *
 * Both are looked up fresh on every call and neither is cached anywhere, so a
 * revocation from the connections screen takes effect on the connector's very
 * next tool call.
 */
import { isFeatureEnabled } from "../features";
import { query, withoutTenantScope } from "../db";
import { businessScope, NO_SCOPE, runInTenantScope } from "../tenant-context";
import {
  MCP_ACCESS_TOKEN_PREFIX,
  MCP_TOKEN_PREFIX,
  hashMcpToken,
  parseMcpBearerToken,
} from "./oauth";
import { parseMcpScopes, type McpScope, type McpWriteMode, isMcpWriteMode } from "./scopes";

export interface McpAuthentication {
  connectionId: string;
  connectionName: string;
  businessId: string;
  locationId: string;
  scopes: McpScope[];
  writeMode: McpWriteMode;
  /**
   * The owner whose authority a write runs under. NULL where the authorizing
   * user has since been deleted — such a connection can still read, but every
   * write is refused, because an automated write is never anonymous (the same
   * rule `ai_autopilot_settings.authorized_by` and `ai_coworker_jobs.authorized_by`
   * encode).
   */
  authorizedByUserId: string | null;
}

export type McpAuthFailure =
  | "unauthorized"
  | "feature_disabled";

type ConnectionRow = {
  id: string;
  name: string;
  business_id: string;
  location_id: string;
  scopes: unknown;
  write_mode: string;
  authorized_by: string | null;
};

/**
 * Resolve a bearer credential to its connection, before any tenant is known.
 *
 * This is the documented `mcp-token-auth` bypass: the token itself is how the
 * tenant gets selected, exactly as with a public API key. The query joins
 * `locations` so a connection pointing at a deactivated branch stops
 * authenticating rather than silently answering about a branch that is closed.
 *
 * The `last_used_at` touch is a second, tenant-scoped statement that re-checks
 * active/expiry: if a revocation won the race after the read, the update matches
 * no row and the call is denied, so a revoke can never be beaten by a request
 * already in flight.
 */
export async function authenticateMcp(
  request: Pick<Request, "headers">,
): Promise<McpAuthentication | null> {
  return runInTenantScope(NO_SCOPE, async () => {
    const token = parseMcpBearerToken(request);
    if (!token) return null;

    const hash = hashMcpToken(token);
    const isOauth = token.startsWith(MCP_ACCESS_TOKEN_PREFIX);

    const { rows } = await withoutTenantScope("mcp-token-auth", () =>
      isOauth
        ? query<ConnectionRow>(
            `SELECT c.id, c.name, c.business_id, c.location_id, c.scopes, c.write_mode, c.authorized_by
               FROM mcp_oauth_tokens t
               JOIN mcp_connections c
                 ON c.id = t.connection_id AND c.business_id = t.business_id
               JOIN locations l
                 ON l.id = c.location_id AND l.business_id = c.business_id AND l.is_active
              WHERE t.token_hash = $1
                AND t.kind = 'access'
                AND t.revoked_at IS NULL
                AND (t.expires_at IS NULL OR t.expires_at > now())
                AND c.status = 'active'
                AND (c.expires_at IS NULL OR c.expires_at > now())`,
            [hash],
          )
        : query<ConnectionRow>(
            `SELECT c.id, c.name, c.business_id, c.location_id, c.scopes, c.write_mode, c.authorized_by
               FROM mcp_connections c
               JOIN locations l
                 ON l.id = c.location_id AND l.business_id = c.business_id AND l.is_active
              WHERE c.token_hash = $1
                AND c.origin = 'token'
                AND c.status = 'active'
                AND (c.expires_at IS NULL OR c.expires_at > now())`,
            [hash],
          ),
    );

    const row = rows[0];
    if (!row) return null;

    const authentication: McpAuthentication = {
      connectionId: row.id,
      connectionName: row.name,
      businessId: row.business_id,
      locationId: row.location_id,
      scopes: parseMcpScopes(row.scopes),
      writeMode: isMcpWriteMode(row.write_mode) ? row.write_mode : "approve",
      authorizedByUserId: row.authorized_by,
    };

    const touched = await runInTenantScope(
      businessScope(authentication.businessId, authentication.locationId),
      () =>
        query<{ id: string }>(
          `UPDATE mcp_connections
              SET last_used_at = now()
            WHERE id = $1
              AND business_id = $2
              AND status = 'active'
              AND (expires_at IS NULL OR expires_at > now())
          RETURNING id`,
          [authentication.connectionId, authentication.businessId],
        ),
    );
    return touched.rows[0] ? authentication : null;
  });
}

/**
 * Whether this business may use the MCP connector at all.
 *
 * Gated on `api_platform`, the same entitlement the public API uses — both are
 * "this business's data, reachable by a program it chose". Checked here rather
 * than through `featureForApiPath`, because that map keys off the request path
 * and `/api/mcp` never passes through `withTenantScope`.
 */
export async function mcpFeatureEnabled(businessId: string): Promise<boolean> {
  return isFeatureEnabled(businessId, "api_platform");
}

/**
 * Run `fn` with the connection's business/location scope established for its
 * whole body.
 *
 * The outer `NO_SCOPE` is deliberate and is the same shape `withApiKeyScope`
 * uses: an absent or rejected credential must fail closed rather than inherit
 * ambient scope from unrelated work — which, with background ticks interleaving
 * in `server.ts`, is a real possibility rather than a theoretical one.
 */
export async function withMcpScope<T>(
  request: Pick<Request, "headers">,
  fn: (auth: McpAuthentication) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: McpAuthFailure }> {
  return runInTenantScope(NO_SCOPE, async () => {
    const auth = await authenticateMcp(request);
    if (!auth) return { ok: false as const, error: "unauthorized" as const };

    return runInTenantScope(
      businessScope(auth.businessId, auth.locationId, auth.authorizedByUserId),
      async () => {
        if (!(await mcpFeatureEnabled(auth.businessId))) {
          return { ok: false as const, error: "feature_disabled" as const };
        }
        return { ok: true as const, value: await fn(auth) };
      },
    );
  });
}

export { MCP_TOKEN_PREFIX };
