/**
 * Phase 38 Wave 1 — the in-memory `WebsiteAdapter`.
 *
 * Two jobs: (1) prove the interface is implementable end to end before any
 * real site exists, and (2) give the sync tick, the assistant tools and the
 * API routes something deterministic to run against in tests. It keeps every
 * contract rule the interface states — a draft is a draft until `publishPost`,
 * money is integer Rial, and failures come out as `WebsiteAdapterError`.
 *
 * `failWith` lets a test flip the site "down" (`unreachable`) or "revoked"
 * (`unauthorized`) between calls, which is how the outbox's retry and
 * dead-letter paths are exercised without a network.
 */
import {
  WebsiteAdapterError,
  slugify,
  type ConnectionTest,
  type Page,
  type Post,
  type PostDraft,
  type PostStatus,
  type RemoteProduct,
  type RemoteProductInput,
  type WebsiteAdapter,
  type WebsiteAdapterErrorCode,
  type WebsiteMedia,
  type MediaUpload,
} from "../adapter";

export interface MockWebsiteOptions {
  siteName?: string;
  siteUrl?: string;
  /** Deterministic clock for tests; defaults to `Date.now`. */
  now?: () => Date;
  posts?: Post[];
  products?: RemoteProduct[];
}

export class MockWebsiteAdapter implements WebsiteAdapter {
  readonly key = "mock" as const;
  readonly siteName: string;
  readonly siteUrl: string;
  readonly posts: Post[];
  readonly products: RemoteProduct[];
  /** Every call made, oldest first — tests assert on it. */
  readonly calls: { method: string; args: unknown[] }[] = [];
  private readonly now: () => Date;
  private counter = 0;
  private failure: WebsiteAdapterErrorCode | null = null;

  constructor(options: MockWebsiteOptions = {}) {
    this.siteName = options.siteName ?? "سایت آزمایشی";
    this.siteUrl = options.siteUrl ?? "https://example.test";
    this.now = options.now ?? (() => new Date());
    this.posts = [...(options.posts ?? [])];
    this.products = [...(options.products ?? [])];
  }

  /** Make every following call fail with `code`; `null` restores the site. */
  failWith(code: WebsiteAdapterErrorCode | null): void {
    this.failure = code;
  }

