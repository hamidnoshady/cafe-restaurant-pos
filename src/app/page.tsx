import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import {
  hostRoutingEnabled,
  parseHost,
  preferredProto,
  rootDomain as configuredRootDomain,
  swapHostLabel,
} from "@/lib/host";
import { resolveBusinessByLabel } from "@/lib/host-resolution";
import { hasAnyUser, isSetupComplete } from "@/lib/setup-state";
import { BusinessDirectory } from "./business-directory";

export default async function Home() {
  // Phase 23 — this page is the only place that can do host resolution for a
  // browser landing on `/`: middleware runs on Edge and cannot reach Postgres,
  // so "which business is this host, and is it an old name?" has to be
  // answered here.
  const rootDomain = configuredRootDomain();
  if (hostRoutingEnabled()) {
    const headerList = await headers();
    const host = parseHost(headerList.get("host"), rootDomain);

    // The apex has no tenant to show. It is a signpost to the business hosts.
    if (host.kind === "apex") return <BusinessDirectory />;

    if (host.kind === "business") {
      const business = await resolveBusinessByLabel(host.label);
      // Arrived on a host the business used to have: send them to the current
      // one so bookmarks made before a rename still work. The scheme and port
      // come from the request rather than being assumed — behind a proxy the
      // app's own view of them is the internal one.
      if (business?.viaAlias) {
        const proto = preferredProto(headerList.get("x-forwarded-proto"), "https");
        const forwardedHost = headerList.get("x-forwarded-host") ?? headerList.get("host");
        redirect(`${proto}://${swapHostLabel(forwardedHost, business.subdomain, rootDomain)}/`);
      }
    }
  }

  const session = await getSession();
  if (!session) {
    // Empty install → first-run wizard; otherwise normal login.
    redirect((await hasAnyUser()) ? "/login" : "/welcome");
  }
  // Owner/Manager land in the wizard until setup is finished.
  if (
    (session.role === "owner" || session.role === "manager") &&
    !(await isSetupComplete(session.businessId))
  ) {
    redirect("/setup");
  }
  // The dashboard has one address. A business is named by its origin, never by
  // a path prefix: `/{slug}/dashboard` is the retired form, still redirected
  // for old bookmarks (see handleLegacyPathRedirect in src/middleware.ts) but
  // no longer generated anywhere.
  redirect("/dashboard");
}
