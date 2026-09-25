import { headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  hostRoutingEnabled,
  parseHost,
  preferredProto,
  requestHost,
  rootDomain as configuredRootDomain,
  swapHostLabel,
} from "@/lib/host";
import { resolveBusinessByLabel } from "@/lib/host-resolution";
import { endedSupportSessionClaims } from "@/lib/auth";
import { SupportSessionEnded } from "@/app/dashboard/support-session-banner";
import LoginForm from "./login-form";

// The alias resolution above reads the request's Host header, so this route
// must render per-request rather than be prerendered at build time.
export const dynamic = "force-dynamic";

/**
 * Phase 23 — the login page is the one public page middleware cannot resolve
 * host aliases for (the Edge runtime has no database), so this route is a thin
 * server component in front of the form. A visit to a business's *old* host —
 * an alias left behind by a subdomain rename — is forwarded to the current
 * host's login, because a login served from a renamed host can never succeed:
 * the session it mints names the *current* subdomain, which the old host no
 * longer matches, so the visitor would be bounced straight back to the login
 * page. Forwarding here costs the canonical host nothing and makes a renamed
 * host behave the same way its bookmarked deep links already do.
 */
export default async function LoginPage() {
  if (hostRoutingEnabled()) {
    const rootDomain = configuredRootDomain();
    const headerList = await headers();
    const host = parseHost(requestHost(headerList), rootDomain);

    if (host.kind === "business") {
      const business = await resolveBusinessByLabel(host.label);
      if (business?.viaAlias) {
        const proto = preferredProto(headerList.get("x-forwarded-proto"), "https");
        const forwardedHost = headerList.get("x-forwarded-host") ?? headerList.get("host");
        redirect(`${proto}://${swapHostLabel(forwardedHost, business.subdomain, rootDomain)}/login`);
      }
    }
  }

  // Every page's `redirect("/login")` lands here, so this is where a support
  // operator whose session is over is sent back to the console instead of
  // being shown the business's staff login.
  const endedSupport = await endedSupportSessionClaims();
  if (endedSupport) return <SupportSessionEnded grantId={endedSupport.imp.grantId} />;

  return <LoginForm />;
}