  private guard(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.failure) throw new WebsiteAdapterError(this.failure, `mock:${method}`);
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}_${this.counter}`;
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  async testConnection(): Promise<ConnectionTest> {
    this.calls.push({ method: "testConnection", args: [] });
    if (this.failure) return { ok: false, error: this.failure };
    return { ok: true, siteName: this.siteName };
  }

  // ---- media -------------------------------------------------------------

  async uploadMedia(input: MediaUpload): Promise<WebsiteMedia> {
    this.guard("uploadMedia", input.filename, input.mimeType, input.bytes.byteLength);
    if (!input.filename.trim() || !input.mimeType.startsWith("image/") || input.bytes.byteLength === 0) {
      throw new WebsiteAdapterError("rejected", "invalid image upload");
    }
    const id = this.nextId("media");
    return { id, url: `${this.siteUrl}/media/${id}`, filename: input.filename, alt: input.alt ?? null };
  }

  // ---- posts -------------------------------------------------------------

  async listPosts(q: { status?: PostStatus; limit: number; cursor?: string }): Promise<Page<Post>> {
    this.guard("listPosts", q);
    const filtered = this.posts.filter((post) => !q.status || post.status === q.status);
    return paginate(filtered, q.limit, q.cursor);
  }

  async getPost(id: string): Promise<Post | null> {
    this.guard("getPost", id);
    return this.posts.find((post) => post.id === id) ?? null;
  }

  async draftPost(input: PostDraft): Promise<Post> {
    this.guard("draftPost", input);
    const at = this.stamp();
    const post: Post = {
      id: this.nextId("post"),
      title: input.title,
      slug: input.slug ?? slugify(input.title),
      body: input.body,
      excerpt: input.excerpt ?? null,
      // The contract: a draft is a draft. There is no input that changes this.
      status: "draft",
      featuredImageUrl: input.featuredImageId ? `${this.siteUrl}/media/${input.featuredImageId}` : null,
      publishedAt: null,
      updatedAt: at,
      createdAt: at,
      url: null,
    };
    this.posts.unshift(post);
    return post;
  }

  async updatePost(id: string, input: Partial<PostDraft>): Promise<Post> {
    this.guard("updatePost", id, input);
    const post = this.posts.find((row) => row.id === id);
    if (!post) throw new WebsiteAdapterError("not_found", id);
    if (input.title !== undefined) post.title = input.title;
    if (input.body !== undefined) post.body = input.body;
    if (input.slug !== undefined) post.slug = input.slug;
    if (input.excerpt !== undefined) post.excerpt = input.excerpt;
    if (input.featuredImageId !== undefined) {
      post.featuredImageUrl = input.featuredImageId ? `${this.siteUrl}/media/${input.featuredImageId}` : null;
    }
    post.updatedAt = this.stamp();
    return { ...post };
  }

  async publishPost(id: string): Promise<Post> {
    this.guard("publishPost", id);
    const post = this.posts.find((row) => row.id === id);
    if (!post) throw new WebsiteAdapterError("not_found", id);
    const at = this.stamp();
    post.status = "published";
    post.publishedAt = post.publishedAt ?? at;
    post.updatedAt = at;
    post.url = `${this.siteUrl}/blog/${post.slug}`;
    return { ...post };
  }

  // ---- products ----------------------------------------------------------

  async listProducts(q: { limit: number; cursor?: string }): Promise<Page<RemoteProduct>> {
    this.guard("listProducts", q);
    return paginate(this.products, q.limit, q.cursor);
  }

  async upsertProduct(input: RemoteProductInput): Promise<RemoteProduct> {
    this.guard("upsertProduct", input);
    if (!Number.isInteger(input.priceRial) || input.priceRial < 0) {
      throw new WebsiteAdapterError("rejected", "price must be a non-negative integer Rial");
    }
    const at = this.stamp();
    if (input.remoteId) {
      const existing = this.products.find((row) => row.id === input.remoteId);
      if (!existing) throw new WebsiteAdapterError("not_found", input.remoteId);
      existing.title = input.title;
      existing.sku = input.sku ?? existing.sku;
      existing.priceRial = input.priceRial;
      if (input.stock !== undefined) existing.stock = input.stock;
      existing.updatedAt = at;
      return { ...existing };
    }
    const product: RemoteProduct = {
      id: this.nextId("prod"),
      title: input.title,
      sku: input.sku ?? null,
      priceRial: input.priceRial,
      stock: input.stock ?? null,
      status: "draft",
      updatedAt: at,
    };
    this.products.unshift(product);
    return product;
  }

  async setProductStock(remoteId: string, quantity: number): Promise<void> {
    this.guard("setProductStock", remoteId, quantity);
    const product = this.products.find((row) => row.id === remoteId);
    if (!product) throw new WebsiteAdapterError("not_found", remoteId);
    product.stock = quantity;
    product.updatedAt = this.stamp();
  }

  async setProductPrice(remoteId: string, priceRial: number): Promise<void> {
    this.guard("setProductPrice", remoteId, priceRial);
    if (!Number.isInteger(priceRial) || priceRial < 0) {
      throw new WebsiteAdapterError("rejected", "price must be a non-negative integer Rial");
    }
    const product = this.products.find((row) => row.id === remoteId);
    if (!product) throw new WebsiteAdapterError("not_found", remoteId);
    product.priceRial = priceRial;
    product.updatedAt = this.stamp();
  }
}

/** Offset pagination behind an opaque cursor, so callers never learn it is an offset. */
function paginate<T>(rows: T[], limit: number, cursor?: string): Page<T> {
  const size = Math.max(1, Math.min(200, Math.trunc(limit)));
  const offset = cursor ? decodeCursor(cursor) : 0;
  const items = rows.slice(offset, offset + size);
  const next = offset + size;
  return { items, nextCursor: next < rows.length ? encodeCursor(next) : null, total: rows.length };
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^o:(\d+)$/.exec(decoded);
  return match ? Number(match[1]) : 0;
}
