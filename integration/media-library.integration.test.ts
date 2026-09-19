/**
 * The media library (migration 0149) against a real migrated database and an
 * in-memory S3 server — the two halves the unit tests cannot cover together:
 *
 *   • the platform_media_config singleton (secret keep/clear semantics);
 *   • store → read → delete round-trips through real SigV4 requests, with the
 *     object landing under the owning business's own key prefix;
 *   • tenant isolation twice over: RLS on the rows, and the fail-closed
 *     `keyBelongsToBusiness` check refusing a row whose storage_key points at
 *     another tenant's object even when the row itself is reachable;
 *   • listing filters, facets and usage rollups;
 *   • the daily billing tick: idempotent per Tehran day, flat + per-GB from
 *     the console tariff, and the insufficient-funds rollback that keeps a
 *     broke business billable tomorrow instead of silently written off.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { MediaStorageConfig } from "../src/lib/media";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName: string;
let db: Client;
let s3Server: Server;
/** key → bytes; what our mock bucket holds right now. */
const bucketObjects = new Map<string, Buffer>();

let media: typeof import("../src/lib/media-service");
let mediaLib: typeof import("../src/lib/media");
let wallet: typeof import("../src/lib/wallet-service");
let dbLib: typeof import("../src/lib/db");

const BID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; // کافه اول — the funded one
const BID2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"; // کافه دوم — the broke one

let config: MediaStorageConfig;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Real PNG magic so nothing upstream of the service would refuse these bytes. */
function pngOf(size: number): Buffer {
  const bytes = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
}

beforeAll(async () => {
  // A path-style S3 endpoint: PUT/GET/DELETE /{bucket}/{key...}. s3-lite signs
  // every request with SigV4; the mock only needs to store and serve bytes.
  s3Server = createServer((req, res) => {
    const key = decodeURIComponent((req.url ?? "").replace(/^\/media-test\//, "").split("?")[0]);
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        bucketObjects.set(key, Buffer.concat(chunks));
        res.statusCode = 200;
        res.end();
      });
      return;
    }
    if (req.method === "GET") {
      const body = bucketObjects.get(key);
      if (!body) {
        res.statusCode = 404;
        res.end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      res.statusCode = 200;
      res.end(body);
      return;
    }
    if (req.method === "DELETE") {
      bucketObjects.delete(key);
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 405;
    res.end();
  });
  await new Promise<void>((resolve) => s3Server.listen(0, "127.0.0.1", resolve));
  const s3Port = (s3Server.address() as AddressInfo).port;

  databaseName = `pos_media_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);

  media = await import("../src/lib/media-service");
  mediaLib = await import("../src/lib/media");
  wallet = await import("../src/lib/wallet-service");
  dbLib = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  await db.query(
    `INSERT INTO businesses (id, name, slug, plan) VALUES
       ($1, 'کافه اول', 'cafe-one', 'pro'),
       ($2, 'کافه دوم', 'cafe-two', 'pro')`,
    [BID, BID2],
  );

  config = {
    ...mediaLib.DEFAULT_MEDIA_CONFIG,
    enabled: true,
    endpoint: `http://127.0.0.1:${s3Port}`,
    region: "us-east-1",
    bucket: "media-test",
    keyPrefix: "media/",
    accessKeyId: "test-access",
    secretAccessKey: "test-secret",
  };
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  await new Promise<void>((resolve) => s3Server?.close(() => resolve()));
  process.env.DATABASE_URL = rootDatabaseUrl;
});

function scoped<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

