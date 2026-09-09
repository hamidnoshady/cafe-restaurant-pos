import { describe, expect, it } from "vitest";

import {
  buildCmsCallRecord,
  buildCmsFeedRecord,
  cmsCallLevel,
  cmsLogStream,
  DEFAULT_CMS_STREAM,
} from "./observability";

describe("cmsLogStream", () => {
  it("defaults to its own stream and honours the override", () => {
    // Deliberately not `pos_app_logs`: a retention or an alert that suits this
    // deployment's own request log does not necessarily suit another product's
    // audit tail, and one stream would mean tuning either tunes both.
    expect(cmsLogStream({})).toBe(DEFAULT_CMS_STREAM);
    expect(cmsLogStream({ OPENOBSERVE_CMS_STREAM: "  website_events " })).toBe("website_events");
    expect(cmsLogStream({ OPENOBSERVE_CMS_STREAM: "   " })).toBe(DEFAULT_CMS_STREAM);
  });
});

describe("cmsCallLevel", () => {
  it("separates a CMS that refused from a CMS that never answered", () => {
    // A refusal means the link works and somebody made a mistake; no answer at all
    // is the outage. In a level filter those must not look the same.
    expect(cmsCallLevel("ok")).toBe("info");
    expect(cmsCallLevel("api_error", 403)).toBe("warn");
    expect(cmsCallLevel("api_error", 500)).toBe("error");
    expect(cmsCallLevel("network_error")).toBe("error");
  });
});

describe("buildCmsCallRecord", () => {
  it("records the operation, not the URL, and rounds the latency", () => {
    const record = buildCmsCallRecord({
      durationMs: 132.7,
      operation: "sites.patch",
      outcome: "ok",
      siteId: "site-1",
      status: 200,
    });
    expect(record).toMatchObject({
      cms_operation: "sites.patch",
      cms_outcome: "ok",
      duration_ms: 133,
      level: "info",
      logger: "cms",
      site_id: "site-1",
      status: 200,
    });
    expect(String(record.message)).toContain("sites.patch");
  });

  it("omits `status` entirely when the CMS never answered", () => {
    // A `status: 0` would sort and filter as a real status code; an absent field
    // reads as what it is.
    const record = buildCmsCallRecord({
      durationMs: 8_000,
      operation: "overview",
      outcome: "network_error",
    });
    expect(record).not.toHaveProperty("status");
    expect(record.level).toBe("error");
    expect(record.site_id).toBe("");
  });
});

describe("buildCmsFeedRecord", () => {
  it("keeps the CMS's own id and timestamp, and flattens its data one level", () => {
    const record = buildCmsFeedRecord({
      at: "2026-09-09T08:00:00.000Z",
      data: { detail: "unauthorized", enabled: true, ok: false },
      id: "gateway:abc:2026-09-09T08:00:00.000Z",
      kind: "gateway.selftest",
      level: "error",
      message: "خودآزمایی درگاه zarinpal ناموفق بود.",
      siteDomain: "acme.ir",
      siteId: "site-1",
    });
    expect(record).toMatchObject({
      cms_detail: "unauthorized",
      cms_enabled: true,
      cms_event_id: "gateway:abc:2026-09-09T08:00:00.000Z",
      cms_kind: "gateway.selftest",
      cms_ok: false,
      cms_site_domain: "acme.ir",
      level: "error",
      logger: "cms-event",
      site_id: "site-1",
      // Without the CMS's own instant, a feed polled every ten minutes would show
      // every record as having happened at poll time.
      source_at: "2026-09-09T08:00:00.000Z",
    });
  });

  it("stringifies a nested value rather than dropping it", () => {
    const record = buildCmsFeedRecord({
      at: "2026-09-09T08:00:00.000Z",
      data: { payload: { amount: 1000, currency: "IRT" } },
      id: "order:1",
      kind: "order.placed",
      level: "info",
      message: "سفارش ثبت شد.",
      siteDomain: null,
      siteId: null,
    });
    // A log store's SQL cannot filter on a nested object without a JSON function
    // that differs between versions, and a dropped field is a lost detail.
    expect(record.cms_payload).toBe('{"amount":1000,"currency":"IRT"}');
    expect(record.cms_site_domain).toBe("");
  });

  it("falls back to info for a level the CMS invents", () => {
    const record = buildCmsFeedRecord({
      at: "2026-09-09T08:00:00.000Z",
      id: "x",
      kind: "site.changed",
      level: "catastrophe",
      message: "…",
      siteDomain: null,
      siteId: null,
    });
    expect(record.level).toBe("info");
  });
});
