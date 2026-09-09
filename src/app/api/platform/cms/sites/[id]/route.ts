import { NextRequest, NextResponse } from "next/server";

import {
  platformAudit,
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";
import { clientIpFrom } from "@/lib/rate-limit";
import { fetchCmsSite, patchCmsSite, type CmsSitePatch } from "@/lib/cms/platform-client";
import { listMirroredCmsSites, resolvePlatformCmsConfig } from "@/lib/cms/platform-control-service";
import { cmsErrorCode, runCmsMirror } from "@/lib/cms/platform-sync";

/**
 * One site: its live report, and its lifecycle.
 *
 * `GET` asks the CMS and falls back to the mirror, so opening a site's panel while
 * the CMS is restarting shows last-known-good figures rather than an error page.
 *
 * `PATCH` is the operator's lifecycle control — suspend, reactivate, rename,
 * change the served locales, tick or untick domain verification, verify an alias.
 * `domain` is deliberately not among them: on the CMS its one write path is
 * `PATCH /api/site/domain`, which resets `domainVerified` and re-checks uniqueness
 * across every site's primary *and* alias hostnames, and a second door onto that
 * column would be a second place for the invariant to be forgotten. Moving a
 * connected site's domain stays the business's own «تنظیمات و همگام‌سازی» flow,
 * which goes through that endpoint and updates the stored `site_domain` with it.
 */
const STATUSES = new Set(["active", "archived", "suspended"]);
const TYPES = new Set(["business", "portfolio", "store"]);

export const GET = withPlatformScope(
  async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePlatformAdmin();
    if (error) return error;
    const { id } = await ctx.params;

    const config = await resolvePlatformCmsConfig();
    const mirrored = (await listMirroredCmsSites()).find((row) => row.id === id) ?? null;

    if (!config) {
      return mirrored
        ? NextResponse.json({ live: null, liveError: "cms_not_configured", site: mirrored })
        : NextResponse.json({ error: "cms_not_configured" }, { status: 400 });
    }

    try {
      const site = await fetchCmsSite(config, id, { actor: session.padmin });
      return NextResponse.json({ live: site, liveError: null, site: mirrored ?? site });
    } catch (err) {
      const code = cmsErrorCode(err);
      if (!mirrored) return NextResponse.json({ error: code }, { status: 502 });
      return NextResponse.json({ live: null, liveError: code, site: mirrored });
    }
  },
);

export const PATCH = withPlatformScope(
  async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePlatformCapability("cms.manage");
    if (error) return error;
    const { id } = await ctx.params;

    const config = await resolvePlatformCmsConfig();
    if (!config) return NextResponse.json({ error: "cms_not_configured" }, { status: 400 });

    let body: Record<string, unknown>;
    try {
      body = ((await request.json()) ?? {}) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const patch: CmsSitePatch = {};
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name || name.length > 120) return NextResponse.json({ error: "invalid_name" }, { status: 400 });
      patch.name = name;
    }
    if (body.status !== undefined) {
      if (typeof body.status !== "string" || !STATUSES.has(body.status)) {
        return NextResponse.json({ error: "invalid_status" }, { status: 400 });
      }
      patch.status = body.status as CmsSitePatch["status"];
    }
    if (body.type !== undefined) {
      if (typeof body.type !== "string" || !TYPES.has(body.type)) {
        return NextResponse.json({ error: "invalid_type" }, { status: 400 });
      }
      patch.type = body.type as CmsSitePatch["type"];
    }
    if (body.domainVerified !== undefined) patch.domainVerified = body.domainVerified === true;
    if (Array.isArray(body.availableLocales)) {
      const locales = body.availableLocales.filter((code): code is string => typeof code === "string");
      if (locales.length === 0) return NextResponse.json({ error: "invalid_locales" }, { status: 400 });
      patch.availableLocales = locales;
    }
    if (typeof body.defaultLocale === "string" && body.defaultLocale.trim()) {
      patch.defaultLocale = body.defaultLocale.trim();
    }
    if (Array.isArray(body.domains)) {
      patch.domains = body.domains
        .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
        .map((row) => ({
          ...(typeof row.id === "string" ? { id: row.id } : {}),
          hostname: String(row.hostname ?? "").trim(),
          verified: row.verified === true,
        }));
      if (patch.domains.some((row) => !row.hostname)) {
        return NextResponse.json({ error: "invalid_domain" }, { status: 400 });
      }
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "nothing_to_change" }, { status: 400 });
    }

    try {
      const site = await patchCmsSite(config, id, patch, { actor: session.padmin });

      await platformAudit({
        action: "platform_cms.site.update",
        adminId: session.padmin,
        // The site's own business, when this platform bills for it, so the audit row
        // is findable from the tenant as well as from the site.
        businessId: (await listMirroredCmsSites()).find((row) => row.id === id)?.businessId ?? null,
        entity: "platform_cms_sites",
        entityId: id,
        ipAddress: clientIpFrom(request.headers, 0),
        payload: { domain: site.domain, patch },
        userAgent: request.headers.get("user-agent"),
      });

      // Keep the mirror honest immediately: a suspended site still showing as
      // active in the table is how an operator suspends it twice.
      await runCmsMirror({ actor: session.padmin, startedBy: session.padmin, trigger: "manual" });

      return NextResponse.json({ site, sites: await listMirroredCmsSites() });
    } catch (err) {
      const code = cmsErrorCode(err);
      // The CMS's own Persian validation message (a domain collision, a default
      // locale outside the site's list) is the useful answer, so it is passed
      // through beside the code rather than replaced by it.
      return NextResponse.json(
        { error: code, message: (err as Error)?.message ?? null },
        { status: code === "cms_unreachable" ? 502 : 400 },
      );
    }
  },
);
