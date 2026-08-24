/**
 * What an MCP connection is allowed to do, and how much it is trusted to do it.
 *
 * Two axes, kept separate on purpose:
 *
 *   * **scope** — `pos.read` and `pos.write` are independent grants. An owner
 *     connecting Claude to answer questions about last week's sales should be
 *     handing over `pos.read` and nothing else, and the UI defaults to exactly
 *     that. Granting both is a second, deliberate click.
 *   * **write mode** — given `pos.write`, does the model's write happen, or does
 *     it wait for a human? `'approve'` is the default because "I let an LLM
 *     change my prices" and "I let an LLM suggest price changes I approve" are
 *     very different sentences, and the code must never pick the first one.
 *
 * Pure: no database, no crypto, no framework. This is the vocabulary every
 * other file in `src/lib/mcp/` narrows against, so a value that reaches it from
 * a request body, a stored row or an OAuth `scope` string all pass through the
 * same parser and fail closed the same way.
 */

export const MCP_SCOPES = {
  read: "pos.read",
  write: "pos.write",
} as const;

export type McpScope = (typeof MCP_SCOPES)[keyof typeof MCP_SCOPES];

export const ALL_MCP_SCOPES: McpScope[] = Object.values(MCP_SCOPES);

export type McpWriteMode = "apply" | "approve";

export const MCP_WRITE_MODES: McpWriteMode[] = ["apply", "approve"];

/** Persian labels, so a consent screen and a connections row never invent their own wording. */
export const MCP_SCOPE_LABELS: Record<McpScope, string> = {
  "pos.read": "خواندن اطلاعات کسب‌وکار",
  "pos.write": "انجام تغییرات (ثبت و ویرایش)",
};

/**
 * What each grant actually means, in the owner's terms, for the consent screen.
 *
 * The person pressing "allow" in Claude is not the person who wrote the
 * integration, and `pos.write` tells them nothing about whether a menu price is
 * about to move. Same reasoning as the API key panel's scope descriptions.
 */
export const MCP_SCOPE_DESCRIPTIONS: Record<McpScope, string> = {
  "pos.read":
    "گزارش‌ها، فروش، منو، موجودی انبار، مشتریان، حساب‌ها و وضعیت راه‌اندازی — فقط خواندن، بدون هیچ تغییری.",
  "pos.write":
    "تغییر قیمت و وضعیت آیتم منو، تخفیف سفارش باز، پیش‌نویس سفارش خرید، تعدیل شمارش انبار، ثبت هزینه، پیش‌نویس سند حسابداری، یادداشت مشتری و ثبت تولید.",
};

export const MCP_WRITE_MODE_LABELS: Record<McpWriteMode, string> = {
  apply: "بدون تأیید اجرا شود",
  approve: "منتظر تأیید بماند",
};

export function isMcpScope(value: unknown): value is McpScope {
  return typeof value === "string" && (ALL_MCP_SCOPES as string[]).includes(value);
}

export function isMcpWriteMode(value: unknown): value is McpWriteMode {
  return value === "apply" || value === "approve";
}

/**
 * Reads a stored `text[]` (or a request body's array) defensively.
 *
 * Deduplicates, drops anything this release does not recognise, and preserves
 * the canonical order rather than the caller's — so two connections granted the
 * same access always compare and render identically. A removed or misspelled
 * historical scope must never widen a connection.
 */
export function parseMcpScopes(value: unknown): McpScope[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<McpScope>();
  for (const candidate of value) {
    if (isMcpScope(candidate)) seen.add(candidate);
  }
  return ALL_MCP_SCOPES.filter((scope) => seen.has(scope));
}

/**
 * The OAuth wire form: a space-delimited `scope` parameter (RFC 6749 §3.3).
 *
 * Unknown entries are dropped rather than rejected, because a client that asks
 * for `openid profile pos.read` must get a working `pos.read` grant instead of
 * an error page — every OAuth server behaves this way, and the response's own
 * `scope` field is what tells the client what it actually received.
 */
export function parseMcpScopeString(value: unknown): McpScope[] {
  if (typeof value !== "string") return [];
  return parseMcpScopes(value.split(/\s+/).filter(Boolean));
}

export function formatMcpScopeString(scopes: readonly McpScope[]): string {
  return scopes.join(" ");
}

export function hasMcpScope(scopes: readonly McpScope[], scope: McpScope): boolean {
  return scopes.includes(scope);
}

/**
 * The scopes a *granted* connection may hold, given what the client asked for.
 *
 * A grant can only ever narrow: the consent screen decides, and a client that
 * requested `pos.write` gets it only if the owner ticked it. Requesting nothing
 * recognisable means read — the least a connection can usefully be — rather
 * than an error, because "add this connector" with no scope parameter at all is
 * the normal case for a client that has never seen this server before.
 */
export function grantableScopes(requested: readonly McpScope[], approved: readonly McpScope[]): McpScope[] {
  const request = requested.length > 0 ? requested : [MCP_SCOPES.read];
  const granted = ALL_MCP_SCOPES.filter(
    (scope) => request.includes(scope) && approved.includes(scope),
  );
  return granted.length > 0 ? granted : [];
}
