/**
 * Phase 38 Wave 4 (issue #382) — the assistant's four website writes and
 * three reads, as service functions. The route handlers (a human's confirm
 * click), the autopilot executors and the MCP write tools all call these —
 * one mutation path, per the Phase 31 rule.
 *
 * Every function goes through `adapterForBusiness`, so the Payload/mock
 * choice, the credential and the Rial conversion are all the adapter's
 * business; nothing here knows what a Lexical node is.
 *
 * `publishPost` is here because a human's click needs it. It has no executor
 * and no MCP tool — see `website.post.publish` in ACTION_CATALOG.
 */
import { WebsiteAdapterError, type Post, type RemoteProduct } from "./adapter";
import { adapterForBusiness, getWebsiteConnection, WebsiteNotConnectedError } from "./connection-service";
import { summarizeWebsiteQueue } from "./catalog-service";

export type WebsiteResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** HTTP status for a `WebsiteResult` error code — shared by the route handlers. */
export function websiteStatusFor(error: string): number {
  if (error === "not_found") return 404;
  if (error === "unauthorized") return 403;
  if (error === "not_connected") return 409;
  if (error === "unreachable") return 503;
  return 400;
}

function mapError(err: unknown): { ok: false; error: string } {
  if (err instanceof WebsiteNotConnectedError) return { ok: false, error: "not_connected" };
  if (err instanceof WebsiteAdapterError) return { ok: false, error: err.code };
  return { ok: false, error: err instanceof Error ? err.message : "website_failed" };
}

const TITLE_MAX = 200;
const BODY_MAX = 50_000;

export interface PostDraftInput {
  title: string;
  /** Markdown. */
  body: string;
  excerpt?: string;
}

function validateDraft(input: Partial<PostDraftInput>, requireAll: boolean): string | null {
  if (requireAll || input.title !== undefined) {
    if (typeof input.title !== "string" || input.title.trim().length === 0) return "title_required";
    if (input.title.trim().length > TITLE_MAX) return "field_too_long";
  }
  if (requireAll || input.body !== undefined) {
    if (typeof input.body !== "string" || input.body.trim().length === 0) return "content_required";
    if (input.body.length > BODY_MAX) return "field_too_long";
  }
  if (input.excerpt !== undefined && (typeof input.excerpt !== "string" || input.excerpt.length > 500)) return "field_too_long";
  return null;
}

/** Always a draft: the adapter contract forbids `draftPost` from publishing. */
export async function draftWebsitePost(businessId: string, input: PostDraftInput): Promise<WebsiteResult<Post>> {
  const invalid = validateDraft(input, true);
  if (invalid) return { ok: false, error: invalid };
  try {
    const { adapter } = await adapterForBusiness(businessId);
    const post = await adapter.draftPost({ title: input.title.trim(), body: input.body, excerpt: input.excerpt?.trim() || undefined });
    return { ok: true, data: post };
  } catch (err) {
    return mapError(err);
  }
}

/** Edits content only; the publish state is not among the fields it can touch. */
export async function updateWebsitePost(
  businessId: string,
  postId: string,
  input: Partial<PostDraftInput>,
): Promise<WebsiteResult<Post>> {
  if (!postId) return { ok: false, error: "bad_request" };
  const invalid = validateDraft(input, false);
  if (invalid) return { ok: false, error: invalid };
  if (input.title === undefined && input.body === undefined && input.excerpt === undefined) return { ok: false, error: "bad_request" };
  try {
    const { adapter } = await adapterForBusiness(businessId);
    const post = await adapter.updatePost(postId, {
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.excerpt !== undefined ? { excerpt: input.excerpt.trim() } : {}),
    });
    return { ok: true, data: post };
  } catch (err) {
    return mapError(err);
  }
}

