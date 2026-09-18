/**
 * Phase 40 — the WordPress & WooCommerce Manager read models and content
 * mirror, end to end against a real database.
 *
 * These services are what every manager screen reads: the میز کار overview
 * counts, the store's customer list, the operational queue, and the mirrored
 * post/page/media library. They are DB-touching, so they are exercised here
 * rather than in a unit test — the pure title/entity decoding they lean on is
 * covered by `src/lib/integrations/wp-content-service.test.ts`.
 *
 * What is proved:
 *   1. The overview counts a business's connections, mapped entities, terms,
 *      content and queue depth — scoped to one connection or summed across a
 *      business.
 *   2. `upsertWpContent` is a real upsert (a re-sent post updates one row) and
 *      decodes the entities WordPress puts in a title, so the manager's list
 *      never shows a raw `&#8217;`.
 *   3. The queue merges outbound outbox jobs and inbound webhook failures, and
 *      the customer list joins a mapping to its local party.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const KEY = "cd".repeat(32);

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db") | undefined;
let manager: typeof import("../src/lib/integrations/wp-manager-service");
let content: typeof import("../src/lib/integrations/wp-content-service");
let ingest: typeof import("../src/lib/integrations/webhook-ingest-service");
let taxonomy: typeof import("../src/lib/integrations/woo-taxonomy-service");
let connections: typeof import("../src/lib/integrations/connections-service");

const biz = { id: "", locationId: "", userId: "", pluginConnId: "", restConnId: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

/**
 * A connection made through the real service, so the plugin-token constraint
 * (a plugin connection must carry a hashed + encrypted token) is satisfied the
 * same way the app satisfies it. The connection is then marked `active` so the
 * overview's active count is exercised.
 */
async function makeConnection(linkMode: "plugin" | "rest_api", name: string): Promise<string> {
  const result = await connections.createConnection(biz.id, biz.userId, {
    name,
    baseUrl: "https://shop.example.com",
    linkMode,
    currencyUnit: "toman",
    consumerKey: linkMode === "rest_api" ? "ck_test" : undefined,
    consumerSecret: linkMode === "rest_api" ? "cs_test" : undefined,
    locationId: biz.locationId,
  });
  if (!result.ok) throw new Error(`createConnection failed: ${result.error}`);
  await db.query(`UPDATE integration_connections SET status = 'active' WHERE id = $1`, [result.connection.id]);
  return result.connection.id;
}

