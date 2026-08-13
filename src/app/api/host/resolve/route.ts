import { NextRequest, NextResponse } from "next/server";
import { parseHost, businessHost } from "@/lib/host";
import { resolveBusinessByLabel } from "@/lib/host-resolution";

/**
 * What business is this hostname? — the Node-runtime half of host resolution.
 *
 * Middleware answers the *isolation* question on Edge by comparing the host's
 * label to the session's own claim, which needs no database. This route
 * answers the *directory* question, which does: whether a label belongs to a
 * business at all, and whether it is an old host that has since been renamed.
 *
 * Deliberately session-less, and deliberately narrow. It reveals only what the
 * DNS record and the TLS certificate already reveal — that a subdomain is or
 * is not in use, and where a renamed one now points — and nothing about the
 * business behind it beyond its display name, which its own login page shows
 * anyway. Callers are the apex router (does this name exist?) and an alias
 * host redirecting itself to the current name.
 */
export async function GET(request: NextRequest) {
  const rootDomain = process.env.ROOT_DOMAIN?.trim() ?? "";
  const requested = request.nextUrl.searchParams.get("host") ?? request.headers.get("host");
  const parsed = parseHost(requested, rootDomain);

  if (parsed.kind !== "business") {
    return NextResponse.json({ kind: parsed.kind, business: null });
  }

  const business = await resolveBusinessByLabel(parsed.label);
  // Archived businesses are treated as absent: the origin should stop
  // resolving when the tenant is gone, not offer a login that can never work.
  if (!business || business.status === "archived") {
    return NextResponse.json({ kind: "business", business: null });
  }

  return NextResponse.json({
    kind: "business",
    business: {
      name: business.name,
      subdomain: business.subdomain,
      status: business.status,
      // Set when the caller arrived on an old host: the current origin to go
      // to instead. Null on the canonical host, so a client can redirect on
      // truthiness without comparing strings itself.
      canonicalUrl: business.viaAlias ? `https://${businessHost(business.subdomain, rootDomain)}` : null,
    },
  });
}