describe("platform_media_config singleton", () => {
  it("starts disabled with defaults and reports storage not ready", async () => {
    const stored = await dbLib.withoutTenantScope("test", () => media.getMediaConfig());
    expect(stored.enabled).toBe(false);
    expect(stored.keyPrefix).toBe("media/");
    expect(media.isMediaStorageReady(stored)).toBe(false);
  });

  it("saves the config and round-trips every tariff field", async () => {
    await dbLib.withoutTenantScope("test", () =>
      media.saveMediaConfig(
        { ...config, billingEnabled: true, dailyFlatRial: 5000, dailyPerGbRial: 20000, freeQuotaMb: 1 },
        null,
      ),
    );
    const stored = await dbLib.withoutTenantScope("test", () => media.getMediaConfig());
    expect(stored.enabled).toBe(true);
    expect(stored.secretAccessKey).toBe("test-secret");
    expect(stored.dailyFlatRial).toBe(5000);
    expect(stored.dailyPerGbRial).toBe(20000);
    expect(stored.freeQuotaMb).toBe(1);
    expect(media.isMediaStorageReady(stored)).toBe(true);
    // The browser-facing shape never carries the secret.
    const masked = mediaLib.maskMediaConfig(stored);
    expect(JSON.stringify(masked)).not.toContain("test-secret");
    expect(masked.secretAccessKeySet).toBe(true);
  });
});

describe("store → read → delete through real SigV4 against the bucket", () => {
  let assetId: string;
  const bytes = pngOf(600);

  it("stores bytes under the owning business's own prefix", async () => {
    const asset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID,
        userId: null,
        config,
        kind: "image",
        fileName: "اسپرسو دوبل.png",
        mimeType: "image/png",
        bytes,
        sha256: sha256(bytes),
      }),
    );
    assetId = asset.id;
    expect(asset.kind).toBe("image");
    expect(asset.byteSize).toBe(600);

    // The object exists in the bucket, keyed {prefix}{businessId}/{assetId}/…
    const keys = [...bucketObjects.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0].startsWith(`media/${BID}/${assetId}/`)).toBe(true);
    expect(mediaLib.keyBelongsToBusiness(keys[0], "media/", BID)).toBe(true);
    expect(mediaLib.keyBelongsToBusiness(keys[0], "media/", BID2)).toBe(false);
  });

  it("reads the exact bytes back", async () => {
    const read = await scoped(BID, () => media.readMediaObject(BID, assetId, config));
    expect(read).not.toBeNull();
    expect(read!.bytes.equals(bytes)).toBe(true);
    expect(read!.asset.fileName).toContain("اسپرسو");
  });

  it("refuses to read a row whose storage_key points at another tenant's object", async () => {
    // Simulate the impossible-but-catastrophic row: reachable under RLS but
    // carrying a foreign key path. The fail-closed check must refuse it
    // BEFORE s3-lite goes near the network.
    const foreignKey = `media/${BID2}/${randomUUID()}/stolen.png`;
    await db.query(`UPDATE media_assets SET storage_key = $1 WHERE id = $2`, [foreignKey, assetId]);
    const read = await scoped(BID, () => media.readMediaObject(BID, assetId, config));
    expect(read).toBeNull();
    // Restore the honest key for the delete test below.
    const realKey = [...bucketObjects.keys()][0];
    await db.query(`UPDATE media_assets SET storage_key = $1 WHERE id = $2`, [realKey, assetId]);
  });

  it("the other business cannot see or read the asset at all (RLS)", async () => {
    const listed = await scoped(BID2, () => media.listMediaAssets(BID2));
    expect(listed.total).toBe(0);
    const read = await scoped(BID2, () => media.readMediaObject(BID2, assetId, config));
    expect(read).toBeNull();
  });

  it("deletes the row first and then the object", async () => {
    const ok = await scoped(BID, () => media.deleteMediaAsset(BID, assetId, config));
    expect(ok).toBe(true);
    expect(bucketObjects.size).toBe(0);
    expect(await scoped(BID, () => media.getMediaAsset(BID, assetId))).toBeNull();
    // Deleting the already-deleted asset reports false, not an error.
    expect(await scoped(BID, () => media.deleteMediaAsset(BID, assetId, config))).toBe(false);
  });
});