beforeAll(async () => {
  databaseName = `pos_wp_mgr_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  process.env.INTEGRATIONS_ENCRYPTION_KEY = KEY;
  dbLib = await import("../src/lib/db");
  manager = await import("../src/lib/integrations/wp-manager-service");
  content = await import("../src/lib/integrations/wp-content-service");
  ingest = await import("../src/lib/integrations/webhook-ingest-service");
  taxonomy = await import("../src/lib/integrations/woo-taxonomy-service");
  connections = await import("../src/lib/integrations/connections-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, industry) VALUES ('Shop', $1, 'accessories') RETURNING id",
    [`wp-mgr-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;
  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;
  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  biz.userId = userRow.rows[0].id;

  biz.pluginConnId = await makeConnection("plugin", "Plugin Store");
  biz.restConnId = await makeConnection("rest_api", "REST Store");
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
  delete process.env.INTEGRATIONS_ENCRYPTION_KEY;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

const conn = () => ({ id: biz.pluginConnId, business_id: biz.id }) as never;

describe("the content mirror upserts and decodes what WordPress sends", () => {
  it("creates a row from a pushed post and decodes the entities in its title", async () => {
    await content.upsertWpContent(conn(), {
      id: 101,
      type: "post",
      // wptexturize output: apostrophe + curly quotes + ellipsis, plus a tag.
      title: { rendered: "<b>Caf&#233;</b>&#8217;s &#8220;News&#8221;&#8230;" },
      status: "publish",
      slug: "cafe-news",
      link: "https://shop.example.com/cafe-news",
      date_modified: "2026-02-01T10:00:00Z",
    });

    const rows = await content.listWpContent(biz.id, biz.pluginConnId, { wpType: "post" });
    const row = rows.find((r) => r.remoteId === "101");
    expect(row).toBeTruthy();
    // The whole point of the fix: no raw &#8217; / &#8230; in front of the owner.
    expect(row!.title).toBe("Café’s “News”…");
    expect(row!.slug).toBe("cafe-news");
    expect(row!.status).toBe("publish");
  });

  it("updates one row on a re-send rather than duplicating it", async () => {
    await content.upsertWpContent(conn(), { id: 101, type: "post", title: "Renamed", status: "draft" });
    const rows = await content.listWpContent(biz.id, biz.pluginConnId, { wpType: "post" });
    const matching = rows.filter((r) => r.remoteId === "101");
    expect(matching).toHaveLength(1);
    expect(matching[0].title).toBe("Renamed");
    expect(matching[0].status).toBe("draft");
  });

  it("keeps a media attachment's safe source url, mime type and alt text", async () => {
    await content.upsertWpContent(conn(), {
      id: 900,
      type: "attachment",
      title: "Logo",
      source_url: "https://shop.example.com/logo.png",
      mime_type: "image/png",
      alt_text: "نشان فروشگاه",
    });
    const rows = await content.listWpContent(biz.id, biz.pluginConnId, { wpType: "attachment" });
    const media = rows.find((r) => r.remoteId === "900");
    expect(media?.mediaUrl).toBe("https://shop.example.com/logo.png");
    expect(media?.mimeType).toBe("image/png");
    expect(media?.altText).toBe("نشان فروشگاه");

    await content.upsertWpContent(conn(), {
      id: 901,
      type: "attachment",
      title: "Unsafe",
      source_url: "javascript:alert(1)",
      mime_type: "image/svg+xml",
    });
    const unsafe = (await content.listWpContent(biz.id, biz.pluginConnId, { wpType: "attachment" }))
      .find((row) => row.remoteId === "901");
    expect(unsafe?.mediaUrl).toBeNull();
    expect(await content.deleteWpContent(biz.id, biz.pluginConnId, { id: 901, type: "attachment" })).toBe(true);
  });

  it("ignores a payload with no usable id instead of writing a junk row", async () => {
    await content.upsertWpContent(conn(), { id: 0, type: "post", title: "nope" });
    await content.upsertWpContent(conn(), { id: "", type: "post", title: "nope" });
    const rows = await content.listWpContent(biz.id, biz.pluginConnId, { wpType: "post" });
    expect(rows.some((r) => r.title === "nope")).toBe(false);
  });

  it("counts posts, pages and media by type", async () => {
    await content.upsertWpContent(conn(), { id: 200, type: "page", title: "About" });
    const counts = await content.wpContentCounts(biz.id, biz.pluginConnId);
    expect(counts.posts).toBeGreaterThanOrEqual(1);
    expect(counts.pages).toBe(1);
    expect(counts.media).toBe(1);
  });

  it("filters and pages media without hiding attachments after the first result page", async () => {
    await content.upsertWpContent(conn(), {
      id: 902,
      type: "attachment",
      title: "Launch video",
      source_url: "https://shop.example.com/launch.mp4",
      mime_type: "video/mp4",
    });
    await content.upsertWpContent(conn(), {
      id: 903,
      type: "attachment",
      title: "Price list",
      source_url: "https://shop.example.com/prices.pdf",
      mime_type: "application/pdf",
    });

    const videos = await content.listWpContent(biz.id, biz.pluginConnId, {
      wpType: "attachment",
      mediaKind: "video",
    });
    expect(videos.map((row) => row.remoteId)).toEqual(["902"]);
    expect(await content.countWpContent(biz.id, biz.pluginConnId, {
      wpType: "attachment",
      mediaKind: "document",
    })).toBe(1);

    const first = await content.listWpContent(biz.id, biz.pluginConnId, {
      wpType: "attachment",
      limit: 1,
      offset: 0,
    });
    const second = await content.listWpContent(biz.id, biz.pluginConnId, {
      wpType: "attachment",
      limit: 1,
      offset: 1,
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].remoteId).not.toBe(first[0].remoteId);

    await content.deleteWpContent(biz.id, biz.pluginConnId, { id: 902, type: "attachment" });
    await content.deleteWpContent(biz.id, biz.pluginConnId, { id: 903, type: "attachment" });
  });

  it("applies plugin deletion and full-sync watermark events", async () => {
    await content.upsertWpContent(conn(), {
      id: 990,
      type: "attachment",
      title: "Delete me",
      source_url: "https://shop.example.com/delete-me.jpg",
      mime_type: "image/jpeg",
    });
    const connection = await connections.getConnection(biz.id, biz.pluginConnId);
    expect(connection).toBeTruthy();

    const deleted = await ingest.ingestPluginEvent(connection!, {
      topic: "content.deleted",
      deliveryId: randomUUID(),
      payload: { id: 990, type: "attachment" },
    });
    expect(deleted.status).toBe("processed");
    expect((await content.listWpContent(biz.id, biz.pluginConnId, { wpType: "attachment" }))
      .some((row) => row.remoteId === "990")).toBe(false);

    const completed = await ingest.ingestPluginEvent(connection!, {
      topic: "content.sync_completed",
      deliveryId: randomUUID(),
      payload: { id: "content:all", type: "content", count: 1 },
    });
    expect(completed.status).toBe("processed");
    expect((await connections.getConnection(biz.id, biz.pluginConnId))?.last_content_sync_at).toBeTruthy();
  });

  it("filters the content list by a title search", async () => {
    const hits = await content.listWpContent(biz.id, biz.pluginConnId, { search: "About" });
    expect(hits.every((r) => r.title.includes("About"))).toBe(true);
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });
});

describe("the overview counts what the manager mirrors", () => {
  it("counts connections by link mode across the business", async () => {
    const stats = await manager.wpOverviewStats(biz.id);
    expect(stats.connections.total).toBe(2);
    expect(stats.connections.plugin).toBe(1);
    expect(stats.connections.rest).toBe(1);
    expect(stats.connections.active).toBe(2);
    // Content mirrored above sums across the business.
    expect(stats.content.posts).toBeGreaterThanOrEqual(1);
    expect(stats.content.pages).toBe(1);
    expect(stats.content.media).toBe(1);
  });

  it("counts mapped products/orders/customers and terms for one connection", async () => {
    // A product mapping needs a real local item to point at (FK-free here, it
    // stores the uuid as text), plus a customer party and an order.
    const party = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, phone) VALUES ($1, 'سارا', '09120000000') RETURNING id`,
      [biz.id],
    );
    const order = await db.query<{ id: string }>(
      `INSERT INTO orders (location_id, order_number, status, customer_id, total)
       VALUES ($1, 5555, 'completed', $2, 30000) RETURNING id`,
      [biz.locationId, party.rows[0].id],
    );

    await db.query(
      `INSERT INTO integration_mappings (business_id, connection_id, entity_type, remote_id, local_id)
       VALUES ($1, $2, 'product', '5001', $3),
              ($1, $2, 'customer', '7001', $4),
              ($1, $2, 'order', '9001', $5)`,
      [biz.id, biz.pluginConnId, randomUUID(), party.rows[0].id, order.rows[0].id],
    );
    await db.query(
      `INSERT INTO integration_woo_terms (business_id, connection_id, taxonomy, remote_id, name, slug)
       VALUES ($1, $2, 'product_cat', '11', 'پوشاک', 'clothing')`,
      [biz.id, biz.pluginConnId],
    );

    const stats = await manager.wpOverviewStats(biz.id, biz.pluginConnId);
    expect(stats.products).toBe(1);
    expect(stats.customers).toBe(1);
    expect(stats.orders).toBe(1);
    expect(stats.terms).toBe(1);
  });

  it("counts pending and failed queue depth from outbox and inbox", async () => {
    await db.query(
      `INSERT INTO integration_outbox_events (business_id, connection_id, entity_type, remote_id, payload, status)
       VALUES ($1, $2, 'stock', '5001', '{}'::jsonb, 'pending'),
              ($1, $2, 'price', '5001', '{}'::jsonb, 'failed'),
              ($1, $2, 'product_update', '5002', '{}'::jsonb, 'dead')`,
      [biz.id, biz.pluginConnId],
    );
    await db.query(
      `INSERT INTO integration_webhook_events
         (business_id, connection_id, event_topic, remote_id, delivery_id, payload, status)
       VALUES ($1, $2, 'order.created', '9002', $3, '{}'::jsonb, 'failed'),
              ($1, $2, 'order.created', '9003', $4, '{}'::jsonb, 'pending')`,
      [biz.id, biz.pluginConnId, randomUUID(), randomUUID()],
    );

    const stats = await manager.wpOverviewStats(biz.id, biz.pluginConnId);
    // pending + processing + failed
    expect(stats.pendingJobs).toBe(2);
    expect(stats.failedJobs).toBe(1);
    expect(stats.deadJobs).toBe(1);
    expect(stats.pendingInboxEvents).toBe(1);
    expect(stats.failedInboxEvents).toBe(1);
  });
});

describe("the operational queue and the customer list", () => {
  it("merges outbound outbox jobs and inbound inbox failures, newest first", async () => {
    const rows = await manager.wpQueue(biz.id, biz.pluginConnId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.direction === "out")).toBe(true);
    expect(rows.some((r) => r.direction === "in")).toBe(true);
    // A dead outbox job is part of the operational queue.
    expect(rows.some((r) => r.status === "dead")).toBe(true);
    // Sorted by created_at DESC — timestamps are non-increasing.
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i - 1].createdAt >= rows[i].createdAt).toBe(true);
    }
  });

  it("lists the store's customers joined to their local party and order count", async () => {
    const rows = await manager.wpStoreCustomers(biz.id, biz.pluginConnId);
    const sara = rows.find((r) => r.remoteId === "7001");
    expect(sara).toBeTruthy();
    expect(sara!.name).toBe("سارا");
    expect(sara!.phone).toBe("09120000000");
    // She has one order recorded against her local party.
    expect(sara!.ordersCount).toBe(1);
  });
});

describe("the taxonomy mirror learns terms from a product payload (plugin mode)", () => {
  it("upserts the categories and tags a pushed product carries, and records the assignment", async () => {
    // In plugin mode the app never reads /products/categories — the only
    // taxonomy facts that ever arrive are the arrays carried on each product.
    await taxonomy.recordProductTermsFromPayload(biz.id, biz.pluginConnId, "5100", {
      categories: [
        { id: 21, name: "پوشاک", slug: "clothing" },
        { id: 22, name: "مردانه", slug: "mens" },
      ],
      tags: [{ id: 40, name: "حراج", slug: "sale" }],
    });

    const terms = await taxonomy.listTerms(biz.id, biz.pluginConnId);
    // Scope to the ids this payload introduced — the connection may already
    // carry other terms from earlier tests in this suite.
    const cats = terms.filter((t) => t.taxonomy === "product_cat" && ["21", "22"].includes(t.remoteId));
    const tags = terms.filter((t) => t.taxonomy === "product_tag" && t.remoteId === "40");
    expect(cats.map((t) => t.name).sort()).toEqual(["مردانه", "پوشاک"].sort());
    expect(tags.map((t) => t.name)).toEqual(["حراج"]);

    // The assignment is what lets a catalogue row show «دسته‌بندی: پوشاک».
    const byId = await taxonomy.termsByRemoteId(biz.id, biz.pluginConnId, ["5100"], "product_cat");
    expect(byId.get("5100")?.map((c) => c.name).sort()).toEqual(["مردانه", "پوشاک"].sort());
  });

  it("re-records the assignment as a replace, so a removed category disappears", async () => {
    await taxonomy.recordProductTermsFromPayload(biz.id, biz.pluginConnId, "5100", {
      categories: [{ id: 21, name: "پوشاک", slug: "clothing" }],
      tags: [],
    });
    const byId = await taxonomy.termsByRemoteId(biz.id, biz.pluginConnId, ["5100"], "product_cat");
    expect(byId.get("5100")?.map((c) => c.remoteId)).toEqual(["21"]);
  });

  it("keeps an upserted term's name up to date but ignores an empty payload term", async () => {
    await taxonomy.upsertTermFromPayload(biz.id, biz.pluginConnId, "product_cat", { id: 21, name: "پوشاک بانوان" });
    await taxonomy.upsertTermFromPayload(biz.id, biz.pluginConnId, "product_cat", { id: 0, name: "junk" });
    const terms = await taxonomy.listTerms(biz.id, biz.pluginConnId, "product_cat");
    expect(terms.find((t) => t.remoteId === "21")?.name).toBe("پوشاک بانوان");
    expect(terms.some((t) => t.remoteId === "0")).toBe(false);
  });
});

describe("the content mirror pulls over the WordPress REST API (rest mode)", () => {
  it("walks every content type, upserts each row and prunes deleted remote media", async () => {
    const restConn = { id: biz.restConnId, business_id: biz.id } as never;
    await content.upsertWpContent(restConn, {
      id: 3999,
      type: "attachment",
      title: "Deleted remotely",
      source_url: "https://x/deleted.png",
      mime_type: "image/png",
    });
    // A fake wp/v2 client: one page each of posts, pages, media.
    const pagesByType: Record<string, Record<string, unknown>[]> = {
      posts: [{ id: 3001, type: "post", title: { rendered: "Ben &amp; Jerry" }, status: "publish" }],
      pages: [{ id: 3002, type: "page", title: { rendered: "درباره&#8230;" }, status: "publish" }],
      media: [
        { id: 3003, type: "attachment", title: { rendered: "Logo" }, source_url: "https://x/y.png", mime_type: "image/png" },
      ],
    };
    const client = {
      wpListPage: async (type: string) => ({ items: pagesByType[type] ?? [], totalPages: 1 }),
    };

    const outcome = await content.syncWpContentRest(restConn, client);
    expect(outcome.total).toBe(3);

    const rows = await content.listWpContent(biz.id, biz.restConnId);
    expect(rows.find((r) => r.remoteId === "3001")?.title).toBe("Ben & Jerry");
    expect(rows.find((r) => r.remoteId === "3002")?.title).toBe("درباره…");
    expect(rows.find((r) => r.remoteId === "3003")?.mimeType).toBe("image/png");
    expect(rows.some((r) => r.remoteId === "3999")).toBe(false);
  });

  it("keeps paging when a WordPress host omits X-WP-TotalPages", async () => {
    const restConn = { id: biz.restConnId, business_id: biz.id } as never;
    const calls: string[] = [];
    const client = {
      wpListPage: async (type: string, query: { page: number }) => {
        calls.push(`${type}:${query.page}`);
        if (type !== "posts") return { items: [], totalPages: 0 };
        if (query.page === 1) {
          return {
            items: Array.from({ length: 100 }, (_, index) => ({
              id: 4000 + index,
              title: { rendered: `Post ${index}` },
              status: "publish",
            })),
            totalPages: 0,
          };
        }
        if (query.page === 2) {
          return { items: [{ id: 4100, title: { rendered: "Last post" }, status: "publish" }], totalPages: 0 };
        }
        return { items: [], totalPages: 0 };
      },
    };

    const outcome = await content.syncWpContentRest(restConn, client);
    expect(outcome.total).toBe(101);
    expect(calls).toContain("posts:2");
    const rows = await content.listWpContent(biz.id, biz.restConnId, { wpType: "post", limit: 200 });
    expect(rows).toHaveLength(101);
    expect(rows.some((row) => row.remoteId === "4100")).toBe(true);
  });
});
