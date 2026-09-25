/**
 * Source-level regression checks for the WordPress media section. These bugs
 * were interaction/layout contracts (silent fetch failure, a one-page ceiling,
 * nested card chrome and stale request races), so pinning the source patterns
 * catches their accidental return without a browser DOM test dependency.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("./", import.meta.url));
const media = readFileSync(join(DIR, "media-section.tsx"), "utf8");
const picker = readFileSync(join(DIR, "connection-lite.tsx"), "utf8");
const plugin = readFileSync(
  resolve(DIR, "../../../../../wordpress-plugin/pos-accounting-connector/includes/class-pos-sync.php"),
  "utf8",
);
const ingest = readFileSync(
  resolve(DIR, "../../../../../src/lib/integrations/webhook-ingest-service.ts"),
  "utf8",
);
const pluginService = readFileSync(
  resolve(DIR, "../../../../../src/lib/integrations/plugin-service.ts"),
  "utf8",
);

describe("WordPress media browsing", () => {
  it("pages beyond the first response and exposes a load-more control", () => {
    expect(media).toMatch(/const PAGE_SIZE = 24/);
    expect(media).toMatch(/offset: String\(offset\)/);
    expect(media).toContain("نمایش فایل‌های بیشتر");
  });

  it("debounces searches and discards superseded requests", () => {
    expect(media).toMatch(/setTimeout\(/);
    expect(media).toMatch(/new AbortController\(\)/);
    expect(media).toMatch(/request !== listRequestRef\.current/);
  });

  it("distinguishes failed loads from an honestly empty library", () => {
    expect(media).toMatch(/useWpStore/);
    expect(media).toMatch(/loadError/);
    expect(media).toContain("تلاش دوباره");
    expect(media).toContain("هنوز رسانه‌ای همگام نشده است");
  });

  it("keeps loaded tiles visible when only the next page fails", () => {
    expect(media).toMatch(/loadError && rows !== null && rows\.length === 0/);
    expect(media).toMatch(/load\(selectedId, shown, true\)/);
    expect(media).toContain("تلاش دوباره برای ادامهٔ فهرست");
  });

  it("starts as a two-column gallery and grows only at breakpoints", () => {
    expect(media).toMatch(/grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6/);
    expect(media).not.toMatch(/grid-cols-4 gap-3(?![^\n]*lg:grid-cols-4)/);
  });

  it("uses full touch-height file actions and a broken-image fallback", () => {
    expect(media).toMatch(/size="lg" className="mt-3 w-full"/);
    expect(media).toMatch(/onError=\{\(\) => setFailed\(true\)\}/);
    expect(media).toContain("پیش‌نمایش در دسترس نیست");
  });
});

describe("adding media from a URL", () => {
  const route = readFileSync(
    resolve(DIR, "../../../../../src/app/api/integrations/wp-manager/media/route.ts"),
    "utf8",
  );

  it("offers the add action only when the transport can perform it", () => {
    // Capability-driven, not decorative: linkMode plugin + advertised media_create.
    expect(media).toMatch(/pluginSupportsJobType\(selectedConnection\.pluginCapabilities \?\? null, "media_create"\)/);
    expect(media).toMatch(/\{canAddMedia \? \(/);
    expect(media).toContain("افزودن تصویر از نشانی");
  });

  it("queues through the canonical outbox with a stable operation id", () => {
    expect(route).toContain("integration_outbox_events");
    expect(route).toContain("'media_create'");
    expect(route).toMatch(/wp-media:\$\{connectionId\}/);
    expect(route).toContain('"content.media_create_queued"');
  });

  it("refuses transports that cannot sideload instead of pretending", () => {
    expect(route).toContain("media_rest_unsupported");
    expect(route).toContain("plugin_media_unsupported");
    expect(route).toMatch(/pluginSupportsJobType\(connection\.plugin_capabilities, "media_create"\)/);
  });

  it("the plugin applies media_create idempotently and stamps the operation id", () => {
    expect(plugin).toMatch(/apply_media_create/);
    expect(plugin).toContain("operation_id_missing_for_non_idempotent_media_create");
    expect(plugin).toMatch(/_pos_operation_id/);
  });

  it("clears the half-typed form when the store selector moves", () => {
    expect(media).toMatch(/setAddOpen\(false\);\s*\n\s*setAddUrl\(""\);/);
  });
});

describe("the shared connection picker", () => {
  it("uses a unique label target, shared input chrome and the chrome-free embedded form", () => {
    expect(picker).toMatch(/const id = useId\(\)/);
    expect(picker).toMatch(/className=\{`\$\{inputClass\}/);
    expect(picker).toMatch(/embedded\s*\?\s*"flex min-w-0/);
    expect(media).toMatch(/<ConnectionPicker\s+embedded/);
  });
});

describe("the plugin keeps the media mirror current", () => {
  it("observes attachment edits and deletions", () => {
    expect(plugin).toMatch(/add_action\( 'edit_attachment'/);
    expect(plugin).toMatch(/add_action\( 'delete_attachment'/);
    expect(plugin).toContain("'content.deleted'");
  });

  it("requests historical content/media on the plugin's first handshake, gated by its capabilities", () => {
    expect(pluginService).toMatch(/firstContact[\s\S]*"content_export"[\s\S]*enqueuePluginExport\(connection\.business_id, connection\.id, exportType\)/);
    // A plugin that never advertised an export type must not be handed a job
    // its lease query will never return — that row would sit pending forever.
    expect(pluginService).toMatch(/if \(!pluginSupportsJobType\(capabilities, exportType\)\) continue;/);
  });

  it("queues an ordered completion marker and the server advances its watermark", () => {
    expect(plugin).toContain("'content.sync_completed'");
    expect(ingest).toMatch(/event\.topic\.endsWith\("content\.sync_completed"\)/);
    expect(ingest).toContain("last_content_sync_at = now()");
  });
});