describe("listing, folders, facets and usage", () => {
  let folderId: string;

  beforeAll(async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO media_folders (business_id, name) VALUES ($1, 'تصاویر منو') RETURNING id`,
      [BID],
    );
    folderId = rows[0].id;

    const store = (fileName: string, kind: "image" | "document", size: number, folder: string | null) =>
      scoped(BID, async () => {
        const bytes = kind === "image" ? pngOf(size) : Buffer.concat([Buffer.from("%PDF-1.7"), Buffer.alloc(size - 8)]);
        return media.storeMediaAsset({
          businessId: BID,
          userId: null,
          config,
          kind,
          fileName,
          mimeType: kind === "image" ? "image/png" : "application/pdf",
          bytes,
          sha256: sha256(bytes),
          folderId: folder,
        });
      });

    const a = await store("espresso.png", "image", 1000, folderId);
    await db.query(`UPDATE media_assets SET category = 'نوشیدنی', tags = ARRAY['قهوه','اسپرسو'] WHERE id = $1`, [a.id]);
    const b = await store("cheesecake.png", "image", 2000, null);
    await db.query(`UPDATE media_assets SET category = 'دسر', tags = ARRAY['کیک'] WHERE id = $1`, [b.id]);
    await store("منو.pdf", "document", 3000, null);
  });

  it("filters by folder, kind, category, tag and search", async () => {
    await scoped(BID, async () => {
      expect((await media.listMediaAssets(BID)).total).toBe(3);
      expect((await media.listMediaAssets(BID, { folderId })).total).toBe(1);
      expect((await media.listMediaAssets(BID, { folderId: null })).total).toBe(2);
      expect((await media.listMediaAssets(BID, { kind: "document" })).assets[0].fileName).toBe("منو.pdf");
      expect((await media.listMediaAssets(BID, { category: "دسر" })).assets[0].fileName).toBe("cheesecake.png");
      expect((await media.listMediaAssets(BID, { tag: "قهوه" })).assets[0].fileName).toBe("espresso.png");
      // Search matches file name OR category OR tag, case-insensitively.
      expect((await media.listMediaAssets(BID, { search: "ESPRESSO" })).total).toBe(1);
      expect((await media.listMediaAssets(BID, { search: "کیک" })).total).toBe(1);
    });
  });

  it("rolls up facets and usage from the same rows", async () => {
    await scoped(BID, async () => {
      const facets = await media.listMediaFacets(BID);
      expect(facets.categories).toEqual(["دسر", "نوشیدنی"]);
      expect(facets.tags).toEqual(["اسپرسو", "قهوه", "کیک"]);

      const usage = await media.mediaUsageFor(BID);
      expect(usage.assetCount).toBe(3);
      expect(usage.totalBytes).toBe(6000);
      expect(usage.byKind.image).toEqual({ count: 2, bytes: 3000 });
      expect(usage.byKind.document).toEqual({ count: 1, bytes: 3000 });

      const folders = await media.listMediaFolders(BID);
      expect(folders).toHaveLength(1);
      expect(folders[0].name).toBe("تصاویر منو");
      expect(folders[0].assetCount).toBe(1);
    });
  });

  it("keeps the second business's shelves empty (facets/usage are per tenant)", async () => {
    await scoped(BID2, async () => {
      expect((await media.listMediaFacets(BID2)).tags).toEqual([]);
      expect((await media.mediaUsageFor(BID2)).assetCount).toBe(0);
    });
  });
});

describe("daily billing tick", () => {
  it("charges flat + per-GB above the free quota, exactly once per local day", async () => {
    // کافه اول stores 6000 bytes (< 1 MB free quota → flat only), and is funded.
    await scoped(BID, () => wallet.grantCredits({ businessId: BID, amountRial: 100_000, note: "شارژ تست" }));

    const charged = await media.runMediaBillingTick();
    expect(charged).toBe(1);

    const { rows: charges } = await db.query(
      `SELECT day, stored_bytes, flat_rial, per_gb_rial, amount_rial FROM media_usage_charges WHERE business_id = $1`,
      [BID],
    );
    expect(charges).toHaveLength(1);
    expect(charges[0].day).toBe(media.localBillingDay());
    expect(Number(charges[0].stored_bytes)).toBe(6000);
    expect(Number(charges[0].flat_rial)).toBe(5000);
    expect(Number(charges[0].per_gb_rial)).toBe(0); // under the 1 MB free quota
    expect(Number(charges[0].amount_rial)).toBe(5000);

    const balance = await scoped(BID, () => wallet.getWalletBalanceRial(BID));
    expect(balance).toBe(95_000);

    // Same day, second tick: the UNIQUE claim makes it a no-op.
    expect(await media.runMediaBillingTick()).toBe(0);
    expect(await scoped(BID, () => wallet.getWalletBalanceRial(BID))).toBe(95_000);
  });

  it("rolls the claim back for an empty wallet so tomorrow's tick retries", async () => {
    // کافه دوم now stores something but holds no credit.
    const bytes = pngOf(500);
    await scoped(BID2, () =>
      media.storeMediaAsset({
        businessId: BID2,
        userId: null,
        config,
        kind: "image",
        fileName: "latte.png",
        mimeType: "image/png",
        bytes,
        sha256: sha256(bytes),
      }),
    );

    // A fresh day so the funded business's existing claim doesn't mask the run.
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const charged = await media.runMediaBillingTick(tomorrow);
    expect(charged).toBe(1); // funded business only

    const { rows: brokeCharges } = await db.query(
      `SELECT id FROM media_usage_charges WHERE business_id = $1`,
      [BID2],
    );
    // No claim row left for the broke business — it stays billable tomorrow.
    expect(brokeCharges).toHaveLength(0);

    const { rows: fundedCharges } = await db.query(
      `SELECT day FROM media_usage_charges WHERE business_id = $1 ORDER BY day`,
      [BID],
    );
    expect(fundedCharges).toHaveLength(2);
    expect(fundedCharges[1].day).toBe(media.localBillingDay(tomorrow));

    // Fund the wallet and re-run the same "tomorrow": now it charges.
    await scoped(BID2, () => wallet.grantCredits({ businessId: BID2, amountRial: 50_000, note: "شارژ" }));
    expect(await media.runMediaBillingTick(tomorrow)).toBe(1);
    expect(await scoped(BID2, () => wallet.getWalletBalanceRial(BID2))).toBe(45_000);
  });

  it("charges nothing when billing is disabled in the console", async () => {
    await dbLib.withoutTenantScope("test", () =>
      media.saveMediaConfig({ ...config, billingEnabled: false }, null),
    );
    const dayAfter = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    expect(await media.runMediaBillingTick(dayAfter)).toBe(0);
    // Restore for any test that runs after this file.
    await dbLib.withoutTenantScope("test", () =>
      media.saveMediaConfig(
        { ...config, billingEnabled: true, dailyFlatRial: 5000, dailyPerGbRial: 20000, freeQuotaMb: 1 },
        null,
      ),
    );
  });

  it("bills the per-GB share once storage exceeds the free quota", async () => {
    // Push کافه دوم past the 1 MB free quota: store a 2 MB image.
    const big = pngOf(2 * 1024 * 1024);
    await scoped(BID2, () =>
      media.storeMediaAsset({
        businessId: BID2,
        userId: null,
        config,
        kind: "image",
        fileName: "banner.png",
        mimeType: "image/png",
        bytes: big,
        sha256: sha256(big),
      }),
    );

    const day3 = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await media.runMediaBillingTick(day3);

    const { rows } = await db.query(
      `SELECT per_gb_rial, amount_rial FROM media_usage_charges WHERE business_id = $1 AND day = $2`,
      [BID2, media.localBillingDay(day3)],
    );
    expect(rows).toHaveLength(1);
    // (2 MB + 500 B − 1 MB free) ≈ 1 MB billable → ceil(1MB/1GB × 20000) = 20 Rial.
    // The exact number matters less than the invariant: rounded UP, never free.
    expect(Number(rows[0].per_gb_rial)).toBeGreaterThan(0);
    expect(Number(rows[0].amount_rial)).toBe(5000 + Number(rows[0].per_gb_rial));
  });
});

describe("Phase G — asset provenance (source, AI authorship, conversation/project)", () => {
  it("defaults an ordinary store to a human upload with no workspace", async () => {
    const bytes = pngOf(300);
    const asset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "plain.png", mimeType: "image/png", bytes, sha256: sha256(bytes),
      }),
    );
    expect(asset.source).toBe("upload");
    expect(asset.createdByAi).toBe(false);
    expect(asset.conversationId).toBeNull();
    expect(asset.projectId).toBeNull();
  });

  it("records an AI attachment as user-authored but AI-adjacent, linked to its conversation", async () => {
    const { rows: conv } = await db.query<{ id: string }>(
      `INSERT INTO ai_conversations (business_id, actor_user_id, mode, title)
       VALUES ($1, gen_random_uuid(), 'dashboard', 'رسید') RETURNING id`,
      [BID],
    );
    const bytes = pngOf(400);
    const asset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "receipt.png", mimeType: "image/png", bytes, sha256: sha256(bytes),
        source: "ai_attachment", conversationId: conv[0].id,
      }),
    );
    expect(asset.source).toBe("ai_attachment");
    // An attachment is the user's own file; only generation is AI-authored.
    expect(asset.createdByAi).toBe(false);
    expect(asset.conversationId).toBe(conv[0].id);
  });

  it("marks a generated image AI-authored and derives createdByAi from source", async () => {
    const bytes = pngOf(500);
    const asset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "generated.png", mimeType: "image/png", bytes, sha256: sha256(bytes),
        source: "ai_generated",
      }),
    );
    expect(asset.source).toBe("ai_generated");
    expect(asset.createdByAi).toBe(true);
  });

  it("filters the library by conversation and by project", async () => {
    const { rows: proj } = await db.query<{ id: string }>(
      `INSERT INTO ai_projects (business_id, name, created_by) VALUES ($1, 'کمپین', 'seed') RETURNING id`,
      [BID],
    );
    const { rows: conv } = await db.query<{ id: string }>(
      `INSERT INTO ai_conversations (business_id, actor_user_id, mode, title, project_id)
       VALUES ($1, gen_random_uuid(), 'dashboard', 'نخ', $2) RETURNING id`,
      [BID, proj[0].id],
    );
    const bytes = pngOf(360);
    const inWorkspace = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "ws.png", mimeType: "image/png", bytes, sha256: sha256(bytes),
        source: "ai_generated", conversationId: conv[0].id, projectId: proj[0].id,
      }),
    );

    const byConv = await scoped(BID, () => media.listMediaAssets(BID, { conversationId: conv[0].id }));
    expect(byConv.assets.map((a) => a.id)).toContain(inWorkspace.id);
    expect(byConv.assets.every((a) => a.conversationId === conv[0].id)).toBe(true);

    const byProject = await scoped(BID, () => media.listMediaAssets(BID, { projectId: proj[0].id }));
    expect(byProject.assets.map((a) => a.id)).toContain(inWorkspace.id);
    expect(byProject.assets.every((a) => a.projectId === proj[0].id)).toBe(true);
  });

  it("nulls the links when the conversation or project is deleted, keeping the asset", async () => {
    const { rows: proj } = await db.query<{ id: string }>(
      `INSERT INTO ai_projects (business_id, name, created_by) VALUES ($1, 'موقت', 'seed') RETURNING id`,
      [BID],
    );
    const { rows: conv } = await db.query<{ id: string }>(
      `INSERT INTO ai_conversations (business_id, actor_user_id, mode, title, project_id)
       VALUES ($1, gen_random_uuid(), 'dashboard', 'نخ موقت', $2) RETURNING id`,
      [BID, proj[0].id],
    );
    const bytes = pngOf(320);
    const asset = await scoped(BID, () =>
      media.storeMediaAsset({
        businessId: BID, userId: null, config, kind: "image",
        fileName: "keep.png", mimeType: "image/png", bytes, sha256: sha256(bytes),
        source: "ai_attachment", conversationId: conv[0].id, projectId: proj[0].id,
      }),
    );

    await db.query(`DELETE FROM ai_conversations WHERE id = $1`, [conv[0].id]);
    await db.query(`DELETE FROM ai_projects WHERE id = $1`, [proj[0].id]);

    const survived = await scoped(BID, () => media.getMediaAsset(BID, asset.id));
    expect(survived).not.toBeNull();
    expect(survived!.conversationId).toBeNull();
    expect(survived!.projectId).toBeNull();
    // The provenance label itself is retained — we still know it came from chat.
    expect(survived!.source).toBe("ai_attachment");
  });
});