/** A human's click only. */
export async function publishWebsitePost(businessId: string, postId: string): Promise<WebsiteResult<Post>> {
  if (!postId) return { ok: false, error: "bad_request" };
  try {
    const { adapter } = await adapterForBusiness(businessId);
    return { ok: true, data: await adapter.publishPost(postId) };
  } catch (err) {
    return mapError(err);
  }
}

export interface ProductUpsertInput {
  remoteId?: string;
  title: string;
  sku?: string;
  summary?: string;
  /** Integer Rial. */
  priceRial: number;
  stock?: number;
}

export async function upsertWebsiteProduct(businessId: string, input: ProductUpsertInput): Promise<WebsiteResult<RemoteProduct>> {
  if (typeof input.title !== "string" || input.title.trim().length === 0) return { ok: false, error: "title_required" };
  if (input.title.trim().length > TITLE_MAX) return { ok: false, error: "field_too_long" };
  if (!Number.isInteger(input.priceRial) || input.priceRial <= 0) return { ok: false, error: "invalid_price" };
  if (input.stock !== undefined && (!Number.isInteger(input.stock) || input.stock < 0)) return { ok: false, error: "invalid_inventory" };
  try {
    const { adapter } = await adapterForBusiness(businessId);
    const product = await adapter.upsertProduct({
      remoteId: input.remoteId || undefined,
      title: input.title.trim(),
      sku: input.sku?.trim() || undefined,
      summary: input.summary?.trim() || undefined,
      priceRial: input.priceRial,
      ...(input.stock !== undefined ? { stock: input.stock } : {}),
    });
    return { ok: true, data: product };
  } catch (err) {
    return mapError(err);
  }
}

// ---------------------------------------------------------------------------
// Reads — the three tools
// ---------------------------------------------------------------------------

export async function listWebsitePostsTool(
  businessId: string,
  args: { status?: string; limit?: number },
): Promise<WebsiteResult<{ posts: Post[]; hasMore: boolean }>> {
  try {
    const { adapter } = await adapterForBusiness(businessId);
    const status = args.status === "draft" || args.status === "published" ? args.status : undefined;
    const limit = Math.max(1, Math.min(50, Math.trunc(Number(args.limit) || 20)));
    const page = await adapter.listPosts({ status, limit });
    return { ok: true, data: { posts: page.items, hasMore: page.nextCursor !== null } };
  } catch (err) {
    return mapError(err);
  }
}

export async function listWebsiteProductsTool(
  businessId: string,
  args: { limit?: number },
): Promise<WebsiteResult<{ products: RemoteProduct[]; hasMore: boolean }>> {
  try {
    const { adapter } = await adapterForBusiness(businessId);
    const limit = Math.max(1, Math.min(100, Math.trunc(Number(args.limit) || 50)));
    const page = await adapter.listProducts({ limit });
    return { ok: true, data: { products: page.items, hasMore: page.nextCursor !== null } };
  } catch (err) {
    return mapError(err);
  }
}

export interface WebsiteStatusView {
  connected: boolean;
  adapterKey: string | null;
  siteDomain: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  pushPrices: boolean;
  pushStock: boolean;
  productScope: "selected" | "all" | null;
  queue: { pending: number; failed: number; dead: number; sent24h: number } | null;
}

/** Connection + sync state, masked. Never the key. */
export async function websiteStatusTool(businessId: string): Promise<WebsiteStatusView> {
  const connection = await getWebsiteConnection(businessId);
  if (!connection) {
    return {
      connected: false,
      adapterKey: null,
      siteDomain: null,
      lastCheckedAt: null,
      lastError: null,
      pushPrices: false,
      pushStock: false,
      productScope: null,
      queue: null,
    };
  }
  return {
    connected: connection.status === "active",
    adapterKey: connection.adapterKey,
    siteDomain: connection.siteDomain,
    lastCheckedAt: connection.lastCheckedAt,
    lastError: connection.lastError,
    pushPrices: connection.pushPrices,
    pushStock: connection.pushStock,
    productScope: connection.productScope,
    queue: await summarizeWebsiteQueue(businessId),
  };
}
