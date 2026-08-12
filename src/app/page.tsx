import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { businessHost, hostRoutingEnabled, parseHost, rootDomain as configuredRootDomain } from "@/lib/host";
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
    const host = parseHost((await headers()).get("host"), rootDomain);

    // The apex has no tenant to show. It is a signpost to the business hosts.
    if (host.kind === "apex") return <BusinessDirectory />;

    if (host.kind === "business") {
      const business = await resolveBusinessByLabel(host.label);
      // Arrived on a host the business used to have: send them to the current
      // one so bookmarks made before a rename still work.
      if (business?.viaAlias) {
        redirect(`https://${businessHost(business.subdomain, rootDomain)}`);
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
  // Under subdomain routing the host already names the business, so the
  // dashboard is served unprefixed. The slug prefix is the pre-Phase-21 form,
  // which middleware still rewrites while SUBDOMAIN_ROUTING is off.
  if (hostRoutingEnabled()) redirect("/dashboard");
  redirect(session.businessSlug ? `/${session.businessSlug}/dashboard` : "/dashboard");
}
